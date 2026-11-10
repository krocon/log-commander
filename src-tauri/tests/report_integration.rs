//! Dashboard database (prompt 012) through real files: the table has one row per entry head with the
//! right levels, times and fields, follows the tail while the dashboard is open, starts over on
//! truncation and rotation, rests while frozen, and its file goes with the session. No file and no
//! thread before a dashboard opens.

use log_commander_lib::extract::{ExtractRule, ValueKind};
use log_commander_lib::level::Level;
use log_commander_lib::merge::MergeSource;
use log_commander_lib::model::{ReportResult, ReportState, ReportStatus, SessionUpdate, Status};
use log_commander_lib::profile::{builtin_profiles, Profile, GENERIC_PROFILE};
use log_commander_lib::report_db::ReportLimits;
use log_commander_lib::session::{LogSession, OpenOptions, SessionManager};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions as FsOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "../src/test_support.rs"]
mod test_support;
use test_support::{stays_false, wait_until_or};

fn profile(id: &str) -> Profile {
    builtin_profiles().into_iter().find(|p| p.id == id).unwrap()
}

fn options(dir: &Path, keep_on_rotate: bool) -> OpenOptions {
    OpenOptions {
        keep_on_rotate,
        report_dir: Some(dir.to_path_buf()),
        report_limits: ReportLimits {
            catch_up: Duration::from_millis(100),
            ..ReportLimits::default()
        },
        ..OpenOptions::default()
    }
}

fn open(path: &Path, reports: &Path, keep_on_rotate: bool) -> LogSession {
    let session = LogSession::open(
        1,
        path,
        options(reports, keep_on_rotate),
        &profile(GENERIC_PROFILE),
        Box::new(|_: SessionUpdate| {}),
    )
    .unwrap();
    wait(&session, "loaded", |s| s.status == Status::Live);
    session
}

#[track_caller]
fn wait(session: &LogSession, what: &str, condition: impl Fn(&SessionUpdate) -> bool) {
    wait_until_or(
        what,
        || format!("{:?}", session.stats()),
        || condition(&session.stats()),
    );
}

/// Waits until the table covers every line there is and is ready.
fn wait_ready(session: &LogSession, what: &str) -> ReportStatus {
    wait(session, what, |s| {
        s.report
            .as_ref()
            .is_some_and(|r| r.state == ReportState::Ready && r.lines == s.total_lines)
    });
    session.stats().report.unwrap()
}

fn sql(session: &LogSession, text: &str) -> ReportResult {
    session
        .run_report(text, "test")
        .unwrap_or_else(|e| panic!("{text}: {e:?}"))
}

fn int(result: &ReportResult) -> i64 {
    result.rows[0][0].as_i64().unwrap_or(-1)
}

