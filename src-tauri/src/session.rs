//! A session per open file: the shared state, its queries and the background jobs that recompute
//! the filter and the levels. Following the file happens in `tail.rs`.

use crate::encoding::{display_text, strip_ansi, Encoding};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::fields::{self, FormatGuess};
use crate::filter::{
    FilterCheckpoint, FilterSpec, FilteredLines, LevelMask, SearchMode, SearchQuery, TextMatcher,
};
use crate::indexer::{
    LineEntry, LineIndex, LineReader, Segment, MAX_DISPLAY_BYTES, MAX_SEARCH_BYTES,
};
use crate::level::{Level, LevelDetector, PrevLine};
use crate::model::{
    ColumnSet, EntryDetail, EntryRange, FilterInfo, FindHit, LogLine, SessionInfo, SessionUpdate,
    Status,
};
use crate::platform::open_shared;
use crate::profile::{Profile, ProfileRegistry};
use crate::tail::Tailer;
use memchr::memchr;
use parking_lot::{Mutex, RwLock};
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

const SCAN_BLOCK: usize = 1024 * 1024;
const VIEW_BLOCK: usize = 64 * 1024;
/// Lines per step of a background job, between which it looks for cancellation.
const JOB_BATCH: usize = 16 * 1024;
/// Below this remainder a filter job finishes under the write lock.
const JOB_FINAL_LINES: usize = 1024;
const MAX_GET_LINES: usize = 5000;
const MAX_COPY_LINES: usize = 1_000_000;
const MAX_COPY_BYTES: usize = 256 * 1024 * 1024;
/// An entry longer than this is not a stack trace; selecting it stops here.
const MAX_ENTRY_WALK: usize = 100_000;

pub type UpdateSink = Box<dyn Fn(SessionUpdate) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct OpenOptions {
    pub keep_on_rotate: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            keep_on_rotate: true,
        }
    }
}

/// The provisional last line (a line without an end shown after a pause) and how to undo it.
#[derive(Debug, Clone, Copy)]
pub struct Provisional {
    pub checkpoint: FilterCheckpoint,
    pub prev: PrevLine,
}

pub struct SessionData {
    pub index: LineIndex,
    pub filter: FilteredLines,
    /// What the running or last job works towards (`filter` swaps to it when done).
    pub requested_spec: FilterSpec,
    pub segments: Vec<Arc<Segment>>,
    pub encoding: Encoding,
    pub detector: Arc<LevelDetector>,
    pub profile_id: String,
    /// The profile the user chose; its layout applies once the first lines are there.
    pub chosen_profile: Option<Profile>,
    /// No choice by the user yet: the suggestion may still replace the profile.
    pub profile_auto: bool,
    pub suggested_profile: Option<String>,
    pub relevel_needed: bool,
    /// How lines split into fields, and how well the sample fits.
    pub format: Arc<FormatGuess>,
    /// Waits for the running job: the spans change together with the view generation.
    pub requested_format: Option<Arc<FormatGuess>>,
    /// Changes with the columns; then the view generation changes too.
    pub columns_revision: u64,
    /// Decoded first lines of the file (at most `SAMPLE_LINES`), for building a format.
    pub sample: Arc<Vec<String>>,
    pub prev: PrevLine,
    pub provisional: Option<Provisional>,
    pub epoch: u64,
    pub view_generation: u64,
    pub filter_pending: bool,
    pub filter_progress: f32,
    pub status: Status,
    pub file_size: u64,
    pub keep_on_rotate: bool,
    /// The worker reads nothing new, so everything derived from the index stays as it is.
    pub frozen: bool,
    pub pending_bytes: u64,
    pub frozen_stale: bool,
    /// Something changed that the frontend has not heard of.
    pub dirty: bool,
}

impl SessionData {
    /// Removes the provisional last line, if there is one.
    pub fn retract_provisional(&mut self) {
        if let Some(provisional) = self.provisional.take() {
            self.index.pop();
            self.filter.restore(provisional.checkpoint);
            self.prev = provisional.prev;
        }
    }

