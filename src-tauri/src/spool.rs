//! The spool (prompt 016): sources without a file of their own (syslog, later SFTP, Windows events,
//! databases) write their lines into a file in the app's cache folder, and the session follows that
//! file like any other. Index, tail, rotation, filter, search, freeze, export and merge need no code
//! of their own for them.
//!
//! - `SpoolWriter` is what a source holds: it hands complete lines to a bounded queue and never blocks
//!   a receiving thread (`try_line`; when the queue is full the line is dropped and counted).
//!   Pull-based sources may wait instead (`line_blocking`).
//! - A writer thread owns the files (`SpoolFiles`): buffered, flushed at least every 100 ms, rotated
//!   at `rotate_bytes` (rename to `spool-NNNNNN.log`, new `spool.log`: the case `switch_file` in
//!   `tail.rs` already handles) and at most `max_files` files, the oldest deleted.
//!
//! The session keeps the handles of rotated files open (virtual offsets), so a deleted spool file
//! would keep its disk space until the session lets go. The session of a spool therefore starts over
//! once it holds `max_files` files (`OpenOptions::max_segments`), see `SpoolConfig::max_files`.

use crate::error::{AppError, AppResult, ErrorCode};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const MIB: u64 = 1024 * 1024;
/// Rotation size of the spool files (prompt 016), unless the total limit asks for smaller ones.
pub const ROTATE_BYTES: u64 = 256 * MIB;
/// Default total limit of one spool (settings `spoolLimitMb`).
pub const DEFAULT_MAX_TOTAL: u64 = 2048 * MIB;
pub const MIN_MAX_TOTAL: u64 = 64 * MIB;
/// More files than the session keeps open (`MAX_SEGMENTS`) would make it start over earlier.
pub const MAX_MAX_TOTAL: u64 = ROTATE_BYTES * crate::tail::MAX_SEGMENTS as u64;
/// Files per spool by default: the limit is reached by deleting long before `MAX_SEGMENTS`.
const FILES_PER_LIMIT: u64 = 8;
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(100);
/// Bytes of lines waiting for the writer thread; beyond this a source's lines are dropped.
pub const QUEUE_BYTES: usize = 32 * MIB as usize;
/// Lines waiting for the writer thread.
pub const QUEUE_LINES: usize = 64 * 1024;
const WRITE_BUFFER: usize = 1024 * 1024;
pub const CURRENT_FILE: &str = "spool.log";

/// Where and how big a spool is.
#[derive(Debug, Clone)]
pub struct SpoolConfig {
    pub dir: PathBuf,
    pub rotate_bytes: u64,
    /// Files on disk including the current one; also the session's segment limit.
    pub max_files: usize,
    pub flush_interval: Duration,
    pub queue_bytes: usize,
    pub queue_lines: usize,
}

impl SpoolConfig {
    /// A spool of at most `max_total` bytes (clamped to `MIN_MAX_TOTAL..=MAX_MAX_TOTAL`): files of
    /// a eighth of it, at most `ROTATE_BYTES` each.
    pub fn new(dir: PathBuf, max_total: u64) -> Self {
        let total = max_total.clamp(MIN_MAX_TOTAL, MAX_MAX_TOTAL);
        let rotate = (total / FILES_PER_LIMIT).clamp(MIB, ROTATE_BYTES);
        Self::sized(dir, rotate, (total / rotate) as usize)
    }

    /// Exact sizes, for tests.
    pub fn sized(dir: PathBuf, rotate_bytes: u64, max_files: usize) -> Self {
        Self {
            dir,
            rotate_bytes: rotate_bytes.max(1),
            max_files: max_files.clamp(2, crate::tail::MAX_SEGMENTS),
            flush_interval: FLUSH_INTERVAL,
            queue_bytes: QUEUE_BYTES,
            queue_lines: QUEUE_LINES,
        }
    }

    pub fn current_path(&self) -> PathBuf {
        self.dir.join(CURRENT_FILE)
    }
}

/// Counters of a spool, shared by the writer thread, the sources and the session's updates.
#[derive(Debug, Default)]
pub struct SpoolStats {
    pub lines: AtomicU64,
    pub bytes: AtomicU64,
    /// Lines a full queue (or a failing disk) did not take.
    pub dropped: AtomicU64,
    pub rotations: AtomicU64,
    /// The last write error; cleared by the next successful write.
    pub error: Mutex<Option<String>>,
}

