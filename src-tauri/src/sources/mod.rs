//! Sources without a file of their own (prompt 016): each writes into a spool (`spool.rs`) on a
//! thread of its own, and the session follows the spool like a file. Syslog is the first; SFTP (017),
//! Windows events (018) and databases (019) plug in the same way:
//!
//! 1. a config variant in `SourceConfig` (no secrets in it: those come from the keychain),
//! 2. `prepare` checks it and does what can fail visibly (bind a port, connect, authenticate), so
//!    the open dialog shows the error,
//! 3. `Source::run` receives or pulls until the `StopToken` says stop, writes complete lines with the
//!    `SpoolWriter` (receivers drop when the spool is full, pullers may wait) and reports its state
//!    and counters through the `SourceMonitor`.
//!
//! `RunningSource` owns the thread and the spool: stopping the source flushes the spool, dropping it
//! deletes the spool unless it is kept.

pub mod syslog;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{SourceDescriptor, SourceKind, SourceState, SourceStatus};
use crate::spool::{
    remove_spool_dir, Spool, SpoolConfig, SpoolStats, SpoolWriter, StopToken, KEEP_MARKER,
};
use parking_lot::Mutex;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Sources open at the same time; with the spool limit this bounds the disk use of all of them.
pub const MAX_SOURCES: usize = 8;

/// Counters change many times a second; the session hears of it at most this often.
const NOTIFY_INTERVAL: Duration = Duration::from_millis(200);

/// What the open dialog sends: the kind and its settings.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceConfig {
    Syslog(syslog::SyslogConfig),
}

/// A source that writes lines into a spool.
pub trait Source: Send + 'static {
    fn kind(&self) -> SourceKind;
    /// Shown as the tab's name: "Syslog :5514".
    fn label(&self) -> String;
    /// The configuration as opened (bound port included), for the descriptor and saved sources.
    fn config(&self) -> serde_json::Value;
    /// The profile for the spool's lines, if the source knows it.
    fn profile(&self) -> Option<&'static str> {
        None
    }
    /// Runs until `ctx.stop` is set; on its own thread.
    fn run(self: Box<Self>, ctx: SourceContext);
}

/// What a running source gets.
pub struct SourceContext {
    pub writer: SpoolWriter,
    pub stop: StopToken,
    pub monitor: Arc<SourceMonitor>,
}

/// Checks a configuration and prepares the source (ports are bound here).
pub fn prepare(config: SourceConfig) -> AppResult<Box<dyn Source>> {
    match config {
        SourceConfig::Syslog(config) => Ok(Box::new(syslog::SyslogSource::bind(config)?)),
    }
}

type Notify = Box<dyn Fn() + Send + Sync>;

/// State and counters of a running source, read by the session for its updates.
pub struct SourceMonitor {
    state: Mutex<SourceState>,
    pub received: AtomicU64,
    pub truncated: AtomicU64,
    pub rejected: AtomicU64,
    pub connections: AtomicU32,
    spool: Arc<SpoolStats>,
    notify: Mutex<Option<Notify>>,
    /// Milliseconds since `created` of the last notification by a counter.
    last_notify: AtomicU64,
    pending: AtomicBool,
    /// The state is `Error`: the next success sets it back (`recovered`), without a lock per message.
    in_error: AtomicBool,
    created: Instant,
}

impl std::fmt::Debug for SourceMonitor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceMonitor")
            .field("status", &self.status())
            .finish()
    }
}

impl SourceMonitor {
    pub fn new(spool: Arc<SpoolStats>) -> Self {
        Self {
            state: Mutex::new(SourceState::Connecting),
            received: AtomicU64::new(0),
            truncated: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            connections: AtomicU32::new(0),
            spool,
            notify: Mutex::new(None),
            last_notify: AtomicU64::new(0),
            pending: AtomicBool::new(false),
            in_error: AtomicBool::new(false),
            created: Instant::now(),
        }
    }

