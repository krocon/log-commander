//! Following a file: one worker thread per session reads in blocks until the end of the file, then
//! waits for a `notify` event or the next poll. Handles the incomplete last line, truncation,
//! rotation and a missing file, and sends bundled updates.

use crate::encoding::{display_text, Encoding};
use crate::fields::{self, MIN_CONFIDENCE};
use crate::filter::TextMatcher;
use crate::indexer::{read_at, LineEntry, LineReader, LineSplitter, Segment, MAX_SEARCH_BYTES};
use crate::model::Status;
use crate::platform::{file_id, open_file_id, open_shared, FileId};
use crate::profile::{suggest_profile, Profile, ProfileRegistry};
use crate::session::{detection_bytes, Provisional, Shared};
use notify::{EventKind, RecursiveMode, Watcher};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

const BLOCK_SIZE: usize = 1024 * 1024;
/// `notify` is unreliable on network drives and in Docker volumes: the size is checked regardless.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// While a writer is active the poll follows the update rate.
const ACTIVE_POLL_INTERVAL: Duration = Duration::from_millis(100);
const ACTIVE_FOR: Duration = Duration::from_secs(2);
/// Bundling: at most ~10 updates per second.
const EMIT_INTERVAL: Duration = Duration::from_millis(100);
/// Waking per write of a busy logger would be wasted work.
const MIN_TICK: Duration = Duration::from_millis(40);
/// A last line without a line end is shown after this pause, and replaced if it grows.
const PARTIAL_COMMIT_AFTER: Duration = Duration::from_secs(1);
/// Old files kept open after rotations; more would pile up file descriptors.
const MAX_SEGMENTS: usize = 32;
/// Lines of the first block that decide the profile and the format.
pub const SAMPLE_LINES: usize = 200;
/// Text of the sample kept per line; the format only looks at the start anyway.
const SAMPLE_LINE_BYTES: usize = fields::MAX_PARSE_BYTES;

struct TailFile {
    file: Arc<File>,
    id: FileId,
    base: u64,
    /// Next physical offset to read.
    read_pos: u64,
    /// Encoding known, BOM skipped.
    started: bool,
}

pub struct Tailer {
    shared: Arc<Shared>,
    path: PathBuf,
    current: TailFile,
    splitter: LineSplitter,
    buf: Vec<u8>,
    loading: bool,
    missing: bool,
    last_emit: Option<Instant>,
    last_data: Instant,
    /// The file got smaller during a freeze. It may have grown past the old size again by the time
    /// the freeze ends, so this has to be remembered.
    shrunk_while_frozen: bool,
}

impl Tailer {
    pub fn new(shared: Arc<Shared>, path: PathBuf, file: File) -> io::Result<Self> {
        let id = open_file_id(&file)?;
        let file = Arc::new(file);
        {
            let mut data = shared.data.write();
            data.segments = vec![Arc::new(Segment {
                base: 0,
                file: Arc::clone(&file),
                encoding: Encoding::Utf8,
            })];
        }
        Ok(Self {
            shared,
            path,
            current: TailFile {
                file,
                id,
                base: 0,
                read_pos: 0,
                started: false,
            },
            splitter: LineSplitter::new(Encoding::Utf8, 0),
            buf: vec![0; BLOCK_SIZE],
            loading: true,
            missing: false,
            last_emit: None,
            last_data: Instant::now(),
            shrunk_while_frozen: false,
        })
    }

    pub fn read_first_block(&mut self) -> io::Result<()> {
        self.read_block()?;
        Ok(())
    }

    pub fn run(mut self, wake: Receiver<()>) {
        loop {
            let tick_start = Instant::now();
            self.tick();
            if self.shared.shutdown.load(Ordering::SeqCst) {
                return;
            }
            self.wait(&wake, tick_start);
            if self.shared.shutdown.load(Ordering::SeqCst) {
                return;
            }
        }
    }

