//! A session per open file: the shared state, its queries and the background jobs that recompute
//! the filter and the levels. Following the file happens in `tail.rs`.

use crate::encoding::{display_text, strip_ansi, Encoding};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::extract::{self, ExtractRule, FieldSuggestion, RuleBook};
use crate::fields::{self, FormatGuess};
use crate::filter::{
    FilterCheckpoint, FilterSpec, FilteredLines, LevelMask, Probe, SearchMode, SearchQuery,
    SourceMask, TextMatcher, TextTest,
};
use crate::filter_expr::{CompiledExpr, ExprContext, FilterExpr};
use crate::indexer::{
    segment_of, LineEntry, LineIndex, LineReader, Segment, MAX_DISPLAY_BYTES, MAX_SEARCH_BYTES,
};
use crate::level::{Level, LevelDetector, PrevLine};
use crate::merge::{MergeSource, MergeWorker};
use crate::model::{
    ColumnSet, EntryDetail, EntryRange, FilterInfo, FindHit, LogLine, Overview, OverviewMark,
    ReportResult, ReportSchema, ReportStatus, SessionInfo, SessionUpdate, SourceInfo, SourceUpdate,
    Status, TimeAnchor, TimeHit, TimeRange, Timeline, TimelineBucket, ViewInfo,
};
use crate::overview::{level_bit, LevelSummary};
use crate::platform::open_shared;
use crate::profile::{Profile, ProfileRegistry};
use crate::report_db::{ReportDb, ReportLimits};
use crate::tail::Tailer;
use crate::timeline::{TimeMark, TimelineQuery};
use crate::timestamp::TimestampParser;
use crate::views::{compose, ViewFilter, MAX_VIEWS};
use memchr::memchr;
use parking_lot::{Mutex, RwLock};
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Instant;

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
/// Pixel buckets of the overview ruler (its height in CSS pixels).
pub const MAX_OVERVIEW_BUCKETS: usize = 8192;
/// Lines (selection and bookmarks) whose position the overview reports.
pub const MAX_OVERVIEW_LINES: usize = 10_000;
/// At most this many time buckets per timeline (prompt 014).
pub const MAX_TIMELINE_BUCKETS: usize = 4096;
/// Line → time anchors per timeline answer.
pub const TIMELINE_ANCHORS: usize = 1024;

pub type UpdateSink = Box<dyn Fn(SessionUpdate) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct OpenOptions {
    pub keep_on_rotate: bool,
    /// Extraction rules per profile (prompt 011), shared with the other sessions.
    pub rules: Arc<RuleBook>,
    /// Folder for the dashboard database (prompt 012); without one there is no dashboard.
    pub report_dir: Option<PathBuf>,
    /// Limits of dashboard queries (tests use smaller ones).
    pub report_limits: ReportLimits,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            keep_on_rotate: true,
            rules: Arc::default(),
            report_dir: None,
            report_limits: ReportLimits::default(),
        }
    }
}

/// The provisional last line (a line without an end shown after a pause) and how to undo it; the
/// filter of every view keeps its own checkpoint (`ViewState::provisional`).
#[derive(Debug, Clone, Copy)]
pub struct Provisional {
    pub prev: PrevLine,
    /// The time summary before the line (prompt 014): a time it brought is taken back exactly.
    pub time: TimeMark,
}

/// Where updates of a view go (a Tauri channel per view).
pub type ViewSink = Arc<dyn Fn(SessionUpdate) + Send + Sync>;

/// An unchanged view (only the line count of the file grew) hears of it at most this often.
const QUIET_VIEW_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// One view of the session (prompt 013): its filter and its list. View 0 always exists and behaves
/// as the single view did before.
pub struct ViewState {
    pub id: u32,
    /// The view this one filters further; `None` for view 0 and for views whose ancestors closed.
    pub parent: Option<u32>,
    /// What the user set for this view.
    pub own: ViewFilter,
    /// Filters of closed ancestors, outermost first: the chain stays as it was.
    pub inherited: Vec<ViewFilter>,
    pub filter: FilteredLines,
    /// What the running or last job works towards (`filter` swaps to it when done).
    pub requested_spec: FilterSpec,
    pub view_generation: u64,
    pub filter_pending: bool,
    pub filter_progress: f32,
    /// The newest filter job of this view; an older one sees the difference and stops.
    job: Arc<AtomicU64>,
    /// A relevel runs: the filter job starts after it and finishes with this view generation.
    awaiting_relevel: Option<u64>,
    /// Filter state before the provisional last line, to withdraw it.
    pub provisional: Option<FilterCheckpoint>,
    /// Something of this view changed that its tab has not heard of.
    pub dirty: bool,
    /// Skipped while only the file grew: sent once `QUIET_VIEW_INTERVAL` is over.
    behind: bool,
    /// View 0 after its tab closed while others stay: an identity without listener.
    pub hidden: bool,
    sink: Option<ViewSink>,
    last_sent: Option<(SessionUpdate, Instant)>,
}

impl ViewState {
    fn new(id: u32, parent: Option<u32>, sink: Option<ViewSink>) -> Self {
        let spec = FilterSpec::default();
        Self {
            id,
            parent,
            own: ViewFilter::default(),
            inherited: Vec::new(),
            filter: FilteredLines::new(spec.clone()),
            requested_spec: spec,
            view_generation: 0,
            filter_pending: false,
            filter_progress: 0.0,
            job: Arc::new(AtomicU64::new(0)),
            awaiting_relevel: None,
            provisional: None,
            dirty: true,
            behind: false,
            hidden: false,
            sink,
            last_sent: None,
        }
    }

    /// Bytes of its list (4 per line it shows; the identity has none).
    pub fn list_bytes(&self, total: usize) -> usize {
        if self.filter.is_identity() {
            0
        } else {
            self.filter.len(total) * std::mem::size_of::<u32>()
        }
    }
}

pub struct SessionData {
    pub index: LineIndex,
    /// View 0 first, always there; at most `MAX_VIEWS` visible ones.
    pub views: Vec<ViewState>,
    next_view_id: u32,
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
    /// Waits for the running relevel: the spans change together with the view generations.
    pub requested_format: Option<Arc<FormatGuess>>,
    /// Changes with the columns; then the view generation changes too.
    pub columns_revision: u64,
    /// Decoded first lines of the file (at most `SAMPLE_LINES`), for building a format.
    pub sample: Arc<Vec<String>>,
    pub prev: PrevLine,
    pub provisional: Option<Provisional>,
    pub epoch: u64,
    pub status: Status,
    pub file_size: u64,
    pub keep_on_rotate: bool,
    /// The worker reads nothing new, so everything derived from the index stays as it is.
    pub frozen: bool,
    pub pending_bytes: u64,
    pub frozen_stale: bool,
    /// Something of the file changed that the frontend has not heard of (all views).
    pub dirty: bool,
    /// The sources of a merge (empty for a single file).
    pub sources: Vec<SourceUpdate>,
    /// The user asked to merge everything again ("Neu sortieren").
    pub resort_requested: bool,
    /// Extraction rules of every profile (prompt 011): each format gets the rules of its profile.
    pub rule_book: Arc<RuleBook>,
    /// The dashboard database (prompt 012), written by its builder.
    pub report: Option<ReportStatus>,
}