/// The rotated and current files of a spool, written synchronously (the writer thread drives it).
pub struct SpoolFiles {
    config: SpoolConfig,
    out: Option<BufWriter<File>>,
    current_len: u64,
    /// Rotated files, oldest first, with their sizes.
    rotated: VecDeque<(PathBuf, u64)>,
    seq: u64,
    dirty: bool,
}

impl SpoolFiles {
    /// Creates the folder and an empty current file (an existing one is started over).
    pub fn create(config: SpoolConfig) -> io::Result<Self> {
        create_private_dir(&config.dir)?;
        let file = create_private_file(&config.current_path(), false)?;
        Ok(Self {
            config,
            out: Some(BufWriter::with_capacity(WRITE_BUFFER, file)),
            current_len: 0,
            rotated: VecDeque::new(),
            seq: 0,
            dirty: false,
        })
    }

    pub fn config(&self) -> &SpoolConfig {
        &self.config
    }

    /// Appends one line and its `\n`; rotates first if the line would not fit any more. The line
    /// must not hold a `\n` itself (the sources escape them).
    pub fn append(&mut self, line: &[u8]) -> io::Result<()> {
        debug_assert!(!line.contains(&b'\n'));
        let len = line.len() as u64 + 1;
        if self.current_len > 0 && self.current_len + len > self.config.rotate_bytes {
            self.rotate()?;
        }
        let out = self.out()?;
        out.write_all(line)?;
        out.write_all(b"\n")?;
        self.current_len += len;
        self.dirty = true;
        Ok(())
    }

    fn out(&mut self) -> io::Result<&mut BufWriter<File>> {
        if self.out.is_none() {
            // A failed rotation left no current file: try again.
            let file = create_private_file(&self.config.current_path(), true)?;
            self.current_len = file.metadata()?.len();
            self.out = Some(BufWriter::with_capacity(WRITE_BUFFER, file));
        }
        Ok(self.out.as_mut().expect("just set"))
    }

    pub fn flush(&mut self) -> io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        if let Some(out) = self.out.as_mut() {
            out.flush()?;
        }
        self.dirty = false;
        Ok(())
    }

    /// Deletes the oldest files so that one more fits into `max_files`, renames the current file
    /// away and starts a new one. In this order the folder never holds more than `max_files`
    /// files, not even for a moment.
    pub fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut out) = self.out.take() {
            out.flush()?;
        }
        self.dirty = false;
        // The current file becomes a rotated one, and a new current one joins.
        while self.rotated.len() + 2 > self.config.max_files {
            let Some((oldest, _)) = self.rotated.pop_front() else {
                break;
            };
            // Gone already (removed by hand) is fine.
            let _ = std::fs::remove_file(oldest);
        }
        self.seq += 1;
        let rotated = self.config.dir.join(format!("spool-{:06}.log", self.seq));
        std::fs::rename(self.config.current_path(), &rotated)?;
        self.rotated.push_back((rotated, self.current_len));
        self.current_len = 0;
        let file = create_private_file(&self.config.current_path(), false)?;
        self.out = Some(BufWriter::with_capacity(WRITE_BUFFER, file));
        Ok(())
    }

    /// Bytes on disk (written or buffered) of all files.
    pub fn total_bytes(&self) -> u64 {
        self.current_len + self.rotated.iter().map(|(_, len)| len).sum::<u64>()
    }

    pub fn file_count(&self) -> usize {
        self.rotated.len() + 1
    }
}

/// A folder only the user can enter (0700 on Unix): log data from the network is in it.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// A file only the user can read (0600 on Unix); `append` keeps what is there, otherwise it is
/// started over.
pub fn create_private_file(path: &Path, append: bool) -> io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// What goes to the writer thread.
#[derive(Debug, PartialEq, Eq)]
pub enum SpoolItem {
    Line(Vec<u8>),
    /// Start a new spool file now (an SFTP source mirrors a remote truncation or rotation, prompt
    /// 017: the session sees a rotation, `tail.rs` needs nothing new).
    Rotate,
}