fn append(path: &Path, text: &str) {
    let mut file = FsOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

fn files_in(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|d| d.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

const LOG: &str = "\
2026-01-15 10:00:00,001 INFO [main] c.a.Shop - Grüße 🎉 took 340ms
2026-01-15 10:00:30,002 ERROR [main] c.a.Shop - failed took 1.2s
java.lang.IllegalStateException: boom
\tat com.acme.Pool.acquire(Pool.java:142)
\tat com.acme.Pool.run(Pool.java:12)
2026-01-15 10:01:05,003 WARN [pool-1] c.a.Pool - slow took 2s
2026-01-15 10:01:06,004 ERROR [pool-1] c.a.Pool - again
\tat com.acme.Pool.acquire(Pool.java:142)
plain text the profile takes as a continuation
2026-01-15 10:02:00,005 INFO [main] c.a.Shop - done
";

#[test]
fn no_file_and_no_thread_before_a_dashboard_opens() {
    let dir = tempfile::tempdir().unwrap();
    let reports = dir.path().join("reports");
    let path = dir.path().join("app.log");
    fs::write(&path, LOG).unwrap();
    let session = open(&path, &reports, true);
    assert!(session.stats().report.is_none());
    assert_eq!(session.report_active(), (false, false));
    assert!(files_in(&reports).is_empty());
    assert!(session.run_report("SELECT 1", "a").is_err());
    // Opening creates the file and the builder, closing the dashboard stops the thread.
    session.open_report(None).unwrap();
    assert!(!files_in(&reports).is_empty());
    wait_ready(&session, "built");
    session.close_report();
    assert_eq!(session.report_active(), (true, false));
    // Closing the session deletes the file.
    drop(session);
    assert!(files_in(&reports).is_empty(), "{:?}", files_in(&reports));
}

#[test]
fn heads_only_with_levels_times_and_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, LOG).unwrap();
    let session = open(&path, dir.path(), true);
    session.open_report(None).unwrap();
    wait_ready(&session, "built");

    // One row per head, per level as many as heads in the index.
    let lines = session.get_lines(false, 0, 1000).unwrap();
    let mut heads: HashMap<String, i64> = HashMap::new();
    for line in lines.iter().filter(|l| !l.is_continuation) {
        *heads
            .entry(format!("{:?}", line.level).to_uppercase())
            .or_default() += 1;
    }
    let result = sql(&session, "SELECT level, count(*) FROM log GROUP BY level");
    let counted: HashMap<String, i64> = result
        .rows
        .iter()
        .map(|r| (r[0].as_str().unwrap().to_string(), r[1].as_i64().unwrap()))
        .collect();
    assert_eq!(counted, heads);
    assert_eq!(counted["ERROR"], 2, "a stack trace counts once");
    // `counts` counts lines (continuations inherit the level); the table counts entries.
    assert!(session.stats().counts.error > 2);

    // `line` is the line number as shown (1-based) of the head.
    let errors = sql(
        &session,
        "SELECT line FROM log WHERE level = 'ERROR' ORDER BY line",
    );
    let lines_of: Vec<i64> = errors.rows.iter().map(|r| r[0].as_i64().unwrap()).collect();
    assert_eq!(lines_of, [2, 7]);
    // Every head here has a time.
    let none = sql(&session, "SELECT count(*) FROM log WHERE ts IS NULL");
    assert_eq!(int(&none), 0);
    // Errors per minute with the helper; the minute is UTC milliseconds.
    let per_minute = sql(
        &session,
        "SELECT bucket(ts, '1m') AS t, count(*) FROM log WHERE level = 'ERROR' GROUP BY t ORDER BY t",
    );
    assert_eq!(per_minute.rows.len(), 2);
    let gap = per_minute.rows[1][0].as_i64().unwrap() - per_minute.rows[0][0].as_i64().unwrap();
    assert_eq!(gap, 60_000);
    // Sources table, the file name.
    let name = sql(&session, "SELECT name FROM sources WHERE source = 0");
    assert_eq!(name.rows[0][0], "app.log");

    // Text fields only when chosen: logger and thread, with umlauts intact.
    let schema = session.report_schema().unwrap();
    let logger = schema.columns.iter().find(|c| c.name == "logger").unwrap();
    assert!(!logger.included);
    session
        .open_report(Some(vec!["logger".into(), "thread".into()]))
        .unwrap();
    wait(&session, "rebuilt with fields", |s| {
        s.report
            .as_ref()
            .is_some_and(|r| r.generation >= 2 && r.state == ReportState::Ready)
    });
    let report = session.stats().report.unwrap();
    assert_eq!(report.reason.as_deref(), Some("fields"));
    let per_logger = sql(
        &session,
        "SELECT logger, count(*) FROM log WHERE logger IS NOT NULL GROUP BY logger ORDER BY logger",
    );
    assert_eq!(per_logger.rows.len(), 2);
    assert_eq!(per_logger.rows[0][0], "c.a.Pool");
    assert!(session
        .report_schema()
        .unwrap()
        .columns
        .iter()
        .any(|c| c.name == "logger" && c.included));
}