impl SessionData {
    fn new(
        detector: Arc<LevelDetector>,
        profile_id: String,
        file_size: u64,
        options: &OpenOptions,
    ) -> Self {
        let keep = options.keep_on_rotate;
        Self {
            index: LineIndex::default(),
            views: vec![ViewState::new(0, None, None)],
            next_view_id: 1,
            segments: Vec::new(),
            encoding: Encoding::Utf8,
            detector,
            profile_id,
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
            status: Status::Loading { progress: 0.0 },
            file_size,
            keep_on_rotate: keep,
            frozen: false,
            pending_bytes: 0,
            frozen_stale: false,
            dirty: true,
            sources: Vec::new(),
            resort_requested: false,
            rule_book: Arc::clone(&options.rules),
            report: None,
        }
    }

    /// A format with the extraction rules of its profile (prompt 011).
    pub fn with_rules(&self, format: &FormatGuess) -> FormatGuess {
        format.with_rules(&self.rule_book.get(&format.profile_id))
    }

    pub fn is_merge(&self) -> bool {
        !self.sources.is_empty()
    }

    /// The view with this id.
    pub fn view(&self, id: u32) -> AppResult<&ViewState> {
        self.views
            .iter()
            .find(|v| v.id == id && !v.hidden)
            .ok_or_else(|| unknown_view(id))
    }

    pub fn view_mut(&mut self, id: u32) -> AppResult<&mut ViewState> {
        self.views
            .iter_mut()
            .find(|v| v.id == id && !v.hidden)
            .ok_or_else(|| unknown_view(id))
    }

    /// The text tests of all views, for reading lines before the write lock (tail, merge).
    pub fn text_tests(&self) -> (Vec<u32>, Vec<TextTest>) {
        self.views
            .iter()
            .map(|v| (v.id, v.filter.spec.text_test()))
            .unzip()
    }

    /// Appends one line to the index and to the list of every view. `probe(i)` reads the text for
    /// view `i` of `views`; it is only called when that view's answer depends on it.
    pub fn push_line(
        &mut self,
        entry: LineEntry,
        ts: Option<i64>,
        mut probe: impl FnMut(usize) -> Probe,
    ) {
        for (i, view) in self.views.iter_mut().enumerate() {
            view.filter.append_from(
                entry.source(),
                entry.level(),
                entry.is_continuation(),
                || probe(i),
            );
        }
        self.index.push_timed(entry, ts);
    }

    /// Removes the provisional last line, if there is one.
    pub fn retract_provisional(&mut self) {
        if let Some(provisional) = self.provisional.take() {
            self.index.pop();
            self.index.time.restore(provisional.time);
            for view in &mut self.views {
                if let Some(checkpoint) = view.provisional.take() {
                    view.filter.restore(checkpoint);
                }
            }
            self.prev = provisional.prev;
        }
    }

    /// Notes where every view stands before a provisional line is appended.
    pub fn mark_provisional(&mut self, prev: PrevLine) {
        for view in &mut self.views {
            view.provisional = Some(view.filter.checkpoint());
        }
        self.provisional = Some(Provisional {
            prev,
            time: self.index.time.mark(),
        });
    }

    /// Uses a new format right away, with a new view generation so cached spans are void.
    pub fn set_format(&mut self, format: FormatGuess, view_generation: u64) {
        self.format = Arc::new(self.with_rules(&format));
        self.columns_revision += 1;
        for view in &mut self.views {
            view.view_generation = view_generation;
            view.dirty = true;
        }
        self.dirty = true;
    }

    /// Forgets all lines (truncation, rotation without keeping the old lines).
    pub fn reset_index(&mut self) {
        self.index.clear();
        for view in &mut self.views {
            view.filter.clear();
            view.provisional = None;
        }
        self.prev = PrevLine::default();
        self.provisional = None;
        self.epoch += 1;
        self.dirty = true;
    }

    /// The update of view 0.
    pub fn update(&self) -> SessionUpdate {
        self.update_of(&self.views[0])
    }

    pub fn update_of(&self, view: &ViewState) -> SessionUpdate {
        SessionUpdate {
            total_lines: self.index.len() as u64,
            filtered_lines: view.filter.len(self.index.len()) as u64,
            retracted_from: view.filter.retracted(),
            counts: self.index.counts.into(),
            view_counts: view.filter.counts(&self.index.counts).into(),
            status: self.status.clone(),
            file_size: self.file_size,
            epoch: self.epoch,
            view_generation: view.view_generation,
            columns_revision: self.columns_revision,
            filter_pending: view.filter_pending,
            filter_progress: view.filter_progress,
            profile_id: self.profile_id.clone(),
            encoding: self.encoding,
            frozen: self.frozen,
            pending_bytes: self.pending_bytes,
            frozen_stale: self.frozen_stale,
            sources: self.sources.clone(),
            report: self.report.clone(),
        }
    }

    /// Something is waiting to be sent.
    pub fn has_due_updates(&self) -> bool {
        self.dirty || self.views.iter().any(|v| v.dirty || v.behind)
    }

    /// The updates due now, with where they go. Views whose own state did not change hear of a
    /// grown file at most once per `QUIET_VIEW_INTERVAL` (view 0 always, as before). Clears what it
    /// reports, including the retraction of each list.
    pub fn take_updates(&mut self, now: Instant) -> Vec<(ViewSink, SessionUpdate)> {
        let file_dirty = std::mem::take(&mut self.dirty);
        let mut out = Vec::new();
        for i in 0..self.views.len() {
            let view = &self.views[i];
            if view.hidden || !(view.dirty || view.behind || file_dirty) {
                continue;
            }
            let Some(sink) = view.sink.clone() else {
                continue;
            };
            let update = self.update_of(view);
            let quiet = view.id != 0
                && !view.dirty
                && view.last_sent.as_ref().is_some_and(|(sent, at)| {
                    now.duration_since(*at) < QUIET_VIEW_INTERVAL && !differs(sent, &update)
                });
            let view = &mut self.views[i];
            if quiet {
                view.behind = true;
                continue;
            }
            view.dirty = false;
            view.behind = false;
            view.filter.take_retracted();
            view.last_sent = Some((update.clone(), now));
            out.push((sink, update));
        }
        out
    }
}

/// Under the write lock: which views still have the text test their probes were prepared with
/// (before the lock), and how the others read the text again (a filter changed meanwhile, or a view
/// is new). The text of a line is read and decoded at most once for all of them.
pub struct Fresh {
    /// Per view of `SessionData::views`: index into the prepared probes, if they still hold.
    map: Vec<Option<usize>>,
    tests: Vec<TextTest>,
    segments: Vec<Arc<Segment>>,
    reader: Option<LineReader>,
}

impl Fresh {
    pub fn new(data: &SessionData, ids: &[u32], prepared: &[TextTest]) -> Self {
        let tests: Vec<TextTest> = data
            .views
            .iter()
            .map(|v| v.filter.spec.text_test())
            .collect();
        let map: Vec<Option<usize>> = data
            .views
            .iter()
            .zip(&tests)
            .map(|(v, now)| {
                ids.iter()
                    .position(|id| *id == v.id)
                    .filter(|&j| prepared[j].same(now))
            })
            .collect();
        Self {
            map,
            tests,
            segments: data.segments.clone(),
            reader: None,
        }
    }

    /// The probes of one line.
    pub fn line(&mut self, entry: LineEntry) -> FreshLine<'_> {
        FreshLine {
            fresh: self,
            entry,
            text: None,
        }
    }
}

pub struct FreshLine<'a> {
    fresh: &'a mut Fresh,
    entry: LineEntry,
    text: Option<String>,
}

