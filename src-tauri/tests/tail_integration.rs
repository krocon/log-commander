//! End-to-end through a real file: write → tail sees it → truncate → rotate, without Tauri.

use log_commander_lib::filter::{SearchMode, SearchQuery};
use log_commander_lib::level::Level;
use log_commander_lib::model::{SessionUpdate, Status};
use log_commander_lib::profile::{builtin_profiles, Profile, GENERIC_PROFILE};
use log_commander_lib::session::{LogSession, OpenOptions};
use parking_lot::Mutex;
use std::fs::{self, File, OpenOptions as FsOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(10);

fn generic() -> Profile {
    builtin_profiles()
        .into_iter()
        .find(|p| p.id == GENERIC_PROFILE)
        .unwrap()
}

struct Fixture {
    session: LogSession,
    updates: Arc<Mutex<Vec<SessionUpdate>>>,
}

fn open(path: &Path, keep_on_rotate: bool) -> Fixture {
    let updates = Arc::new(Mutex::new(Vec::new()));
    let sink_updates = Arc::clone(&updates);
    let session = LogSession::open(
        1,
        path,
        OpenOptions { keep_on_rotate },
        &generic(),
        Box::new(move |update| sink_updates.lock().push(update)),
    )
    .unwrap();
    Fixture { session, updates }
}

impl Fixture {
    fn wait(&self, what: &str, condition: impl Fn(&SessionUpdate) -> bool) {
        let start = Instant::now();
        loop {
            let stats = self.session.stats();
            if condition(&stats) {
                return;
            }
            assert!(
                start.elapsed() < TIMEOUT,
                "timeout waiting for {what}: {stats:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_status(&self, what: &str, condition: impl Fn(&Status) -> bool) {
        let start = Instant::now();
        loop {
            if self.updates.lock().iter().any(|u| condition(&u.status)) {
                return;
            }
            assert!(
                start.elapsed() < TIMEOUT,
                "timeout waiting for status {what}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn texts(&self, filtered: bool) -> Vec<String> {
        self.session
            .get_lines(filtered, 0, 1000)
            .unwrap()
            .into_iter()
            .map(|l| l.text)
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

#[test]
fn write_tail_truncate_rotate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n").unwrap();
    let fx = open(&path, false);
    assert_eq!(fx.session.stats().total_lines, 1);
    // The end of the load shows a partial line at once, so tailing starts after it.
    fx.wait("loaded", |s| s.status == Status::Live);

    // Tail: new lines appear, an incomplete one only when its end arrives.
    append(&path, "2024-01-01 ERROR two\n2024-01-01 WARN thr");
    fx.wait("two lines", |s| s.total_lines == 2);
    assert_eq!(fx.session.stats().counts.error, 1);
    append(&path, "ee\n");
    fx.wait("third line", |s| s.total_lines == 3);
    assert_eq!(fx.texts(false)[2], "2024-01-01 WARN three");

    // Truncation: index restarts, reported once.
    let epoch = fx.session.stats().epoch;
    File::create(&path).unwrap();
    fx.wait("truncated", |s| s.total_lines == 0 && s.epoch > epoch);
    fx.wait_status("truncated", |s| *s == Status::Truncated);
    append(&path, "2024-01-01 DEBUG fresh\n");
    fx.wait("fresh line", |s| s.total_lines == 1);
    assert_eq!(fx.texts(false), vec!["2024-01-01 DEBUG fresh"]);

    // Rotation: lines written to the old file just before still count, then the new file is read.
    append(&path, "2024-01-01 INFO last in old\n");
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "2024-01-01 FATAL new file\n").unwrap();
    fx.wait_status("rotated", |s| *s == Status::Rotated);
    fx.wait("new file only", |s| {
        s.counts.fatal == 1 && s.total_lines == 1
    });
    assert_eq!(fx.texts(false), vec!["2024-01-01 FATAL new file"]);
}

#[test]
fn rotation_can_keep_the_old_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO old 1\n2024-01-01 INFO old 2\n").unwrap();
    let fx = open(&path, true);
    fx.wait("old lines", |s| s.total_lines == 2);
    let epoch = fx.session.stats().epoch;

    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "2024-01-01 ERROR new 1\n").unwrap();
    fx.wait("both files", |s| s.total_lines == 3);
    assert_eq!(fx.session.stats().epoch, epoch, "line numbers stay valid");
    assert_eq!(
        fx.texts(false),
        vec![
            "2024-01-01 INFO old 1",
            "2024-01-01 INFO old 2",
            "2024-01-01 ERROR new 1"
        ]
    );

    // The old file may even be gone: its handle stays open.
    fs::remove_file(dir.path().join("app.log.1")).unwrap();
    append(&path, "2024-01-01 ERROR new 2\n");
    fx.wait("appended", |s| s.total_lines == 4);
    assert_eq!(fx.texts(false)[0], "2024-01-01 INFO old 1");
    assert_eq!(fx.texts(false)[3], "2024-01-01 ERROR new 2");
}

#[test]
fn deleted_file_is_reported_and_picked_up_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO before\n").unwrap();
    let fx = open(&path, true);
    fs::remove_file(&path).unwrap();
    fx.wait("missing", |s| s.status == Status::FileMissing);
    fs::write(&path, "2024-01-01 INFO after\n").unwrap();
    fx.wait("reappeared", |s| {
        s.total_lines == 2 && s.status == Status::Live
    });
    assert_eq!(fx.texts(false)[1], "2024-01-01 INFO after");
}

#[test]
fn line_without_end_shows_after_a_pause_and_is_replaced_when_it_grows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO no newline").unwrap();
    let fx = open(&path, true);
    // Initial load shows a last line without newline at once.
    fx.wait("provisional", |s| s.total_lines == 1);
    append(&path, " yet\n2024-01-01 ERROR next\n");
    fx.wait("completed", |s| s.total_lines == 2);
    assert_eq!(fx.texts(false)[0], "2024-01-01 INFO no newline yet");
    assert_eq!(fx.session.stats().counts.info, 1);
    assert_eq!(fx.session.stats().counts.error, 1);
}

#[test]
fn filter_recomputes_and_then_grows_incrementally() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let mut content = String::new();
    for i in 0..50_000 {
        let level = if i % 10 == 0 { "ERROR" } else { "INFO" };
        content.push_str(&format!("2024-01-01 {level} line {i}\n"));
    }
    fs::write(&path, content).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 50_000);

    let info = fx
        .session
        .set_filter(&[Level::Error], &SearchQuery::default(), SearchMode::Filter)
        .unwrap();
    fx.wait("filter", |s| {
        !s.filter_pending && s.view_generation == info.view_generation
    });
    assert_eq!(fx.session.stats().filtered_lines, 5_000);

    append(&path, "2024-01-01 ERROR another\n2024-01-01 INFO quiet\n");
    fx.wait("grown", |s| {
        s.filtered_lines == 5_001 && s.total_lines == 50_002
    });

    // Search on top, then back to everything.
    let query = SearchQuery {
        text: "line 4999[0-9]".into(),
        is_regex: true,
        case_sensitive: false,
    };
    let info = fx
        .session
        .set_filter(&Level::ALL, &query, SearchMode::Filter)
        .unwrap();
    fx.wait("search", |s| {
        !s.filter_pending && s.view_generation == info.view_generation
    });
    assert_eq!(fx.session.stats().filtered_lines, 10);
    let line = &fx.session.get_lines(true, 0, 1).unwrap()[0];
    assert_eq!(line.matches, vec![[17, 27]]);

    let info = fx
        .session
        .set_filter(&Level::ALL, &SearchQuery::default(), SearchMode::Filter)
        .unwrap();
    assert!(!info.pending);
    assert_eq!(fx.session.stats().filtered_lines, 50_002);
}

