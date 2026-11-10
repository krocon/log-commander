//! Merging several real files into one session (prompt 006), without Tauri. Single files are
//! covered by `tail_integration.rs`, which this file leaves alone.
//!
//! The global allocator counts bytes, so `measure_merge` can report the peak memory of opening a
//! merge against a single file of the same size:
//! `cargo test --release --test merge_integration -- --ignored --nocapture measure_merge`

use log_commander_lib::error::ErrorCode;
use log_commander_lib::filter::{SearchMode, SearchQuery};
use log_commander_lib::level::Level;
use log_commander_lib::merge::{MergeSource, HOLD_BACK};
use log_commander_lib::model::{SessionUpdate, Status};
use log_commander_lib::profile::{builtin_profiles, Profile, GENERIC_PROFILE};
use log_commander_lib::session::{LogSession, OpenOptions};
use parking_lot::Mutex;
use std::alloc::{GlobalAlloc, Layout, System};
use std::fs::{self, File, OpenOptions as FsOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "../src/test_support.rs"]
mod test_support;
use test_support::{wait_until, wait_until_or};

struct Counting;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            let now = CURRENT.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new = unsafe { System.realloc(ptr, layout, new_size) };
        if !new.is_null() {
            if new_size >= layout.size() {
                let now = CURRENT.fetch_add(new_size - layout.size(), Ordering::Relaxed) + new_size
                    - layout.size();
                PEAK.fetch_max(now, Ordering::Relaxed);
            } else {
                CURRENT.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        new
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn profile(id: &str) -> Profile {
    builtin_profiles().into_iter().find(|p| p.id == id).unwrap()
}

struct Fixture {
    session: LogSession,
    updates: Arc<Mutex<Vec<SessionUpdate>>>,
}

fn sources(paths: &[&Path]) -> Vec<MergeSource> {
    paths
        .iter()
        .map(|p| MergeSource {
            path: p.to_path_buf(),
            profile: None,
        })
        .collect()
}

fn try_merge(paths: &[&Path], keep_on_rotate: bool) -> Result<Fixture, ErrorCode> {
    let updates = Arc::new(Mutex::new(Vec::new()));
    let sink_updates = Arc::clone(&updates);
    LogSession::open_merged(
        1,
        sources(paths),
        OpenOptions {
            keep_on_rotate,
            ..OpenOptions::default()
        },
        Box::new(move |update| sink_updates.lock().push(update)),
    )
    .map(|session| Fixture { session, updates })
    .map_err(|e| e.code)
}

fn merge(paths: &[&Path]) -> Fixture {
    let fx = try_merge(paths, true).unwrap();
    fx.wait("loaded", |s| s.status == Status::Live);
    fx
}

fn open_single(path: &Path) -> Fixture {
    let updates = Arc::new(Mutex::new(Vec::new()));
    let sink_updates = Arc::clone(&updates);
    let session = LogSession::open(
        1,
        path,
        OpenOptions::default(),
        &profile(GENERIC_PROFILE),
        Box::new(move |update| sink_updates.lock().push(update)),
    )
    .unwrap();
    Fixture { session, updates }
}

impl Fixture {
    #[track_caller]
    fn wait(&self, what: &str, condition: impl Fn(&SessionUpdate) -> bool) {
        wait_until_or(
            what,
            || format!("{:?}", self.session.stats()),
            || condition(&self.session.stats()),
        );
    }

    /// Waits for an update that was sent, not for the state: one-time states (rotated,
    /// truncated) only show in the updates.
    #[track_caller]
    fn wait_update(&self, what: &str, condition: impl Fn(&SessionUpdate) -> bool) {
        wait_until_or(
            what,
            || {
                let updates = self.updates.lock();
                let seen: Vec<_> = updates.iter().map(|u| &u.status).collect();
                format!("statuses sent: {seen:?}, now: {:?}", self.session.stats())
            },
            || self.updates.lock().iter().any(&condition),
        );
    }

    #[track_caller]
    fn wait_status(&self, what: &str, condition: impl Fn(&Status) -> bool) {
        self.wait_update(what, |u| condition(&u.status));
    }

    fn texts(&self, filtered: bool) -> Vec<String> {
        self.session
            .get_lines(filtered, 0, 5000)
            .unwrap()
            .into_iter()
            .map(|l| l.text)
            .collect()
    }

    fn sources_of_lines(&self) -> Vec<u8> {
        self.session
            .get_lines(false, 0, 5000)
            .unwrap()
            .into_iter()
            .map(|l| l.source)
            .collect()
    }
}

fn append(path: &Path, text: &str) {
    let mut file = FsOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

fn query(text: &str) -> SearchQuery {
    SearchQuery {
        text: text.into(),
        is_regex: false,
        case_sensitive: false,
    }
}

fn set_filter(fx: &Fixture, levels: &[Level], text: &str, sources: Option<u16>) {
    let info = fx
        .session
        .set_filter_with_sources(levels, &query(text), SearchMode::Filter, sources)
        .unwrap();
    fx.wait("filter", |s| {
        !s.filter_pending && s.view_generation == info.view_generation
    });
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, text).unwrap();
    path
}

#[test]
fn two_files_read_like_one_in_time_order() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(
        dir.path(),
        "a.log",
        "2024-01-01 10:00:01,000 INFO  [main] app - a1\n\
         2024-01-01 10:00:03,000 ERROR [main] app - a3 failed\n\
         \tat com.acme.A.run(A.java:1)\n\
         2024-01-01 10:00:05,000 INFO  [main] app - a5\n",
    );
    let b = write(
        dir.path(),
        "b.log",
        "2024-01-01 10:00:02,000 WARN  [main] db - b2\r\n\
         2024-01-01 10:00:03,000 INFO  [main] db - b3\r\n\
         2024-01-01 10:00:04,000 DEBUG [main] db - b4\r\n",
    );
    let fx = merge(&[&a, &b]);
    let texts = fx.texts(false);
    let short: Vec<&str> = texts
        .iter()
        .map(|t| t.rsplit(" - ").next().unwrap_or(t))
        .collect();
    assert_eq!(
        short,
        vec![
            "a1",
            "b2",
            "a3 failed",
            "\tat com.acme.A.run(A.java:1)",
            "b3",
            "b4",
            "a5"
        ]
    );
    assert_eq!(fx.sources_of_lines(), vec![0, 1, 0, 0, 1, 1, 0]);
    let stats = fx.session.stats();
    assert_eq!(stats.sources.len(), 2);
    assert_eq!((stats.sources[0].lines, stats.sources[1].lines), (4, 3));
    assert_eq!(
        stats.file_size,
        fs::metadata(&a).unwrap().len() + fs::metadata(&b).unwrap().len()
    );
    assert_eq!((stats.counts.error, stats.counts.warn), (2, 1));
    let info = fx.session.info();
    assert_eq!(info.sources.len(), 2);
    assert_eq!(info.sources[1].file_name, "b.log");
    assert_eq!(info.path, "");

    // The stack trace belongs to its head: entry range, detail with source and byte offset.
    let range = fx.session.entry_range(3);
    assert_eq!((range.first, range.last), (2, 3));
    let entry = fx.session.get_entry(4).unwrap();
    let first_b = "2024-01-01 10:00:02,000 WARN  [main] db - b2\r\n".len() as u64;
    assert_eq!((entry.source, entry.byte_offset), (1, first_b));
    // Copying gives the raw text without a prefix, the CR of the CRLF file gone.
    let copied = fx.session.copy_lines(1, 2).unwrap();
    assert_eq!(
        copied,
        "2024-01-01 10:00:02,000 WARN  [main] db - b2\n2024-01-01 10:00:03,000 ERROR [main] app - a3 failed\n"
    );
    // A merge has a profile per file: changing it is refused.
    assert_eq!(
        fx.session.set_profile(&profile("log4j")).unwrap_err().code,
        ErrorCode::InvalidMerge
    );
}

#[test]
fn filter_search_and_source_filter_work_across_sources() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = String::new();
    let mut b = String::new();
    for i in 0..3000 {
        a.push_str(&format!(
            "2024-01-01 10:00:{:02}.{:03} INFO a line {i}\n",
            i / 1000,
            i % 1000
        ));
        let level = if i % 10 == 0 { "ERROR" } else { "INFO" };
        b.push_str(&format!(
            "2024-01-01 10:00:{:02}.{:03} {level} b line {i}\n",
            i / 1000,
            i % 1000
        ));
        if i % 10 == 0 {
            b.push_str("\tat needle.B(B.java:1)\n");
        }
    }
    let a = write(dir.path(), "a.log", &a);
    let b = write(dir.path(), "b.log", &b);
    let fx = merge(&[&a, &b]);
    assert_eq!(fx.session.stats().total_lines, 6300);

    // Text across sources: the whole entry of a hit in a stack trace.
    set_filter(&fx, &Level::ALL, "needle", None);
    assert_eq!(fx.session.stats().filtered_lines, 600);
    // Only source 1, all levels.
    set_filter(&fx, &Level::ALL, "", Some(0b10));
    let stats = fx.session.stats();
    assert_eq!(stats.filtered_lines, 3300);
    assert!(fx
        .session
        .get_lines(true, 0, 5000)
        .unwrap()
        .iter()
        .all(|l| l.source == 1));
    // Source 0 and errors: nothing (its lines are INFO).
    set_filter(&fx, &[Level::Error], "", Some(0b01));
    assert_eq!(fx.session.stats().filtered_lines, 0);
    // Both bits set is no filter at all.
    let info = fx
        .session
        .set_filter_with_sources(&Level::ALL, &query(""), SearchMode::Filter, Some(0b11))
        .unwrap();
    assert!(!info.pending);

    // Find forward and backward across sources.
    let q = query("line 1500");
    let hit = fx.session.find(None, &q, true).unwrap().unwrap();
    let next = fx.session.find(Some(hit.line), &q, true).unwrap().unwrap();
    let texts = fx.texts(false);
    assert!(texts[hit.line as usize].contains("a line 1500"));
    assert!(texts[next.line as usize].contains("b line 1500"));
    let back = fx
        .session
        .find(Some(next.line), &q, false)
        .unwrap()
        .unwrap();
    assert_eq!(back.line, hit.line);
    let last = fx.session.find(None, &q, false).unwrap().unwrap();
    assert_eq!(last.line, next.line);
}