    /// Uses a new format right away, with a new view generation so cached spans are void.
    pub fn set_format(&mut self, format: FormatGuess, view_generation: u64) {
        self.format = Arc::new(format);
        self.columns_revision += 1;
        self.view_generation = view_generation;
        self.dirty = true;
    }

    /// The view is recomputed: a format waiting for it takes over now.
    fn finish_view(&mut self, view_generation: u64) {
        self.view_generation = view_generation;
        if let Some(format) = self.requested_format.take() {
            self.format = format;
            self.columns_revision += 1;
        }
    }

    /// Forgets all lines (truncation, rotation without keeping the old lines).
    pub fn reset_index(&mut self) {
        self.index.clear();
        self.filter.clear();
        self.prev = PrevLine::default();
        self.provisional = None;
        self.epoch += 1;
        self.dirty = true;
    }

    pub fn update(&self) -> SessionUpdate {
        SessionUpdate {
            total_lines: self.index.len() as u64,
            filtered_lines: self.filter.len(self.index.len()) as u64,
            counts: self.index.counts.into(),
            status: self.status.clone(),
            file_size: self.file_size,
            epoch: self.epoch,
            view_generation: self.view_generation,
            columns_revision: self.columns_revision,
            filter_pending: self.filter_pending,
            filter_progress: self.filter_progress,
            profile_id: self.profile_id.clone(),
            encoding: self.encoding,
            frozen: self.frozen,
            pending_bytes: self.pending_bytes,
            frozen_stale: self.frozen_stale,
        }
    }
}

pub struct Shared {
    pub data: RwLock<SessionData>,
    /// The newest job; an older one sees the difference and stops.
    job_generation: AtomicU64,
    /// Source of view generations, separate from the jobs so a format change cancels none.
    view_counter: AtomicU64,
    find_generation: AtomicU64,
    pub shutdown: AtomicBool,
    pub wake: Sender<()>,
    pub sink: UpdateSink,
}

impl Shared {
    pub fn next_view_generation(&self) -> u64 {
        self.view_counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn wake(&self) {
        // The receiver is only gone while the session shuts down.
        let _ = self.wake.send(());
    }
}

pub struct LogSession {
    pub id: u64,
    pub path: PathBuf,
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
    _watcher: Option<notify::RecommendedWatcher>,
}

impl LogSession {
    /// Opens the file and indexes its first block, so errors and the first lines are there when
    /// this returns. The rest happens in the session's worker thread.
    pub fn open(
        id: u64,
        path: &Path,
        options: OpenOptions,
        default_profile: &Profile,
        sink: UpdateSink,
    ) -> AppResult<Self> {
        let path = std::path::absolute(path).map_err(|e| AppError::from_io(&e, path))?;
        let meta = std::fs::metadata(&path).map_err(|e| AppError::from_io(&e, &path))?;
        if meta.is_dir() {
            return Err(AppError::new(
                ErrorCode::IsADirectory,
                format!("{} is a folder", path.display()),
            ));
        }
        let file = open_shared(&path).map_err(|e| AppError::from_io(&e, &path))?;
        let detector = Arc::new(default_profile.detector()?);
        let spec = FilterSpec::default();
        let data = SessionData {
            index: LineIndex::default(),
            filter: FilteredLines::new(spec.clone()),
            requested_spec: spec,
            segments: Vec::new(),
            encoding: Encoding::Utf8,
            detector,
            profile_id: default_profile.id.clone(),
            chosen_profile: None,
            profile_auto: true,
            suggested_profile: None,
            relevel_needed: false,
            format: Arc::new(FormatGuess::none()),
            requested_format: None,
            columns_revision: 0,
            sample: Arc::new(Vec::new()),
            prev: PrevLine::default(),
            provisional: None,
            epoch: 0,
            view_generation: 0,
            filter_pending: false,
            filter_progress: 0.0,
            status: Status::Loading { progress: 0.0 },
            file_size: meta.len(),
            keep_on_rotate: options.keep_on_rotate,
            frozen: false,
            pending_bytes: 0,
            frozen_stale: false,
            dirty: true,
        };
        let (wake, wake_rx): (Sender<()>, Receiver<()>) = channel();
        let shared = Arc::new(Shared {
            data: RwLock::new(data),
            job_generation: AtomicU64::new(0),
            view_counter: AtomicU64::new(0),
            find_generation: AtomicU64::new(0),
            shutdown: AtomicBool::new(false),
            wake,
            sink,
        });
        let mut tailer = Tailer::new(Arc::clone(&shared), path.clone(), file)
            .map_err(|e| AppError::from_io(&e, &path))?;
        tailer
            .read_first_block()
            .map_err(|e| AppError::from_io(&e, &path))?;
        let watcher = crate::tail::watch_parent(&path, shared.wake.clone());
        let worker = thread::Builder::new()
            .name(format!("tail-{id}"))
            .spawn(move || tailer.run(wake_rx))
            .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
        Ok(Self {
            id,
            path,
            shared,
            worker: Mutex::new(Some(worker)),
            _watcher: watcher,
        })
    }