#[test]
fn entries_without_time_have_null_and_nothing_is_made_up() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plain.log");
    fs::write(
        &path,
        "INFO no time here\nWARN none either\n2026-01-15 10:00:00,001 ERROR timed\n",
    )
    .unwrap();
    let session = open(&path, dir.path(), true);
    session.open_report(None).unwrap();
    wait_ready(&session, "built");
    let rows = sql(&session, "SELECT level, ts FROM log ORDER BY line");
    assert_eq!(rows.rows.len(), 3);
    assert!(rows.rows[0][1].is_null());
    assert!(rows.rows[1][1].is_null());
    assert!(rows.rows[2][1].is_i64());
    // They count only when asked for: GROUP BY bucket puts them under NULL.
    let per_minute = sql(
        &session,
        "SELECT bucket(ts) AS t, count(*) FROM log GROUP BY t ORDER BY t",
    );
    assert!(per_minute.rows[0][0].is_null());
    assert_eq!(per_minute.rows[0][1], 2);
}

#[test]
fn extracted_numbers_in_their_base_unit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, LOG).unwrap();
    let manager = SessionManager::default();
    manager.set_report_dir(dir.path().join("reports"));
    let info = manager
        .open(
            &path,
            OpenOptions::default(),
            Box::new(|_: SessionUpdate| {}),
        )
        .unwrap();
    let session = manager.session(info.session_id).unwrap();
    wait(&session, "loaded", |s| s.status == Status::Live);
    let rule = ExtractRule {
        id: "r-took".into(),
        name: "took".into(),
        column: "message".into(),
        pattern: r"took (\d+(?:\.\d+)?\s*(?:ms|s))".into(),
        kind: ValueKind::Duration,
        unit: None,
    };
    manager
        .set_extract_rules(info.session_id, vec![rule])
        .unwrap();
    session.open_report(None).unwrap();
    wait(&session, "built", |s| {
        s.report
            .as_ref()
            .is_some_and(|r| r.state == ReportState::Ready && r.lines == s.total_lines)
    });
    let result = sql(
        &session,
        "SELECT line, took FROM log WHERE took IS NOT NULL ORDER BY line",
    );
    let values: Vec<(i64, f64)> = result
        .rows
        .iter()
        .map(|r| (r[0].as_i64().unwrap(), r[1].as_f64().unwrap()))
        .collect();
    assert_eq!(values, [(1, 0.34), (2, 1.2), (6, 2.0)]);
    let stats = sql(&session, "SELECT avg(took), max(took) FROM log");
    assert!((stats.rows[0][0].as_f64().unwrap() - 3.54 / 3.0).abs() < 1e-9);
    // Missing values are NULL, not 0.
    let missing = sql(&session, "SELECT count(*) FROM log WHERE took IS NULL");
    assert_eq!(int(&missing), 2);
}

#[test]
fn tail_rotation_truncation_and_freeze() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2026-01-15 10:00:00,001 INFO a\n").unwrap();
    let session = open(&path, dir.path(), true);
    session.open_report(None).unwrap();
    let first = wait_ready(&session, "built");
    assert_eq!(first.rows, 1);

    // Tail: new lines arrive with the next catch-up.
    append(
        &path,
        "2026-01-15 10:00:01,001 ERROR b\n\tat x\n2026-01-15 10:00:02,001 INFO c\n",
    );
    wait(&session, "tail", |s| {
        s.report.as_ref().is_some_and(|r| r.rows == 3)
    });
    assert_eq!(int(&sql(&session, "SELECT max(line) FROM log")), 4);

    // Rotation keeping the old lines: rows go on, same table.
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "2026-01-15 10:00:03,001 WARN d\n").unwrap();
    wait(&session, "rotated", |s| {
        s.report.as_ref().is_some_and(|r| r.rows == 4)
    });
    assert_eq!(session.stats().report.unwrap().generation, first.generation);

    // Freeze: nothing new is read, so nothing new comes in.
    session.set_frozen(true);
    let held = "2026-01-15 10:00:04,001 INFO e\n";
    append(&path, held);
    wait(&session, "the frozen worker sees the line", |s| {
        s.frozen && s.pending_bytes == held.len() as u64
    });
    assert!(stays_false(Duration::from_millis(500), || {
        session.stats().report.unwrap().rows != 4
    }));
    session.set_frozen(false);
    wait(&session, "resumed", |s| {
        s.report.as_ref().is_some_and(|r| r.rows == 5)
    });

    // Truncation: a new epoch builds anew, with the reason.
    File::create(&path).unwrap();
    append(&path, "2026-01-15 11:00:00,001 FATAL fresh\n");
    wait(&session, "rebuilt", |s| {
        s.report.as_ref().is_some_and(|r| {
            r.generation > first.generation && r.rows == 1 && r.state == ReportState::Ready
        })
    });
    let report = session.stats().report.unwrap();
    assert_eq!(report.reason.as_deref(), Some("epoch"));
    let level = sql(&session, "SELECT level, line FROM log");
    assert_eq!(level.rows[0][0], "FATAL");
    assert_eq!(level.rows[0][1], 1);
}