#[test]
fn sixteen_sources_and_a_seventeenth_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let paths: Vec<PathBuf> = (0..17)
        .map(|i| {
            write(
                dir.path(),
                &format!("s{i}.log"),
                &format!(
                    "2024-01-01 10:00:{:02} INFO source {i}\n2024-01-01 10:01:{:02} INFO again {i}\n",
                    16 - i.min(16),
                    i
                ),
            )
        })
        .collect();
    let refs: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
    assert_eq!(try_merge(&refs, true).err(), Some(ErrorCode::InvalidMerge));
    let fx = merge(&refs[..16]);
    let texts = fx.texts(false);
    assert_eq!(texts.len(), 32);
    // Sorted by the first minute in reverse source order, then the second minute in source order.
    assert!(texts[0].ends_with("source 15"));
    assert!(texts[15].ends_with("source 0"));
    assert!(texts[16].ends_with("again 0"));
    assert!(texts[31].ends_with("again 15"));
    assert_eq!(fx.session.stats().sources.len(), 16);
    // One file alone is no merge, the same file twice neither.
    assert_eq!(
        try_merge(&refs[..1], true).err(),
        Some(ErrorCode::InvalidMerge)
    );
    assert_eq!(
        try_merge(&[refs[0], refs[0]], true).err(),
        Some(ErrorCode::InvalidMerge)
    );
}