    pub fn info(&self) -> SessionInfo {
        let data = self.shared.data.read();
        SessionInfo {
            session_id: self.id,
            path: self.path.display().to_string(),
            file_name: self
                .path
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
            suggested_profile_id: data
                .suggested_profile
                .clone()
                .unwrap_or_else(|| data.profile_id.clone()),
            update: data.update(),
        }
    }

    pub fn stats(&self) -> SessionUpdate {
        self.shared.data.read().update()
    }

    pub fn set_keep_on_rotate(&self, keep: bool) {
        self.shared.data.write().keep_on_rotate = keep;
    }

    /// Stops or resumes reading the file. Resuming picks up everything written in between.
    pub fn set_frozen(&self, frozen: bool) {
        {
            let mut data = self.shared.data.write();
            if data.frozen == frozen {
                return;
            }
            data.frozen = frozen;
            data.pending_bytes = 0;
            data.frozen_stale = false;
            data.dirty = true;
        }
        self.shared.wake();
    }

    /// Lines of a view. `filtered = false` addresses all lines of the file.
    pub fn get_lines(&self, filtered: bool, start: usize, count: usize) -> AppResult<Vec<LogLine>> {
        let count = count.min(MAX_GET_LINES);
        let (lines, segments, matcher, format) = {
            let data = self.shared.data.read();
            let total = data.index.len();
            let mut lines = Vec::with_capacity(count);
            for position in start..start.saturating_add(count) {
                let line = if filtered {
                    data.filter.line_at(position, total)
                } else {
                    (position < total).then_some(position as u32)
                };
                let Some(line) = line else { break };
                lines.push((line, data.index.entries[line as usize]));
            }
            (
                lines,
                data.segments.clone(),
                data.filter.spec.matcher.clone(),
                Arc::clone(&data.format),
            )
        };
        let parser = &format.parser;
        let mut reader = LineReader::new(segments, VIEW_BLOCK);
        let mut out = Vec::with_capacity(lines.len());
        for (line, entry) in lines {
            let (raw, encoding) = reader
                .raw(&entry, MAX_DISPLAY_BYTES)
                .map_err(|e| AppError::from_io(&e, &self.path))?;
            let text = display_text(raw, encoding).into_owned();
            let matches = matcher
                .as_ref()
                .map_or_else(Vec::new, |m| m.match_ranges(&text));
            let truncated = entry.len as usize > MAX_DISPLAY_BYTES;
            // A continuation (stack trace) is no entry of its own: all of it is the message.
            let fields = if entry.is_continuation() {
                parser.whole_line(&text)
            } else {
                parser.parse(&text, truncated)
            };
            out.push(LogLine {
                line,
                level: entry.level(),
                text,
                is_continuation: entry.is_continuation(),
                truncated,
                matches,
                fields,
            });
        }
        Ok(out)
    }

