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
const GENERIC_PATTERN_FOR_TESTS: &str = r"(?i)\b(?P<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b";

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
        ..Profile::default()
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

    // Fields: 5000 lines per call with the detected layout and without one.
    let columns = fx.session.columns();
    assert_eq!(columns.profile_id, "log4j");
    let time_pages = |label: &str| {
        let start = Instant::now();
        let calls = 20;
        for call in 0..calls {
            let lines = fx.session.get_lines(false, call * 200_000, 5000).unwrap();
            assert_eq!(lines.len(), 5000);
        }
        println!(
            "get_lines (5000 lines, {label}): {:?} each",
            start.elapsed() / calls as u32
        );
    };
    time_pages("with layout");
    let plain = Profile {
        id: "plain".into(),
        name: "Plain".into(),
        patterns: vec![GENERIC_PATTERN_FOR_TESTS.into()],
        // No layout and no inference: the JSON scanner gives up at the first byte.
        structure: log_commander_lib::profile::Structure::Json,
        ..Profile::default()
    };
    let info = fx.session.set_profile(&plain).unwrap();
    fx.wait("plain profile", |s| {
        s.view_generation == info.view_generation && !s.filter_pending
    });
    assert_eq!(fx.session.columns().columns.len(), 1);
    time_pages("without layout");

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

/// Field values of a line by column id, empty ones left out.
fn field_values(fx: &Fixture, line: usize) -> Vec<(String, String)> {
    let columns = fx.session.columns().columns;
    let lines = fx.session.get_lines(false, line, 1).unwrap();
    let line = &lines[0];
    let units: Vec<u16> = line.text.encode_utf16().collect();
    assert_eq!(line.fields.len(), columns.len());
    line.fields
        .iter()
        .zip(columns)
        .filter(|([s, e], _)| e > s)
        .map(|([s, e], c)| {
            (
                c.id,
                String::from_utf16(&units[*s as usize..*e as usize]).unwrap(),
            )
        })
        .collect()
}

fn value<'a>(values: &'a [(String, String)], id: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|(k, _)| k == id)
        .map(|(_, v)| v.as_str())
}

#[test]
fn fields_for_utf16_lines_and_continuations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("utf16.log");
    let text = "2024-01-15 10:00:00,123 ERROR [wörker] c.ä.App - Größe 😀 kaputt\r\n\tat a.B(B.java:1)\r\n2024-01-15 10:00:01,000 INFO [main] c.a.App - ok\r\n";
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    fs::write(&path, bytes).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 3);
    let set = fx.session.columns();
    assert_eq!(set.profile_id, "log4j");
    assert!(set.revision >= 1);
    assert_eq!(set.confidence, 1.0);
    let v = field_values(&fx, 0);
    assert_eq!(value(&v, "thread"), Some("wörker"));
    assert_eq!(value(&v, "logger"), Some("c.ä.App"));
    assert_eq!(value(&v, "message"), Some("Größe 😀 kaputt"));
    // The stack trace line is all message.
    let v = field_values(&fx, 1);
    assert_eq!(
        v,
        vec![("message".to_string(), "\tat a.B(B.java:1)".to_string())]
    );
}

#[test]
fn rotation_keeps_the_layout_and_other_lines_fall_back_to_the_message() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-15 10:00:00,123 INFO [main] a.B - one\n2024-01-15 10:00:01,123 WARN [main] a.B - two\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 2);
    let revision = fx.session.columns().revision;
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "{\"level\":\"info\",\"msg\":\"json now\"}\n").unwrap();
    fx.wait("rotated", |s| s.total_lines == 3);
    assert_eq!(fx.session.columns().revision, revision);
    assert_eq!(value(&field_values(&fx, 0), "message"), Some("one"));
    assert_eq!(
        field_values(&fx, 2),
        vec![(
            "message".to_string(),
            "{\"level\":\"info\",\"msg\":\"json now\"}".to_string()
        )]
    );
}