#[test]
fn utf16_next_to_utf8_and_json_lines_next_to_log4j() {
    let dir = tempfile::tempdir().unwrap();
    let utf16 = dir.path().join("win.log");
    let text = "2024-01-01 10:00:02 WARN Größe 😀\r\n2024-01-01 10:00:04 ERROR fehlgeschlagen\r\n";
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(&utf16, bytes).unwrap();
    let json = write(
        dir.path(),
        "app.jsonl",
        "{\"time\":\"2024-01-01T10:00:01\",\"level\":\"debug\",\"msg\":\"j1\"}\n\
         {\"time\":\"2024-01-01T10:00:03\",\"level\":50,\"msg\":\"j3\"}\n",
    );
    let empty = write(dir.path(), "empty.log", "");
    let fx = merge(&[&utf16, &json, &empty]);
    let lines = fx.session.get_lines(false, 0, 10).unwrap();
    let got: Vec<(u8, Level)> = lines.iter().map(|l| (l.source, l.level)).collect();
    assert_eq!(
        got,
        vec![
            (1, Level::Debug),
            (0, Level::Warn),
            (1, Level::Error),
            (0, Level::Error)
        ]
    );
    assert_eq!(lines[1].text, "2024-01-01 10:00:02 WARN Größe 😀");
    let info = fx.session.info();
    assert_eq!(info.sources[1].profile_id, "jsonl");
    assert_eq!(
        serde_json::to_string(&info.sources[0].encoding).unwrap(),
        "\"utf16Le\""
    );
    // The empty file joins later.
    append(&empty, "2024-01-01 10:00:05 INFO late arrival\n");
    fx.wait("empty file grew", |s| s.total_lines == 5);
    assert_eq!(fx.session.get_lines(false, 4, 1).unwrap()[0].source, 2);
}

#[test]
fn a_file_without_timestamps_is_refused_with_its_name() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.log", "2024-01-01 10:00:01 INFO a\n");
    let b = write(dir.path(), "plain.txt", "just words\nmore words\n");
    let err = LogSession::open_merged(
        1,
        sources(&[&a, &b]),
        OpenOptions::default(),
        Box::new(|_| {}),
    )
    .err()
    .unwrap();
    assert_eq!(err.code, ErrorCode::NoTimestamps);
    assert!(err.message.contains("plain.txt"));
    assert!(err.path.unwrap().ends_with("plain.txt"));
    let missing = dir.path().join("gone.log");
    assert_eq!(
        try_merge(&[&a, &missing], true).err(),
        Some(ErrorCode::NotFound)
    );
}

