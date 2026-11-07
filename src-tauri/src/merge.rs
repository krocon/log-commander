//! Several files as one session (prompt 006): their entries in time order, live.
//!
//! - Every source has its own address space in the virtual offsets (`source << 56`, see
//!   `indexer.rs`), so the 16 bytes per line stay and the source of a line costs nothing.
//! - [`Merger`] is the pure part: lines in, entries (head + continuations) out in the order
//!   `(time, source, position in the file)`. New lines are only ever appended.
//! - [`MergeWorker`] follows the files (rotation, truncation, missing file, freeze) and writes what
//!   the merger releases into the index and the filter of the session.
//!
//! Loading streams all sources at once: the source that lags behind in time is read next, and an
//! entry is released once every unfinished source has seen a later time. A source whose entries are
//! not in order is noticed when one of them would come too late; then the merge starts over with
//! that source read completely and sorted first. Live, new entries wait up to [`HOLD_BACK`].

use crate::encoding::Encoding;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::fields::{self, MAX_PARSE_BYTES};
use crate::filter::{Probe, TextTest};
use crate::indexer::{
    insert_segment, read_at, source_base, LineEntry, LineReader, LineSplitter, Segment,
    MAX_SEARCH_BYTES, MAX_SOURCES,
};
use crate::level::{LevelDetector, PrevLine};
use crate::model::{SourceInfo, SourceUpdate, Status};
use crate::platform::{file_id, open_file_id, open_shared, FileId};
use crate::profile::{Profile, ProfileRegistry};
use crate::session::{detection_bytes, SessionData, Shared};
use crate::tail::{
    suggest, Sample, ACTIVE_FOR, ACTIVE_POLL_INTERVAL, BLOCK_SIZE, EMIT_INTERVAL, MAX_SEGMENTS,
    MIN_TICK, PARTIAL_COMMIT_AFTER, POLL_INTERVAL, SAMPLE_LINES,
};
use crate::timestamp::TimestampParser;
use std::collections::VecDeque;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// New entries of a live merge wait this long for the other sources to catch up.
pub const HOLD_BACK: Duration = Duration::from_secs(1);
/// Bytes at the start of a line where its time is looked for (JSON lines: up to the parse limit).
const TIME_PREFIX: usize = 512;
/// Lines written under one acquisition of the write lock.
const WRITE_BATCH: usize = 16 * 1024;

// ------------------------------------------------------------------------------------------------
// The pure merge
// ------------------------------------------------------------------------------------------------

/// A line on its way into the index; `probe` was computed with the filter's text test numbered
/// `matcher`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MergedLine {
    pub entry: LineEntry,
    pub probe: Probe,
    pub matcher: u32,
}

#[derive(Debug)]
struct Pending {
    time: i64,
    seq: u64,
    arrived: Instant,
    /// The rest of an entry that was already released when it went on (live only).
    orphan: bool,
    head: MergedLine,
    rest: Vec<MergedLine>,
}

impl Pending {
    fn len(&self) -> usize {
        1 + self.rest.len()
    }
}

/// What the merger knows of one source.
#[derive(Debug)]
struct SourceParse {
    detector: Arc<LevelDetector>,
    prev: PrevLine,
    parser: TimestampParser,
    /// Time of the first timestamp in the sample: entries before it start the file there.
    first_time: Option<i64>,
    /// Time of the previous entry; an entry without a time stays with it.
    last_time: Option<i64>,
    max_seen: Option<i64>,
    seq: u64,
    /// The entry a continuation line belongs to (it may be released already).
    open: Option<u64>,
    queue: VecDeque<Pending>,
    /// Loading: everything of the source is read.
    done: bool,
    last_data: Option<Instant>,
    lines: u64,
    late: u64,
}

/// Result of feeding a line in strict mode (loading).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fed {
    Ok,
    /// The source is not in time order: an entry would have to go before released ones.
    OutOfOrder,
}

/// Up to where `release` goes.
#[derive(Debug, Clone, Copy)]
pub enum Until {
    /// Loading: what no unfinished source can undercut any more.
    Settled,
    /// Live: the watermark of the active sources, or what waited `HOLD_BACK`.
    Live(Instant),
    /// Everything.
    All,
}

/// Mixes the entries of several sources by `(time, source, position)`; pure, no files.
#[derive(Debug)]
pub struct Merger {
    sources: Vec<SourceParse>,
    /// Loading: an entry that would come too late is reported instead of queued.
    strict: bool,
    last_released: Option<i64>,
    /// Source of the last line handed out: a late continuation may still join its entry.
    last_source: Option<usize>,
}

impl Merger {
    /// `parsers[i]` and `first_times[i]` belong to source `i`.
    pub fn new(
        detectors: Vec<Arc<LevelDetector>>,
        parsers: Vec<TimestampParser>,
        first_times: Vec<Option<i64>>,
    ) -> Self {
        let sources = detectors
            .into_iter()
            .zip(parsers)
            .zip(first_times)
            .map(|((detector, parser), first_time)| SourceParse {
                detector,
                prev: PrevLine::default(),
                parser,
                first_time,
                last_time: None,
                max_seen: None,
                seq: 0,
                open: None,
                queue: VecDeque::new(),
                done: false,
                last_data: None,
                lines: 0,
                late: 0,
            })
            .collect();
        Self {
            sources,
            strict: true,
            last_released: None,
            last_source: None,
        }
    }

    pub fn set_strict(&mut self, strict: bool) {
        self.strict = strict;
    }

    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    pub fn lines(&self, source: usize) -> u64 {
        self.sources[source].lines
    }

    pub fn late(&self, source: usize) -> u64 {
        self.sources[source].late
    }

    pub fn max_seen(&self, source: usize) -> Option<i64> {
        self.sources[source].max_seen
    }

    pub fn set_done(&mut self, source: usize, done: bool) {
        self.sources[source].done = done;
    }

    pub fn is_done(&self, source: usize) -> bool {
        self.sources[source].done
    }

    /// Lines waiting in the hold-back buffer.
    pub fn waiting(&self) -> usize {
        self.sources
            .iter()
            .flat_map(|s| s.queue.iter())
            .map(Pending::len)
            .sum()
    }