/// What sources hold: hands lines to the writer thread. Cheap to clone (one per receiving thread).
#[derive(Clone)]
pub struct SpoolWriter {
    tx: SyncSender<SpoolItem>,
    queued: Arc<AtomicUsize>,
    queue_bytes: usize,
    stats: Arc<SpoolStats>,
}

impl SpoolWriter {
    /// Queues a line without waiting. False: the queue is full (or the spool closed), the line is
    /// dropped and counted.
    pub fn try_line(&self, line: Vec<u8>) -> bool {
        let len = line.len();
        let before = self.queued.fetch_add(len, Ordering::SeqCst);
        if before + len > self.queue_bytes {
            self.queued.fetch_sub(len, Ordering::SeqCst);
            self.stats.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        match self.tx.try_send(SpoolItem::Line(line)) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.queued.fetch_sub(len, Ordering::SeqCst);
                self.stats.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    /// Queues a line, waiting while the queue is full (sources that pull and can slow down).
    /// False if `stop` was set or the spool closed meanwhile.
    pub fn line_blocking(&self, line: Vec<u8>, stop: &StopToken) -> bool {
        let mut line = line;
        loop {
            let len = line.len();
            if self.queued.load(Ordering::SeqCst) + len <= self.queue_bytes {
                self.queued.fetch_add(len, Ordering::SeqCst);
                match self.tx.try_send(SpoolItem::Line(line)) {
                    Ok(()) => return true,
                    Err(TrySendError::Full(back)) => {
                        self.queued.fetch_sub(len, Ordering::SeqCst);
                        let SpoolItem::Line(back) = back else {
                            unreachable!("sent a line")
                        };
                        line = back;
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        self.queued.fetch_sub(len, Ordering::SeqCst);
                        return false;
                    }
                }
            }
            if stop.is_stopped() {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Asks for a new spool file after the lines queued so far, waiting while the queue is full.
    /// False if `stop` was set or the spool closed meanwhile.
    pub fn rotate_blocking(&self, stop: &StopToken) -> bool {
        loop {
            match self.tx.try_send(SpoolItem::Rotate) {
                Ok(()) => return true,
                Err(TrySendError::Disconnected(_)) => return false,
                Err(TrySendError::Full(_)) => {}
            }
            if stop.is_stopped() {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn stats(&self) -> &Arc<SpoolStats> {
        &self.stats
    }
}

/// Asks a source (and the spool's writer thread) to end. Receiving threads look at it between
/// reads, which have a timeout for that reason.
#[derive(Debug, Clone, Default)]
pub struct StopToken(Arc<AtomicBool>);

impl StopToken {
    pub fn stop(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// A running spool: the writer thread and its files.
pub struct Spool {
    config: SpoolConfig,
    stats: Arc<SpoolStats>,
    writer: Option<SpoolWriter>,
    thread: Option<JoinHandle<()>>,
    stop: StopToken,
}

impl Spool {
    /// Creates the folder, the empty current file and the writer thread.
    pub fn start(config: SpoolConfig) -> AppResult<Self> {
        let files = SpoolFiles::create(config.clone())
            .map_err(|e| AppError::from_io(&e, &config.current_path()))?;
        let (tx, rx) = sync_channel(config.queue_lines);
        let queued = Arc::new(AtomicUsize::new(0));
        let stats = Arc::new(SpoolStats::default());
        let stop = StopToken::default();
        let thread = {
            let queued = Arc::clone(&queued);
            let stats = Arc::clone(&stats);
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("spool-writer".into())
                .spawn(move || write_loop(files, rx, &queued, &stats, &stop))
                .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?
        };
        Ok(Self {
            writer: Some(SpoolWriter {
                tx,
                queued,
                queue_bytes: config.queue_bytes,
                stats: Arc::clone(&stats),
            }),
            config,
            stats,
            thread: Some(thread),
            stop,
        })
    }

    pub fn writer(&self) -> SpoolWriter {
        self.writer.clone().expect("the spool is open")
    }

    pub fn path(&self) -> PathBuf {
        self.config.current_path()
    }

    pub fn dir(&self) -> &Path {
        &self.config.dir
    }

    pub fn config(&self) -> &SpoolConfig {
        &self.config
    }

    pub fn stats(&self) -> &Arc<SpoolStats> {
        &self.stats
    }

    /// Writes what is queued, flushes and ends the writer thread. Sources must be stopped first,
    /// or their clones of the writer keep the queue open until the stop token ends it.
    pub fn close(&mut self) {
        self.writer = None;
        self.stop.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        self.close();
    }
}

fn write_loop(
    mut files: SpoolFiles,
    rx: Receiver<SpoolItem>,
    queued: &AtomicUsize,
    stats: &SpoolStats,
    stop: &StopToken,
) {
    let interval = files.config().flush_interval;
    let mut last_flush = Instant::now();
    let write = |files: &mut SpoolFiles, item: SpoolItem| {
        let line = match item {
            SpoolItem::Line(line) => line,
            // An empty file needs no successor.
            SpoolItem::Rotate if files.current_len == 0 => return,
            SpoolItem::Rotate => {
                match files.rotate() {
                    Ok(()) => {
                        stats.rotations.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => *stats.error.lock() = Some(e.to_string()),
                }
                return;
            }
        };
        queued.fetch_sub(line.len(), Ordering::SeqCst);
        let seq_before = files.seq;
        match files.append(&line) {
            Ok(()) => {
                stats.lines.fetch_add(1, Ordering::Relaxed);
                stats
                    .bytes
                    .fetch_add(line.len() as u64 + 1, Ordering::Relaxed);
                if files.seq != seq_before {
                    stats.rotations.fetch_add(1, Ordering::Relaxed);
                }
                let mut error = stats.error.lock();
                if error.is_some() {
                    *error = None;
                }
            }
            Err(e) => {
                stats.dropped.fetch_add(1, Ordering::Relaxed);
                *stats.error.lock() = Some(e.to_string());
            }
        }
    };
    loop {
        let wait = interval.saturating_sub(last_flush.elapsed());
        match rx.recv_timeout(wait.max(Duration::from_millis(1))) {
            Ok(line) => {
                write(&mut files, line);
                // Take what is there without waking per line.
                while let Ok(line) = rx.try_recv() {
                    write(&mut files, line);
                    if last_flush.elapsed() >= interval {
                        break;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if last_flush.elapsed() >= interval {
            if let Err(e) = files.flush() {
                *stats.error.lock() = Some(e.to_string());
            }
            last_flush = Instant::now();
        }
        if stop.is_stopped() {
            // Whatever the sources queued before they stopped.
            while let Ok(line) = rx.try_recv() {
                write(&mut files, line);
            }
            break;
        }
    }
    if let Err(e) = files.flush() {
        *stats.error.lock() = Some(e.to_string());
    }
}

/// Only files a spool writes (and the markers of its folder), so a wrong path never removes
/// anything else.
pub fn only_spool_files(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().all(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name == CURRENT_FILE
                || name == "lock"
                || name == KEEP_MARKER
                || (name.starts_with("spool-") && name.ends_with(".log"))
        })
    })
}

/// A spool folder with this file stays when its session closes and at the next start.
pub const KEEP_MARKER: &str = "keep";

/// Removes a spool folder if it holds only spool files. True if it is gone.
pub fn remove_spool_dir(dir: &Path) -> bool {
    if !dir.exists() {
        return true;
    }
    only_spool_files(dir) && std::fs::remove_dir_all(dir).is_ok()
}

// ------------------------------------------------------------------------------------------------
// The cache folder
// ------------------------------------------------------------------------------------------------

/// This process's spool folders: `<cache>/spool/<pid>/`, held by a locked `lock` file like the
/// dashboard folders (`report_db::ReportDir`). Folders of processes that are gone are removed at
/// start, except kept spools (`<cache>/spool/kept/…`).
pub struct SpoolRoot {
    pub path: PathBuf,
    pub kept: PathBuf,
    _lock: File,
    next: AtomicU64,
}

impl SpoolRoot {
    pub fn prepare(cache: &Path) -> io::Result<Self> {
        let root = cache.join("spool");
        let kept = root.join("kept");
        create_private_dir(&root)?;
        create_private_dir(&kept)?;
        let own = root.join(std::process::id().to_string());
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path == own || path == kept || !path.is_dir() {
                    continue;
                }
                let lock = path.join("lock");
                let free = match File::options().write(true).open(&lock) {
                    Ok(file) => file.try_lock().is_ok(),
                    Err(_) => true,
                };
                if free {
                    remove_process_dir(&path);
                }
            }
        }
        create_private_dir(&own)?;
        // Left by an earlier process with the same id.
        if let Ok(entries) = std::fs::read_dir(&own) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    remove_spool_dir(&entry.path());
                }
            }
        }
        let lock = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(own.join("lock"))?;
        lock.try_lock()
            .map_err(|e| io::Error::other(e.to_string()))?;
        Ok(Self {
            path: own,
            kept,
            _lock: lock,
            next: AtomicU64::new(1),
        })
    }

    /// Kept spools (`kept/…`): how many and their bytes on disk (settings, security review L4).
    pub fn kept_usage(&self) -> (u32, u64) {
        let mut count = 0;
        let mut bytes = 0;
        if let Ok(entries) = std::fs::read_dir(&self.kept) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() || !only_spool_files(&path) {
                    continue;
                }
                count += 1;
                if let Ok(files) = std::fs::read_dir(&path) {
                    bytes += files
                        .flatten()
                        .filter_map(|f| f.metadata().ok())
                        .map(|m| m.len())
                        .sum::<u64>();
                }
            }
        }
        (count, bytes)
    }

    /// Deletes all kept spools (only folders holding nothing but spool files). Returns how many.
    pub fn delete_kept(&self) -> u32 {
        let mut deleted = 0;
        if let Ok(entries) = std::fs::read_dir(&self.kept) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && remove_spool_dir(&path) {
                    deleted += 1;
                }
            }
        }
        deleted
    }

    /// A new, unused folder for one source.
    pub fn new_dir(&self) -> PathBuf {
        let n = self.next.fetch_add(1, Ordering::SeqCst);
        self.path.join(format!("source-{n}"))
    }
}

/// The folder of a process that is gone: its spool folders (only spool files), then itself.
fn remove_process_dir(path: &Path) {
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let sub = entry.path();
            if sub.is_dir() {
                if sub.join(KEEP_MARKER).exists() {
                    continue;
                }
                remove_spool_dir(&sub);
            }
        }
    }
    let empty = std::fs::read_dir(path).is_ok_and(|entries| {
        entries
            .flatten()
            .all(|e| e.file_name() == "lock" && e.path().is_file())
    });
    if empty {
        let _ = std::fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn sizes_follow_the_total_limit() {
        let c = SpoolConfig::new(PathBuf::from("/x"), DEFAULT_MAX_TOTAL);
        assert_eq!((c.rotate_bytes, c.max_files), (ROTATE_BYTES, 8));
        let c = SpoolConfig::new(PathBuf::from("/x"), 64 * MIB);
        assert_eq!((c.rotate_bytes, c.max_files), (8 * MIB, 8));
        // Above `MAX_MAX_TOTAL` the files stay at 256 MB and the session's segments decide.
        let c = SpoolConfig::new(PathBuf::from("/x"), 100 * 1024 * MIB);
        assert_eq!(
            (c.rotate_bytes, c.max_files),
            (ROTATE_BYTES, crate::tail::MAX_SEGMENTS)
        );
        // Below the minimum: clamped.
        let c = SpoolConfig::new(PathBuf::from("/x"), 1);
        assert_eq!(c.rotate_bytes * c.max_files as u64, MIN_MAX_TOTAL);
    }

    #[test]
    fn appends_lines_and_flushes() {
        let dir = tempfile::tempdir().unwrap();
        let config = SpoolConfig::sized(dir.path().join("s"), 1024, 4);
        let mut files = SpoolFiles::create(config.clone()).unwrap();
        files.append("a ä 😀".as_bytes()).unwrap();
        files.append(b"b").unwrap();
        // Buffered until the flush.
        assert_eq!(read(&config.current_path()), "");
        files.flush().unwrap();
        assert_eq!(read(&config.current_path()), "a ä 😀\nb\n");
        assert_eq!(files.total_bytes(), "a ä 😀\nb\n".len() as u64);
    }

    #[test]
    fn rotates_and_keeps_at_most_max_files() {
        let dir = tempfile::tempdir().unwrap();
        let config = SpoolConfig::sized(dir.path().join("s"), 20, 3);
        let mut files = SpoolFiles::create(config.clone()).unwrap();
        for i in 0..10 {
            // 10 bytes per line with the newline: two lines per file.
            files.append(format!("line {i:03}").as_bytes()).unwrap();
        }
        files.flush().unwrap();
        assert_eq!(
            names(&config.dir),
            ["spool-000003.log", "spool-000004.log", "spool.log"]
        );
        assert_eq!(
            read(&config.dir.join("spool-000003.log")),
            "line 004\nline 005\n"
        );
        assert_eq!(read(&config.current_path()), "line 008\nline 009\n");
        assert!(files.total_bytes() <= 3 * 20);
        assert_eq!(files.file_count(), 3);
    }

    #[test]
    fn a_line_longer_than_a_file_gets_a_file_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let config = SpoolConfig::sized(dir.path().join("s"), 8, 4);
        let mut files = SpoolFiles::create(config.clone()).unwrap();
        files.append(b"x").unwrap();
        files.append(b"a long line").unwrap();
        files.append(b"y").unwrap();
        files.flush().unwrap();
        assert_eq!(read(&config.dir.join("spool-000001.log")), "x\n");
        assert_eq!(read(&config.dir.join("spool-000002.log")), "a long line\n");
        assert_eq!(read(&config.current_path()), "y\n");
    }

    #[test]
    fn writer_thread_flushes_within_the_interval() {
        let dir = tempfile::tempdir().unwrap();
        let config = SpoolConfig::sized(dir.path().join("s"), MIB, 4);
        let spool = Spool::start(config.clone()).unwrap();
        let writer = spool.writer();
        assert!(writer.try_line(b"hello".to_vec()));
        // Nobody closes the spool or asks for a flush: only the writer thread's interval can put
        // the line into the file. That it gets there is the proof, not how fast.
        crate::test_support::wait_until("the writer thread to flush", || {
            read(&config.current_path()) == "hello\n"
        });
        assert_eq!(spool.stats().lines.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn close_writes_everything_queued() {
        let dir = tempfile::tempdir().unwrap();
        let config = SpoolConfig::sized(dir.path().join("s"), MIB, 4);
        let mut spool = Spool::start(config.clone()).unwrap();
        let writer = spool.writer();
        for i in 0..1000 {
            assert!(writer.try_line(format!("l{i}").into_bytes()));
        }
        drop(writer);
        spool.close();
        assert_eq!(read(&config.current_path()).lines().count(), 1000);
    }

    #[test]
    fn a_full_queue_drops_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = SpoolConfig::sized(dir.path().join("s"), MIB, 4);
        config.queue_bytes = 100;
        config.queue_lines = 4;
        // No writer thread drains it: the files only, and a writer by hand.
        let (tx, _rx) = sync_channel(config.queue_lines);
        let writer = SpoolWriter {
            tx,
            queued: Arc::new(AtomicUsize::new(0)),
            queue_bytes: config.queue_bytes,
            stats: Arc::default(),
        };
        let accepted = (0..10).filter(|_| writer.try_line(vec![b'x'; 30])).count();
        // 3 × 30 bytes fit, the fourth would pass 100.
        assert_eq!(accepted, 3);
        assert_eq!(writer.stats().dropped.load(Ordering::Relaxed), 7);
        // By count: small lines stop at the channel's 4.
        let (tx, _rx2) = sync_channel(4);
        let writer = SpoolWriter {
            tx,
            queued: Arc::new(AtomicUsize::new(0)),
            queue_bytes: 1000,
            stats: Arc::default(),
        };
        let accepted = (0..10).filter(|_| writer.try_line(vec![b'x'])).count();
        assert_eq!(accepted, 4);
        assert_eq!(writer.stats().dropped.load(Ordering::Relaxed), 6);
        assert_eq!(writer.queued.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn blocking_lines_wait_and_stop() {
        let (tx, rx) = sync_channel(1);
        let writer = SpoolWriter {
            tx,
            queued: Arc::new(AtomicUsize::new(0)),
            queue_bytes: 1000,
            stats: Arc::default(),
        };
        let stop = StopToken::default();
        assert!(writer.line_blocking(b"a".to_vec(), &stop));
        let stopper = stop.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            stopper.stop();
        });
        // The channel is full: waits until stopped, drops nothing silently.
        assert!(!writer.line_blocking(b"b".to_vec(), &stop));
        t.join().unwrap();
        assert_eq!(rx.try_recv().unwrap(), SpoolItem::Line(b"a".to_vec()));
        assert_eq!(writer.stats().dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn root_removes_what_dead_processes_left_but_not_kept_spools() {
        let cache = tempfile::tempdir().unwrap();
        let root = cache.path().join("spool");
        let dead = root.join("999999999");
        std::fs::create_dir_all(dead.join("source-1")).unwrap();
        std::fs::write(dead.join("source-1/spool.log"), "x").unwrap();
        std::fs::create_dir_all(dead.join("source-2")).unwrap();
        std::fs::write(dead.join("source-2/spool.log"), "y").unwrap();
        std::fs::write(dead.join("source-2").join(KEEP_MARKER), "").unwrap();
        // Something that is not a spool stays.
        std::fs::create_dir_all(dead.join("source-3")).unwrap();
        std::fs::write(dead.join("source-3/notes.txt"), "mine").unwrap();
        std::fs::create_dir_all(root.join("kept/a")).unwrap();
        std::fs::write(root.join("kept/a/spool.log"), "z").unwrap();
        let prepared = SpoolRoot::prepare(cache.path()).unwrap();
        assert!(!dead.join("source-1").exists());
        assert!(dead.join("source-2/spool.log").exists());
        assert!(dead.join("source-3/notes.txt").exists());
        assert!(root.join("kept/a/spool.log").exists());
        // Kept spools: counted, and deleted on request (not what is no spool).
        std::fs::write(root.join("kept/a").join(KEEP_MARKER), "").unwrap();
        std::fs::create_dir_all(root.join("kept/b")).unwrap();
        std::fs::write(root.join("kept/b/mine.txt"), "x").unwrap();
        assert_eq!(prepared.kept_usage(), (1, 1));
        assert_eq!(prepared.delete_kept(), 1);
        assert!(!root.join("kept/a").exists());
        assert!(root.join("kept/b/mine.txt").exists());
        assert_eq!(prepared.kept_usage(), (0, 0));
        let a = prepared.new_dir();
        let b = prepared.new_dir();
        assert_ne!(a, b);
        assert!(a.starts_with(&prepared.path));
    }

    #[cfg(unix)]
    #[test]
    fn spool_folders_and_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let cache = tempfile::tempdir().unwrap();
        let root = SpoolRoot::prepare(cache.path()).unwrap();
        let config = SpoolConfig::sized(root.new_dir(), 8, 4);
        let mut files = SpoolFiles::create(config.clone()).unwrap();
        files.append(b"one").unwrap();
        files.append(b"two").unwrap();
        files.append(b"three").unwrap();
        files.flush().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        for dir in [
            cache.path().join("spool"),
            root.kept.clone(),
            root.path.clone(),
            config.dir.clone(),
        ] {
            assert_eq!(mode(&dir), 0o700, "{}", dir.display());
        }
        assert_eq!(mode(&config.current_path()), 0o600);
        assert_eq!(mode(&config.dir.join("spool-000001.log")), 0o600);
    }

    #[test]
    fn removes_only_spool_folders() {
        let dir = tempfile::tempdir().unwrap();
        let spool = dir.path().join("s");
        std::fs::create_dir_all(&spool).unwrap();
        std::fs::write(spool.join("spool.log"), "x").unwrap();
        std::fs::write(spool.join("spool-000001.log"), "x").unwrap();
        assert!(remove_spool_dir(&spool));
        assert!(!spool.exists());
        std::fs::create_dir_all(&spool).unwrap();
        std::fs::write(spool.join("other.txt"), "x").unwrap();
        assert!(!remove_spool_dir(&spool));
        assert!(spool.join("other.txt").exists());
    }
}