    /// Where updates go (the session marks itself dirty and wakes its worker).
    pub fn set_notify(&self, notify: Notify) {
        *self.notify.lock() = Some(notify);
    }

    pub fn state(&self) -> SourceState {
        self.state.lock().clone()
    }

    pub fn set_state(&self, state: SourceState) {
        {
            let mut current = self.state.lock();
            if *current == state {
                return;
            }
            self.in_error.store(
                matches!(state, SourceState::Error { .. }),
                Ordering::Relaxed,
            );
            *current = state;
        }
        self.notify_now();
    }

    /// Something worked again (a datagram, a connection): an error state goes back to `state`.
    pub fn recovered(&self, state: SourceState) {
        if self.in_error.load(Ordering::Relaxed) {
            self.set_state(state);
        }
    }

    /// A counter changed: tells the session, at most every `NOTIFY_INTERVAL`. A change in between is
    /// picked up by the next update anyway (the counters are read when it is built), or by `flush`.
    pub fn counted(&self) {
        let now = self.created.elapsed().as_millis() as u64;
        let last = self.last_notify.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= NOTIFY_INTERVAL.as_millis() as u64
            && self
                .last_notify
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            self.pending.store(false, Ordering::Relaxed);
            self.notify_now();
        } else {
            self.pending.store(true, Ordering::Relaxed);
        }
    }

    /// Sends a notification held back by `counted` (receivers call this when they are idle).
    pub fn flush(&self) {
        if self.pending.swap(false, Ordering::Relaxed) {
            self.last_notify
                .store(self.created.elapsed().as_millis() as u64, Ordering::Relaxed);
            self.notify_now();
        }
    }

    fn notify_now(&self) {
        if let Some(notify) = self.notify.lock().as_ref() {
            notify();
        }
    }

    pub fn status(&self) -> SourceStatus {
        SourceStatus {
            state: self.state(),
            received: self.received.load(Ordering::Relaxed),
            dropped: self.spool.dropped.load(Ordering::Relaxed),
            truncated: self.truncated.load(Ordering::Relaxed),
            rejected: self.rejected.load(Ordering::Relaxed),
            connections: self.connections.load(Ordering::Relaxed),
            spooled: self.spool.lines.load(Ordering::Relaxed),
            spool_error: self.spool.error.lock().clone(),
        }
    }
}

/// A started source with its spool. Stops on drop and deletes the spool unless it is kept.
pub struct RunningSource {
    descriptor: Mutex<SourceDescriptor>,
    profile: Option<&'static str>,
    stop: StopToken,
    thread: Mutex<Option<JoinHandle<()>>>,
    spool: Mutex<Spool>,
    dir: PathBuf,
    monitor: Arc<SourceMonitor>,
    /// Where a kept spool moves when the session closes (`<cache>/spool/kept`).
    kept_root: Option<PathBuf>,
}