    /// Takes the next line of a source. `text` is the plain text for the level detection and the
    /// time (decoded, without ANSI); `offset` and `len` locate the raw line.
    #[allow(clippy::too_many_arguments)]
    pub fn line(
        &mut self,
        source: usize,
        offset: u64,
        len: u32,
        text: &[u8],
        probe: Probe,
        matcher: u32,
        now: Instant,
    ) -> Fed {
        let last_released = self.last_released;
        let strict = self.strict;
        let s = &mut self.sources[source];
        s.last_data = Some(now);
        let (level, continuation) = s.detector.classify(text, &mut s.prev);
        let line = MergedLine {
            entry: LineEntry::new(offset, len, level, continuation),
            probe,
            matcher,
        };
        if continuation {
            if let Some(open) = s.open {
                // Usually the last one; an entry out of order sits further front.
                if let Some(pending) = s.queue.iter_mut().rev().find(|p| p.seq == open) {
                    pending.rest.push(line);
                    return Fed::Ok;
                }
                if strict {
                    return Fed::OutOfOrder;
                }
                s.seq += 1;
                s.open = Some(s.seq);
                s.queue.push_front(Pending {
                    time: i64::MIN,
                    seq: s.seq,
                    arrived: now,
                    orphan: true,
                    head: line,
                    rest: Vec::new(),
                });
                return Fed::Ok;
            }
        }
        let line = MergedLine {
            entry: line.entry.as_head(),
            ..line
        };
        let time = match time_of(&mut s.parser, text) {
            Some(time) => {
                s.last_time = Some(time);
                time
            }
            None => s.last_time.or(s.first_time).or(last_released).unwrap_or(0),
        };
        if strict && last_released.is_some_and(|released| time < released) {
            return Fed::OutOfOrder;
        }
        s.max_seen = Some(s.max_seen.map_or(time, |m| m.max(time)));
        s.seq += 1;
        s.open = Some(s.seq);
        let pending = Pending {
            time,
            seq: s.seq,
            arrived: now,
            orphan: false,
            head: line,
            rest: Vec::new(),
        };
        // Sorted by (time, seq): new entries usually belong at the end.
        let at = s
            .queue
            .iter()
            .rposition(|p| p.time <= time)
            .map_or(0, |i| i + 1);
        s.queue.insert(at, pending);
        Fed::Ok
    }

    /// Hands out released lines in merge order, at most about `max` of them (whole entries).
    /// Returns whether more could be released.
    pub fn release(&mut self, until: Until, out: &mut Vec<MergedLine>, max: usize) -> bool {
        let cut = self.cut(until);
        loop {
            if out.len() >= max {
                return true;
            }
            let mut best: Option<(i64, usize)> = None;
            for (i, s) in self.sources.iter().enumerate() {
                if let Some(head) = s.queue.front() {
                    if best.is_none_or(|(t, _)| head.time < t) {
                        best = Some((head.time, i));
                    }
                }
            }
            let Some((time, source)) = best else {
                return false;
            };
            if cut.is_some_and(|cut| time > cut) {
                return false;
            }
            let pending = self.sources[source]
                .queue
                .pop_front()
                .expect("a head was found");
            self.emit(source, pending, out);
        }
    }

    fn emit(&mut self, source: usize, pending: Pending, out: &mut Vec<MergedLine>) {
        let count = pending.len() as u64;
        let s = &mut self.sources[source];
        let mut head = pending.head;
        if pending.orphan {
            // Joins its entry only if nothing of another source came in between.
            if self.last_source != Some(source) {
                head.entry = head.entry.as_head();
                s.late += count;
            }
        } else {
            if self
                .last_released
                .is_some_and(|released| pending.time < released)
            {
                s.late += count;
            }
            self.last_released = Some(
                self.last_released
                    .map_or(pending.time, |r| r.max(pending.time)),
            );
        }
        s.lines += count;
        self.last_source = Some(source);
        out.push(head);
        out.extend(pending.rest);
    }

    /// The latest time that may be released now; `None` means everything.
    fn cut(&self, until: Until) -> Option<i64> {
        match until {
            Until::All => None,
            Until::Settled => {
                // Strictly below what every unfinished source has seen: it cannot go back.
                let mut cut = i64::MAX;
                for s in self.sources.iter().filter(|s| !s.done) {
                    match s.max_seen {
                        Some(seen) => cut = cut.min(seen.saturating_sub(1)),
                        None => return Some(i64::MIN),
                    }
                }
                (cut != i64::MAX).then_some(cut)
            }
            Until::Live(now) => {
                let active = |s: &&SourceParse| {
                    s.last_data
                        .is_some_and(|at| now.saturating_duration_since(at) < HOLD_BACK)
                };
                let watermark = self
                    .sources
                    .iter()
                    .filter(active)
                    .filter_map(|s| s.max_seen)
                    .min();
                let mut cut = watermark?;
                // No entry waits longer than HOLD_BACK: it takes everything before it along.
                for s in &self.sources {
                    for p in &s.queue {
                        if now.saturating_duration_since(p.arrived) >= HOLD_BACK {
                            cut = cut.max(p.time);
                        }
                    }
                }
                Some(cut)
            }
        }
    }

    /// Changes the matcher number of every waiting line, after the worker checked them again.
    pub fn rematch(&mut self, mut check: impl FnMut(&LineEntry) -> Probe, matcher: u32) {
        for s in &mut self.sources {
            for p in &mut s.queue {
                for line in std::iter::once(&mut p.head).chain(p.rest.iter_mut()) {
                    line.probe = check(&line.entry);
                    line.matcher = matcher;
                }
            }
        }
    }

    /// Starts over (a new merge of everything): parsers fresh, nothing waiting, nothing released.
    pub fn reset(&mut self, parsers: Vec<TimestampParser>) {
        for (s, parser) in self.sources.iter_mut().zip(parsers) {
            s.prev = PrevLine::default();
            s.parser = parser;
            s.last_time = None;
            s.max_seen = None;
            s.seq = 0;
            s.open = None;
            s.queue.clear();
            s.done = false;
            s.last_data = None;
            s.lines = 0;
            s.late = 0;
        }
        self.strict = true;
        self.last_released = None;
        self.last_source = None;
    }

    /// Sorts what a source has queued (all of it, for a source read completely).
    pub fn sort_source(&mut self, source: usize) {
        let queue = &mut self.sources[source].queue;
        queue.make_contiguous().sort_by_key(|p| (p.time, p.seq));
    }
}

/// The time of a line, `None` without one. Looks at the start of the line only, except for JSON.
pub fn time_of(parser: &mut TimestampParser, text: &[u8]) -> Option<i64> {
    let json = text
        .iter()
        .find(|b| !b.is_ascii_whitespace())
        .is_some_and(|b| *b == b'{');
    let cut = text
        .len()
        .min(if json { MAX_PARSE_BYTES } else { TIME_PREFIX });
    let slice = &text[..cut];
    let line = match std::str::from_utf8(slice) {
        Ok(line) => line,
        Err(err) => std::str::from_utf8(&slice[..err.valid_up_to()]).unwrap_or(""),
    };
    parser.parse(line)
}

// ------------------------------------------------------------------------------------------------
// Opening
// ------------------------------------------------------------------------------------------------

/// A file to merge; without a profile the suggestion for its first lines applies.
#[derive(Debug, Clone)]
pub struct MergeSource {
    pub path: PathBuf,
    pub profile: Option<Profile>,
}