#[test]
fn a_newer_filter_wins_over_a_running_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let mut content = String::new();
    for i in 0..200_000 {
        content.push_str(&format!("2024-01-01 INFO line {i}\n"));
    }
    fs::write(&path, content).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 200_000);
    let query = |text: &str| SearchQuery {
        text: text.into(),
        is_regex: false,
        case_sensitive: false,
    };
    fx.session
        .set_filter(&Level::ALL, &query("line 1"), SearchMode::Filter)
        .unwrap();
    let last = fx
        .session
        .set_filter(&Level::ALL, &query("line 199999"), SearchMode::Filter)
        .unwrap();
    fx.wait("newest filter", |s| {
        s.view_generation == last.view_generation
    });
    assert_eq!(fx.session.stats().filtered_lines, 1);
}

#[test]
fn find_navigates_and_wraps() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(
        &path,
        "2024-01-01 INFO a\n2024-01-01 INFO needle 1\n2024-01-01 ERROR b\n2024-01-01 INFO needle 2\n",
    )
    .unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 4);
    let query = SearchQuery {
        text: "NEEDLE".into(),
        is_regex: false,
        case_sensitive: false,
    };
    let find = |from, forward| fx.session.find(from, &query, forward).unwrap().unwrap();
    assert_eq!(find(None, true).line, 1);
    assert_eq!(find(Some(1), true).line, 3);
    let wrapped = find(Some(3), true);
    assert_eq!((wrapped.line, wrapped.wrapped), (1, true));
    assert_eq!(find(Some(3), false).line, 1);
    let wrapped = find(Some(1), false);
    assert_eq!((wrapped.line, wrapped.wrapped), (3, true));
    assert_eq!(find(None, false).line, 3);

    let missing = SearchQuery {
        text: "nothing".into(),
        is_regex: false,
        case_sensitive: false,
    };
    assert!(fx.session.find(None, &missing, true).unwrap().is_none());
}