    /// Applies a new filter. An unrestricted one is immediate, anything else runs in the
    /// background and a newer call cancels it.
    pub fn set_filter(
        &self,
        levels: &[Level],
        query: &SearchQuery,
        mode: SearchMode,
    ) -> AppResult<FilterInfo> {
        let matcher = if query.text.is_empty() {
            None
        } else {
            Some(Arc::new(TextMatcher::new(query)?))
        };
        let spec = FilterSpec {
            levels: LevelMask::from_levels(levels),
            matcher,
            mode,
        };
        self.shared.data.write().requested_spec = spec;
        Ok(self.start_job())
    }

    /// The columns of the current format.
    pub fn columns(&self) -> ColumnSet {
        let data = self.shared.data.read();
        ColumnSet {
            revision: data.columns_revision,
            confidence: data.format.confidence,
            profile_id: data.format.profile_id.clone(),
            inferred_layout: data.format.inferred_layout.clone(),
            columns: data.format.parser.columns().to_vec(),
        }
    }

    /// A chosen profile wins over the suggestion, for the levels and for the layout. The new
    /// columns apply when the levels are recomputed, together with a new view generation.
    pub fn set_profile(&self, profile: &Profile) -> AppResult<FilterInfo> {
        let detector = Arc::new(profile.detector()?);
        let sample = Arc::clone(&self.shared.data.read().sample);
        let refs: Vec<&str> = sample.iter().map(String::as_str).collect();
        let format = Arc::new(fields::format_for(profile, &refs)?);
        {
            let mut data = self.shared.data.write();
            data.detector = detector;
            data.profile_id = profile.id.clone();
            data.chosen_profile = Some(profile.clone());
            data.requested_format = Some(format);
            data.profile_auto = false;
            data.relevel_needed = true;
            data.dirty = true;
        }
        Ok(self.start_job())
    }

    fn start_job(&self) -> FilterInfo {
        let generation = self.shared.job_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let view = self.shared.next_view_generation();
        let mut data = self.shared.data.write();
        data.dirty = true;
        if !data.relevel_needed && data.requested_spec.is_identity() {
            let total = data.index.len();
            let spec = data.requested_spec.clone();
            data.filter = FilteredLines::identity(spec, total);
            data.finish_view(view);
            data.filter_pending = false;
            data.filter_progress = 1.0;
            let info = FilterInfo {
                view_generation: view,
                pending: false,
                filtered_lines: total as u64,
            };
            drop(data);
            self.shared.wake();
            return info;
        }
        data.filter_pending = true;
        data.filter_progress = 0.0;
        let info = FilterInfo {
            view_generation: view,
            pending: true,
            filtered_lines: data.filter.len(data.index.len()) as u64,
        };
        drop(data);
        let shared = Arc::clone(&self.shared);
        let job = move || run_job(&shared, generation, view);
        if thread::Builder::new()
            .name("filter-job".into())
            .spawn(job)
            .is_err()
        {
            let mut data = self.shared.data.write();
            data.filter_pending = false;
            data.status = Status::Error {
                message: "cannot start the filter thread".into(),
            };
        }
        info
    }

    /// Next or previous line with a match in the current view, wrapping around once.
    pub fn find(
        &self,
        from_line: Option<u32>,
        query: &SearchQuery,
        forward: bool,
    ) -> AppResult<Option<FindHit>> {
        if query.text.is_empty() {
            return Ok(None);
        }
        let matcher = TextMatcher::new(query)?;
        let token = self.shared.find_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (len, start) = {
            let data = self.shared.data.read();
            let total = data.index.len();
            let len = data.filter.len(total);
            let start = match from_line {
                Some(line) => data.filter.position_of(line, total),
                None if forward => 0,
                None => len,
            };
            (len, start)
        };
        // `start` itself counts only in the wrapped part when coming from a current line.
        let first_from = if from_line.is_some() && forward {
            start.saturating_add(1)
        } else {
            start
        };
        let parts = if forward {
            [
                (first_from.min(len), len, false),
                (0, first_from.min(len), true),
            ]
        } else {
            [(0, start.min(len), false), (start.min(len), len, true)]
        };
        for (from, to, wrapped) in parts {
            if let Some(hit) = self.scan(&matcher, from, to, forward, wrapped, token)? {
                return Ok(Some(hit));
            }
        }
        Ok(None)
    }