/// What the merge dialog shows of a file: profile suggestion, encoding, first and last time.
pub fn inspect(path: &Path) -> AppResult<crate::model::MergeCandidate> {
    let path = std::path::absolute(path).map_err(|e| AppError::from_io(&e, path))?;
    let meta = std::fs::metadata(&path).map_err(|e| AppError::from_io(&e, &path))?;
    if meta.is_dir() {
        return Err(AppError::new(
            ErrorCode::IsADirectory,
            format!("{} is a folder", path.display()),
        ));
    }
    let file = open_shared(&path).map_err(|e| AppError::from_io(&e, &path))?;
    let reference = meta.modified().unwrap_or_else(|_| SystemTime::now());
    let mut buf = vec![0; BLOCK_SIZE];
    let n = read_full(&file, &mut buf, 0).map_err(|e| AppError::from_io(&e, &path))?;
    let sample = Sample::of(&buf[..n]);
    let refs: Vec<&str> = sample.texts.iter().map(String::as_str).collect();
    let registry = ProfileRegistry::default();
    let (suggestion, _) = suggest(&sample.plain, &refs, &registry);
    let mut parser = TimestampParser::detect(refs.iter().copied(), reference);
    let first_time = sample
        .plain
        .iter()
        .find_map(|line| time_of(&mut parser, line));
    // The last time: the last lines of the file, read backwards from its end.
    let size = meta.len();
    let tail_len = (64 * 1024).min(size) as usize;
    let mut last_time = None;
    if tail_len > 0 && first_time.is_some() {
        let mut tail = vec![0; tail_len];
        let n = read_full(&file, &mut tail, size - tail_len as u64)
            .map_err(|e| AppError::from_io(&e, &path))?;
        let tail = &tail[..n];
        // Starting in the middle of a UTF-16 file: keep the code units aligned.
        let skip = usize::from(sample.encoding.code_unit() == 2 && (size - n as u64) % 2 == 1);
        let mut splitter = LineSplitter::new(sample.encoding, 0);
        let mut lines: Vec<Vec<u8>> = Vec::new();
        splitter.feed(&tail[skip..], |_, raw| {
            lines.push(detection_bytes(raw, sample.encoding).into_owned());
        });
        if let Some((_, raw)) = splitter.take_partial() {
            lines.push(detection_bytes(&raw, sample.encoding).into_owned());
        }
        // A time-only log counts days by the order of its lines: from the start, not here.
        let mut tail_parser = TimestampParser::detect(refs.iter().copied(), reference);
        last_time = lines
            .iter()
            .rev()
            .take(SAMPLE_LINES)
            .find_map(|line| time_of(&mut tail_parser, line));
    }
    Ok(crate::model::MergeCandidate {
        path: path.display().to_string(),
        file_name: file_name_of(&path),
        suggested_profile_id: suggestion,
        encoding: sample.encoding,
        first_time,
        last_time,
        file_size: size,
    })
}