#[test]
fn profile_change_recomputes_the_levels() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "OOPS one\nMEH two\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 2);
    assert_eq!(fx.session.stats().counts.unknown, 2);

    let profile = Profile {
        id: "mine".into(),
        name: "Mine".into(),
        builtin: false,
        patterns: vec!["^(?P<level>OOPS|MEH) ".into()],
        mapping: [
            ("oops".to_string(), Level::Fatal),
            ("meh".to_string(), Level::Warn),
        ]
        .into(),
        json: false,
        syslog_pri: false,
        head: None,
    };
    let info = fx.session.set_profile(&profile).unwrap();
    fx.wait("relevel", |s| {
        s.view_generation == info.view_generation && !s.filter_pending
    });
    let stats = fx.session.stats();
    assert_eq!(
        (stats.counts.fatal, stats.counts.warn, stats.counts.unknown),
        (1, 1, 0)
    );
    assert_eq!(stats.profile_id, "mine");
    append(&path, "OOPS three\n");
    fx.wait("new line uses it", |s| s.counts.fatal == 2);
}

#[test]
fn utf16_ansi_and_entry_range() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("utf16.log");
    let text = "2024-01-01 ERROR größe\r\n\tat a\r\n2024-01-01 INFO ok\r\n";
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    fs::write(&path, bytes).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 3);
    let lines = fx.session.get_lines(false, 0, 10).unwrap();
    assert_eq!(lines[0].text, "2024-01-01 ERROR größe");
    assert_eq!(lines[0].level, Level::Error);
    assert!(lines[1].is_continuation);
    assert_eq!(lines[1].level, Level::Error);
    let range = fx.session.entry_range(1);
    assert_eq!((range.first, range.last), (0, 1));
    assert_eq!(
        fx.session.copy_lines(0, 1).unwrap(),
        "2024-01-01 ERROR größe\n\tat a\n"
    );

    let path = dir.path().join("ansi.log");
    fs::write(&path, "\u{1b}[31mERROR\u{1b}[0m boom\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 1);
    let line = &fx.session.get_lines(false, 0, 1).unwrap()[0];
    assert_eq!(
        (line.text.as_str(), line.level),
        ("ERROR boom", Level::Error)
    );
}

#[test]
fn profile_is_suggested_from_the_first_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("py.log");
    fs::write(&path, "ERROR:root:boom\nINFO:root:ok\n").unwrap();
    let fx = open(&path, true);
    assert_eq!(fx.session.info().suggested_profile_id, "python");
    assert_eq!(fx.session.stats().counts.error, 1);
}

#[test]
fn errors_are_structured() {
    let dir = tempfile::tempdir().unwrap();
    let open_err = |p: &Path| {
        LogSession::open(1, p, OpenOptions::default(), &generic(), Box::new(|_| {}))
            .err()
            .unwrap()
    };
    let missing = open_err(&dir.path().join("nope.log"));
    assert_eq!(missing.code, log_commander_lib::error::ErrorCode::NotFound);
    let folder = open_err(dir.path());
    assert_eq!(
        folder.code,
        log_commander_lib::error::ErrorCode::IsADirectory
    );
}