impl FreshLine<'_> {
    /// The probe of view `view`; `prepared` has the probes made before the lock (empty: none hold).
    pub fn probe(&mut self, view: usize, prepared: &[Probe]) -> Probe {
        if let Some(j) = self.fresh.map[view].filter(|&j| j < prepared.len()) {
            return prepared[j];
        }
        if self.fresh.tests[view].is_empty() {
            return Probe::default();
        }
        if self.text.is_none() {
            let fresh = &mut *self.fresh;
            let reader = fresh.reader.get_or_insert_with(|| {
                LineReader::new(fresh.segments.clone(), crate::tail::BLOCK_SIZE)
            });
            self.text = Some(reader.raw(&self.entry, MAX_SEARCH_BYTES).map_or_else(
                |_| String::new(),
                |(raw, enc)| display_text(raw, enc).into_owned(),
            ));
        }
        self.fresh.tests[view].probe_text(
            self.text.as_deref().unwrap_or(""),
            !self.entry.is_continuation(),
        )
    }
}

/// Whether an update says more than that the file grew (lines, counts, sizes, sources, dashboard).
fn differs(sent: &SessionUpdate, next: &SessionUpdate) -> bool {
    let quiet = |u: &SessionUpdate| SessionUpdate {
        total_lines: 0,
        counts: Default::default(),
        file_size: 0,
        pending_bytes: 0,
        sources: Vec::new(),
        report: None,
        ..u.clone()
    };
    quiet(sent) != quiet(next)
}

fn unknown_view(id: u32) -> AppError {
    AppError::new(ErrorCode::UnknownView, format!("no open view {id}"))
}

pub struct Shared {
    pub data: RwLock<SessionData>,
    /// The newest relevel; an older one sees the difference and stops. Filter jobs have one per view.
    job_generation: AtomicU64,
    /// Source of view generations, separate from the jobs so a format change cancels none.
    view_counter: AtomicU64,
    find_generation: AtomicU64,
    pub shutdown: AtomicBool,
    pub wake: Sender<()>,
}

impl Shared {
    fn new(mut data: SessionData, wake: Sender<()>, sink: UpdateSink) -> Self {
        data.views[0].sink = Some(Arc::from(sink));
        Self {
            data: RwLock::new(data),
            job_generation: AtomicU64::new(0),
            view_counter: AtomicU64::new(0),
            find_generation: AtomicU64::new(0),
            shutdown: AtomicBool::new(false),
            wake,
        }
    }