fn file_name_of(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

fn read_full(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = read_at(file, &mut buf[filled..], offset + filled as u64)?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// One physical file of a source.
struct SourceSegment {
    segment: Arc<Segment>,
    /// Length of the BOM, known once the start was read.
    bom: Option<u64>,
    /// Physical end of a file left by a rotation; the current file has none.
    end: Option<u64>,
}

/// Following the files of one source.
struct SourceFile {
    path: PathBuf,
    file_name: String,
    profile_id: String,
    reference: SystemTime,
    /// Oldest first; the last one is followed.
    segments: Vec<SourceSegment>,
    id: Option<FileId>,
    /// Segment being read and the physical position in it.
    cursor: usize,
    read_pos: u64,
    splitter: LineSplitter,
    missing: bool,
    shrunk_while_frozen: bool,
    status: Status,
    file_size: u64,
    /// When the last bytes came: a line without an end is taken after a pause.
    last_read: Instant,
    /// Read completely and sorted before merging (its entries were not in time order).
    needs_sort: bool,
}

impl SourceFile {
    fn current(&self) -> &SourceSegment {
        &self.segments[self.cursor]
    }

    fn encoding(&self) -> Encoding {
        self.current().segment.encoding
    }

    fn base(&self) -> u64 {
        self.current().segment.base
    }

    fn rewind(&mut self) {
        self.cursor = 0;
        // A known BOM is skipped; an unknown one is detected when the start is read.
        self.read_pos = self.segments[0].bom.unwrap_or(0);
        let first = &self.segments[0];
        self.splitter = LineSplitter::new(
            first.segment.encoding,
            first.segment.base + first.bom.unwrap_or(0),
        );
    }

    /// Bytes still to read, for the progress of a load.
    fn remaining(&self) -> u64 {
        let mut total = 0u64;
        for (i, seg) in self.segments.iter().enumerate().skip(self.cursor) {
            let size = seg
                .end
                .or_else(|| seg.segment.file.metadata().ok().map(|m| m.len()))
                .unwrap_or(0);
            let from = if i == self.cursor { self.read_pos } else { 0 };
            total += size.saturating_sub(from);
        }
        total
    }
}

/// Checked sources, before the session exists.
pub struct MergeWorker {
    files: Vec<SourceFile>,
    profiles: Vec<Profile>,
    samples: Vec<Sample>,
    format: Arc<fields::FormatGuess>,
    merger: Merger,
}

impl MergeWorker {
    /// Opens and checks all files: 2 to 16 distinct files, each with a time in its first lines.
    pub fn prepare(sources: Vec<MergeSource>) -> AppResult<Self> {
        if sources.len() < 2 || sources.len() > MAX_SOURCES {
            return Err(AppError::new(
                ErrorCode::InvalidMerge,
                format!(
                    "a merge takes 2 to {MAX_SOURCES} files, not {}",
                    sources.len()
                ),
            ));
        }
        let registry = ProfileRegistry::default();
        let mut files = Vec::new();
        let mut profiles = Vec::new();
        let mut samples = Vec::new();
        let mut detectors = Vec::new();
        let mut parsers = Vec::new();
        let mut first_times = Vec::new();
        let mut ids: Vec<FileId> = Vec::new();
        let mut buf = vec![0; BLOCK_SIZE];
        for (index, source) in sources.into_iter().enumerate() {
            let path = std::path::absolute(&source.path)
                .map_err(|e| AppError::from_io(&e, &source.path))?;
            let meta = std::fs::metadata(&path).map_err(|e| AppError::from_io(&e, &path))?;
            if meta.is_dir() {
                return Err(AppError {
                    path: Some(path.display().to_string()),
                    ..AppError::new(
                        ErrorCode::IsADirectory,
                        format!("{} is a folder", path.display()),
                    )
                });
            }
            let file = open_shared(&path).map_err(|e| AppError::from_io(&e, &path))?;
            let id = open_file_id(&file).map_err(|e| AppError::from_io(&e, &path))?;
            if ids.contains(&id) {
                return Err(AppError {
                    path: Some(path.display().to_string()),
                    ..AppError::new(
                        ErrorCode::InvalidMerge,
                        format!("{} is in the merge twice", path.display()),
                    )
                });
            }
            ids.push(id);
            let n = read_full(&file, &mut buf, 0).map_err(|e| AppError::from_io(&e, &path))?;
            let sample = Sample::of(&buf[..n]);
            let refs: Vec<&str> = sample.texts.iter().map(String::as_str).collect();
            let profile = match source.profile {
                Some(profile) => profile,
                None => {
                    let (suggestion, _) = suggest(&sample.plain, &refs, &registry);
                    registry.find(&suggestion)?
                }
            };
            let reference = meta.modified().unwrap_or_else(|_| SystemTime::now());
            let mut parser = TimestampParser::detect(refs.iter().copied(), reference);
            let first_time = sample
                .plain
                .iter()
                .find_map(|line| time_of(&mut parser, line));
            let has_text = sample.plain.iter().any(|l| !l.trim_ascii().is_empty());
            if first_time.is_none() && has_text {
                return Err(AppError {
                    path: Some(path.display().to_string()),
                    ..AppError::new(
                        ErrorCode::NoTimestamps,
                        format!(
                            "no timestamp in the first {SAMPLE_LINES} lines of {}",
                            file_name_of(&path)
                        ),
                    )
                });
            }
            detectors.push(Arc::new(profile.detector()?));
            parsers.push(TimestampParser::detect(refs.iter().copied(), reference));
            first_times.push(first_time);
            let encoding = sample.encoding;
            let base = source_base(index);
            files.push(SourceFile {
                file_name: file_name_of(&path),
                path,
                profile_id: profile.id.clone(),
                reference,
                segments: vec![SourceSegment {
                    segment: Arc::new(Segment {
                        base,
                        file: Arc::new(file),
                        encoding,
                    }),
                    bom: (n > 0).then_some(sample.bom as u64),
                    end: None,
                }],
                id: Some(id),
                cursor: 0,
                read_pos: sample.bom as u64,
                splitter: LineSplitter::new(encoding, base + sample.bom as u64),
                missing: false,
                shrunk_while_frozen: false,
                status: Status::Loading { progress: 0.0 },
                file_size: meta.len(),
                last_read: Instant::now(),
                needs_sort: false,
            });
            profiles.push(profile);
            samples.push(sample);
        }
        // The columns are those of the first file; lines of other formats fall back to the message.
        let refs: Vec<&str> = samples[0].texts.iter().map(String::as_str).collect();
        let (suggestion, guess) = suggest(&samples[0].plain, &refs, &registry);
        let format = if suggestion == profiles[0].id {
            guess
        } else {
            fields::format_for(&profiles[0], &refs)?
        };
        let merger = Merger::new(detectors, parsers, first_times);
        Ok(Self {
            files,
            profiles,
            samples,
            format: Arc::new(format),
            merger,
        })
    }

    pub fn first_profile(&self) -> &Profile {
        &self.profiles[0]
    }

    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.file_size).sum()
    }

    pub fn paths(&self) -> Vec<PathBuf> {
        self.files.iter().map(|f| f.path.clone()).collect()
    }

    pub fn infos(&self) -> Vec<SourceInfo> {
        self.files
            .iter()
            .enumerate()
            .map(|(i, f)| SourceInfo {
                index: i as u8,
                path: f.path.display().to_string(),
                file_name: f.file_name.clone(),
                profile_id: f.profile_id.clone(),
                encoding: f.encoding(),
            })
            .collect()
    }

    /// The session data of a fresh merge: segments, format, sources.
    pub fn init_data(&self, data: &mut SessionData) {
        data.segments = self
            .files
            .iter()
            .map(|f| Arc::clone(&f.segments[0].segment))
            .collect();
        data.encoding = self.files[0].encoding();
        data.format = Arc::clone(&self.format);
        data.sample = Arc::new(self.samples[0].texts.clone());
        data.suggested_profile = Some(self.profiles[0].id.clone());
        data.profile_auto = false;
        data.sources = self.files.iter().map(source_update_of).collect();
    }

    pub fn run(self, shared: Arc<Shared>, wake: Receiver<()>) {
        let mut runner = Runner {
            shared,
            files: self.files,
            merger: self.merger,
            loading: true,
            load_total: 0,
            test: TextTest::default(),
            matcher_id: 0,
            out: Vec::new(),
            buf: vec![0; BLOCK_SIZE],
            last_emit: None,
            last_data: Instant::now(),
        };
        runner.start_load(None);
        loop {
            let tick_start = Instant::now();
            runner.tick();
            if runner.shared.shutdown.load(Ordering::SeqCst) {
                return;
            }
            runner.wait(&wake, tick_start);
            if runner.shared.shutdown.load(Ordering::SeqCst) {
                return;
            }
        }
    }
}

fn source_update_of(file: &SourceFile) -> SourceUpdate {
    SourceUpdate {
        status: file.status.clone(),
        file_size: file.file_size,
        lines: 0,
        late_lines: 0,
    }
}

// ------------------------------------------------------------------------------------------------
// The worker
// ------------------------------------------------------------------------------------------------

/// Why everything is merged again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Remerge {
    /// "Neu sortieren", or a source turned out not to be in time order.
    Resort,
    Truncated,
    Rotated,
}

struct Runner {
    shared: Arc<Shared>,
    files: Vec<SourceFile>,
    merger: Merger,
    loading: bool,
    /// Bytes the current load has to read.
    load_total: u64,
    /// The filter's text test the lines are checked with, and its number.
    test: TextTest,
    matcher_id: u32,
    out: Vec<MergedLine>,
    buf: Vec<u8>,
    last_emit: Option<Instant>,
    last_data: Instant,
}

enum Step {
    Read,
    End,
    Failed,
}

impl Runner {
    fn wait(&self, wake: &Receiver<()>, tick_start: Instant) {
        let active = self.last_data.elapsed() < ACTIVE_FOR;
        let waiting = self.merger.waiting() > 0;
        let timeout = if active || waiting || self.shared.data.read().dirty {
            ACTIVE_POLL_INTERVAL
        } else {
            POLL_INTERVAL
        };
        match wake.recv_timeout(timeout) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if let Some(rest) = MIN_TICK.checked_sub(tick_start.elapsed()) {
            std::thread::sleep(rest);
        }
        while wake.try_recv().is_ok() {}
    }

    fn tick(&mut self) {
        let (frozen, resort) = {
            let mut data = self.shared.data.write();
            (data.frozen, std::mem::take(&mut data.resort_requested))
        };
        if resort {
            self.start_load(Some(Remerge::Resort));
        }
        if frozen {
            self.watch_while_frozen();
        } else if self.loading {
            self.load();
        } else {
            self.follow();
        }
        self.emit_if_due();
    }