#[test]
fn rotation_without_keeping_builds_anew() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(
        &path,
        "2026-01-15 10:00:00,001 INFO a\n2026-01-15 10:00:01,001 INFO b\n",
    )
    .unwrap();
    let session = open(&path, dir.path(), false);
    session.open_report(None).unwrap();
    let first = wait_ready(&session, "built");
    assert_eq!(first.rows, 2);
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "2026-01-15 10:00:03,001 WARN new\n").unwrap();
    wait(&session, "rebuilt", |s| {
        s.report
            .as_ref()
            .is_some_and(|r| r.generation > first.generation && r.rows == 1)
    });
    assert_eq!(sql(&session, "SELECT level FROM log").rows[0][0], "WARN");
}

#[test]
fn only_while_open_and_closing_the_session_stops_the_build() {
    let dir = tempfile::tempdir().unwrap();
    let reports = dir.path().join("reports");
    let path = dir.path().join("app.log");
    let mut text = String::new();
    for i in 0..200_000 {
        text.push_str(&format!(
            "2026-01-15 10:{:02}:{:02},000 INFO line {i}\n",
            (i / 60) % 60,
            i % 60
        ));
    }
    fs::write(&path, &text).unwrap();
    let session = open(&path, &reports, true);
    session.open_report(None).unwrap();
    // Closing the dashboard pauses the builder; opening it again goes on from there. The builder
    // has begun its table when it says so; 200 000 lines take it a while from there.
    wait(&session, "the builder has begun", |s| s.report.is_some());
    session.close_report();
    let paused = session.stats().report.unwrap();
    assert_eq!(session.report_active(), (true, false));
    assert!(
        stays_false(Duration::from_millis(100), || {
            session.stats().report.as_ref() != Some(&paused)
        }),
        "paused: the table does not go on"
    );
    session.open_report(None).unwrap();
    let done = wait_ready(&session, "built");
    assert_eq!(done.rows, 200_000);
    assert_eq!(
        done.generation, paused.generation,
        "went on, did not start over"
    );
    // Closing the tab while building stops at the next batch and deletes the file.
    // How long is "at the next batch"? Not a number of seconds (that depends on the machine and
    // on what else it does), but far less than the whole build: a second session builds the
    // same table from the same file at the same time, and begins first. Had closing waited for
    // the build to finish, this one would be done as well.
    let other_reports = dir.path().join("other-reports");
    let other = open(&path, &other_reports, true);
    assert_eq!(other.stats().total_lines, 200_000);
    let fields = || Some(vec!["thread".to_string()]);
    other.open_report(fields()).unwrap();
    session.open_report(fields()).unwrap();
    wait(&session, "the table starts over for the field", |s| {
        s.report
            .as_ref()
            .is_some_and(|r| r.generation > done.generation)
    });
    // The builder has stopped when the file of the table is gone. Closing the session does
    // more after that (it lets go of the file watcher, which takes macOS seconds when the
    // machine is busy), so the other session is looked at then, not when the drop returns.
    let racing = std::thread::scope(|scope| {
        scope.spawn(move || drop(session));
        wait_until_or(
            "the file of the table to go",
            || format!("{:?}", files_in(&reports)),
            || files_in(&reports).is_empty(),
        );
        other.stats().report
    });
    assert!(
        racing
            .as_ref()
            .is_none_or(|r| r.state != ReportState::Ready && r.rows < 200_000),
        "closing took as long as building the whole table: {racing:?}"
    );
    assert!(files_in(&reports).is_empty());
    // The other one was building all of it, and goes on undisturbed.
    let whole = wait_ready(&other, "the other session builds the table");
    assert_eq!(whole.rows, 200_000);
}