#[test]
fn a_source_out_of_order_is_sorted_before_merging() {
    let dir = tempfile::tempdir().unwrap();
    // Threads writing slightly out of order.
    let mut a = String::new();
    for i in 0..2000 {
        let jitter = if i % 2 == 0 { i + 1 } else { i - 1 };
        a.push_str(&format!(
            "2024-01-01 10:{:02}:{:02} INFO a {jitter}\n",
            jitter / 60,
            jitter % 60
        ));
    }
    let mut b = String::new();
    for i in 0..2000 {
        b.push_str(&format!(
            "2024-01-01 10:{:02}:{:02} INFO b {i}\n",
            i / 60,
            i % 60
        ));
    }
    let a = write(dir.path(), "a.log", &a);
    let b = write(dir.path(), "b.log", &b);
    let fx = merge(&[&a, &b]);
    let texts = fx.texts(false);
    assert_eq!(texts.len(), 4000);
    let times: Vec<&str> = texts.iter().map(|t| &t[..19]).collect();
    let mut sorted = times.clone();
    sorted.sort();
    assert_eq!(times, sorted);
    assert_eq!(fx.session.stats().sources[0].late_lines, 0);
}

#[test]
fn live_lines_wait_for_each_other_and_late_ones_are_counted() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.log", "2024-01-01 10:00:00 INFO a0\n");
    let b = write(dir.path(), "b.log", "2024-01-01 10:00:00 INFO b0\n");
    let fx = merge(&[&a, &b]);
    assert_eq!(fx.session.stats().total_lines, 2);

    // Written in the wrong order within the hold-back: shown in time order. Both lines are
    // read in the same round, whatever the load of the machine: they are written during a
    // freeze and read when it ends.
    let line_a = "2024-01-01 10:00:01 INFO a1\n";
    let line_b = "2024-01-01 10:00:02 INFO b2\n";
    let size_a = fs::metadata(&a).unwrap().len() + line_a.len() as u64;
    fx.session.set_frozen(true);
    append(&a, line_a);
    // The worker has seen the freeze (it reports what waits), or a round that began before the
    // freeze has read the line and is over (it reports the size). Either way it reads no more.
    fx.wait("the worker holds", |s| {
        s.pending_bytes == line_a.len() as u64 || s.sources[0].file_size == size_a
    });
    append(&b, line_b);
    fx.wait("b2 waits", |s| {
        let waiting_of_a = if s.sources[0].file_size == size_a {
            0
        } else {
            line_a.len()
        };
        s.pending_bytes == (waiting_of_a + line_b.len()) as u64
    });
    fx.session.set_frozen(false);
    fx.wait("both", |s| s.total_lines == 4);
    let texts = fx.texts(false);
    assert!(
        texts[2].ends_with("a1") && texts[3].ends_with("b2"),
        "{texts:?}"
    );

    // Long after: appended at the end and counted.
    std::thread::sleep(HOLD_BACK + Duration::from_millis(200));
    append(&a, "2024-01-01 09:59:00 INFO a-late\n\tat stack\n");
    fx.wait("late", |s| s.total_lines == 6);
    let stats = fx.session.stats();
    assert_eq!(stats.sources[0].late_lines, 2);
    assert!(fx.texts(false)[4].ends_with("a-late"));

    // A continuation of an entry released before another source came: a line of its own, late.
    append(&b, "2024-01-01 10:00:03 ERROR b3\n");
    fx.wait("b3", |s| s.total_lines == 7);
    std::thread::sleep(HOLD_BACK + Duration::from_millis(200));
    append(&a, "2024-01-01 10:00:04 INFO a4\n");
    fx.wait("a4", |s| s.total_lines == 8);
    append(&b, "\tat b.trace\n");
    fx.wait("orphan", |s| s.total_lines == 9);
    let last = fx.session.get_lines(false, 8, 1).unwrap().remove(0);
    assert!(!last.is_continuation && last.source == 1 && last.level == Level::Error);
    assert_eq!(fx.session.stats().sources[1].late_lines, 1);

    // "Neu sortieren": everything in time order, a new epoch, nothing late.
    let epoch = fx.session.stats().epoch;
    fx.session.resort().unwrap();
    fx.wait("resorted", |s| {
        s.epoch > epoch && s.status == Status::Live && s.total_lines == 9
    });
    let stats = fx.session.stats();
    assert_eq!(
        (stats.sources[0].late_lines, stats.sources[1].late_lines),
        (0, 0)
    );
    let texts = fx.texts(false);
    assert!(texts[0].ends_with("a-late"), "{texts:?}");
    assert_eq!(texts[1], "\tat stack");
    // The trace joins b3 again.
    assert!(
        texts[6].ends_with("b3") && texts[7] == "\tat b.trace",
        "{texts:?}"
    );
}