impl RunningSource {
    /// Creates the spool and starts the source on a thread of its own.
    pub fn start(
        source: Box<dyn Source>,
        spool: SpoolConfig,
        keep: bool,
        kept_root: Option<PathBuf>,
    ) -> AppResult<Self> {
        let dir = spool.dir.clone();
        let spool = Spool::start(spool)?;
        let monitor = Arc::new(SourceMonitor::new(Arc::clone(spool.stats())));
        let descriptor = SourceDescriptor {
            kind: source.kind(),
            label: source.label(),
            spool_path: spool.path().display().to_string(),
            keep,
            config: source.config(),
        };
        let profile = source.profile();
        let stop = StopToken::default();
        let ctx = SourceContext {
            writer: spool.writer(),
            stop: stop.clone(),
            monitor: Arc::clone(&monitor),
        };
        let thread = std::thread::Builder::new()
            .name(format!("source-{}", descriptor.label))
            .spawn(move || {
                // A bug in a source must not end receiving silently: its state says so.
                let monitor = Arc::clone(&ctx.monitor);
                let run =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| source.run(ctx)));
                if run.is_err() {
                    monitor.set_state(SourceState::Error {
                        message: "the source stopped unexpectedly".into(),
                    });
                }
            })
            .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
        let running = Self {
            descriptor: Mutex::new(descriptor),
            profile,
            stop,
            thread: Mutex::new(Some(thread)),
            spool: Mutex::new(spool),
            dir,
            monitor,
            kept_root,
        };
        if keep {
            running.set_keep(true);
        }
        Ok(running)
    }

    pub fn descriptor(&self) -> SourceDescriptor {
        self.descriptor.lock().clone()
    }

    pub fn profile(&self) -> Option<&'static str> {
        self.profile
    }

    pub fn monitor(&self) -> &Arc<SourceMonitor> {
        &self.monitor
    }

    pub fn spool_path(&self) -> PathBuf {
        self.spool.lock().path()
    }

    /// Files the spool keeps (current one included).
    pub fn max_files(&self) -> usize {
        self.spool.lock().config().max_files
    }

    pub fn spool_dir(&self) -> &Path {
        &self.dir
    }

    /// The marker file is written at once, so a crash keeps the spool too.
    pub fn set_keep(&self, keep: bool) {
        self.descriptor.lock().keep = keep;
        let marker = self.dir.join(KEEP_MARKER);
        if keep {
            let _ = std::fs::write(marker, "");
        } else {
            let _ = std::fs::remove_file(marker);
        }
    }

    pub fn keep(&self) -> bool {
        self.descriptor.lock().keep
    }

    /// Ends receiving (the port is free afterwards) and writes what is queued. The spool stays
    /// until the source is dropped.
    pub fn stop(&self) {
        self.stop.stop();
        if let Some(thread) = self.thread.lock().take() {
            let _ = thread.join();
        }
        self.spool.lock().close();
        self.monitor.set_state(SourceState::Stopped);
    }
}

impl Drop for RunningSource {
    fn drop(&mut self) {
        self.stop();
        if self.keep() {
            keep_spool(
                &self.dir,
                self.kept_root.as_deref(),
                &self.descriptor.lock().label,
            );
        } else if !remove_spool_dir(&self.dir) {
            eprintln!("spool not removed: {}", self.dir.display());
        }
    }
}