#[test]
fn encodings_crlf_and_ansi() {
    let dir = tempfile::tempdir().unwrap();
    // UTF-16 LE with BOM and CRLF.
    let text = "2026-01-15 10:00:00,001 ERROR [m] c.A - Grüße 😀\r\n2026-01-15 10:00:01,001 INFO [m] c.A - ok\r\n";
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let path = dir.path().join("utf16.log");
    fs::write(&path, bytes).unwrap();
    let session = open(&path, dir.path(), true);
    session.open_report(Some(vec!["logger".into()])).unwrap();
    wait_ready(&session, "built");
    let rows = sql(
        &session,
        "SELECT level, ts IS NOT NULL, logger FROM log ORDER BY line",
    );
    assert_eq!(rows.rows.len(), 2);
    assert_eq!(rows.rows[0][0], "ERROR");
    assert_eq!(rows.rows[0][1], 1);
    assert_eq!(rows.rows[0][2], "c.A");

    // ANSI colours around the level.
    let path = dir.path().join("ansi.log");
    fs::write(
        &path,
        "2026-01-15 10:00:00,001 \x1b[31mERROR\x1b[0m boom\n2026-01-15 10:00:01,001 INFO fine\n",
    )
    .unwrap();
    let reports = dir.path().join("second");
    let session = open(&path, &reports, true);
    session.open_report(None).unwrap();
    wait_ready(&session, "built");
    let errors = sql(
        &session,
        "SELECT count(*) FROM log WHERE level = 'ERROR' AND ts IS NOT NULL",
    );
    assert_eq!(int(&errors), 1);
}

#[test]
fn empty_file_and_line_without_end() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.log");
    fs::write(&path, "").unwrap();
    let session = open(&path, dir.path(), true);
    session.open_report(None).unwrap();
    wait(&session, "ready", |s| {
        s.report
            .as_ref()
            .is_some_and(|r| r.state == ReportState::Ready)
    });
    assert_eq!(int(&sql(&session, "SELECT count(*) FROM log")), 0);
    // A line without its end is shown after a pause; the table takes it once it is final.
    append(&path, "2026-01-15 10:00:00,001 WARN partial");
    wait(&session, "provisional shown", |s| s.total_lines == 1);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(int(&sql(&session, "SELECT count(*) FROM log")), 0);
    append(&path, " done\n2026-01-15 10:00:01,001 INFO next\n");
    wait(&session, "final", |s| {
        s.report.as_ref().is_some_and(|r| r.rows == 2)
    });
}