#[test]
fn a_profile_change_brings_new_columns_with_a_new_view_generation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "ERROR:root:boom\nINFO:db:ok\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 2);
    let before = fx.session.columns();
    assert_eq!(before.profile_id, "python");
    assert_eq!(fx.session.stats().columns_revision, before.revision);
    let stats = fx.session.stats();

    let custom = Profile {
        id: "mine".into(),
        name: "Mine".into(),
        patterns: vec!["^(?P<level>ERROR|INFO):".into()],
        layouts: vec!["^(?P<level>[A-Z]+):(?P<source>[a-z]+):(?P<message>.*)$".into()],
        ..Profile::default()
    };
    let info = fx.session.set_profile(&custom).unwrap();
    fx.wait("new profile", |s| {
        s.view_generation == info.view_generation && !s.filter_pending
    });
    let after = fx.session.stats();
    assert!(after.view_generation != stats.view_generation);
    assert_eq!(after.columns_revision, before.revision + 1);
    let set = fx.session.columns();
    assert_eq!(set.profile_id, "mine");
    let ids: Vec<&str> = set.columns.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["level", "source", "message"]);
    assert_eq!(value(&field_values(&fx, 1), "source"), Some("db"));

    // A broken layout is refused like a broken level regex.
    let broken = Profile {
        layouts: vec!["(".into()],
        ..custom
    };
    let err = fx.session.set_profile(&broken).unwrap_err();
    assert_eq!(
        err.code,
        log_commander_lib::error::ErrorCode::InvalidProfile
    );
}

#[test]
fn empty_binary_and_cut_lines_give_fields_without_errors() {
    let dir = tempfile::tempdir().unwrap();
    let empty = dir.path().join("empty.log");
    fs::write(&empty, "").unwrap();
    let fx = open(&empty, true);
    fx.wait("live", |s| s.status == Status::Live);
    assert_eq!(fx.session.columns().columns.len(), 1);
    // The first lines arrive later: the format is detected then.
    append(&empty, "2024-01-15 10:00:00,123 INFO [main] a.B - late\n");
    fx.wait("late line", |s| {
        s.total_lines == 1 && s.columns_revision >= 1
    });
    assert_eq!(fx.session.columns().profile_id, "log4j");
    assert_eq!(value(&field_values(&fx, 0), "message"), Some("late"));

    let binary = dir.path().join("binary.log");
    let bytes: Vec<u8> = (0..20_000u32).map(|i| (i * 7919 % 256) as u8).collect();
    fs::write(&binary, bytes).unwrap();
    let fx = open(&binary, true);
    fx.wait("live", |s| s.status == Status::Live);
    let total = fx.session.stats().total_lines as usize;
    let lines = fx.session.get_lines(false, 0, total).unwrap();
    let columns = fx.session.columns().columns.len();
    assert!(lines.iter().all(|l| l.fields.len() == columns));

    // A line over the display limit: the last field ends at the end of the text that was sent.
    let long = dir.path().join("long.log");
    let line = format!(
        "2024-01-15 10:00:00,123 INFO [main] a.B - {}\n",
        "ä".repeat(100_000)
    );
    fs::write(&long, line).unwrap();
    let fx = open(&long, true);
    fx.wait("live", |s| s.status == Status::Live);
    let got = &fx.session.get_lines(false, 0, 1).unwrap()[0];
    assert!(got.truncated);
    let end = got.text.encode_utf16().count() as u32;
    assert_eq!(got.fields.iter().map(|f| f[1]).max(), Some(end));
}

// ---------------------------------------------------------------- detail panel (prompt 004)

const STACK: &str = "2024-01-01 INFO before\n\
2024-01-01 ERROR boom\n\
\tat a.B.c(B.java:1)\n\
\tat a.B.d(B.java:2)\n\
Caused by: java.io.IOException: gone\n\
\t... 3 more\n\
2024-01-01 INFO after\n";

#[test]
fn entry_of_a_line_in_the_middle_of_a_stack_trace_ignores_the_filter() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, STACK).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 7);
    // A filter that hides the whole entry: the panel still gets it from the index.
    fx.session
        .set_filter(
            &[Level::Info],
            &SearchQuery {
                text: String::new(),
                is_regex: false,
                case_sensitive: false,
            },
            SearchMode::Filter,
        )
        .unwrap();
    fx.wait("filtered", |s| !s.filter_pending && s.filtered_lines == 2);
    let entry = fx.session.get_entry(3).unwrap();
    assert_eq!((entry.first, entry.last, entry.line_count), (1, 5, 5));
    assert_eq!(entry.level, Level::Error);
    assert!(!entry.truncated);
    assert_eq!(
        entry.text,
        "2024-01-01 ERROR boom\n\tat a.B.c(B.java:1)\n\tat a.B.d(B.java:2)\n\
         Caused by: java.io.IOException: gone\n\t... 3 more"
    );
    let bytes: u64 = STACK.lines().skip(1).take(5).map(|l| l.len() as u64).sum();
    assert_eq!(entry.total_bytes, bytes);
    // A single line is an entry of its own.
    // Copying the entry ignores the filter as well; the filtered copy has none of it.
    assert_eq!(
        fx.session.copy_all_lines(1, 5).unwrap(),
        format!("{}\n", entry.text)
    );
    assert_eq!(fx.session.copy_lines(1, 5).unwrap(), "");
    let single = fx.session.get_entry(0).unwrap();
    assert_eq!(
        (single.first, single.last, single.text.as_str()),
        (0, 0, "2024-01-01 INFO before")
    );
}