    fn scan(
        &self,
        matcher: &TextMatcher,
        from: usize,
        to: usize,
        forward: bool,
        wrapped: bool,
        token: u64,
    ) -> AppResult<Option<FindHit>> {
        let segments = self.shared.data.read().segments.clone();
        let mut reader = LineReader::new(segments, SCAN_BLOCK);
        if !forward {
            reader = reader.backward();
        }
        let mut remaining = from..to;
        while !remaining.is_empty() {
            if self.shared.find_generation.load(Ordering::SeqCst) != token
                || self.shared.shutdown.load(Ordering::SeqCst)
            {
                return Ok(None);
            }
            let step = remaining.len().min(JOB_BATCH);
            let batch = if forward {
                let batch = remaining.start..remaining.start + step;
                remaining.start += step;
                batch
            } else {
                let batch = remaining.end - step..remaining.end;
                remaining.end -= step;
                batch
            };
            let lines = {
                let data = self.shared.data.read();
                let total = data.index.len();
                batch
                    .clone()
                    .filter_map(|p| {
                        let line = data.filter.line_at(p, total)?;
                        Some((p, line, data.index.entries[line as usize]))
                    })
                    .collect::<Vec<_>>()
            };
            let check = |reader: &mut LineReader, p: usize, line: u32, entry: &LineEntry| {
                let (raw, encoding) = reader
                    .raw(entry, MAX_SEARCH_BYTES)
                    .map_err(|e| AppError::from_io(&e, &self.path))?;
                let hit = matcher.is_match(&display_text(raw, encoding));
                Ok::<_, AppError>(hit.then_some(FindHit {
                    line,
                    position: p as u32,
                    wrapped,
                }))
            };
            if forward {
                for (p, line, entry) in &lines {
                    if let Some(hit) = check(&mut reader, *p, *line, entry)? {
                        return Ok(Some(hit));
                    }
                }
            } else {
                for (p, line, entry) in lines.iter().rev() {
                    if let Some(hit) = check(&mut reader, *p, *line, entry)? {
                        return Ok(Some(hit));
                    }
                }
            }
        }
        Ok(None)
    }

    /// Position of a line in the filtered view (or of the next visible line after it).
    pub fn position_of_line(&self, line: u32) -> u32 {
        let data = self.shared.data.read();
        data.filter.position_of(line, data.index.len()) as u32
    }

    /// First and last line of the entry (head + continuations) a line belongs to.
    pub fn entry_range(&self, line: u32) -> EntryRange {
        let data = self.shared.data.read();
        let (first, last) = range_of(&data.index.entries, line as usize);
        EntryRange {
            first: first as u32,
            last: last as u32,
        }
    }