#[test]
fn merge_rows_carry_their_source_and_min_line_finds_the_first_in_a_range() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.log");
    let b = dir.path().join("b.log");
    fs::write(
        &a,
        "2026-01-15 10:00:00,000 INFO a1\n2026-01-15 10:00:02,000 ERROR a2\n2026-01-15 10:00:04,000 INFO a3\n",
    )
    .unwrap();
    fs::write(
        &b,
        "2026-01-15 10:00:01,000 INFO b1\n2026-01-15 10:00:03,000 ERROR b2\n",
    )
    .unwrap();
    let sources = [&a, &b]
        .iter()
        .map(|p| MergeSource {
            path: p.to_path_buf(),
            profile: None,
        })
        .collect();
    let session =
        LogSession::open_merged(1, sources, options(dir.path(), true), Box::new(|_| {})).unwrap();
    wait(&session, "loaded", |s| s.status == Status::Live);
    session.open_report(None).unwrap();
    wait_ready(&session, "built");
    let per_source = sql(
        &session,
        "SELECT s.name, count(*) FROM log JOIN sources s USING (source) GROUP BY s.name ORDER BY s.name",
    );
    assert_eq!(per_source.rows[0][0], "a.log");
    assert_eq!(per_source.rows[0][1], 3);
    assert_eq!(per_source.rows[1][1], 2);
    let t1 = int(&sql(
        &session,
        "SELECT ts FROM log ORDER BY ts LIMIT 1 OFFSET 1",
    ));
    // A late line of the merge (appended at the end) has a higher line but an earlier time:
    // min(line) in the range is still the first line within it, not the first by time.
    std::thread::sleep(Duration::from_millis(1200));
    append(&a, "2026-01-15 10:00:05,000 INFO a4\n");
    append(&b, "2026-01-15 10:00:01,500 WARN late\n");
    wait(&session, "late line in", |s| {
        s.report.as_ref().is_some_and(|r| r.rows == 7)
    });
    let late = sql(&session, "SELECT line, ts FROM log WHERE level = 'WARN'");
    let late_line = late.rows[0][0].as_i64().unwrap();
    let late_ts = late.rows[0][1].as_i64().unwrap();
    assert!(late_line > 5, "late line appended at the end: {late_line}");
    let first_in_range = sql(
        &session,
        &format!(
            "SELECT min(line) FROM log WHERE ts >= {t1} AND ts < {}",
            t1 + 1000
        ),
    );
    assert_eq!(int(&first_in_range), 2, "b1 is line 2");
    let only_late = sql(
        &session,
        &format!(
            "SELECT min(line) FROM log WHERE ts >= {late_ts} AND ts < {}",
            late_ts + 100
        ),
    );
    assert_eq!(int(&only_late), late_line);
    let _ = Level::Warn;
}