#[test]
fn entry_at_the_end_of_the_file_grows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 INFO one\n2024-01-01 ERROR boom\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 2 && s.status == Status::Live);
    let entry = fx.session.get_entry(1).unwrap();
    assert_eq!((entry.first, entry.last), (1, 1));
    append(&path, "\tat a.B.c(B.java:1)\n\tat a.B.d(B.java:2)\n");
    fx.wait("trace arrived", |s| s.total_lines == 4);
    let grown = fx.session.get_entry(1).unwrap();
    assert_eq!((grown.first, grown.last, grown.line_count), (1, 3, 3));
    assert!(grown.text.ends_with("\tat a.B.d(B.java:2)"));
}

#[test]
fn entry_text_stops_at_the_limit_on_a_character_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let limit = log_commander_lib::session::MAX_DETAIL_BYTES;

    // UTF-8: "ä" has two bytes; the prefix makes the limit fall in the middle of one.
    let path = dir.path().join("utf8.log");
    let long = format!("2024-01-01 ERROR x{}\n", "ä".repeat(limit));
    fs::write(&path, format!("{long}\tat more\n")).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 2);
    let entry = fx.session.get_entry(1).unwrap();
    assert!(entry.truncated);
    assert_eq!((entry.first, entry.last), (0, 1));
    assert!(entry.text.len() <= limit && entry.text.len() > limit - 4);
    assert!(entry.text.ends_with('ä'), "no broken character at the end");
    assert!(!entry.text.contains('\u{FFFD}'));
    // Copying is not limited.
    let copied = fx.session.copy_lines(0, 1).unwrap();
    assert!(copied.ends_with("\tat more\n") && copied.len() > limit);

    // UTF-16 with emoji (surrogate pairs, four bytes in UTF-8).
    let path = dir.path().join("utf16.log");
    let text = format!("2024-01-01 ERROR {}\r\n", "😀".repeat(limit / 3));
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    fs::write(&path, bytes).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 1);
    let entry = fx.session.get_entry(0).unwrap();
    assert!(entry.truncated);
    assert!(entry.text.len() <= limit && entry.text.len() > limit - 4);
    assert!(entry.text.starts_with("2024-01-01 ERROR 😀"));
    assert!(entry.text.ends_with('😀'));
    assert!(!entry.text.contains('\u{FFFD}'));

    // Short lines in plenty: the limit cuts between lines as well.
    let path = dir.path().join("many.log");
    let mut many = String::from("2024-01-01 ERROR head\n");
    for i in 0..30_000 {
        many.push_str(&format!("\tat frame number {i:06} of a long trace\n"));
    }
    fs::write(&path, many).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 30_001);
    let entry = fx.session.get_entry(0).unwrap();
    assert_eq!((entry.first, entry.last), (0, 30_000));
    assert!(entry.truncated && entry.text.len() <= limit);
}

#[test]
fn entry_from_the_file_before_a_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-01 ERROR old\n\tat old.Frame\n").unwrap();
    let fx = open(&path, true);
    fx.wait("old lines", |s| s.total_lines == 2);
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "2024-01-01 ERROR new\n\tat new.Frame\n").unwrap();
    fx.wait("both files", |s| s.total_lines == 4);
    let old = fx.session.get_entry(1).unwrap();
    assert_eq!((old.first, old.last), (0, 1));
    assert_eq!(old.text, "2024-01-01 ERROR old\n\tat old.Frame");
    let new = fx.session.get_entry(2).unwrap();
    assert_eq!(new.text, "2024-01-01 ERROR new\n\tat new.Frame");
}

#[test]
fn entry_of_a_file_that_shrank_is_shorter_but_no_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, STACK).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 7 && s.status == Status::Live);
    // Frozen, the index keeps the lines while the file loses its end.
    fx.session.set_frozen(true);
    std::thread::sleep(SETTLE);
    let cut = STACK.find("\tat a.B.d").unwrap() as u64;
    FsOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(cut)
        .unwrap();
    fx.wait("stale", |s| s.frozen_stale);
    let entry = fx.session.get_entry(1).unwrap();
    assert_eq!((entry.first, entry.last), (1, 5));
    assert_eq!(
        entry.text,
        "2024-01-01 ERROR boom\n\tat a.B.c(B.java:1)\n\n\n"
    );
    // An empty log has no entry.
    let empty = dir.path().join("empty.log");
    fs::write(&empty, "").unwrap();
    let fx = open(&empty, true);
    fx.wait("live", |s| s.status == Status::Live);
    assert!(fx.session.get_entry(0).is_err());
}