/// Requirement numbers on a 500 MB file. Run with:
/// `cargo test --release --test tail_integration -- --ignored --nocapture measure_`
#[test]
#[ignore]
fn measure_500mb() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.log");
    let mut writer = std::io::BufWriter::new(File::create(&path).unwrap());
    let mut written = 0usize;
    let mut i = 0u64;
    const LEVELS: [&str; 6] = ["TRACE", "DEBUG", "INFO", "INFO", "WARN", "ERROR"];
    while written < 500 * 1024 * 1024 {
        let line = format!(
            "2024-01-15 10:00:00,123 {} [worker-{}] com.acme.service.Handler - request {} finished in {} ms\n",
            LEVELS[(i % 6) as usize], i % 16, i, i % 977
        );
        writer.write_all(line.as_bytes()).unwrap();
        written += line.len();
        i += 1;
    }
    writer.flush().unwrap();
    drop(writer);

    let start = Instant::now();
    let fx = open(&path, true);
    let first = fx.session.get_lines(true, 0, 100).unwrap();
    println!("first lines: {:?} ({} lines)", start.elapsed(), first.len());
    fx.wait("indexed", |s| s.status == Status::Live);
    let stats = fx.session.stats();
    println!(
        "indexed {} lines in {:?}",
        stats.total_lines,
        start.elapsed()
    );
    println!(
        "index size: {} MB",
        stats.total_lines * std::mem::size_of::<log_commander_lib::indexer::LineEntry>() as u64
            / 1024
            / 1024
    );

    let start = Instant::now();
    let info = fx
        .session
        .set_filter(&[Level::Error], &SearchQuery::default(), SearchMode::Filter)
        .unwrap();
    fx.wait("level filter", |s| {
        s.view_generation == info.view_generation
    });
    println!("level filter: {:?}", start.elapsed());

    let start = Instant::now();
    let query = SearchQuery {
        text: "request 12345 ".into(),
        is_regex: false,
        case_sensitive: false,
    };
    let info = fx
        .session
        .set_filter(&Level::ALL, &query, SearchMode::Filter)
        .unwrap();
    fx.wait("search filter", |s| {
        s.view_generation == info.view_generation
    });
    println!(
        "search filter: {:?}, {} hits",
        start.elapsed(),
        fx.session.stats().filtered_lines
    );

    let start = Instant::now();
    let pages = 200;
    for page in 0..pages {
        fx.session.get_lines(false, page * 20_000, 200).unwrap();
    }
    println!(
        "get_lines (200 lines, random): {:?} each",
        start.elapsed() / pages as u32
    );

    // Tail with 10 000 lines/s for 3 seconds.
    let info = fx
        .session
        .set_filter(&Level::ALL, &SearchQuery::default(), SearchMode::Filter)
        .unwrap();
    assert!(!info.pending);
    let before = fx.session.stats().total_lines;
    fx.updates.lock().clear();
    let mut file = FsOptions::new().append(true).open(&path).unwrap();
    for _ in 0..30 {
        let batch = "2024-01-15 10:00:00,123 INFO [w] c.a.H - tailing\n".repeat(1000);
        file.write_all(batch.as_bytes()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
    }
    fx.wait("tail caught up", |s| s.total_lines == before + 30_000);
    println!(
        "tail: {} updates during 3 s at 10k lines/s",
        fx.updates.lock().len()
    );
}

/// Long enough for the worker to have read a file if it were reading.
const SETTLE: Duration = Duration::from_millis(400);

#[test]
fn freeze_holds_the_lines_and_resuming_catches_up() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);

    fx.session.set_frozen(true);
    assert!(fx.session.stats().frozen);
    std::thread::sleep(SETTLE);
    let written = "2024-01-01 ERROR two\n";
    append(&path, written);
    fx.wait("waiting bytes are reported", |s| {
        s.pending_bytes == written.len() as u64
    });
    std::thread::sleep(SETTLE);
    let held = fx.session.stats();
    assert_eq!(held.total_lines, 1);
    assert_eq!(held.counts.error, 0);
    assert!(held.frozen);
    assert!(
        fx.updates.lock().iter().any(|u| u.frozen),
        "the frontend hears of it"
    );

    fx.session.set_frozen(false);
    fx.wait("caught up", |s| s.total_lines == 2);
    let resumed = fx.session.stats();
    assert!(!resumed.frozen);
    assert_eq!(resumed.pending_bytes, 0);
    assert_eq!(
        fx.texts(false),
        vec!["2024-01-01 INFO one", "2024-01-01 ERROR two"]
    );
}

#[test]
fn a_line_without_end_is_not_shown_during_a_freeze() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);

    fx.session.set_frozen(true);
    std::thread::sleep(SETTLE);
    append(&path, "2024-01-01 INFO par");
    std::thread::sleep(Duration::from_millis(1300));
    assert_eq!(fx.session.stats().total_lines, 1);

    append(&path, "tial\n");
    fx.session.set_frozen(false);
    fx.wait("whole line", |s| s.total_lines == 2);
    assert_eq!(fx.texts(false)[1], "2024-01-01 INFO partial");
}