#[test]
fn a_silent_source_holds_up_the_others_at_most_hold_back() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.log", "2024-01-01 10:00:00 INFO a0\n");
    let b = write(dir.path(), "b.log", "2024-01-01 10:00:00 INFO b0\n");
    let fx = merge(&[&a, &b]);
    // How long the wait may take is the rule of `Merger::cut`, proven without a clock by the
    // unit test `a_silent_source_holds_up_the_rest_at_most_hold_back` in merge.rs. Here: the lines of the
    // writing source arrive although the other one never writes again, and in their order.
    std::thread::sleep(HOLD_BACK);
    append(&a, "2024-01-01 10:00:05 INFO a5\n");
    fx.wait("a5", |s| s.total_lines == 3);
    // A busy and a quiet source: the busy one is not held up by the quiet one.
    for i in 0..10 {
        append(
            &a,
            &format!("2024-01-01 10:00:{:02} INFO busy {i}\n", 10 + i),
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    fx.wait("busy", |s| s.total_lines == 13);
    let texts = fx.texts(false);
    assert!(texts[2].ends_with("a5"), "{texts:?}");
    for i in 0..10 {
        assert!(texts[3 + i].ends_with(&format!("busy {i}")), "{texts:?}");
    }
    let stats = fx.session.stats();
    assert_eq!(
        (stats.sources[0].lines, stats.sources[0].late_lines),
        (12, 0)
    );
}

#[test]
fn rotation_of_one_source_keeps_its_lines_and_the_rest_runs_on() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.log", "2024-01-01 10:00:00 INFO a0\n");
    let b = write(dir.path(), "b.log", "2024-01-01 10:00:01 INFO b1\n");
    let fx = merge(&[&a, &b]);
    let epoch = fx.session.stats().epoch;
    fs::rename(&a, dir.path().join("a.log.1")).unwrap();
    fs::write(&a, "2024-01-01 10:00:02 INFO a2 rotated\n").unwrap();
    append(&b, "2024-01-01 10:00:03 INFO b3\n");
    fx.wait("rotated", |s| s.total_lines == 4);
    assert_eq!(fx.session.stats().epoch, epoch);
    let texts = fx.texts(false);
    assert!(
        texts[0].ends_with("a0") && texts[2].ends_with("a2 rotated") && texts[3].ends_with("b3")
    );
    assert_eq!(fx.sources_of_lines(), vec![0, 1, 0, 1]);
    // Sent with the next update, which may come after the lines are in the index.
    fx.wait_update("source 0 rotated", |u| {
        u.sources
            .first()
            .is_some_and(|s| s.status == Status::Rotated)
    });

    // Without keeping: everything is merged again, the old lines of that source are gone.
    fx.session.set_keep_on_rotate(false);
    fs::rename(&a, dir.path().join("a.log.2")).unwrap();
    fs::write(&a, "2024-01-01 10:00:04 INFO a4 fresh\n").unwrap();
    fx.wait("merged again", |s| s.epoch > epoch && s.total_lines == 3);
    fx.wait_status("rotated", |s| *s == Status::Rotated);
    let texts = fx.texts(false);
    assert!(
        texts[0].ends_with("b1") && texts[2].ends_with("a4 fresh"),
        "{texts:?}"
    );
}

#[test]
fn truncation_of_a_source_merges_everything_again() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(
        dir.path(),
        "a.log",
        "2024-01-01 10:00:00 INFO a0\n2024-01-01 10:00:02 INFO a2\n",
    );
    let b = write(dir.path(), "b.log", "2024-01-01 10:00:01 INFO b1\n");
    let fx = merge(&[&a, &b]);
    let epoch = fx.session.stats().epoch;
    File::create(&a).unwrap();
    fx.wait("truncated", |s| s.epoch > epoch && s.total_lines == 1);
    fx.wait_status("truncated", |s| *s == Status::Truncated);
    append(&a, "2024-01-01 10:00:05 INFO a5 new\n");
    fx.wait("new line", |s| s.total_lines == 2);
    let texts = fx.texts(false);
    assert!(texts[0].ends_with("b1") && texts[1].ends_with("a5 new"));
}