    /// The whole entry of a line straight from the index (no filter), for the detail panel. The
    /// text stops after `MAX_DETAIL_BYTES` at a character boundary; a file that shrank meanwhile
    /// gives shorter text, which is no error.
    pub fn get_entry(&self, line: u32) -> AppResult<EntryDetail> {
        let (first, lines, segments) = {
            let data = self.shared.data.read();
            let entries = &data.index.entries;
            if entries.is_empty() {
                return Err(AppError::new(ErrorCode::NotFound, "the log has no lines"));
            }
            let (first, last) = range_of(entries, line as usize);
            (first, entries[first..=last].to_vec(), data.segments.clone())
        };
        let mut reader = LineReader::new(segments, SCAN_BLOCK);
        let mut text = String::new();
        let mut truncated = false;
        for (i, entry) in lines.iter().enumerate() {
            if i > 0 {
                if text.len() >= MAX_DETAIL_BYTES {
                    truncated = true;
                    break;
                }
                text.push('\n');
            }
            let room = MAX_DETAIL_BYTES - text.len();
            // Two raw bytes give at least one byte of text in every encoding, a few more cover the
            // last character.
            let limit = room.saturating_mul(2).saturating_add(4).min(MAX_LINE_COPY);
            let (raw, encoding) = reader
                .raw(entry, limit)
                .map_err(|e| AppError::from_io(&e, &self.path))?;
            let cut = raw.len() < entry.len as usize && raw.len() == limit;
            let decoded = display_text(raw, encoding);
            if decoded.len() > room {
                text.push_str(&decoded[..floor_char_boundary(&decoded, room)]);
                truncated = true;
                break;
            }
            text.push_str(&decoded);
            if cut {
                // Fewer characters than bytes (ANSI removed): the line still went on.
                truncated = true;
                break;
            }
        }
        let first_entry = lines[0];
        Ok(EntryDetail {
            first: first as u32,
            last: (first + lines.len() - 1) as u32,
            level: first_entry.level(),
            line_count: lines.len() as u32,
            total_bytes: lines.iter().map(|e| u64::from(e.len)).sum(),
            text,
            truncated,
        })
    }

    /// The visible lines between two line numbers as text, for the clipboard.
    pub fn copy_lines(&self, first: u32, last: u32) -> AppResult<String> {
        self.copy(true, first, last)
    }

    /// All lines between two line numbers, whatever the filter hides (an entry of the detail panel).
    pub fn copy_all_lines(&self, first: u32, last: u32) -> AppResult<String> {
        self.copy(false, first, last)
    }

    fn copy(&self, filtered: bool, first: u32, last: u32) -> AppResult<String> {
        let (lines, segments) = {
            let data = self.shared.data.read();
            let total = data.index.len();
            let (from, to) = if filtered {
                let from = data.filter.position_of(first, total);
                let to = data
                    .filter
                    .position_of(last.saturating_add(1), total)
                    .min(data.filter.len(total));
                (from, to)
            } else {
                let to = (last as usize).saturating_add(1).min(total);
                ((first as usize).min(to), to)
            };
            if to.saturating_sub(from) > MAX_COPY_LINES {
                return Err(AppError::new(
                    ErrorCode::TooLarge,
                    format!("more than {MAX_COPY_LINES} lines selected"),
                ));
            }
            let lines = if filtered {
                (from..to)
                    .filter_map(|p| data.filter.line_at(p, total))
                    .map(|line| data.index.entries[line as usize])
                    .collect::<Vec<_>>()
            } else {
                data.index.entries[from..to].to_vec()
            };
            (lines, data.segments.clone())
        };
        let mut reader = LineReader::new(segments, SCAN_BLOCK);
        let mut text = String::new();
        for entry in &lines {
            let (raw, encoding) = reader
                .raw(entry, MAX_LINE_COPY)
                .map_err(|e| AppError::from_io(&e, &self.path))?;
            text.push_str(&display_text(raw, encoding));
            text.push('\n');
            if text.len() > MAX_COPY_BYTES {
                return Err(AppError::new(
                    ErrorCode::TooLarge,
                    "the selection is too large to copy",
                ));
            }
        }
        Ok(text)
    }
}

const MAX_LINE_COPY: usize = crate::indexer::MAX_LINE_BYTES;
/// Text of an entry in the detail panel; copying is not limited by it.
pub const MAX_DETAIL_BYTES: usize = 1024 * 1024;

/// First and last index of the entry a line belongs to, at most `MAX_ENTRY_WALK` lines each way.
/// `entries` must not be empty.
fn range_of(entries: &[LineEntry], line: usize) -> (usize, usize) {
    let line = line.min(entries.len().saturating_sub(1));
    let mut first = line;
    let lower = line.saturating_sub(MAX_ENTRY_WALK);
    while first > lower && entries.get(first).is_some_and(LineEntry::is_continuation) {
        first -= 1;
    }
    let mut last = line;
    let upper = (line + MAX_ENTRY_WALK).min(entries.len());
    while last + 1 < upper && entries[last + 1].is_continuation() {
        last += 1;
    }
    (first, last)
}

/// The largest index at or below `index` that starts a character.
fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

impl Drop for LogSession {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        // Stops a running job at its next check.
        self.shared.job_generation.fetch_add(1, Ordering::SeqCst);
        self.shared.wake();
        if let Some(worker) = self.worker.lock().take() {
            let _ = worker.join();
        }
    }
}