/// Marks a spool as kept and moves it under `kept_root` with a readable name. If the move fails
/// (Windows: still open) the marker keeps it in place.
fn keep_spool(dir: &Path, kept_root: Option<&Path>, label: &str) {
    let _ = std::fs::write(dir.join(KEEP_MARKER), "");
    let Some(root) = kept_root else { return };
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    for n in 0..100 {
        let target = if n == 0 {
            root.join(format!("{stamp}-{name}"))
        } else {
            root.join(format!("{stamp}-{name}-{n}"))
        };
        if target.exists() {
            continue;
        }
        let _ = std::fs::create_dir_all(root);
        if std::fs::rename(dir, &target).is_ok() {
            return;
        }
        break;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Lines(Vec<&'static str>);

    impl Source for Lines {
        fn kind(&self) -> SourceKind {
            SourceKind::Syslog
        }
        fn label(&self) -> String {
            "Test :1".into()
        }
        fn config(&self) -> serde_json::Value {
            serde_json::json!({})
        }
        fn run(self: Box<Self>, ctx: SourceContext) {
            ctx.monitor.set_state(SourceState::Listening);
            for line in self.0 {
                ctx.writer.try_line(line.as_bytes().to_vec());
                ctx.monitor.received.fetch_add(1, Ordering::Relaxed);
            }
            while !ctx.stop.is_stopped() {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    #[test]
    fn runs_writes_stops_and_removes_the_spool() {
        let dir = tempfile::tempdir().unwrap();
        let spool = dir.path().join("source-1");
        let running = RunningSource::start(
            Box::new(Lines(vec!["a", "b"])),
            SpoolConfig::sized(spool.clone(), 1024, 4),
            false,
            None,
        )
        .unwrap();
        let notified = Arc::new(AtomicUsize::new(0));
        let n = Arc::clone(&notified);
        running.monitor().set_notify(Box::new(move || {
            n.fetch_add(1, Ordering::SeqCst);
        }));
        let start = Instant::now();
        while running.monitor().status().spooled < 2 {
            assert!(start.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
        running.stop();
        assert_eq!(running.monitor().state(), SourceState::Stopped);
        assert!(notified.load(Ordering::SeqCst) >= 1);
        assert_eq!(
            std::fs::read_to_string(spool.join("spool.log")).unwrap(),
            "a\nb\n"
        );
        drop(running);
        assert!(!spool.exists());
    }

    struct Panics;

    impl Source for Panics {
        fn kind(&self) -> SourceKind {
            SourceKind::Syslog
        }
        fn label(&self) -> String {
            "Panics".into()
        }
        fn config(&self) -> serde_json::Value {
            serde_json::json!({})
        }
        fn run(self: Box<Self>, _ctx: SourceContext) {
            panic!("a bug in a source");
        }
    }

    #[test]
    fn a_panicking_source_shows_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let running = RunningSource::start(
            Box::new(Panics),
            SpoolConfig::sized(dir.path().join("s"), 1024, 4),
            false,
            None,
        )
        .unwrap();
        let start = Instant::now();
        while !matches!(running.monitor().state(), SourceState::Error { .. }) {
            assert!(start.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_kept_spool_moves_to_the_kept_folder() {
        let dir = tempfile::tempdir().unwrap();
        let spool = dir.path().join("source-1");
        let kept = dir.path().join("kept");
        let running = RunningSource::start(
            Box::new(Lines(vec!["x"])),
            SpoolConfig::sized(spool.clone(), 1024, 4),
            false,
            Some(kept.clone()),
        )
        .unwrap();
        running.set_keep(true);
        drop(running);
        assert!(!spool.exists());
        let moved: Vec<_> = std::fs::read_dir(&kept).unwrap().flatten().collect();
        assert_eq!(moved.len(), 1);
        let name = moved[0].file_name().to_string_lossy().into_owned();
        assert!(name.ends_with("-Test-1"), "{name}");
        assert_eq!(
            std::fs::read_to_string(moved[0].path().join("spool.log")).unwrap(),
            "x\n"
        );
        assert!(moved[0].path().join(KEEP_MARKER).exists());
    }

    #[test]
    fn counters_notify_at_most_every_interval() {
        let monitor = SourceMonitor::new(Arc::default());
        let notified = Arc::new(AtomicUsize::new(0));
        let n = Arc::clone(&notified);
        monitor.set_notify(Box::new(move || {
            n.fetch_add(1, Ordering::SeqCst);
        }));
        // The first one after the interval since creation.
        std::thread::sleep(NOTIFY_INTERVAL);
        for _ in 0..1000 {
            monitor.counted();
        }
        assert_eq!(notified.load(Ordering::SeqCst), 1);
        monitor.flush();
        assert_eq!(notified.load(Ordering::SeqCst), 2);
        monitor.flush();
        assert_eq!(notified.load(Ordering::SeqCst), 2);
        monitor.set_state(SourceState::Listening);
        monitor.set_state(SourceState::Listening);
        assert_eq!(notified.load(Ordering::SeqCst), 3);
        // An error goes back once something works again; otherwise nothing happens.
        monitor.recovered(SourceState::Listening);
        assert_eq!(notified.load(Ordering::SeqCst), 3);
        monitor.set_state(SourceState::Error {
            message: "x".into(),
        });
        monitor.recovered(SourceState::Listening);
        assert_eq!(monitor.state(), SourceState::Listening);
        assert_eq!(notified.load(Ordering::SeqCst), 5);
    }
}