    pub fn next_view_generation(&self) -> u64 {
        self.view_counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn wake(&self) {
        // The receiver is only gone while the session shuts down.
        let _ = self.wake.send(());
    }

    /// Sends what is due (tail and merge workers call this at most every `EMIT_INTERVAL`). `after`
    /// runs under the lock once the updates are taken (one-shot states). Returns whether it sent.
    pub fn emit(&self, after: impl FnOnce(&mut SessionData)) -> bool {
        let updates = {
            let mut data = self.data.write();
            if !data.has_due_updates() {
                return false;
            }
            let updates = data.take_updates(Instant::now());
            after(&mut data);
            updates
        };
        for (sink, update) in updates {
            sink(update);
        }
        true
    }
}

pub struct LogSession {
    pub id: u64,
    /// Empty for a merge: its files are in `sources`.
    pub path: PathBuf,
    sources: Vec<SourceInfo>,
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
    _watchers: Vec<notify::RecommendedWatcher>,
    /// Dashboard (prompt 012): created when a dashboard opens the first time.
    report: Mutex<Option<Arc<ReportDb>>>,
    report_dir: Option<PathBuf>,
    report_limits: ReportLimits,
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
        let report_dir = options.report_dir.clone();
        let report_limits = options.report_limits;
        let detector = Arc::new(default_profile.detector()?);
        let data = SessionData::new(detector, default_profile.id.clone(), meta.len(), &options);
        let (wake, wake_rx): (Sender<()>, Receiver<()>) = channel();
        let shared = Arc::new(Shared::new(data, wake, sink));
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
            sources: Vec::new(),
            shared,
            worker: Mutex::new(Some(worker)),
            _watchers: watcher.into_iter().collect(),
            report: Mutex::new(None),
            report_dir,
            report_limits,
        })
    }

    /// Opens several files as one session, their entries in time order (prompt 006). Checks every
    /// file first (exists, timestamps in the first lines), so an error names the file.
    pub fn open_merged(
        id: u64,
        sources: Vec<MergeSource>,
        options: OpenOptions,
        sink: UpdateSink,
    ) -> AppResult<Self> {
        let worker = MergeWorker::prepare(sources)?;
        let report_dir = options.report_dir.clone();
        let report_limits = options.report_limits;
        let first = worker.first_profile();
        let mut data = SessionData::new(
            Arc::new(first.detector()?),
            first.id.clone(),
            worker.total_size(),
            &options,
        );
        worker.init_data(&mut data);
        let infos = worker.infos();
        let paths = worker.paths();
        let (wake, wake_rx): (Sender<()>, Receiver<()>) = channel();
        let shared = Arc::new(Shared::new(data, wake, sink));
        let watchers = paths
            .iter()
            .filter_map(|p| crate::tail::watch_parent(p, shared.wake.clone()))
            .collect();
        let worker_shared = Arc::clone(&shared);
        let handle = thread::Builder::new()
            .name(format!("merge-{id}"))
            .spawn(move || worker.run(worker_shared, wake_rx))
            .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
        Ok(Self {
            id,
            path: PathBuf::new(),
            sources: infos,
            shared,
            worker: Mutex::new(Some(handle)),
            _watchers: watchers,
            report: Mutex::new(None),
            report_dir,
            report_limits,
        })
    }

    fn is_merge(&self) -> bool {
        !self.sources.is_empty()
    }

    pub fn info(&self) -> SessionInfo {
        let data = self.shared.data.read();
        let file_name = if self.is_merge() {
            self.sources
                .iter()
                .map(|s| s.file_name.as_str())
                .collect::<Vec<_>>()
                .join(" + ")
        } else {
            self.path
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
        };
        SessionInfo {
            session_id: self.id,
            path: self.path.display().to_string(),
            file_name,
            suggested_profile_id: data
                .suggested_profile
                .clone()
                .unwrap_or_else(|| data.profile_id.clone()),
            update: data.update(),
            sources: self.sources.clone(),
        }
    }

    // ---- Dashboard (prompt 012) ----

    /// The dashboard of this tab is shown: creates the database the first time, chooses its fields
    /// (`None`: the numbers) and (re)starts the builder, which catches up every 5 s from now on.
    pub fn open_report(&self, fields: Option<Vec<String>>) -> AppResult<ReportSchema> {
        let db = {
            let mut slot = self.report.lock();
            match slot.as_ref() {
                Some(db) => Arc::clone(db),
                None => {
                    let dir = self.report_dir.as_ref().ok_or_else(|| {
                        AppError::new(ErrorCode::Io, "no cache folder for the dashboard")
                    })?;
                    let names = if self.is_merge() {
                        self.sources.iter().map(|s| s.file_name.clone()).collect()
                    } else {
                        vec![self
                            .path
                            .file_name()
                            .map_or_else(String::new, |n| n.to_string_lossy().into_owned())]
                    };
                    let db = Arc::new(ReportDb::create(dir, self.id, names, self.report_limits)?);
                    *slot = Some(Arc::clone(&db));
                    db
                }
            }
        };
        db.set_fields(fields);
        db.start(Arc::clone(&self.shared), self.id)?;
        self.report_schema()
    }

    /// The dashboard is hidden: the builder stops (the file stays until the session closes).
    pub fn close_report(&self) {
        let db = self.report.lock().clone();
        if let Some(db) = db {
            db.pause();
        }
    }

    /// Whether a dashboard database exists, and whether its builder runs.
    pub fn report_active(&self) -> (bool, bool) {
        match self.report.lock().as_ref() {
            Some(db) => (true, db.is_running()),
            None => (false, false),
        }
    }

    /// The file of the dashboard database, if there is one.
    pub fn report_path(&self) -> Option<PathBuf> {
        self.report
            .lock()
            .as_ref()
            .map(|db| db.path().to_path_buf())
    }

    /// Columns of the table and the fields that could be added, for the help of the editor.
    pub fn report_schema(&self) -> AppResult<ReportSchema> {
        let db = self.report_db()?;
        let (format, status) = {
            let data = self.shared.data.read();
            (Arc::clone(&data.format), data.report.clone())
        };
        Ok(db.schema(&format, status))
    }

    /// One read-only query on the dashboard database; a newer one of the same `slot` stops it. Runs
    /// on its own connection, without the session lock: run it blocking.
    pub fn run_report(&self, sql: &str, slot: &str) -> AppResult<ReportResult> {
        self.report_db()?.query(sql, slot)
    }

    fn report_db(&self) -> AppResult<Arc<ReportDb>> {
        self.report.lock().clone().ok_or_else(|| {
            AppError::new(
                ErrorCode::InvalidQuery,
                "the dashboard of this tab is not open",
            )
        })
    }

    /// Merges all sources again from the start (late entries in place), as a new epoch.
    pub fn resort(&self) -> AppResult<()> {
        if !self.is_merge() {
            return Err(AppError::new(ErrorCode::InvalidMerge, "not a merge"));
        }
        self.shared.data.write().resort_requested = true;
        self.shared.wake();
        Ok(())
    }

    pub fn stats(&self) -> SessionUpdate {
        self.shared.data.read().update()
    }

    /// The current update of a view (`get_stats`).
    pub fn stats_of(&self, view: u32) -> AppResult<SessionUpdate> {
        let data = self.shared.data.read();
        Ok(data.update_of(data.view(view)?))
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

    /// Lines of view 0. `filtered = false` addresses all lines of the file.
    pub fn get_lines(&self, filtered: bool, start: usize, count: usize) -> AppResult<Vec<LogLine>> {
        self.get_lines_of(0, filtered, start, count)
    }

    /// Lines of a view. `filtered = false` addresses all lines of the file (marked as in the view).
    pub fn get_lines_of(
        &self,
        view: u32,
        filtered: bool,
        start: usize,
        count: usize,
    ) -> AppResult<Vec<LogLine>> {
        let count = count.min(MAX_GET_LINES);
        let (lines, segments, matcher, expr, format) = {
            let data = self.shared.data.read();
            let filter = &data.view(view)?.filter;
            let total = data.index.len();
            let mut lines = Vec::with_capacity(count);
            for position in start..start.saturating_add(count) {
                let line = if filtered {
                    filter.line_at(position, total)
                } else {
                    (position < total).then_some(position as u32)
                };
                let Some(line) = line else { break };
                lines.push((line, data.index.entries[line as usize]));
            }
            (
                lines,
                data.segments.clone(),
                filter.spec.matcher.clone(),
                filter.spec.expr.clone().filter(|e| e.highlights()),
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
            let mut matches = matcher
                .as_ref()
                .map_or_else(Vec::new, |m| m.match_ranges(&text));
            if let Some(expr) = &expr {
                // Text conditions of the tree are marked like the search.
                expr.match_ranges(&text, &mut matches);
                matches.sort_unstable();
                matches.truncate(crate::filter::MAX_MATCHES_PER_LINE);
            }
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
                source: entry.source() as u8,
                text,
                is_continuation: entry.is_continuation(),
                truncated,
                matches,
                fields,
            });
        }
        Ok(out)
    }

    /// Applies a new filter to view 0. An unrestricted one is immediate, anything else runs in the
    /// background and a newer call cancels it.
    pub fn set_filter(
        &self,
        levels: &[Level],
        query: &SearchQuery,
        mode: SearchMode,
    ) -> AppResult<FilterInfo> {
        self.set_filter_with_sources(levels, query, mode, None)
    }

    /// Like `set_filter`, plus the visible sources of a merge (bit = source index).
    pub fn set_filter_with_sources(
        &self,
        levels: &[Level],
        query: &SearchQuery,
        mode: SearchMode,
        sources: Option<u16>,
    ) -> AppResult<FilterInfo> {
        self.set_filter_expr(levels, query, mode, sources, None)
    }

    /// The whole filter of view 0 in one call: levels, search, sources and the tree of the sidebar
    /// (prompt 010). An invalid expression changes nothing and names its node in the error.
    pub fn set_filter_expr(
        &self,
        levels: &[Level],
        query: &SearchQuery,
        mode: SearchMode,
        sources: Option<u16>,
        expr: Option<&FilterExpr>,
    ) -> AppResult<FilterInfo> {
        self.set_view_filter(0, self.view_filter(levels, query, mode, sources, expr))
    }

    /// A view's own filter as the commands send it; sources beyond those of the merge mean nothing.
    pub fn view_filter(
        &self,
        levels: &[Level],
        query: &SearchQuery,
        mode: SearchMode,
        sources: Option<u16>,
        expr: Option<&FilterExpr>,
    ) -> ViewFilter {
        ViewFilter {
            levels: LevelMask::from_levels(levels),
            query: query.clone(),
            mode,
            // All sources of the merge set is no filter.
            sources: match sources {
                Some(mask) if self.is_merge() => {
                    let all = (1u32 << self.sources.len()) - 1;
                    if u32::from(mask) & all == all {
                        SourceMask::ALL
                    } else {
                        SourceMask(mask)
                    }
                }
                _ => SourceMask::ALL,
            },
            expr: expr.cloned(),
        }
    }

    /// A new own filter for a view (prompt 013): the views below it follow, each with a job of its
    /// own. Everything is compiled first, so an invalid filter (also one that only fails in the chain
    /// below) changes nothing.
    pub fn set_view_filter(&self, view: u32, own: ViewFilter) -> AppResult<FilterInfo> {
        let (specs, gens) = {
            let data = self.shared.data.read();
            data.view(view)?;
            let affected = subtree(&data, view);
            let mut specs = Vec::with_capacity(affected.len());
            for id in &affected {
                let spec = if *id == view {
                    self.compile_chain(&data, *id, Some(&own))?
                } else {
                    // The new filter of `view` is not stored yet: the chain is built with it.
                    self.compile_chain_with(&data, *id, view, &own)?
                };
                specs.push((*id, spec));
            }
            let gens: Vec<u64> = specs
                .iter()
                .map(|_| self.shared.next_view_generation())
                .collect();
            (specs, gens)
        };
        let mut info = None;
        {
            let mut data = self.shared.data.write();
            data.view_mut(view)?.own = own;
            for ((id, spec), generation) in specs.into_iter().zip(gens) {
                // A view closed meanwhile is simply gone.
                if let Ok(v) = data.view_mut(id) {
                    v.requested_spec = spec;
                    let started = start_view_job(&self.shared, &mut data, id, generation);
                    if id == view {
                        info = started;
                    }
                }
            }
        }
        self.shared.wake();
        info.ok_or_else(|| unknown_view(view))
    }

    /// The parts of the chain above a view, outermost first (closed ancestors included).
    fn chain_of(data: &SessionData, view: u32) -> Vec<&ViewFilter> {
        let mut stack: Vec<&ViewState> = Vec::new();
        let mut at = data.views.iter().find(|v| v.id == view);
        while let Some(v) = at {
            stack.push(v);
            at = v
                .parent
                .and_then(|p| data.views.iter().find(|w| w.id == p && !w.hidden));
        }
        let mut chain = Vec::new();
        for (i, v) in stack.iter().rev().enumerate() {
            chain.extend(v.inherited.iter());
            if i + 1 < stack.len() {
                chain.push(&v.own);
            }
        }
        chain
    }

    /// The compiled effective filter of a view, with `own` instead of its stored own filter if given.
    fn compile_chain(
        &self,
        data: &SessionData,
        view: u32,
        own: Option<&ViewFilter>,
    ) -> AppResult<FilterSpec> {
        let chain = Self::chain_of(data, view);
        let own = match own {
            Some(own) => own,
            None => &data.view(view)?.own,
        };
        self.compile(data, &compose(&chain, own))
    }

    /// Like `compile_chain`, with `changed` (an ancestor) having the filter `own`.
    fn compile_chain_with(
        &self,
        data: &SessionData,
        view: u32,
        changed: u32,
        own: &ViewFilter,
    ) -> AppResult<FilterSpec> {
        let changed_own = &data.view(changed)?.own;
        let chain: Vec<&ViewFilter> = Self::chain_of(data, view)
            .into_iter()
            .map(|part| {
                if std::ptr::eq(part, changed_own) {
                    own
                } else {
                    part
                }
            })
            .collect();
        self.compile(data, &compose(&chain, &data.view(view)?.own))
    }

    fn compile(
        &self,
        data: &SessionData,
        composed: &crate::views::Composed,
    ) -> AppResult<FilterSpec> {
        let expr = match &composed.expr {
            None => None,
            Some(expr) => {
                let reference = reference_time(data);
                let ctx = ExprContext {
                    format: Arc::clone(&data.format),
                    sample: &data.sample,
                    reference,
                };
                Some(Arc::new(CompiledExpr::compile(expr, &ctx)?))
            }
        };
        let matcher = if composed.query.text.is_empty() {
            None
        } else {
            Some(Arc::new(TextMatcher::new(&composed.query)?))
        };
        Ok(FilterSpec {
            levels: composed.levels,
            matcher,
            mode: composed.mode,
            sources: composed.sources,
            expr,
        })
    }

    /// Opens a view below `parent` (prompt 013): the result of the parent, filtered further by `own`.
    /// Its updates go to `sink`. At most `MAX_VIEWS` visible views per session.
    pub fn open_view(&self, parent: u32, own: ViewFilter, sink: UpdateSink) -> AppResult<ViewInfo> {
        let spec = {
            let data = self.shared.data.read();
            data.view(parent)?;
            let visible = data.views.iter().filter(|v| !v.hidden).count();
            if visible >= MAX_VIEWS {
                return Err(AppError::new(
                    ErrorCode::TooManyViews,
                    format!("at most {MAX_VIEWS} views per file"),
                ));
            }
            let chain = {
                let mut chain = Self::chain_of(&data, parent);
                chain.push(&data.view(parent)?.own);
                chain
            };
            self.compile(&data, &compose(&chain, &own))?
        };
        let generation = self.shared.next_view_generation();
        let info = {
            let mut data = self.shared.data.write();
            // Checked again: another view may have opened meanwhile.
            data.view(parent)?;
            if data.views.iter().filter(|v| !v.hidden).count() >= MAX_VIEWS {
                return Err(AppError::new(
                    ErrorCode::TooManyViews,
                    format!("at most {MAX_VIEWS} views per file"),
                ));
            }
            let id = data.next_view_id;
            data.next_view_id += 1;
            let mut view = ViewState::new(id, Some(parent), Some(Arc::from(sink)));
            view.own = own;
            view.requested_spec = spec;
            data.views.push(view);
            start_view_job(&self.shared, &mut data, id, generation);
            let view = data.view(id)?;
            ViewInfo {
                view_id: id,
                parent_view_id: Some(parent),
                update: data.update_of(view),
            }
        };
        self.shared.wake();
        Ok(info)
    }

    /// Closes a view: its children take over its part of the chain and stay the same. View 0 stays
    /// as a hidden identity (no list, no listener) while other views are open.
    pub fn close_view(&self, view: u32) -> AppResult<()> {
        let mut data = self.shared.data.write();
        let index = data
            .views
            .iter()
            .position(|v| v.id == view && !v.hidden)
            .ok_or_else(|| unknown_view(view))?;
        let (parent, handed) = {
            let closing = &data.views[index];
            let mut handed = closing.inherited.clone();
            handed.push(closing.own.clone());
            (closing.parent, handed)
        };
        for child in data.views.iter_mut().filter(|v| v.parent == Some(view)) {
            child.parent = parent;
            let mut inherited = handed.clone();
            inherited.append(&mut child.inherited);
            child.inherited = inherited;
        }
        let closing = &mut data.views[index];
        // A running job of the view stops at its next check.
        closing.job.fetch_add(1, Ordering::SeqCst);
        if view == 0 {
            let total = data.index.len();
            let provisional = data.provisional.is_some();
            let v = &mut data.views[0];
            v.hidden = true;
            v.sink = None;
            v.parent = None;
            v.own = ViewFilter::default();
            v.inherited.clear();
            v.requested_spec = FilterSpec::default();
            v.filter_pending = false;
            v.awaiting_relevel = None;
            set_identity(v, total, provisional);
        } else {
            // Dropping the view drops its sink and with it the channel.
            data.views.remove(index);
        }
        Ok(())
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

    /// The profile the rules of this session belong to: the one of its format (prompt 011).
    pub fn format_profile(&self) -> String {
        self.shared.data.read().format.profile_id.clone()
    }

    /// New extraction rules for the profile of this session's format (prompt 011). They are checked
    /// against the columns of the format; nothing is renamed. Returns the profile they belong to; the
    /// manager applies them to the other sessions of that profile.
    pub fn set_extract_rules(&self, rules: Vec<ExtractRule>) -> AppResult<String> {
        let (profile, book) = {
            let data = self.shared.data.read();
            extract::validate(&rules, data.format.parser.base_columns())?;
            (data.format.profile_id.clone(), Arc::clone(&data.rule_book))
        };
        book.set(&profile, rules);
        self.refresh_rules();
        Ok(profile)
    }

    /// The rules of the profile changed: the format takes them over now, the requested one too.
    /// A new columns revision and view generation make the frontend load columns and lines again.
    pub fn refresh_rules(&self) {
        let view = self.shared.next_view_generation();
        let mut data = self.shared.data.write();
        let current = Arc::clone(&data.format);
        data.set_format((*current).clone(), view);
        if let Some(requested) = data.requested_format.take() {
            data.requested_format = Some(Arc::new(data.with_rules(&requested)));
        }
        drop(data);
        self.shared.wake();
    }

    /// Candidates for extraction rules (prompt 011) from up to `SUGGEST_SAMPLE` entry heads spread
    /// over the whole file, not only its start. Reads the file: run it blocking.
    pub fn suggest_fields(&self) -> AppResult<Vec<FieldSuggestion>> {
        let (entries, segments, format) = {
            let data = self.shared.data.read();
            let total = data.index.len();
            let want = extract::SUGGEST_SAMPLE.min(total);
            let mut entries: Vec<LineEntry> = Vec::with_capacity(want);
            let mut next = 0usize;
            for i in 0..want {
                // Evenly spread; from there the next head, without going back.
                let mut at = (i as u64 * total as u64 / want as u64) as usize;
                at = at.max(next);
                let end = (at + 64).min(total);
                while at < end && data.index.entries[at].is_continuation() {
                    at += 1;
                }
                if at < end {
                    entries.push(data.index.entries[at]);
                    next = at + 1;
                }
            }
            (entries, data.segments.clone(), Arc::clone(&data.format))
        };
        let parser = &format.parser;
        let source = parser.fallback_column().id.clone();
        let source_index = parser
            .columns()
            .iter()
            .position(|c| c.id == source)
            .unwrap_or(0);
        let mut reader = LineReader::new(segments, SCAN_BLOCK);
        let mut texts = Vec::with_capacity(entries.len());
        for entry in &entries {
            let (raw, encoding) = reader
                .raw(entry, fields::MAX_PARSE_BYTES)
                .map_err(|e| AppError::from_io(&e, &self.path))?;
            let text = display_text(raw, encoding).into_owned();
            let value = parser
                .field(&text, source_index)
                .map(str::to_string)
                .unwrap_or_default();
            texts.push(value);
        }
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        Ok(extract::suggest(&refs, parser.columns(), &source))
    }

    /// A chosen profile wins over the suggestion, for the levels and for the layout. The new
    /// columns apply when the levels are recomputed, together with a new view generation.
    pub fn set_profile(&self, profile: &Profile) -> AppResult<FilterInfo> {
        if self.is_merge() {
            // Every source has its own profile, chosen in the merge dialog.
            return Err(AppError::new(
                ErrorCode::InvalidMerge,
                "the profiles of a merge are chosen per file when merging",
            ));
        }
        let detector = Arc::new(profile.detector()?);
        let sample = Arc::clone(&self.shared.data.read().sample);
        let refs: Vec<&str> = sample.iter().map(String::as_str).collect();
        let format = fields::format_for(profile, &refs)?;
        let generation = self.shared.job_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let info = {
            let mut data = self.shared.data.write();
            let format = Arc::new(data.with_rules(&format));
            data.detector = detector;
            data.profile_id = profile.id.clone();
            data.chosen_profile = Some(profile.clone());
            data.requested_format = Some(format);
            data.profile_auto = false;
            data.relevel_needed = true;
            data.dirty = true;
            // Every view waits for the new levels, then filters again.
            let ids: Vec<u32> = data
                .views
                .iter()
                .filter(|v| !v.hidden)
                .map(|v| v.id)
                .collect();
            let mut info = None;
            for id in ids {
                let view_generation = self.shared.next_view_generation();
                let started = start_view_job(&self.shared, &mut data, id, view_generation);
                info = info.or(started);
            }
            info
        };
        let shared = Arc::clone(&self.shared);
        let spawned = thread::Builder::new()
            .name("relevel-job".into())
            .spawn(move || run_relevel(&shared, generation));
        if spawned.is_err() {
            self.shared.data.write().status = Status::Error {
                message: "cannot start the level thread".into(),
            };
        }
        info.ok_or_else(|| unknown_view(0))
    }

    /// Next or previous line with a match in view 0, wrapping around once.
    pub fn find(
        &self,
        from_line: Option<u32>,
        query: &SearchQuery,
        forward: bool,
    ) -> AppResult<Option<FindHit>> {
        self.find_in(0, from_line, query, forward)
    }

    /// Next or previous line with a match in a view, wrapping around once.
    pub fn find_in(
        &self,
        view: u32,
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
            let filter = &data.view(view)?.filter;
            let total = data.index.len();
            let len = filter.len(total);
            let start = match from_line {
                Some(line) => filter.position_of(line, total),
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
            if let Some(hit) = self.scan(view, &matcher, from, to, forward, wrapped, token)? {
                return Ok(Some(hit));
            }
        }
        Ok(None)
    }

    #[allow(clippy::too_many_arguments)]
    fn scan(
        &self,
        view: u32,
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
                // A view closed meanwhile has nothing more to find.
                let Ok(v) = data.view(view) else {
                    return Ok(None);
                };
                let total = data.index.len();
                batch
                    .clone()
                    .filter_map(|p| {
                        let line = v.filter.line_at(p, total)?;
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

    /// Levels per pixel bucket of the current view plus where the given lines are (prompt 007). Reads
    /// the running summary only, no line: a short read lock.
    pub fn overview(&self, buckets: usize, lines: &[u32]) -> AppResult<Overview> {
        self.overview_of(0, buckets, lines)
    }

    /// Like `overview`, for a view.
    pub fn overview_of(&self, view: u32, buckets: usize, lines: &[u32]) -> AppResult<Overview> {
        if buckets > MAX_OVERVIEW_BUCKETS || lines.len() > MAX_OVERVIEW_LINES {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                format!(
                    "at most {MAX_OVERVIEW_BUCKETS} buckets and {MAX_OVERVIEW_LINES} lines per overview"
                ),
            ));
        }
        let data = self.shared.data.read();
        let v = data.view(view)?;
        let filter = &v.filter;
        let total = data.index.len();
        let count = filter.len(total);
        let summary = filter.summary().unwrap_or(&data.index.summary);
        let marks = lines
            .iter()
            .map(|&line| {
                let position = filter.position_of(line, total);
                OverviewMark {
                    line,
                    position: position as u32,
                    visible: filter.line_at(position, total) == Some(line),
                }
            })
            .collect();
        let laid = summary.buckets(count as u64, buckets);
        Ok(Overview {
            view_generation: v.view_generation,
            epoch: data.epoch,
            count: count as u64,
            buckets: laid.bits,
            density: laid.density,
            marks,
        })
    }

    /// Next (or previous) entry head of one of `levels` in the current view, strictly after (before)
    /// `from_position` or from the start (end), wrapping around once. Chunks of the summary without
    /// such a level are skipped, no text is read. Continuations do not count: a stack trace is one hit.
    pub fn find_level(
        &self,
        from_position: Option<u32>,
        forward: bool,
        levels: &[Level],
    ) -> Option<FindHit> {
        self.find_level_in(0, from_position, forward, levels)
            .ok()
            .flatten()
    }

    /// Like `find_level`, in a view.
    pub fn find_level_in(
        &self,
        view: u32,
        from_position: Option<u32>,
        forward: bool,
        levels: &[Level],
    ) -> AppResult<Option<FindHit>> {
        let mask = levels.iter().fold(0u8, |m, l| m | level_bit(*l));
        if mask == 0 {
            return Ok(None);
        }
        let data = self.shared.data.read();
        let filter = &data.view(view)?.filter;
        let total = data.index.len();
        let count = filter.len(total) as u64;
        let summary = filter.summary().unwrap_or(&data.index.summary);
        let Some((position, wrapped)) =
            summary.find(count, from_position.map(u64::from), forward, mask, |p| {
                let Some(line) = filter.line_at(p as usize, total) else {
                    return false;
                };
                let entry = data.index.entries[line as usize];
                (line == 0 || !entry.is_continuation()) && mask & level_bit(entry.level()) != 0
            })
        else {
            return Ok(None);
        };
        Ok(filter
            .line_at(position as usize, total)
            .map(|line| FindHit {
                line,
                position: position as u32,
                wrapped,
            }))
    }

    /// The timeline (prompt 014): entries of the whole file over time, from the running time
    /// summary of the index; `from`/`to` `None` is the whole file (percentile axis). A read lock only.
    pub fn timeline(
        &self,
        from: Option<i64>,
        to: Option<i64>,
        buckets: usize,
    ) -> AppResult<Timeline> {
        if buckets > MAX_TIMELINE_BUCKETS {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                format!("at most {MAX_TIMELINE_BUCKETS} buckets per timeline"),
            ));
        }
        let data = self.shared.data.read();
        let time = &data.index.time;
        let laid = time.timeline(&TimelineQuery {
            from,
            to,
            buckets,
            anchors: TIMELINE_ANCHORS,
        });
        let has_times = laid.min.is_some();
        Ok(Timeline {
            epoch: data.epoch,
            total_lines: data.index.len() as u64,
            entries: laid.entries,
            has_times,
            from: laid.from,
            to: laid.to,
            buckets: laid
                .buckets
                .iter()
                .map(|b| TimelineBucket {
                    all: b.all,
                    warn: b.warn,
                    error: b.error,
                    fatal: b.fatal,
                })
                .collect(),
            gaps: laid
                .gaps
                .iter()
                .map(|&(from, to)| TimeRange { from, to })
                .collect(),
            min: laid.min,
            max: laid.max,
            before: laid.before,
            after: laid.after,
            untimed: laid.untimed,
            anchors: laid
                .anchors
                .iter()
                .map(|&(line, ts)| TimeAnchor {
                    line: line as u32,
                    ts,
                })
                .collect(),
        })
    }

    /// The first entry head at or after `ts` in a view (prompt 014): the chunk from the time
    /// summary, then its heads read and parsed. A hidden line gives the next visible one. `None`
    /// when the file has no times; after the last time, the last line.
    pub fn position_at_time(&self, view: u32, ts: i64) -> AppResult<Option<TimeHit>> {
        let (range, entries, segments, mut clock) = {
            let data = self.shared.data.read();
            data.view(view)?;
            let time = &data.index.time;
            if !time.has_times() || data.index.is_empty() {
                return Ok(None);
            }
            let Some((start, end)) = time.chunk_reaching(ts) else {
                let last = data.index.len() as u32 - 1;
                drop(data);
                return self.time_hit(view, last, false);
            };
            let (start, end) = (start as usize, end as usize);
            let clock = TimestampParser::detect(
                data.sample.iter().map(String::as_str),
                reference_time(&data),
            );
            (
                start,
                data.index.entries[start..end.min(data.index.len())].to_vec(),
                data.segments.clone(),
                clock,
            )
        };
        let mut reader = LineReader::new(segments, SCAN_BLOCK);
        let mut found = None;
        for (i, entry) in entries.iter().enumerate() {
            if entry.is_continuation() && range + i > 0 {
                continue;
            }
            let Ok((raw, encoding)) = reader.raw(entry, fields::MAX_PARSE_BYTES) else {
                continue;
            };
            let text = detection_bytes(raw, encoding);
            if crate::merge::time_of(&mut clock, &text).is_some_and(|t| t >= ts) {
                found = Some(range + i);
                break;
            }
        }
        let exact = found.is_some();
        self.time_hit(view, found.unwrap_or(range) as u32, exact)
    }

    fn time_hit(&self, view: u32, line: u32, exact: bool) -> AppResult<Option<TimeHit>> {
        let data = self.shared.data.read();
        let total = data.index.len();
        let filter = &data.view(view)?.filter;
        let position = filter.position_of(line, total);
        let count = filter.len(total);
        if count == 0 {
            return Ok(None);
        }
        let position = position.min(count - 1);
        Ok(Some(TimeHit {
            line: filter.line_at(position, total).unwrap_or(line),
            position: position as u32,
            exact,
        }))
    }

    /// Position of a line in view 0 (or of the next visible line after it).
    pub fn position_of_line(&self, line: u32) -> u32 {
        self.position_in(0, line).unwrap_or(0)
    }

    /// Position of a line in a view (or of the next visible line after it).
    pub fn position_in(&self, view: u32, line: u32) -> AppResult<u32> {
        let data = self.shared.data.read();
        Ok(data.view(view)?.filter.position_of(line, data.index.len()) as u32)
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
        let mut reader = LineReader::new(segments.clone(), SCAN_BLOCK);
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
        let byte_offset =
            segment_of(&segments, first_entry.offset).map_or(0, |s| first_entry.offset - s.base);
        Ok(EntryDetail {
            first: first as u32,
            last: (first + lines.len() - 1) as u32,
            level: first_entry.level(),
            line_count: lines.len() as u32,
            total_bytes: lines.iter().map(|e| u64::from(e.len)).sum(),
            text,
            truncated,
            source: first_entry.source() as u8,
            byte_offset,
        })
    }

    /// The visible lines of view 0 between two line numbers as text, for the clipboard.
    pub fn copy_lines(&self, first: u32, last: u32) -> AppResult<String> {
        self.copy(Some(0), first, last)
    }

    /// The lines of a view between two line numbers as text.
    pub fn copy_lines_of(&self, view: u32, first: u32, last: u32) -> AppResult<String> {
        self.copy(Some(view), first, last)
    }

    /// All lines between two line numbers, whatever the filter hides (an entry of the detail panel).
    pub fn copy_all_lines(&self, first: u32, last: u32) -> AppResult<String> {
        self.copy(None, first, last)
    }

    fn copy(&self, view: Option<u32>, first: u32, last: u32) -> AppResult<String> {
        let (lines, segments) = {
            let data = self.shared.data.read();
            let total = data.index.len();
            let filter = match view {
                Some(view) => Some(&data.view(view)?.filter),
                None => None,
            };
            let (from, to) = if let Some(filter) = filter {
                let from = filter.position_of(first, total);
                let to = filter
                    .position_of(last.saturating_add(1), total)
                    .min(filter.len(total));
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
            let lines = if let Some(filter) = filter {
                (from..to)
                    .filter_map(|p| filter.line_at(p, total))
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
        // Stops a running relevel at its next check; filter jobs look at `shutdown`.
        self.shared.job_generation.fetch_add(1, Ordering::SeqCst);
        self.shared.wake();
        if let Some(report) = self.report.lock().take() {
            // Stops the builder at its next batch and deletes the file.
            report.shutdown();
        }
        if let Some(worker) = self.worker.lock().take() {
            let _ = worker.join();
        }
    }
}

/// Plain bytes of a line for the level detection: decoded for UTF-16, without ANSI colours.
/// Date for logs that only write a time of day: the modification time of the first file.
pub fn reference_time(data: &SessionData) -> std::time::SystemTime {
    data.segments
        .first()
        .and_then(|s| s.file.metadata().ok()?.modified().ok())
        .unwrap_or_else(std::time::SystemTime::now)
}

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

/// The view and every view below it, parents before children.
fn subtree(data: &SessionData, view: u32) -> Vec<u32> {
    let mut out = vec![view];
    let mut i = 0;
    while i < out.len() {
        let at = out[i];
        out.extend(
            data.views
                .iter()
                .filter(|v| v.parent == Some(at) && !v.hidden)
                .map(|v| v.id),
        );
        i += 1;
    }
    out
}

/// Swaps in an identity list covering all lines; with a provisional last line its checkpoint, too.
fn set_identity(view: &mut ViewState, total: usize, provisional: bool) {
    let spec = view.requested_spec.clone();
    view.provisional = (provisional && total > 0)
        .then(|| FilteredLines::identity(spec.clone(), total - 1).checkpoint());
    view.filter = FilteredLines::identity(spec, total);
}

/// Starts the filter job of a view for its `requested_spec` (under the write lock). An identity is
/// immediate; while a relevel runs the job waits for it. Returns what `set_filter` answers.
fn start_view_job(
    shared: &Arc<Shared>,
    data: &mut SessionData,
    id: u32,
    view_generation: u64,
) -> Option<FilterInfo> {
    let relevel = data.relevel_needed;
    let total = data.index.len();
    let provisional = data.provisional.is_some();
    let view = data.view_mut(id).ok()?;
    let generation = view.job.fetch_add(1, Ordering::SeqCst) + 1;
    view.dirty = true;
    if !relevel && view.requested_spec.is_identity() {
        set_identity(view, total, provisional);
        view.view_generation = view_generation;
        view.filter_pending = false;
        view.filter_progress = 1.0;
        view.awaiting_relevel = None;
        return Some(FilterInfo {
            view_generation,
            pending: false,
            filtered_lines: total as u64,
        });
    }
    view.filter_pending = true;
    view.filter_progress = 0.0;
    let info = FilterInfo {
        view_generation,
        pending: true,
        filtered_lines: view.filter.len(total) as u64,
    };
    if relevel {
        view.awaiting_relevel = Some(view_generation);
        return Some(info);
    }
    view.awaiting_relevel = None;
    let job = Arc::clone(&view.job);
    let worker = Arc::clone(shared);
    let spawned = thread::Builder::new()
        .name("filter-job".into())
        .spawn(move || run_filter(&worker, id, &job, generation, view_generation));
    if spawned.is_err() {
        view.filter_pending = false;
        data.status = Status::Error {
            message: "cannot start the filter thread".into(),
        };
    }
    Some(info)
}

/// Detects the levels of all lines again after a profile change. Lines arriving meanwhile already
/// use the new detector. Then the new format applies and every view filters again. Returns false if
/// cancelled.
fn run_relevel(shared: &Arc<Shared>, generation: u64) -> bool {
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
    // The summary of the index cannot take back old levels: a new one grows alongside and is swapped in.
    let mut summary = LevelSummary::new();
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
            if !is_current(shared, generation) {
                return false;
            }
            if data.epoch == epoch {
                data.prev = prev;
                // Lines that came in meanwhile already carry the new levels.
                let len = data.index.len();
                summary.truncate(len as u64);
                for entry in &data.index.entries[summary.len() as usize..len] {
                    summary.push(entry.level());
                }
                data.index.summary = summary;
                // Entry counts per chunk of the timeline (prompt 014); its times stay.
                let index = &mut data.index;
                index.time.recount(&index.entries);
            }
            data.relevel_needed = false;
            // The columns change with new view generations, so cached spans are void.
            if let Some(format) = data.requested_format.take() {
                data.format = format;
                data.columns_revision += 1;
                for view in &mut data.views {
                    view.view_generation = shared.next_view_generation();
                    view.dirty = true;
                }
            }
            let waiting: Vec<(u32, u64)> = data
                .views
                .iter()
                .filter_map(|v| v.awaiting_relevel.map(|g| (v.id, g)))
                .collect();
            for (id, view_generation) in waiting {
                start_view_job(shared, &mut data, id, view_generation);
            }
            data.dirty = true;
            drop(data);
            shared.wake();
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
        for entry in &updated {
            summary.push(entry.level());
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

/// Builds the filtered list of a view for its requested spec without holding up the reader or the
/// tail, and swaps it in at the end. `job` is the view's job counter: a newer job stops this one.
fn run_filter(shared: &Shared, view: u32, job: &AtomicU64, generation: u64, view_generation: u64) {
    let current =
        || job.load(Ordering::SeqCst) == generation && !shared.shutdown.load(Ordering::SeqCst);
    'restart: loop {
        let (spec, epoch, segments) = {
            let data = shared.data.read();
            let Ok(v) = data.view(view) else { return };
            (v.requested_spec.clone(), data.epoch, data.segments.clone())
        };
        let test = spec.text_test();
        let mut builder = FilteredLines::new(spec);
        let mut reader = LineReader::new(segments, SCAN_BLOCK);
        let mut position = 0usize;
        loop {
            if !current() {
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
                feed(&mut builder, entry, &mut reader, &test);
            }
            position += batch.len();
            {
                let mut data = shared.data.write();
                if let Ok(v) = data.view_mut(view) {
                    v.filter_progress = position as f32 / total.max(1) as f32;
                    v.dirty = true;
                }
            }
            shared.wake();
        }
        let mut data = shared.data.write();
        if !current() {
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
        let provisional = data.provisional.is_some();
        let before_provisional = total - usize::from(provisional);
        for line in position..before_provisional {
            let entry = data.index.entries[line];
            feed(&mut builder, &entry, &mut reader, &test);
        }
        let checkpoint = provisional.then(|| builder.checkpoint());
        for line in before_provisional..total {
            let entry = data.index.entries[line];
            feed(&mut builder, &entry, &mut reader, &test);
        }
        let Ok(v) = data.view_mut(view) else { return };
        v.provisional = checkpoint;
        v.filter = builder;
        v.view_generation = view_generation;
        v.filter_pending = false;
        v.filter_progress = 1.0;
        v.dirty = true;
        drop(data);
        shared.wake();
        return;
    }
}

fn feed(builder: &mut FilteredLines, entry: &LineEntry, reader: &mut LineReader, test: &TextTest) {
    builder.append_from(
        entry.source(),
        entry.level(),
        entry.is_continuation(),
        || {
            reader.raw(entry, MAX_SEARCH_BYTES).map_or_else(
                |_| Probe::default(),
                |(raw, encoding)| test.probe_raw(raw, encoding, !entry.is_continuation()),
            )
        },
    );
}

/// The open sessions and the profiles they can use (Tauri state).
pub struct SessionManager {
    sessions: RwLock<HashMap<u64, Arc<LogSession>>>,
    next_id: AtomicU64,
    profiles: RwLock<ProfileRegistry>,
    rules: Arc<RuleBook>,
    /// Folder for dashboard databases (prompt 012), set at start.
    report_dir: RwLock<Option<PathBuf>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            profiles: RwLock::new(ProfileRegistry::default()),
            rules: Arc::default(),
            report_dir: RwLock::new(None),
        }
    }
}

impl SessionManager {
    pub fn open(
        &self,
        path: &Path,
        mut options: OpenOptions,
        sink: UpdateSink,
    ) -> AppResult<SessionInfo> {
        options.rules = Arc::clone(&self.rules);
        if options.report_dir.is_none() {
            options.report_dir = self.report_dir.read().clone();
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let default_profile = self.profiles.read().find(crate::profile::GENERIC_PROFILE)?;
        let session = LogSession::open(id, path, options, &default_profile, sink)?;
        let info = session.info();
        self.sessions.write().insert(id, Arc::new(session));
        Ok(info)
    }

    pub fn open_merged(
        &self,
        sources: Vec<MergeSource>,
        mut options: OpenOptions,
        sink: UpdateSink,
    ) -> AppResult<SessionInfo> {
        options.rules = Arc::clone(&self.rules);
        if options.report_dir.is_none() {
            options.report_dir = self.report_dir.read().clone();
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let session = LogSession::open_merged(id, sources, options, sink)?;
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

    /// The folder of this process for dashboard databases (prompt 012).
    pub fn set_report_dir(&self, dir: PathBuf) {
        *self.report_dir.write() = Some(dir);
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

    /// Rules for the profile of a session (prompt 011), right away for every open session of that
    /// profile. Returns the columns of the session.
    pub fn set_extract_rules(&self, id: u64, rules: Vec<ExtractRule>) -> AppResult<ColumnSet> {
        let session = self.session(id)?;
        let profile = session.set_extract_rules(rules)?;
        for other in self.sessions.read().values() {
            if other.id != id && other.format_profile() == profile {
                other.refresh_rules();
            }
        }
        Ok(session.columns())
    }

    /// All rules from the settings, at start; open sessions take them over.
    pub fn load_extract_rules(&self, all: HashMap<String, Vec<ExtractRule>>) {
        self.rules.load(all);
        for session in self.sessions.read().values() {
            session.refresh_rules();
        }
    }
}