    /// The parsers of all sources, fresh (time-only logs count days from the start).
    fn parsers(&self) -> Vec<TimestampParser> {
        self.files
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let sample = Sample::of(&self.first_block(i));
                let refs: Vec<&str> = sample.texts.iter().map(String::as_str).collect();
                TimestampParser::detect(refs.into_iter(), f.reference)
            })
            .collect()
    }

    fn first_block(&self, source: usize) -> Vec<u8> {
        let file = &self.files[source].segments[0].segment.file;
        let mut buf = vec![0; 64 * 1024];
        let n = read_full(file, &mut buf, 0).unwrap_or(0);
        buf.truncate(n);
        buf
    }

    /// Everything is merged from the start: a new epoch, all segments of all sources.
    fn start_load(&mut self, reason: Option<Remerge>) {
        if reason.is_some() {
            let parsers = self.parsers();
            self.merger.reset(parsers);
        }
        for file in &mut self.files {
            file.rewind();
            file.status = Status::Loading { progress: 0.0 };
        }
        self.loading = true;
        self.load_total = self
            .files
            .iter()
            .map(SourceFile::remaining)
            .sum::<u64>()
            .max(1);
        let mut data = self.shared.data.write();
        if reason.is_some() {
            data.reset_index();
        }
        data.segments = self
            .files
            .iter()
            .flat_map(|f| f.segments.iter().map(|s| Arc::clone(&s.segment)))
            .collect();
        data.segments.sort_by_key(|s| s.base);
        data.status = match reason {
            Some(Remerge::Truncated) => Status::Truncated,
            Some(Remerge::Rotated) => Status::Rotated,
            _ => Status::Loading { progress: 0.0 },
        };
        self.publish(&mut data);
        data.dirty = true;
    }

    /// Reads all sources to their end, the one that lags behind in time first.
    fn load(&mut self) {
        loop {
            if self.shared.shutdown.load(Ordering::SeqCst) {
                return;
            }
            {
                let data = self.shared.data.read();
                if data.frozen || data.resort_requested {
                    return;
                }
            }
            let next = (0..self.files.len())
                .filter(|&i| !self.merger.is_done(i))
                .min_by_key(|&i| self.merger.max_seen(i).unwrap_or(i64::MIN));
            let Some(source) = next else { break };
            let fed = if self.files[source].needs_sort {
                self.read_sorted(source)
            } else {
                self.read_step(source, true)
            };
            match fed {
                Ok(Step::Read) => {}
                Ok(Step::End) | Ok(Step::Failed) => self.merger.set_done(source, true),
                Err(Restart) => {
                    self.files[source].needs_sort = true;
                    self.start_load(Some(Remerge::Resort));
                    continue;
                }
            }
            self.write(Until::Settled);
            self.update_progress();
            self.emit_if_due();
        }
        self.write(Until::All);
        self.loading = false;
        self.merger.set_strict(false);
        for file in &mut self.files {
            if matches!(file.status, Status::Loading { .. }) {
                file.status = Status::Live;
            }
        }
        let mut data = self.shared.data.write();
        data.status = Status::Live;
        self.publish(&mut data);
        data.dirty = true;
    }

    fn update_progress(&mut self) {
        let remaining: u64 = self.files.iter().map(SourceFile::remaining).sum();
        let progress = 1.0 - (remaining as f64 / self.load_total as f64).clamp(0.0, 1.0);
        let mut data = self.shared.data.write();
        if matches!(data.status, Status::Loading { .. }) {
            data.status = Status::Loading {
                progress: progress as f32,
            };
        }
        data.file_size = self.files.iter().map(|f| f.file_size).sum();
        data.dirty = true;
    }

    /// A source not in time order: all of it into the merger, then sorted.
    fn read_sorted(&mut self, source: usize) -> Result<Step, Restart> {
        self.merger.set_strict(false);
        loop {
            match self.read_step(source, false) {
                Ok(Step::Read) => continue,
                Ok(_) => break,
                Err(Restart) => unreachable!("not strict"),
            }
        }
        self.merger.set_strict(true);
        self.merger.sort_source(source);
        Ok(Step::End)
    }

    /// Reads one block of a source into the merger. During a load the end of an old segment moves
    /// on to the next; the end of the current file ends the source.
    fn read_step(&mut self, source: usize, strict: bool) -> Result<Step, Restart> {
        self.refresh_matcher();
        let (handle, end, at_last) = {
            let file = &self.files[source];
            let segment = file.current();
            (
                Arc::clone(&segment.segment.file),
                segment.end,
                file.cursor + 1 == file.segments.len(),
            )
        };
        let read_pos = self.files[source].read_pos;
        let mut want = self.buf.len();
        if let Some(end) = end {
            want = want.min(end.saturating_sub(read_pos) as usize);
        }
        let n = if want == 0 {
            0
        } else {
            match read_at(&handle, &mut self.buf[..want], read_pos) {
                Ok(n) => n,
                Err(err) => {
                    self.files[source].status = Status::Error {
                        message: err.to_string(),
                    };
                    return Ok(Step::Failed);
                }
            }
        };
        if n == 0 {
            if at_last {
                return Ok(Step::End);
            }
            // An old file is done: its last line has ended for good.
            self.finish_partial(source, strict)?;
            let file = &mut self.files[source];
            file.cursor += 1;
            file.read_pos = file.current().bom.unwrap_or(0);
            let next = file.current();
            file.splitter = LineSplitter::new(
                next.segment.encoding,
                next.segment.base + next.bom.unwrap_or(0),
            );
            return Ok(Step::Read);
        }
        let now = Instant::now();
        self.last_data = now;
        self.files[source].last_read = now;
        let mut skip = 0usize;
        if self.files[source].current().bom.is_none() {
            skip = self.start_segment(source, n);
        }
        let file = &mut self.files[source];
        file.read_pos += n as u64;
        let encoding = file.encoding();
        let test = &self.test;
        let matcher_id = self.matcher_id;
        let merger = &mut self.merger;
        let mut fed = Fed::Ok;
        file.splitter.feed(&self.buf[skip..n], |offset, raw| {
            if fed == Fed::OutOfOrder {
                return;
            }
            let text = detection_bytes(raw, encoding);
            // The merger classifies the line; field and time leaves are read on every line here.
            let probe = test.probe_raw(raw, encoding, true);
            fed = merger.line(
                source,
                offset,
                raw.len() as u32,
                &text,
                probe,
                matcher_id,
                now,
            );
        });
        if strict && fed == Fed::OutOfOrder {
            return Err(Restart);
        }
        Ok(Step::Read)
    }

    /// First bytes of a file of a source: encoding and BOM. Returns the BOM length.
    fn start_segment(&mut self, source: usize, n: usize) -> usize {
        let (encoding, bom) = Encoding::detect(&self.buf[..n]);
        let file = &mut self.files[source];
        let current = &mut file.segments[file.cursor];
        current.bom = Some(bom as u64);
        let segment = Arc::new(Segment {
            base: current.segment.base,
            file: Arc::clone(&current.segment.file),
            encoding,
        });
        current.segment = Arc::clone(&segment);
        file.splitter = LineSplitter::new(encoding, segment.base + bom as u64);
        let mut data = self.shared.data.write();
        if let Some(slot) = data.segments.iter_mut().find(|s| s.base == segment.base) {
            *slot = segment;
        }
        bom
    }

    /// The line without an end of a source becomes a line of its own.
    fn finish_partial(&mut self, source: usize, strict: bool) -> Result<(), Restart> {
        let file = &mut self.files[source];
        let Some((offset, raw)) = file.splitter.take_partial() else {
            return Ok(());
        };
        let encoding = file.encoding();
        let text = detection_bytes(&raw, encoding);
        let probe = self.test.probe_raw(&raw, encoding, true);
        let fed = self.merger.line(
            source,
            offset,
            raw.len() as u32,
            &text,
            probe,
            self.matcher_id,
            Instant::now(),
        );
        if strict && fed == Fed::OutOfOrder {
            return Err(Restart);
        }
        Ok(())
    }

    /// A new filter: lines still waiting are checked against it, later ones right away.
    fn refresh_matcher(&mut self) {
        let now = self.shared.data.read().filter.spec.text_test();
        if now.same(&self.test) {
            return;
        }
        self.test = now;
        self.matcher_id = self.matcher_id.wrapping_add(1);
        if self.merger.waiting() > 0 {
            let segments = self.shared.data.read().segments.clone();
            let mut reader = LineReader::new(segments, BLOCK_SIZE);
            let test = &self.test;
            self.merger.rematch(
                |entry| {
                    reader.raw(entry, MAX_SEARCH_BYTES).map_or_else(
                        |_| Probe::default(),
                        |(raw, enc)| test.probe_raw(raw, enc, !entry.is_continuation()),
                    )
                },
                self.matcher_id,
            );
        }
    }

    /// Writes released lines into index and filter, in batches under the write lock.
    fn write(&mut self, until: Until) {
        loop {
            self.out.clear();
            let more = self.merger.release(until, &mut self.out, WRITE_BATCH);
            if self.out.is_empty() {
                break;
            }
            let mut data = self.shared.data.write();
            let now = data.filter.spec.text_test();
            let same = now.same(&self.test);
            let mut reader: Option<LineReader> = None;
            for line in &self.out {
                let entry = line.entry;
                let probe = if same && line.matcher == self.matcher_id {
                    line.probe
                } else if now.is_empty() {
                    Probe::default()
                } else {
                    // The filter changed since the line was read: look at the text again.
                    let reader = reader
                        .get_or_insert_with(|| LineReader::new(data.segments.clone(), BLOCK_SIZE));
                    reader.raw(&entry, MAX_SEARCH_BYTES).map_or_else(
                        |_| Probe::default(),
                        |(raw, enc)| now.probe_raw(raw, enc, !entry.is_continuation()),
                    )
                };
                data.filter.append_from(
                    entry.source(),
                    entry.level(),
                    entry.is_continuation(),
                    || probe,
                );
                data.index.push(entry);
            }
            self.publish(&mut data);
            data.dirty = true;
            drop(data);
            if !more {
                break;
            }
        }
    }

    /// Live: every source is checked and read, then what is due goes into the index.
    fn follow(&mut self) {
        for source in 0..self.files.len() {
            if let Some(reason) = self.follow_source(source) {
                self.start_load(Some(reason));
                return;
            }
        }
        self.write(Until::Live(Instant::now()));
        let mut data = self.shared.data.write();
        self.publish(&mut data);
    }

    fn follow_source(&mut self, source: usize) -> Option<Remerge> {
        let path = self.files[source].path.clone();
        match file_id(&path) {
            Ok(id) if Some(id) != self.files[source].id => {
                if let Some(reason) = self.switch_file(source) {
                    return Some(reason);
                }
            }
            Ok(_) => {
                let file = &mut self.files[source];
                if file.missing || matches!(file.status, Status::Error { .. }) {
                    file.missing = false;
                    file.status = Status::Live;
                }
                if self.truncated(source) {
                    return Some(Remerge::Truncated);
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                self.drain(source);
                if !self.files[source].missing {
                    self.files[source].missing = true;
                    self.files[source].status = Status::FileMissing;
                    let _ = self.finish_partial(source, false);
                }
            }
            Err(err) => {
                self.files[source].status = Status::Error {
                    message: err.to_string(),
                };
            }
        }
        self.drain(source);
        let file = &self.files[source];
        if file.splitter.has_partial() && file.last_read.elapsed() >= PARTIAL_COMMIT_AFTER {
            // No provisional line in a merge: it could only be replaced at the end.
            let _ = self.finish_partial(source, false);
        }
        None
    }

    fn drain(&mut self, source: usize) {
        loop {
            if self.shared.shutdown.load(Ordering::SeqCst) {
                return;
            }
            match self.read_step(source, false) {
                Ok(Step::Read) => {
                    let file = &mut self.files[source];
                    file.file_size = file
                        .current()
                        .segment
                        .file
                        .metadata()
                        .map_or(file.file_size, |m| m.len());
                }
                _ => return,
            }
        }
    }

    /// The path names another file: the old one is read to its end, then the new one is followed.
    fn switch_file(&mut self, source: usize) -> Option<Remerge> {
        self.drain(source);
        let _ = self.finish_partial(source, false);
        let path = self.files[source].path.clone();
        let (file, id) = match open_shared(&path).and_then(|f| open_file_id(&f).map(|id| (f, id))) {
            Ok(opened) => opened,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
            Err(err) => {
                self.files[source].status = Status::Error {
                    message: err.to_string(),
                };
                return None;
            }
        };
        let size = file.metadata().map_or(0, |m| m.len());
        let keep_wanted = self.shared.data.read().keep_on_rotate;
        let src = &mut self.files[source];
        src.shrunk_while_frozen = false;
        src.id = Some(id);
        src.missing = false;
        src.file_size = size;
        let file = Arc::new(file);
        let encoding = src.encoding();
        let keep = keep_wanted && src.segments.len() < MAX_SEGMENTS;
        if !keep {
            // Without the old lines (or too many files): this source starts over, all is merged again.
            src.segments = vec![SourceSegment {
                segment: Arc::new(Segment {
                    base: source_base(source),
                    file,
                    encoding,
                }),
                bom: None,
                end: None,
            }];
            src.status = Status::Rotated;
            return Some(Remerge::Rotated);
        }
        let old_end = src.read_pos;
        let base = src.base() + old_end;
        if let Some(last) = src.segments.last_mut() {
            last.end = Some(old_end);
        }
        let segment = Arc::new(Segment {
            base,
            file,
            encoding,
        });
        src.segments.push(SourceSegment {
            segment: Arc::clone(&segment),
            bom: None,
            end: None,
        });
        src.cursor = src.segments.len() - 1;
        src.read_pos = 0;
        src.splitter = LineSplitter::new(encoding, base);
        src.status = Status::Rotated;
        insert_segment(&mut self.shared.data.write().segments, segment);
        None
    }

    fn truncated(&mut self, source: usize) -> bool {
        let file = &mut self.files[source];
        let Ok(meta) = file.current().segment.file.metadata() else {
            return false;
        };
        let shrunk = std::mem::take(&mut file.shrunk_while_frozen);
        if meta.len() >= file.read_pos && !shrunk {
            return false;
        }
        file.file_size = meta.len();
        file.status = Status::Truncated;
        // Read again from the start, its BOM too.
        if let Some(current) = file.segments.last_mut() {
            current.bom = None;
        }
        true
    }

    /// A freeze reads nothing; it only tells what is waiting, summed over the sources.
    fn watch_while_frozen(&mut self) {
        let mut pending = 0u64;
        let mut stale = false;
        for file in &mut self.files {
            let current = file.segments.last().map(|s| Arc::clone(&s.segment.file));
            let reading_current = file.cursor + 1 == file.segments.len();
            let read_pos = if reading_current { file.read_pos } else { 0 };
            let size = current
                .and_then(|f| f.metadata().ok())
                .map_or(read_pos, |m| m.len());
            if reading_current && size < read_pos {
                file.shrunk_while_frozen = true;
            }
            let rotated_in = match file_id(&file.path) {
                Ok(id) if Some(id) != file.id => {
                    std::fs::metadata(&file.path).map_or(0, |m| m.len())
                }
                _ => 0,
            };
            pending += size.saturating_sub(read_pos) + rotated_in;
            stale |= file.shrunk_while_frozen;
        }
        let mut data = self.shared.data.write();
        if data.pending_bytes != pending || data.frozen_stale != stale {
            data.pending_bytes = pending;
            data.frozen_stale = stale;
            data.dirty = true;
        }
    }

    /// The per-source state into the session data (marks it dirty if it changed).
    fn publish(&self, data: &mut SessionData) {
        let mut size = 0u64;
        let mut changed = false;
        for (i, file) in self.files.iter().enumerate() {
            size += file.file_size;
            let next = SourceUpdate {
                status: file.status.clone(),
                file_size: file.file_size,
                lines: self.merger.lines(i),
                late_lines: self.merger.late(i),
            };
            if data.sources.get(i) != Some(&next) {
                changed = true;
                if i < data.sources.len() {
                    data.sources[i] = next;
                } else {
                    data.sources.push(next);
                }
            }
        }
        if data.file_size != size {
            data.file_size = size;
            changed = true;
        }
        if changed {
            data.dirty = true;
        }
    }

    fn emit_if_due(&mut self) {
        if self
            .last_emit
            .is_some_and(|last| last.elapsed() < EMIT_INTERVAL)
        {
            return;
        }
        let update = {
            let mut data = self.shared.data.write();
            self.publish(&mut data);
            if !data.dirty {
                return;
            }
            data.dirty = false;
            let update = data.update();
            data.filter.take_retracted();
            // One-shot states: the next update says what comes after.
            if matches!(data.status, Status::Truncated | Status::Rotated) {
                data.status = if self.loading {
                    Status::Loading { progress: 0.0 }
                } else {
                    Status::Live
                };
                data.dirty = true;
            }
            for file in &mut self.files {
                if matches!(file.status, Status::Truncated | Status::Rotated) {
                    file.status = if self.loading {
                        Status::Loading { progress: 0.0 }
                    } else {
                        Status::Live
                    };
                    data.dirty = true;
                }
            }
            update
        };
        self.last_emit = Some(Instant::now());
        (self.shared.sink)(update);
    }
}