/// Plain bytes of a line for the level detection: decoded for UTF-16, without ANSI colours.
pub fn detection_bytes<'a>(raw: &'a [u8], encoding: Encoding) -> Cow<'a, [u8]> {
    match encoding {
        Encoding::Utf8 | Encoding::Latin1 if memchr(0x1b, raw).is_none() => Cow::Borrowed(raw),
        Encoding::Utf8 | Encoding::Latin1 => {
            let text = String::from_utf8_lossy(raw);
            Cow::Owned(strip_ansi(&text).into_owned().into_bytes())
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            Cow::Owned(display_text(raw, encoding).into_owned().into_bytes())
        }
    }
}

fn is_current(shared: &Shared, generation: u64) -> bool {
    shared.job_generation.load(Ordering::SeqCst) == generation
}

fn run_job(shared: &Shared, generation: u64, view: u64) {
    let relevel = shared.data.read().relevel_needed;
    if relevel && !run_relevel(shared, generation) {
        return;
    }
    run_filter(shared, generation, view);
}

/// Detects the levels of all lines again after a profile change. Lines arriving meanwhile already
/// use the new detector. Returns false if cancelled.
fn run_relevel(shared: &Shared, generation: u64) -> bool {
    let (detector, segments, epoch) = {
        let data = shared.data.read();
        (
            Arc::clone(&data.detector),
            data.segments.clone(),
            data.epoch,
        )
    };
    let mut reader = LineReader::new(segments, SCAN_BLOCK);
    let mut prev = PrevLine::default();
    let mut position = 0usize;
    loop {
        if !is_current(shared, generation) {
            return false;
        }
        let batch = {
            let data = shared.data.read();
            if data.epoch != epoch {
                // Everything is being read again, with the new detector.
                Vec::new()
            } else {
                let end = (position + JOB_BATCH).min(data.index.len());
                data.index.entries[position..end].to_vec()
            }
        };
        if batch.is_empty() {
            let mut data = shared.data.write();
            if data.epoch == epoch {
                data.prev = prev;
            }
            data.relevel_needed = false;
            return true;
        }
        let mut updated = Vec::with_capacity(batch.len());
        for entry in &batch {
            let Ok((raw, encoding)) = reader.raw(entry, MAX_LINE_COPY) else {
                updated.push(*entry);
                continue;
            };
            let text = detection_bytes(raw, encoding);
            let (level, continuation) = detector.classify(&text, &mut prev);
            updated.push(LineEntry::new(entry.offset, entry.len, level, continuation));
        }
        let mut data = shared.data.write();
        if data.epoch == epoch {
            for (i, entry) in updated.into_iter().enumerate() {
                data.index.replace(position + i, entry);
            }
            data.dirty = true;
        }
        drop(data);
        position += batch.len();
        shared.wake();
    }
}