/// Build time, file size and query time on 500 MB, and what the log view feels meanwhile. Run with:
/// `cargo test --release --test report_integration -- --ignored --nocapture measure_`
#[test]
#[ignore]
fn measure_report() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.log");
    let mut writer = std::io::BufWriter::new(File::create(&path).unwrap());
    let mut written = 0usize;
    let mut i = 0u64;
    const LEVELS: [&str; 6] = ["TRACE", "DEBUG", "INFO", "INFO", "WARN", "ERROR"];
    // One line every 10 ms: 5 million lines span about 14 hours.
    while written < 500 * 1024 * 1024 {
        let ms = i * 10;
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
        writer.write_all(line.as_bytes()).unwrap();
        written += line.len();
        i += 1;
    }
    writer.flush().unwrap();
    drop(writer);
    let reports = dir.path().join("reports");
    let manager = SessionManager::default();
    manager.set_report_dir(reports.clone());
    let info = manager
        .open(
            &path,
            OpenOptions::default(),
            Box::new(|_: SessionUpdate| {}),
        )
        .unwrap();
    let session = manager.session(info.session_id).unwrap();
    wait_long(&session, "indexed", |s| s.status == Status::Live);
    let total = session.stats().total_lines;
    let rule = ExtractRule {
        id: "r-took".into(),
        name: "took".into(),
        column: "message".into(),
        pattern: r"finished in (\d+ ms)".into(),
        kind: ValueKind::Duration,
        unit: None,
    };
    manager
        .set_extract_rules(info.session_id, vec![rule])
        .unwrap();

    // get_lines and a filter without a build, for comparison.
    let view = |label: &str| {
        let start = Instant::now();
        for page in 0..200 {
            session.get_lines(false, page * 20_000, 200).unwrap();
        }
        println!(
            "get_lines (200, random) {label}: {:?} each",
            start.elapsed() / 200
        );
    };
    view("idle");
    let filter = |label: &str| {
        let start = Instant::now();
        let info = session
            .set_filter(
                &[Level::Error],
                &Default::default(),
                log_commander_lib::filter::SearchMode::Filter,
            )
            .unwrap();
        wait_long(&session, "filter", |s| {
            s.view_generation == info.view_generation
        });
        println!("level filter {label}: {:?}", start.elapsed());
        session
            .set_filter(
                &Level::ALL,
                &Default::default(),
                log_commander_lib::filter::SearchMode::Filter,
            )
            .unwrap();
    };
    filter("idle");

    for (label, fields) in [
        ("numbers only (took)", None),
        (
            "plus logger and thread",
            Some(vec!["took".into(), "logger".into(), "thread".into()]),
        ),
    ] {
        let start = Instant::now();
        session.open_report(fields).unwrap();
        // Meanwhile: the view and a filter.
        std::thread::sleep(Duration::from_millis(300));
        view("while building");
        filter("while building");
        wait_long(&session, "built", |s| {
            s.report.as_ref().is_some_and(|r| {
                r.state == ReportState::Ready && r.lines == s.total_lines && r.rows > 0
            })
        });
        let report = session.stats().report.unwrap();
        let size: u64 = files_in(&reports)
            .iter()
            .filter_map(|p| p.metadata().ok())
            .map(|m| m.len())
            .sum();
        println!(
            "build ({label}): {:?} for {} rows of {total} lines, files {} MB (db {} MB)",
            start.elapsed(),
            report.rows,
            size / 1_048_576,
            report.size / 1_048_576
        );
        for query in [
            "SELECT bucket(ts, '1m') AS t, count(*) FROM log GROUP BY t",
            "SELECT ts / 60000 * 60000 AS t, count(*) FROM log GROUP BY t",
            "SELECT count(*) FROM log WHERE level = 'ERROR'",
            "SELECT bucket(ts, '1m') AS t, level, count(*) FROM log GROUP BY t, level",
            "SELECT bucket(ts, '1m') AS t, avg(took), max(took) FROM log GROUP BY t",
            "SELECT min(line) FROM log WHERE ts >= 1705320000000 AND ts < 1705320060000",
        ] {
            let start = Instant::now();
            let result = session.run_report(query, "m").unwrap();
            println!(
                "  {:?} for {} rows: {query}",
                start.elapsed(),
                result.rows.len()
            );
        }
    }

    // Tail with 5000 lines/s for 6 s while the dashboard is open: the index keeps up, the table
    // follows at the next catch-up.
    let before = session.stats().total_lines;
    let mut file = FsOptions::new().append(true).open(&path).unwrap();
    let start = Instant::now();
    let mut lag = Duration::ZERO;
    for step in 0..60 {
        let batch =
            "2024-01-16 10:00:00,123 ERROR [w] c.a.H - tailing finished in 5 ms\n".repeat(500);
        file.write_all(batch.as_bytes()).unwrap();
        let wanted = before + (step + 1) * 500;
        let wrote = Instant::now();
        while session.stats().total_lines < wanted {
            std::thread::sleep(Duration::from_millis(1));
        }
        lag = lag.max(wrote.elapsed());
        std::thread::sleep(Duration::from_millis(100).saturating_sub(wrote.elapsed()));
    }
    println!(
        "tail at 5000 lines/s with the dashboard open: max lag of the index {lag:?} over {:?}",
        start.elapsed()
    );
    let caught = Instant::now();
    wait_long(&session, "caught up", |s| {
        s.report.as_ref().is_some_and(|r| r.lines == s.total_lines)
    });
    println!(
        "table caught up {:?} after the last write",
        caught.elapsed()
    );
}

/// For the measurement on 500 MB: ten minutes, whatever `LC_TEST_TIMEOUT` says.
fn wait_long(session: &LogSession, what: &str, condition: impl Fn(&SessionUpdate) -> bool) {
    assert!(
        test_support::holds_within(Duration::from_secs(600), || condition(&session.stats())),
        "timeout: {what}: {:?}",
        session.stats()
    );
}

#[allow(dead_code)]
fn _arc(_: Arc<()>) {}