/// The one-time status of a merge that starts over must reach the frontend even if no update
/// was due between its start and its end (updates are sent at most every 100 ms): another
/// source keeps the updates busy while a source is truncated.
#[test]
fn a_truncation_is_reported_while_updates_of_another_source_are_running() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.log", "2024-01-01 10:00:00 INFO a0\n");
    let b = write(dir.path(), "b.log", "2024-01-01 10:00:00 INFO b0\n");
    let fx = merge(&[&a, &b]);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let stop = Arc::clone(&stop);
        let b = b.clone();
        std::thread::spawn(move || {
            let mut i = 0u32;
            while !stop.load(Ordering::SeqCst) {
                i += 1;
                append(
                    &b,
                    &format!("2024-01-01 10:{:02}:{:02} INFO b {i}\n", 1 + i / 60, i % 60),
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    for round in 1..=10u64 {
        let before = fx.session.stats();
        // Older than everything shown: it does not wait for the other source.
        append(&a, &format!("2024-01-01 09:00:{round:02} INFO a{round}\n"));
        fx.wait("the line of a", |s| {
            s.epoch == before.epoch && s.sources[0].lines > before.sources[0].lines
        });
        // Right after an update the next one is not due for a while.
        let sent = fx.updates.lock().len();
        wait_until("the next update", || fx.updates.lock().len() > sent);
        let sent = fx.updates.lock().len();
        File::create(&a).unwrap();
        fx.wait("merged again", |s| {
            s.epoch > before.epoch && s.status == Status::Live
        });
        wait_until_or(
            "the update that says truncated",
            || format!("round {round}: {:?}", fx.session.stats()),
            || {
                fx.updates.lock()[sent..]
                    .iter()
                    .any(|u| u.status == Status::Truncated)
            },
        );
    }
    stop.store(true, Ordering::SeqCst);
    writer.join().unwrap();
}

#[test]
fn more_rotations_than_segments_start_the_source_over() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.log", "2024-01-01 10:00:00 INFO r0\n");
    let b = write(dir.path(), "b.log", "2024-01-01 09:00:00 INFO b\n");
    let fx = merge(&[&a, &b]);
    let epoch = fx.session.stats().epoch;
    for i in 1..=32 {
        fs::rename(&a, dir.path().join(format!("a.log.{i}"))).unwrap();
        fs::write(&a, format!("2024-01-01 10:00:{i:02} INFO r{i}\n")).unwrap();
        fx.wait("rotation seen", |s| {
            s.epoch > epoch || s.total_lines == i + 2
        });
    }
    // The 32nd rotation exceeds the segments: source a starts over with its current file.
    fx.wait("over", |s| s.epoch > epoch && s.total_lines == 2);
    let texts = fx.texts(false);
    assert!(
        texts[0].ends_with(" b") && texts[1].ends_with("r32"),
        "{texts:?}"
    );
}

#[test]
fn a_missing_source_does_not_stop_the_others() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.log", "2024-01-01 10:00:00 INFO a0\n");
    let b = write(dir.path(), "b.log", "2024-01-01 10:00:01 INFO b1\n");
    let fx = merge(&[&a, &b]);
    fs::remove_file(&a).unwrap();
    fx.wait("missing", |s| s.sources[0].status == Status::FileMissing);
    assert_eq!(fx.session.stats().status, Status::Live);
    append(&b, "2024-01-01 10:00:02 INFO b2\n");
    fx.wait("b goes on", |s| s.total_lines == 3);
    assert!(fx.texts(false)[0].ends_with("a0"));
    fs::write(&a, "2024-01-01 10:00:03 INFO a3 back\n").unwrap();
    fx.wait("back", |s| {
        s.total_lines == 4 && s.sources[0].status == Status::Live
    });
}

#[test]
fn freeze_holds_all_sources_and_sums_what_waits() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.log", "2024-01-01 10:00:00 INFO a0\n");
    let b = write(dir.path(), "b.log", "2024-01-01 10:00:01 INFO b1\n");
    let fx = merge(&[&a, &b]);
    fx.session.set_frozen(true);
    let line_a = "2024-01-01 10:00:02 INFO a2\n";
    let line_b = "2024-01-01 10:00:03 INFO b3\n";
    append(&a, line_a);
    append(&b, line_b);
    fx.wait("pending", |s| {
        s.frozen && s.pending_bytes == (line_a.len() + line_b.len()) as u64
    });
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(fx.session.stats().total_lines, 2);
    // A source that shrinks is flagged.
    fs::write(&b, "x\n").unwrap();
    fx.wait("stale", |s| s.frozen_stale);
    fx.session.set_frozen(false);
    fx.wait("resumed, merged again", |s| {
        !s.frozen && s.total_lines == 3 && s.status == Status::Live
    });
}