#[test]
fn a_filter_set_during_a_freeze_finishes_without_new_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n2024-01-01 ERROR two\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);

    fx.session.set_frozen(true);
    std::thread::sleep(SETTLE);
    append(&path, "2024-01-01 ERROR three\n");
    let query = SearchQuery {
        text: String::new(),
        is_regex: false,
        case_sensitive: false,
    };
    fx.session
        .set_filter(&[Level::Error], &query, SearchMode::Filter)
        .unwrap();
    fx.wait("filter done", |s| {
        !s.filter_pending && s.filtered_lines == 1
    });
    let start = Instant::now();
    while !fx
        .updates
        .lock()
        .iter()
        .any(|u| u.frozen && !u.filter_pending && u.filtered_lines == 1)
    {
        assert!(
            start.elapsed() < TIMEOUT,
            "the result must reach the frontend during the freeze"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fx.texts(true), vec!["2024-01-01 ERROR two"]);
    assert_eq!(fx.session.stats().total_lines, 2);

    fx.session.set_frozen(false);
    fx.wait("the new line joins the view", |s| s.filtered_lines == 2);
}

#[test]
fn rotation_during_a_freeze_loses_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);
    let epoch = fx.session.stats().epoch;

    fx.session.set_frozen(true);
    std::thread::sleep(SETTLE);
    append(&path, "2024-01-01 INFO two, late in the old file\n");
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "2024-01-01 ERROR three\n").unwrap();
    fx.wait("the new file counts as waiting", |s| {
        s.pending_bytes
            == ("2024-01-01 INFO two, late in the old file\n".len()
                + "2024-01-01 ERROR three\n".len()) as u64
    });
    assert_eq!(fx.session.stats().total_lines, 1);

    fx.session.set_frozen(false);
    fx.wait("both files read", |s| s.total_lines == 3);
    assert_eq!(fx.session.stats().epoch, epoch);
    assert_eq!(
        fx.texts(false),
        vec![
            "2024-01-01 INFO one",
            "2024-01-01 INFO two, late in the old file",
            "2024-01-01 ERROR three"
        ]
    );
}

#[test]
fn rotation_without_keeping_starts_over_when_resuming() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n").unwrap();
    let fx = open(&path, false);
    fx.wait("loaded", |s| s.status == Status::Live);
    let epoch = fx.session.stats().epoch;

    fx.session.set_frozen(true);
    std::thread::sleep(SETTLE);
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "2024-01-01 ERROR new\n").unwrap();
    std::thread::sleep(SETTLE);
    assert_eq!(
        fx.texts(false),
        vec!["2024-01-01 INFO one"],
        "held by the open handle"
    );

    fx.session.set_frozen(false);
    fx.wait("started over", |s| s.epoch > epoch && s.total_lines == 1);
    assert_eq!(fx.texts(false), vec!["2024-01-01 ERROR new"]);
}

#[test]
fn truncation_during_a_freeze_is_flagged_and_handled_when_resuming() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n2024-01-01 INFO two\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);
    let epoch = fx.session.stats().epoch;

    fx.session.set_frozen(true);
    std::thread::sleep(SETTLE);
    File::create(&path).unwrap();
    fx.wait("flagged", |s| s.frozen_stale);
    assert_eq!(fx.session.stats().total_lines, 2);
    assert_eq!(fx.session.stats().epoch, epoch);
    // No crash and no error for lines whose text is gone.
    assert_eq!(fx.session.get_lines(false, 0, 10).unwrap().len(), 2);

    // Written past the old size again: the size alone would not show it any more.
    let rewritten = "2024-01-01 ERROR rewritten after the truncation, long enough\n";
    append(&path, rewritten);
    std::thread::sleep(SETTLE);
    fx.session.set_frozen(false);
    fx.wait("started over", |s| s.epoch > epoch && s.total_lines == 1);
    assert_eq!(fx.texts(false), vec![rewritten.trim_end()]);
    assert!(!fx.session.stats().frozen_stale);
}

#[test]
fn a_file_deleted_during_a_freeze_stays_visible_until_resuming() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);

    fx.session.set_frozen(true);
    std::thread::sleep(SETTLE);
    fs::remove_file(&path).unwrap();
    std::thread::sleep(SETTLE);
    assert_eq!(fx.session.stats().status, Status::Live);
    assert_eq!(fx.texts(false), vec!["2024-01-01 INFO one"]);

    fx.session.set_frozen(false);
    fx.wait("reported", |s| s.status == Status::FileMissing);
}