    fn wait(&self, wake: &Receiver<()>, tick_start: Instant) {
        let active = self.last_data.elapsed() < ACTIVE_FOR;
        let timeout = if active || self.shared.data.read().dirty {
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
        if self.shared.data.read().frozen {
            self.watch_while_frozen();
        } else {
            self.follow_file();
        }
        // Also while frozen: filter and level jobs report through this.
        self.emit_if_due();
    }

    /// A freeze reads nothing and reacts to nothing; it only tells what is waiting.
    fn watch_while_frozen(&mut self) {
        let read_pos = self.current.read_pos;
        let size = self.current.file.metadata().map_or(read_pos, |m| m.len());
        if size < read_pos {
            self.shrunk_while_frozen = true;
        }
        let rotated_in = match file_id(&self.path) {
            Ok(id) if id != self.current.id => std::fs::metadata(&self.path).map_or(0, |m| m.len()),
            _ => 0,
        };
        let pending = size.saturating_sub(read_pos) + rotated_in;
        let mut data = self.shared.data.write();
        if data.pending_bytes != pending || data.frozen_stale != self.shrunk_while_frozen {
            data.pending_bytes = pending;
            data.frozen_stale = self.shrunk_while_frozen;
            data.dirty = true;
        }
    }

    fn follow_file(&mut self) {
        match file_id(&self.path) {
            Ok(id) if id != self.current.id => self.switch_file(),
            Ok(_) => {
                let failed = matches!(self.shared.data.read().status, Status::Error { .. });
                if self.missing || failed {
                    // Renamed away and back, or the error went away: it is the same file.
                    self.missing = false;
                    self.set_status(Status::Live);
                }
                self.check_truncation();
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                self.drain(false);
                if !self.missing {
                    self.missing = true;
                    self.commit_partial_final();
                    self.set_status(Status::FileMissing);
                }
            }
            // E.g. no permission any more: the open handle may still work.
            Err(err) => {
                self.set_status(Status::Error {
                    message: err.to_string(),
                });
            }
        }
        self.drain(true);
        if !self.shared.data.read().frozen {
            self.maybe_commit_partial();
        }
    }

    /// Reads until the end of the file, or until a freeze when `stop_when_frozen` says so. Leaving a
    /// file for good has to read all of it.
    fn drain(&mut self, stop_when_frozen: bool) {
        loop {
            if self.shared.shutdown.load(Ordering::SeqCst) {
                return;
            }
            if stop_when_frozen && self.shared.data.read().frozen {
                return;
            }
            match self.read_block() {
                Ok(0) => break,
                Ok(_) => self.emit_if_due(),
                Err(err) => {
                    self.set_status(Status::Error {
                        message: err.to_string(),
                    });
                    return;
                }
            }
        }
        if self.loading {
            self.loading = false;
            self.commit_partial_now();
            let mut data = self.shared.data.write();
            data.status = Status::Live;
            data.dirty = true;
        }
    }

    fn read_block(&mut self) -> io::Result<usize> {
        let n = read_at(&self.current.file, &mut self.buf, self.current.read_pos)?;
        if n == 0 {
            return Ok(0);
        }
        self.last_data = Instant::now();
        self.shared.data.write().retract_provisional();
        let mut skip = 0usize;
        if !self.current.started {
            skip = self.start_file(n);
        }
        let block_end = self.current.read_pos + n as u64;
        self.current.read_pos = block_end;
        self.ingest(skip, n);
        let size = self.current.file.metadata().map_or(block_end, |m| m.len());
        let mut data = self.shared.data.write();
        data.file_size = size;
        if self.loading {
            data.status = Status::Loading {
                progress: (block_end as f64 / size.max(1) as f64).min(1.0) as f32,
            };
        }
        data.dirty = true;
        Ok(n)
    }

    /// First data of a file: encoding, BOM, the profile suggestion and the format. Returns the BOM
    /// length. Later files of the session (rotation) keep the format: their lines that do not fit
    /// fall back to a single message.
    fn start_file(&mut self, n: usize) -> usize {
        let sample = &self.buf[..n];
        let (encoding, bom) = Encoding::detect(sample);
        let body = &sample[bom..];
        let mut splitter = LineSplitter::new(encoding, 0);
        let mut plain: Vec<Vec<u8>> = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        splitter.feed(body, |_, raw| {
            if plain.len() < SAMPLE_LINES {
                plain.push(detection_bytes(raw, encoding).into_owned());
                let raw = &raw[..raw.len().min(SAMPLE_LINE_BYTES)];
                texts.push(display_text(raw, encoding).into_owned());
            }
        });
        self.current.started = true;
        self.splitter = LineSplitter::new(encoding, self.current.base + bom as u64);
        let mut data = self.shared.data.write();
        data.encoding = encoding;
        if let Some(last) = data.segments.last_mut() {
            *last = Arc::new(Segment {
                base: self.current.base,
                file: Arc::clone(&self.current.file),
                encoding,
            });
        }
        if data.suggested_profile.is_none() {
            drop(data);
            let texts = Arc::new(texts);
            let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
            let registry = ProfileRegistry::default();
            let guess = fields::detect_format(&refs, &registry.list());
            // A layout that fits is the stronger evidence; otherwise the level keywords decide.
            let suggestion =
                if guess.confidence >= MIN_CONFIDENCE && guess.inferred_layout.is_none() {
                    guess.profile_id.clone()
                } else {
                    suggest_profile(plain.iter().map(Vec::as_slice))
                };
            let profile = registry.find(&suggestion).ok();
            let view = self.shared.next_view_generation();
            let mut data = self.shared.data.write();
            data.suggested_profile = Some(suggestion);
            data.sample = Arc::clone(&texts);
            let format = if data.profile_auto {
                apply_suggestion(&mut data, profile.as_ref());
                Some(guess)
            } else {
                // Chosen before there was anything to read: its layout, now with a sample.
                data.chosen_profile
                    .clone()
                    .and_then(|chosen| fields::format_for(&chosen, &refs).ok())
            };
            if let Some(format) = format {
                if data.requested_format.is_some() {
                    data.requested_format = Some(Arc::new(format));
                } else {
                    data.set_format(format, view);
                }
            }
        }
        bom
    }

    fn ingest(&mut self, skip: usize, n: usize) {
        let (detector, mut prev, matcher, encoding) = {
            let data = self.shared.data.read();
            (
                Arc::clone(&data.detector),
                data.prev,
                data.filter.spec.filtering_matcher().cloned(),
                data.encoding,
            )
        };
        let mut batch: Vec<(LineEntry, bool)> = Vec::with_capacity(n / 80);
        let block = &self.buf[skip..n];
        self.splitter.feed(block, |offset, raw| {
            let text = detection_bytes(raw, encoding);
            let (level, continuation) = detector.classify(&text, &mut prev);
            let matched = matcher
                .as_ref()
                .is_some_and(|m| text_matches(m, raw, encoding));
            batch.push((
                LineEntry::new(offset, raw.len() as u32, level, continuation),
                matched,
            ));
        });
        let mut data = self.shared.data.write();
        let mut reader = None;
        for (entry, matched) in batch {
            let same_matcher = match (data.filter.spec.filtering_matcher(), &matcher) {
                (Some(now), Some(then)) => Arc::ptr_eq(now, then),
                (None, None) => true,
                _ => false,
            };
            let now_matcher = data.filter.spec.filtering_matcher().cloned();
            let segments = &data.segments;
            let reader =
                reader.get_or_insert_with(|| LineReader::new(segments.clone(), BLOCK_SIZE));
            // The filter changed since this batch was prepared: look at the text again.
            let matches = || {
                if same_matcher {
                    return matched;
                }
                let Some(now) = now_matcher else { return true };
                reader
                    .raw(&entry, MAX_SEARCH_BYTES)
                    .is_ok_and(|(raw, enc)| text_matches(&now, raw, enc))
            };
            data.filter
                .append(entry.level(), entry.is_continuation(), matches);
            data.index.push(entry);
        }
        data.prev = prev;
    }

    /// The path names another file: finish the old one, then follow the new one.
    fn switch_file(&mut self) {
        self.drain(false);
        self.commit_partial_final();
        self.shrunk_while_frozen = false;
        let (file, id) =
            match open_shared(&self.path).and_then(|f| open_file_id(&f).map(|id| (f, id))) {
                Ok(opened) => opened,
                Err(err) if err.kind() == io::ErrorKind::NotFound => return,
                Err(err) => {
                    self.set_status(Status::Error {
                        message: err.to_string(),
                    });
                    return;
                }
            };
        let file = Arc::new(file);
        let size = file.metadata().map_or(0, |m| m.len());
        let mut data = self.shared.data.write();
        let keep = data.keep_on_rotate && data.segments.len() < MAX_SEGMENTS;
        let base = if keep {
            self.current.base + self.current.read_pos
        } else {
            data.reset_index();
            data.segments.clear();
            0
        };
        let encoding = data.encoding;
        data.segments.push(Arc::new(Segment {
            base,
            file: Arc::clone(&file),
            encoding,
        }));
        data.file_size = size;
        data.status = Status::Rotated;
        data.dirty = true;
        drop(data);
        self.current = TailFile {
            file,
            id,
            base,
            read_pos: 0,
            started: false,
        };
        self.splitter = LineSplitter::new(encoding, base);
        self.missing = false;
    }

    fn check_truncation(&mut self) {
        let Ok(meta) = self.current.file.metadata() else {
            return;
        };
        let size = meta.len();
        let shrunk = std::mem::take(&mut self.shrunk_while_frozen);
        if size >= self.current.read_pos && !shrunk {
            return;
        }
        let mut data = self.shared.data.write();
        data.reset_index();
        data.segments = vec![Arc::new(Segment {
            base: 0,
            file: Arc::clone(&self.current.file),
            encoding: data.encoding,
        })];
        data.file_size = size;
        data.status = Status::Truncated;
        let encoding = data.encoding;
        drop(data);
        self.current.base = 0;
        self.current.read_pos = 0;
        self.current.started = false;
        self.splitter = LineSplitter::new(encoding, 0);
    }

    /// Shows a line that has no end yet, after a pause of the writer.
    fn maybe_commit_partial(&mut self) {
        if self.splitter.has_partial()
            && self.last_data.elapsed() >= PARTIAL_COMMIT_AFTER
            && self.shared.data.read().provisional.is_none()
        {
            self.commit_partial_now();
        }
    }

    /// Adds the incomplete last line as a provisional line. New data replaces it.
    fn commit_partial_now(&mut self) {
        if !self.splitter.has_partial() {
            return;
        }
        let (offset, raw) = self.splitter.partial();
        let mut data = self.shared.data.write();
        if data.provisional.is_some() {
            return;
        }
        let encoding = data.encoding;
        let detector = Arc::clone(&data.detector);
        let provisional = Provisional {
            checkpoint: data.filter.checkpoint(),
            prev: data.prev,
        };
        let mut prev = data.prev;
        let text = detection_bytes(raw, encoding);
        let (level, continuation) = detector.classify(&text, &mut prev);
        let matcher = data.filter.spec.filtering_matcher().cloned();
        data.filter.append(level, continuation, || {
            matcher
                .as_ref()
                .is_some_and(|m| text_matches(m, raw, encoding))
        });
        data.index.push(LineEntry::new(
            offset,
            raw.len() as u32,
            level,
            continuation,
        ));
        data.prev = prev;
        data.provisional = Some(provisional);
        data.dirty = true;
    }

    /// The file ended: what is left is a real line, not a provisional one.
    fn commit_partial_final(&mut self) {
        self.commit_partial_now();
        self.shared.data.write().provisional = None;
    }

    fn set_status(&self, status: Status) {
        let mut data = self.shared.data.write();
        if data.status != status {
            data.status = status;
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
            if !data.dirty {
                return;
            }
            data.dirty = false;
            let update = data.update();
            // One-shot states: the next update says Live again.
            if matches!(data.status, Status::Truncated | Status::Rotated) {
                data.status = if self.loading {
                    Status::Loading { progress: 0.0 }
                } else {
                    Status::Live
                };
                data.dirty = true;
            }
            update
        };
        self.last_emit = Some(Instant::now());
        (self.shared.sink)(update);
    }
}

fn text_matches(matcher: &TextMatcher, raw: &[u8], encoding: Encoding) -> bool {
    let raw = &raw[..raw.len().min(MAX_SEARCH_BYTES)];
    matcher.is_match(&crate::encoding::display_text(raw, encoding))
}

fn apply_suggestion(data: &mut crate::session::SessionData, profile: Option<&Profile>) {
    let Some(profile) = profile else { return };
    if let Ok(detector) = profile.detector() {
        data.detector = Arc::new(detector);
        data.profile_id = profile.id.clone();
    }
}

/// Watches the parent folder, so a rotation (new file under the same name) is noticed. If this
/// fails the session still works through polling.
pub fn watch_parent(path: &Path, wake: Sender<()>) -> Option<notify::RecommendedWatcher> {
    let parent = path.parent()?.to_path_buf();
    let name = path.file_name()?.to_os_string();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let relevant = event.paths.is_empty()
            || event
                .paths
                .iter()
                .any(|p| p.file_name() == Some(name.as_os_str()));
        if relevant {
            let _ = wake.send(());
        }
    })
    .ok()?;
    watcher.watch(&parent, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}