/// Builds the filtered list for the requested spec without holding up the reader or the tail, and
/// swaps it in at the end.
fn run_filter(shared: &Shared, generation: u64, view: u64) {
    'restart: loop {
        let (spec, epoch, segments) = {
            let data = shared.data.read();
            (
                data.requested_spec.clone(),
                data.epoch,
                data.segments.clone(),
            )
        };
        let needs_text = spec.needs_text();
        let matcher = spec.filtering_matcher().cloned();
        let mut builder = FilteredLines::new(spec);
        let mut reader = LineReader::new(segments, SCAN_BLOCK);
        let mut position = 0usize;
        loop {
            if !is_current(shared, generation) {
                return;
            }
            let (batch, total) = {
                let data = shared.data.read();
                if data.epoch != epoch {
                    continue 'restart;
                }
                let total = data.index.len();
                if total - position <= JOB_FINAL_LINES {
                    break;
                }
                let end = (position + JOB_BATCH).min(total);
                (data.index.entries[position..end].to_vec(), total)
            };
            for entry in &batch {
                feed(
                    &mut builder,
                    entry,
                    &mut reader,
                    matcher.as_deref(),
                    needs_text,
                );
            }
            position += batch.len();
            {
                let mut data = shared.data.write();
                data.filter_progress = position as f32 / total.max(1) as f32;
                data.dirty = true;
            }
            shared.wake();
        }
        let mut data = shared.data.write();
        if !is_current(shared, generation) {
            return;
        }
        if data.epoch != epoch {
            drop(data);
            continue 'restart;
        }
        // The last few lines are read under the lock, so no line can slip between list and tail.
        let segments = data.segments.clone();
        let mut reader = LineReader::new(segments, SCAN_BLOCK);
        let total = data.index.len();
        let before_provisional = total - usize::from(data.provisional.is_some());
        for line in position..before_provisional {
            let entry = data.index.entries[line];
            feed(
                &mut builder,
                &entry,
                &mut reader,
                matcher.as_deref(),
                needs_text,
            );
        }
        if let Some(provisional) = &mut data.provisional {
            provisional.checkpoint = builder.checkpoint();
        }
        for line in before_provisional..total {
            let entry = data.index.entries[line];
            feed(
                &mut builder,
                &entry,
                &mut reader,
                matcher.as_deref(),
                needs_text,
            );
        }
        data.filter = builder;
        data.finish_view(view);
        data.filter_pending = false;
        data.filter_progress = 1.0;
        data.dirty = true;
        drop(data);
        shared.wake();
        return;
    }
}

fn feed(
    builder: &mut FilteredLines,
    entry: &LineEntry,
    reader: &mut LineReader,
    matcher: Option<&TextMatcher>,
    needs_text: bool,
) {
    builder.append(entry.level(), entry.is_continuation(), || {
        if !needs_text {
            return true;
        }
        let Some(matcher) = matcher else { return true };
        reader
            .raw(entry, MAX_SEARCH_BYTES)
            .is_ok_and(|(raw, encoding)| matcher.is_match(&display_text(raw, encoding)))
    });
}

/// The open sessions and the profiles they can use (Tauri state).
pub struct SessionManager {
    sessions: RwLock<HashMap<u64, Arc<LogSession>>>,
    next_id: AtomicU64,
    profiles: RwLock<ProfileRegistry>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            profiles: RwLock::new(ProfileRegistry::default()),
        }
    }
}

impl SessionManager {
    pub fn open(
        &self,
        path: &Path,
        options: OpenOptions,
        sink: UpdateSink,
    ) -> AppResult<SessionInfo> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let default_profile = self.profiles.read().find(crate::profile::GENERIC_PROFILE)?;
        let session = LogSession::open(id, path, options, &default_profile, sink)?;
        let info = session.info();
        self.sessions.write().insert(id, Arc::new(session));
        Ok(info)
    }

    pub fn close(&self, id: u64) -> AppResult<()> {
        let session = self.sessions.write().remove(&id);
        session
            .map(drop)
            .ok_or_else(|| AppError::unknown_session(id))
    }

    pub fn session(&self, id: u64) -> AppResult<Arc<LogSession>> {
        self.sessions
            .read()
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::unknown_session(id))
    }

    pub fn profiles(&self) -> Vec<Profile> {
        self.profiles.read().list()
    }

    pub fn profile(&self, id: &str) -> AppResult<Profile> {
        self.profiles.read().find(id)
    }

    pub fn set_custom_profiles(&self, profiles: Vec<Profile>) -> AppResult<()> {
        self.profiles.write().set_custom(profiles)
    }
}