/// A source was found out of order during a load.
struct Restart;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::level::Level;
    use crate::profile::{builtin_profiles, GENERIC_PROFILE};

    fn detector(id: &str) -> Arc<LevelDetector> {
        let profile = builtin_profiles().into_iter().find(|p| p.id == id).unwrap();
        Arc::new(profile.detector().unwrap())
    }

    fn merger(n: usize) -> Merger {
        Merger::new(
            (0..n).map(|_| detector(GENERIC_PROFILE)).collect(),
            (0..n)
                .map(|_| TimestampParser::new(SystemTime::UNIX_EPOCH))
                .collect(),
            vec![None; n],
        )
    }

    /// Feeds `lines` of a source with offsets counting up from the source's base.
    fn feed(m: &mut Merger, source: usize, lines: &[&str]) -> Fed {
        let now = Instant::now();
        let base = source_base(source) + m.lines(source) * 1000 + m.waiting() as u64 * 100;
        for (i, line) in lines.iter().enumerate() {
            let fed = m.line(
                source,
                base + i as u64,
                line.len() as u32,
                line.as_bytes(),
                Probe::default(),
                0,
                now,
            );
            if fed != Fed::Ok {
                return fed;
            }
        }
        Fed::Ok
    }

    fn order(m: &mut Merger, until: Until) -> Vec<(usize, bool)> {
        let mut out = Vec::new();
        m.release(until, &mut out, usize::MAX);
        out.iter()
            .map(|l| (l.entry.source(), l.entry.is_continuation()))
            .collect()
    }

    #[test]
    fn interleaves_by_time_and_breaks_ties_by_source() {
        let mut m = merger(2);
        feed(
            &mut m,
            0,
            &["2024-01-01 10:00:01 INFO a1", "2024-01-01 10:00:03 INFO a3"],
        );
        feed(
            &mut m,
            1,
            &["2024-01-01 10:00:01 INFO b1", "2024-01-01 10:00:02 INFO b2"],
        );
        for s in 0..2 {
            m.set_done(s, true);
        }
        // Equal times: source 0 first, every time.
        assert_eq!(
            order(&mut m, Until::Settled),
            vec![(0, false), (1, false), (1, false), (0, false)]
        );
    }

    #[test]
    fn an_entry_stays_together() {
        let mut m = merger(2);
        feed(
            &mut m,
            0,
            &[
                "2024-01-01 10:00:01 ERROR boom",
                "\tat com.acme.A(A.java:1)",
                "Caused by: x",
            ],
        );
        feed(&mut m, 1, &["2024-01-01 10:00:02 INFO later"]);
        m.set_done(0, true);
        m.set_done(1, true);
        assert_eq!(
            order(&mut m, Until::Settled),
            vec![(0, false), (0, true), (0, true), (1, false)]
        );
    }

    #[test]
    fn settled_waits_for_unfinished_sources() {
        let mut m = merger(2);
        feed(&mut m, 0, &["2024-01-01 10:00:05 INFO a"]);
        // Source 1 has not said anything yet: nothing can go.
        assert!(order(&mut m, Until::Settled).is_empty());
        feed(&mut m, 1, &["2024-01-01 10:00:09 INFO b"]);
        assert_eq!(order(&mut m, Until::Settled), vec![]);
        // Both have seen later times than 10:00:05 now: a goes, b waits for source 0.
        feed(&mut m, 0, &["2024-01-01 10:00:10 INFO a2"]);
        assert_eq!(order(&mut m, Until::Settled), vec![(0, false)]);
    }

    #[test]
    fn an_entry_without_time_stays_with_its_predecessor() {
        let mut m = merger(2);
        feed(
            &mut m,
            0,
            &["2024-01-01 10:00:01 INFO a", "INFO no time here"],
        );
        feed(&mut m, 1, &["2024-01-01 10:00:01 INFO b"]);
        m.set_done(0, true);
        m.set_done(1, true);
        assert_eq!(
            order(&mut m, Until::All),
            vec![(0, false), (0, false), (1, false)]
        );
    }

    #[test]
    fn lines_before_the_first_time_start_their_file() {
        let mut m = Merger::new(
            vec![detector(GENERIC_PROFILE), detector(GENERIC_PROFILE)],
            vec![
                TimestampParser::new(SystemTime::UNIX_EPOCH),
                TimestampParser::new(SystemTime::UNIX_EPOCH),
            ],
            vec![
                time_of(
                    &mut TimestampParser::new(SystemTime::UNIX_EPOCH),
                    b"2024-01-01 10:00:05",
                ),
                None,
            ],
        );
        feed(&mut m, 1, &["2024-01-01 10:00:01 INFO b"]);
        feed(
            &mut m,
            0,
            &["banner without time", "2024-01-01 10:00:05 INFO a"],
        );
        m.set_done(0, true);
        m.set_done(1, true);
        assert_eq!(
            order(&mut m, Until::All),
            vec![(1, false), (0, false), (0, false)]
        );
    }

    #[test]
    fn strict_mode_reports_a_source_out_of_order() {
        let mut m = merger(2);
        feed(&mut m, 0, &["2024-01-01 10:00:05 INFO a"]);
        feed(&mut m, 1, &["2024-01-01 10:00:09 INFO b"]);
        feed(&mut m, 0, &["2024-01-01 10:00:10 INFO a2"]);
        assert_eq!(order(&mut m, Until::Settled), vec![(0, false)]);
        // Back before what was released.
        assert_eq!(
            feed(&mut m, 1, &["2024-01-01 10:00:01 INFO b-early"]),
            Fed::OutOfOrder
        );
    }

    #[test]
    fn a_source_read_completely_is_sorted_stably() {
        let mut m = merger(1);
        m.set_strict(false);
        feed(
            &mut m,
            0,
            &[
                "2024-01-01 10:00:03 INFO c",
                "2024-01-01 10:00:01 INFO a",
                "\tat stack of a",
                "2024-01-01 10:00:03 INFO c2",
                "2024-01-01 10:00:02 INFO b",
            ],
        );
        m.sort_source(0);
        let mut out = Vec::new();
        m.release(Until::All, &mut out, usize::MAX);
        let offsets: Vec<u64> = out.iter().map(|l| l.entry.offset).collect();
        assert_eq!(offsets, vec![1, 2, 4, 0, 3]);
    }

    #[test]
    fn live_late_entries_are_appended_and_counted() {
        let mut m = merger(2);
        m.set_strict(false);
        feed(&mut m, 0, &["2024-01-01 10:00:05 INFO a"]);
        feed(&mut m, 1, &["2024-01-01 10:00:06 INFO b"]);
        let now = Instant::now();
        assert_eq!(order(&mut m, Until::Live(now)), vec![(0, false)]);
        let later = now + HOLD_BACK;
        assert_eq!(order(&mut m, Until::Live(later)), vec![(1, false)]);
        feed(&mut m, 0, &["2024-01-01 10:00:01 INFO a-late"]);
        assert_eq!(order(&mut m, Until::Live(Instant::now())), vec![(0, false)]);
        assert_eq!((m.late(0), m.late(1)), (1, 0));
    }

    #[test]
    fn a_silent_source_holds_up_the_rest_at_most_hold_back() {
        let mut m = merger(2);
        m.set_strict(false);
        let now = Instant::now();
        m.line(
            0,
            0,
            1,
            b"2024-01-01 10:00:05 INFO a",
            Probe::default(),
            0,
            now,
        );
        m.line(
            1,
            source_base(1),
            1,
            b"2024-01-01 10:00:09 INFO b",
            Probe::default(),
            0,
            now,
        );
        // Both active: up to the smaller of the two.
        assert_eq!(order(&mut m, Until::Live(now)), vec![(0, false)]);
        // Source 0 stays quiet: after HOLD_BACK it no longer counts.
        assert_eq!(
            order(&mut m, Until::Live(now + HOLD_BACK)),
            vec![(1, false)]
        );
    }

    #[test]
    fn a_continuation_after_its_entry_was_released() {
        let mut m = merger(2);
        m.set_strict(false);
        feed(&mut m, 0, &["2024-01-01 10:00:05 ERROR a"]);
        assert_eq!(order(&mut m, Until::All), vec![(0, false)]);
        // Nothing came in between: it still joins its entry.
        feed(&mut m, 0, &["\tat one"]);
        assert_eq!(order(&mut m, Until::All), vec![(0, true)]);
        feed(&mut m, 1, &["2024-01-01 10:00:06 INFO b"]);
        assert_eq!(order(&mut m, Until::All), vec![(1, false)]);
        // Now another source came first: a line of its own, counted as late.
        feed(&mut m, 0, &["\tat two"]);
        let mut out = Vec::new();
        m.release(Until::All, &mut out, usize::MAX);
        assert!(!out[0].entry.is_continuation());
        assert_eq!(out[0].entry.level(), Level::Error);
        assert_eq!(m.late(0), 1);
    }

    #[test]
    fn json_and_iso_times_mix() {
        let mut m = Merger::new(
            vec![detector("jsonl"), detector(GENERIC_PROFILE)],
            vec![
                TimestampParser::new(SystemTime::UNIX_EPOCH),
                TimestampParser::new(SystemTime::UNIX_EPOCH),
            ],
            vec![None, None],
        );
        feed(
            &mut m,
            0,
            &[r#"{"time":"2024-01-01T10:00:02Z","level":"error","msg":"j"}"#],
        );
        feed(&mut m, 1, &["2024-01-01T10:00:01Z WARN w"]);
        m.set_done(0, true);
        m.set_done(1, true);
        let mut out = Vec::new();
        m.release(Until::Settled, &mut out, usize::MAX);
        let levels: Vec<Level> = out.iter().map(|l| l.entry.level()).collect();
        assert_eq!(levels, vec![Level::Warn, Level::Error]);
    }
}