/// Requirement numbers: 2 × 500 MB interleaved against one file of 1000 MB. Run with:
/// `cargo test --release --test merge_integration -- --ignored --nocapture measure_merge`
#[test]
#[ignore]
fn measure_merge() {
    let dir = tempfile::tempdir().unwrap();
    let single = dir.path().join("single.log");
    let a = dir.path().join("a.log");
    let b = dir.path().join("b.log");
    const LEVELS: [&str; 6] = ["TRACE", "DEBUG", "INFO", "INFO", "WARN", "ERROR"];
    {
        let mut ws = std::io::BufWriter::new(File::create(&single).unwrap());
        let mut wa = std::io::BufWriter::new(File::create(&a).unwrap());
        let mut wb = std::io::BufWriter::new(File::create(&b).unwrap());
        let mut written = 0usize;
        let mut i = 0u64;
        while written < 1000 * 1024 * 1024 {
            let ms = i * 3;
            let line = format!(
                "2024-01-15 {:02}:{:02}:{:02},{:03} {} [worker-{}] com.acme.service.Handler - request {} finished in {} ms\n",
                (ms / 3_600_000) % 24,
                (ms / 60_000) % 60,
                (ms / 1000) % 60,
                ms % 1000,
                LEVELS[(i % 6) as usize],
                i % 16,
                i,
                i % 977
            );
            ws.write_all(line.as_bytes()).unwrap();
            if i.is_multiple_of(2) {
                &mut wa
            } else {
                &mut wb
            }
            .write_all(line.as_bytes())
            .unwrap();
            written += line.len();
            i += 1;
        }
        ws.flush().unwrap();
        wa.flush().unwrap();
        wb.flush().unwrap();
    }

    let measure = |label: &str, open: &dyn Fn() -> Fixture| {
        let base = CURRENT.load(Ordering::Relaxed);
        PEAK.store(base, Ordering::Relaxed);
        let start = Instant::now();
        let fx = open();
        fx.wait("indexed", |s| s.status == Status::Live);
        let stats = fx.session.stats();
        println!(
            "{label}: open {} lines in {:?}, peak +{} MB, held +{} MB",
            stats.total_lines,
            start.elapsed(),
            (PEAK.load(Ordering::Relaxed) - base) / 1024 / 1024,
            (CURRENT.load(Ordering::Relaxed) - base) / 1024 / 1024
        );
        let start = Instant::now();
        let pages = 200;
        for page in 0..pages {
            fx.session.get_lines(false, page * 40_000, 200).unwrap();
        }
        println!(
            "{label}: get_lines (200, spread) {:?} each",
            start.elapsed() / pages as u32
        );
        let start = Instant::now();
        let info = fx
            .session
            .set_filter(&[Level::Error], &SearchQuery::default(), SearchMode::Filter)
            .unwrap();
        fx.wait("level filter", |s| {
            s.view_generation == info.view_generation && !s.filter_pending
        });
        println!("{label}: level filter {:?}", start.elapsed());
        let start = Instant::now();
        let info = fx
            .session
            .set_filter(&Level::ALL, &query("request 12345 "), SearchMode::Filter)
            .unwrap();
        fx.wait("search filter", |s| {
            s.view_generation == info.view_generation && !s.filter_pending
        });
        println!(
            "{label}: search filter {:?}, {} hits",
            start.elapsed(),
            fx.session.stats().filtered_lines
        );
        fx.session
            .set_filter(&Level::ALL, &SearchQuery::default(), SearchMode::Filter)
            .unwrap();
        let start = Instant::now();
        let hit = fx
            .session
            .find(None, &query("request 9999999 "), false)
            .unwrap();
        println!(
            "{label}: find backward over all {:?} ({:?})",
            start.elapsed(),
            hit.map(|h| h.line)
        );
        drop(fx);
    };
    measure("single 1000 MB", &|| open_single(&single));
    measure("merge 2 x 500 MB", &|| try_merge(&[&a, &b], true).unwrap());
    // The merge reads every line in the order of the single file.
    let fx = merge(&[&a, &b]);
    let single_fx = open_single(&single);
    single_fx.wait("single", |s| s.status == Status::Live);
    for at in [0usize, 1_000_000, 5_000_000] {
        let merged: Vec<String> = fx
            .session
            .get_lines(false, at, 50)
            .unwrap()
            .into_iter()
            .map(|l| l.text)
            .collect();
        let plain: Vec<String> = single_fx
            .session
            .get_lines(false, at, 50)
            .unwrap()
            .into_iter()
            .map(|l| l.text)
            .collect();
        assert_eq!(merged, plain);
    }
}

/// Prompt 010: a filter tree on a merge, live, gives what the job gives, and a section between
/// markers runs in the merged order.
#[test]
fn an_expression_on_a_live_merge_equals_the_job() {
    use log_commander_lib::filter_expr::{Cond, FilterExpr, GroupOp};
    let dir = tempfile::tempdir().unwrap();
    let a = write(
        dir.path(),
        "a.log",
        "2024-01-15 10:00:00,000 INFO a BEGIN\n2024-01-15 10:00:02,000 INFO a two\n",
    );
    let b = write(
        dir.path(),
        "b.log",
        "2024-01-15 10:00:01,000 ERROR b timeout\n\tat retry.X\n2024-01-15 10:00:03,000 INFO b END\n",
    );
    let fx = merge(&[&a, &b]);
    let expr = FilterExpr::Group {
        id: "g".into(),
        op: GroupOp::Or,
        negate: false,
        children: vec![
            FilterExpr::Cond {
                id: "r".into(),
                negate: false,
                cond: Cond::Range {
                    start: query("BEGIN"),
                    end: Some(query("END")),
                    inclusive: false,
                },
            },
            FilterExpr::Cond {
                id: "t".into(),
                negate: false,
                cond: Cond::Text(query("late")),
            },
        ],
    };
    let set = |fx: &Fixture| {
        let info = fx
            .session
            .set_filter_expr(
                &Level::ALL,
                &query(""),
                SearchMode::Filter,
                None,
                Some(&expr),
            )
            .unwrap();
        fx.wait("filter", |s| {
            !s.filter_pending && s.view_generation == info.view_generation
        });
    };
    set(&fx);
    // Inside the section: b's entry (both lines) and a's second line; not the markers.
    let shown = |fx: &Fixture| -> Vec<u32> {
        fx.session
            .get_lines(true, 0, 5000)
            .unwrap()
            .iter()
            .map(|l| l.line)
            .collect()
    };
    assert_eq!(shown(&fx), vec![1, 2, 3]);
    append(&a, "2024-01-15 10:00:04,000 INFO a late\n");
    append(
        &b,
        "2024-01-15 10:00:05,000 INFO b BEGIN\n2024-01-15 10:00:06,000 INFO b in\n",
    );
    fx.wait("live lines", |s| s.total_lines == 8);
    let incremental = shown(&fx);
    set(&fx);
    assert_eq!(incremental, shown(&fx));
    assert_eq!(incremental, vec![1, 2, 3, 5, 7]);
}

/// Prompt 013: views of a merge. View 0 probes ahead, the others read the text when lines are
/// written; both give what the filter says, live too.
#[test]
fn views_of_a_merge_filter_further_and_follow_live_lines() {
    use log_commander_lib::views::ViewFilter;
    let dir = tempfile::tempdir().unwrap();
    let a = write(
        dir.path(),
        "a.log",
        "2024-01-01 10:00:00.000 INFO a needle 1\n2024-01-01 10:00:02.000 ERROR a other\n",
    );
    let b = write(
        dir.path(),
        "b.log",
        "2024-01-01 10:00:01.000 ERROR b needle 2\n2024-01-01 10:00:03.000 INFO b other\n",
    );
    let fx = merge(&[&a, &b]);
    set_filter(&fx, &Level::ALL, "needle", None);
    let child = ViewFilter {
        levels: log_commander_lib::filter::LevelMask::from_levels(&[Level::Error]),
        ..ViewFilter::default()
    };
    let view = fx
        .session
        .open_view(0, child, Box::new(|_| {}))
        .unwrap()
        .view_id;
    let lines = |v: u32| -> Vec<String> {
        fx.session
            .get_lines_of(v, true, 0, 100)
            .unwrap()
            .into_iter()
            .map(|l| l.text)
            .collect()
    };
    wait_until("the filter of the view", || {
        !fx.session.stats_of(view).unwrap().filter_pending
    });
    assert_eq!(
        lines(view),
        vec!["2024-01-01 10:00:01.000 ERROR b needle 2"]
    );
    append(&a, "2024-01-01 10:00:04.000 ERROR a needle 3\n");
    append(&b, "2024-01-01 10:00:05.000 ERROR b needle 4\n");
    fx.wait("live", |s| s.total_lines == 6);
    wait_until_or(
        "the live lines in the view",
        || format!("{:?}", lines(view)),
        || fx.session.stats_of(view).unwrap().filtered_lines >= 3,
    );
    assert_eq!(
        lines(view),
        vec![
            "2024-01-01 10:00:01.000 ERROR b needle 2",
            "2024-01-01 10:00:04.000 ERROR a needle 3",
            "2024-01-01 10:00:05.000 ERROR b needle 4",
        ]
    );
    assert_eq!(lines(0).len(), 4);
}
