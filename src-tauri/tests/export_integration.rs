//! Export and anchors (prompt 015) through real files: every format, encodings, long lines, CSV
//! specials, cancelling, the open log as target, an export during the tail, anchors after a restart,
//! inserted lines, rotation and truncation.

use log_commander_lib::error::ErrorCode;
use log_commander_lib::export::{run_export, ExportFormat, ExportRange, ExportRequest};
use log_commander_lib::filter::{SearchMode, SearchQuery};
use log_commander_lib::level::Level;
use log_commander_lib::model::{Anchor, ExportState, Status};
use log_commander_lib::profile::{builtin_profiles, Profile, GENERIC_PROFILE};
use log_commander_lib::session::{LogSession, OpenOptions};
use std::fs::{self, File, OpenOptions as FsOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(15);

fn generic() -> Profile {
    builtin_profiles()
        .into_iter()
        .find(|p| p.id == GENERIC_PROFILE)
        .unwrap()
}

fn open(path: &Path) -> LogSession {
    LogSession::open(
        1,
        path,
        OpenOptions::default(),
        &generic(),
        Box::new(|_| {}),
    )
    .unwrap()
}

fn wait(what: &str, condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < TIMEOUT, "timeout: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn loaded(session: &LogSession) {
    wait("loaded", || session.stats().status == Status::Live);
}

fn append(path: &Path, text: &str) {
    let mut file = FsOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

fn request(range: ExportRange, format: ExportFormat, target: PathBuf) -> ExportRequest {
    ExportRequest {
        view: 0,
        range,
        format,
        columns: Vec::new(),
        target,
    }
}

fn export(session: &LogSession, request: &ExportRequest) -> String {
    let cancel = AtomicBool::new(false);
    let done = run_export(session, request, 1, &cancel, |_| {}).unwrap();
    assert_eq!(done.state, ExportState::Done);
    fs::read_to_string(&request.target).unwrap()
}

/// Files in a folder, the log itself included.
fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

const SPECIAL: &str = "2026-01-15 10:00:01 ERROR said \"hi\", then =HYPERLINK(\"x\") and ä€😀";

fn mixed_file(dir: &Path) -> (PathBuf, String) {
    let long = format!("2026-01-15 10:00:02 WARN {}", "x".repeat(200 * 1024));
    let text = format!(
        "2026-01-15 10:00:00 INFO Grüße aus Köln\r\n{SPECIAL}\n{long}\n@cmd INFO at the start\n-1 INFO minus\n"
    );
    let path = dir.join("app.log");
    fs::write(&path, &text).unwrap();
    (path, text.replace("\r\n", "\n"))
}

#[test]
fn text_export_is_the_file_with_whole_long_lines() {
    let dir = tempfile::tempdir().unwrap();
    let (path, text) = mixed_file(dir.path());
    let session = open(&path);
    loaded(&session);
    let out = export(
        &session,
        &request(
            ExportRange::All,
            ExportFormat::Txt,
            dir.path().join("all.txt"),
        ),
    );
    assert_eq!(out, text);
    assert!(out.lines().any(|l| l.len() > 200 * 1024), "no 128 KB cut");
}

#[test]
fn csv_quotes_everything_and_guards_formulas() {
    let dir = tempfile::tempdir().unwrap();
    let (path, _) = mixed_file(dir.path());
    let session = open(&path);
    loaded(&session);
    let out = export(
        &session,
        &request(
            ExportRange::All,
            ExportFormat::Csv,
            dir.path().join("all.csv"),
        ),
    );
    let rows: Vec<&str> = out.split("\r\n").collect();
    assert_eq!(rows[0], "\u{feff}\"line\",\"level\",\"text\"");
    assert_eq!(
        rows[1],
        "\"1\",\"INFO\",\"2026-01-15 10:00:00 INFO Grüße aus Köln\""
    );
    assert_eq!(
        rows[2],
        format!("\"2\",\"ERROR\",\"{}\"", SPECIAL.replace('"', "\"\""))
    );
    // The level may be inherited (a line without a time continues an entry); the cell is what counts.
    assert!(
        rows[4].ends_with(",\"'@cmd INFO at the start\""),
        "{}",
        rows[4]
    );
    assert!(rows[5].ends_with(",\"'-1 INFO minus\""), "{}", rows[5]);
    assert_eq!(rows.len(), 7, "five rows, the header and the end");
    assert_eq!(rows[6], "");
}

#[test]
fn json_lines_keep_the_text() {
    let dir = tempfile::tempdir().unwrap();
    let (path, text) = mixed_file(dir.path());
    let session = open(&path);
    loaded(&session);
    let out = export(
        &session,
        &request(
            ExportRange::All,
            ExportFormat::Jsonl,
            dir.path().join("all.jsonl"),
        ),
    );
    let rows: Vec<serde_json::Value> = out
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(rows.len(), lines.len());
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(row["line"], i + 1);
        assert_eq!(row["text"], lines[i]);
    }
    assert_eq!(rows[1]["level"], "ERROR");
}

#[test]
fn ansi_colours_are_not_exported() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ansi.log");
    fs::write(
        &path,
        "\u{1b}[31mERROR\u{1b}[0m red\nINFO \u{1b}[1;32mgreen\u{1b}[0m\n",
    )
    .unwrap();
    let session = open(&path);
    loaded(&session);
    for (format, name) in [
        (ExportFormat::Txt, "a.txt"),
        (ExportFormat::Csv, "a.csv"),
        (ExportFormat::Jsonl, "a.jsonl"),
    ] {
        let out = export(
            &session,
            &request(ExportRange::All, format, dir.path().join(name)),
        );
        assert!(
            !out.contains('\u{1b}') && !out.contains("\\u001b"),
            "{name}: {out:?}"
        );
    }
    let txt = fs::read_to_string(dir.path().join("a.txt")).unwrap();
    assert_eq!(txt, "ERROR red\nINFO green\n");
}

#[test]
fn utf16_is_written_as_utf8() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("u16.log");
    let text = "INFO Grüße 😀\nERROR zwei\n";
    let mut bytes = vec![0xff, 0xfe];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(&path, bytes).unwrap();
    let session = open(&path);
    loaded(&session);
    let out = export(
        &session,
        &request(
            ExportRange::All,
            ExportFormat::Txt,
            dir.path().join("u.txt"),
        ),
    );
    assert_eq!(out, text);
}

#[test]
fn columns_of_the_format_become_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("spring.log");
    let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/spring-boot.log");
    fs::copy(sample, &path).unwrap();
    let session = open(&path);
    loaded(&session);
    let ids: Vec<String> = session
        .columns()
        .columns
        .iter()
        .map(|c| c.id.clone())
        .collect();
    assert!(ids.contains(&"thread".to_string()), "columns: {ids:?}");
    let mut req = request(
        ExportRange::All,
        ExportFormat::Jsonl,
        dir.path().join("c.jsonl"),
    );
    req.columns = vec!["thread".into(), "message".into(), "level".into()];
    let out = export(&session, &req);
    let first: serde_json::Value = serde_json::from_str(out.lines().next().unwrap()).unwrap();
    assert_eq!(first["thread"], "main");
    assert_eq!(
        first["message"],
        "Starting ShopApplication v2.4.1 using Java 21"
    );
    // A column named like one of ours is renamed, ours stays.
    assert_eq!(first["level"], "INFO");
    assert_eq!(first["level_field"], "INFO");
    // A stack trace line is all message.
    let trace = out
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
        .find(|r| {
            r["message"]
                .as_str()
                .unwrap_or("")
                .trim_start()
                .starts_with("at ")
        })
        .expect("a stack trace line");
    assert_eq!(trace["thread"], "");

    let mut req = request(
        ExportRange::All,
        ExportFormat::Csv,
        dir.path().join("c.csv"),
    );
    req.columns = vec!["timestamp".into(), "message".into()];
    let out = export(&session, &req);
    let mut rows = out.split("\r\n");
    assert_eq!(
        rows.next().unwrap(),
        "\u{feff}\"line\",\"level\",\"timestamp\",\"message\""
    );
    assert_eq!(
        rows.next().unwrap(),
        "\"1\",\"INFO\",\"2026-01-15T10:00:00.123+01:00\",\"Starting ShopApplication v2.4.1 using Java 21\""
    );
}

#[test]
fn view_and_selection_follow_the_filter() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let mut text = String::new();
    for i in 0..1000 {
        let level = if i % 10 == 0 { "ERROR" } else { "INFO" };
        text.push_str(&format!("{level} line {i}\n"));
    }
    fs::write(&path, &text).unwrap();
    let session = open(&path);
    loaded(&session);
    let empty = SearchQuery {
        text: String::new(),
        is_regex: false,
        case_sensitive: false,
    };
    session
        .set_filter(&[Level::Error], &empty, SearchMode::Filter)
        .unwrap();
    wait("filtered", || {
        let s = session.stats();
        !s.filter_pending && s.filtered_lines == 100
    });
    let view = export(
        &session,
        &request(
            ExportRange::View,
            ExportFormat::Txt,
            dir.path().join("v.txt"),
        ),
    );
    assert_eq!(view.lines().count(), 100);
    assert!(view.lines().all(|l| l.starts_with("ERROR")));
    let selection = export(
        &session,
        &request(
            ExportRange::Selection {
                first: 15,
                last: 45,
            },
            ExportFormat::Txt,
            dir.path().join("s.txt"),
        ),
    );
    assert_eq!(selection, "ERROR line 20\nERROR line 30\nERROR line 40\n");
    // All lines, whatever the filter hides.
    let all = export(
        &session,
        &request(
            ExportRange::All,
            ExportFormat::Txt,
            dir.path().join("a.txt"),
        ),
    );
    assert_eq!(all, text);
}

#[test]
fn the_end_is_fixed_while_the_tail_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let mut text = String::new();
    for i in 0..200_000 {
        text.push_str(&format!("INFO line {i} with some text to make it longer\n"));
    }
    fs::write(&path, &text).unwrap();
    let session = open(&path);
    loaded(&session);
    let stop = AtomicBool::new(false);
    let out = std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            let mut i = 0;
            while !stop.load(Ordering::Relaxed) {
                append(&path, &format!("WARN appended {i}\n"));
                i += 1;
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        std::thread::sleep(Duration::from_millis(50));
        let out = export(
            &session,
            &request(
                ExportRange::View,
                ExportFormat::Txt,
                dir.path().join("t.txt"),
            ),
        );
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        out
    });
    // Everything up to where the view ended when the export began, nothing after it.
    let lines: Vec<&str> = out.lines().collect();
    assert!(lines.len() >= 200_000, "{} lines", lines.len());
    assert_eq!(
        lines[199_999],
        "INFO line 199999 with some text to make it longer"
    );
    let written = fs::read_to_string(&path).unwrap();
    assert!(written.lines().count() > lines.len() || lines.len() > 200_000);
    assert!(written.starts_with(&out));
}

#[test]
fn cancelling_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let mut file = std::io::BufWriter::new(File::create(&path).unwrap());
    for i in 0..300_000 {
        writeln!(file, "INFO line {i}").unwrap();
    }
    drop(file);
    let session = open(&path);
    loaded(&session);
    let target = dir.path().join("out.csv");
    let cancel = AtomicBool::new(false);
    let mut calls = 0;
    let result = run_export(
        &session,
        &request(ExportRange::All, ExportFormat::Csv, target.clone()),
        7,
        &cancel,
        |p| {
            calls += 1;
            if p.state == ExportState::Running {
                // Cancelled right after the start, while the temporary file exists.
                cancel.store(true, Ordering::Relaxed);
            }
        },
    )
    .unwrap();
    assert_eq!(result.state, ExportState::Cancelled);
    assert!(calls >= 2);
    assert!(!target.exists());
    assert_eq!(files_in(dir.path()), vec!["app.log".to_string()]);
}

#[test]
fn the_open_log_is_no_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.txt");
    fs::write(&path, "INFO one\nINFO two\n").unwrap();
    let session = open(&path);
    loaded(&session);
    let cancel = AtomicBool::new(false);
    let same = run_export(
        &session,
        &request(ExportRange::All, ExportFormat::Txt, path.clone()),
        1,
        &cancel,
        |_| {},
    )
    .unwrap_err();
    assert_eq!(same.code, ErrorCode::InvalidExport);
    #[cfg(unix)]
    {
        // The same file under another name.
        let link = dir.path().join("link.txt");
        fs::hard_link(&path, &link).unwrap();
        let linked = run_export(
            &session,
            &request(ExportRange::All, ExportFormat::Txt, link),
            1,
            &cancel,
            |_| {},
        )
        .unwrap_err();
        assert_eq!(linked.code, ErrorCode::InvalidExport);
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), "INFO one\nINFO two\n");
    // A wrong extension is refused before anything is written.
    let script = run_export(
        &session,
        &request(ExportRange::All, ExportFormat::Txt, dir.path().join("x.sh")),
        1,
        &cancel,
        |_| {},
    )
    .unwrap_err();
    assert_eq!(script.code, ErrorCode::InvalidExport);
    assert!(!dir.path().join("x.sh").exists());
}

#[test]
fn a_truncation_during_the_export_fails_it_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let mut file = std::io::BufWriter::new(File::create(&path).unwrap());
    for i in 0..100_000 {
        writeln!(file, "INFO line {i}").unwrap();
    }
    drop(file);
    let session = open(&path);
    loaded(&session);
    let epoch = session.stats().epoch;
    let cancel = AtomicBool::new(false);
    let target = dir.path().join("out.txt");
    let err = run_export(
        &session,
        &request(ExportRange::All, ExportFormat::Txt, target.clone()),
        1,
        &cancel,
        |p| {
            if p.state == ExportState::Running && p.lines == 0 {
                fs::write(&path, "").unwrap();
                wait("new epoch", || session.stats().epoch != epoch);
            }
        },
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::FileChanged);
    assert!(!target.exists());
    assert_eq!(files_in(dir.path()), vec!["app.log".to_string()]);
}

// ---------------------------------------------------------------- anchors

fn numbered(count: usize) -> String {
    (0..count)
        .map(|i| format!("2026-01-15 10:00:00 INFO entry number {i}\n"))
        .collect()
}

fn anchors_of(session: &LogSession, lines: &[u32]) -> Vec<Anchor> {
    session
        .line_anchors(lines)
        .unwrap()
        .into_iter()
        .map(Option::unwrap)
        .collect()
}

#[test]
fn anchors_find_their_lines_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, numbered(50_000)).unwrap();
    let session = open(&path);
    loaded(&session);
    let anchors = anchors_of(&session, &[0, 17, 49_999]);
    assert_eq!(anchors[1].offset, numbered(17).len() as u64);
    assert_eq!(session.line_anchors(&[50_000]).unwrap(), vec![None]);
    drop(session);
    let again = open(&path);
    loaded(&again);
    assert_eq!(
        again.resolve_anchors(&anchors).unwrap(),
        vec![Some(0), Some(17), Some(49_999)]
    );
}

#[test]
fn anchors_follow_lines_inserted_before_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, numbered(30_000)).unwrap();
    let session = open(&path);
    loaded(&session);
    let anchors = anchors_of(&session, &[5, 20_000]);
    drop(session);
    fs::write(
        &path,
        format!(
            "INFO new one\nINFO new two\nINFO new three\n{}",
            numbered(30_000)
        ),
    )
    .unwrap();
    let again = open(&path);
    loaded(&again);
    assert_eq!(
        again.resolve_anchors(&anchors).unwrap(),
        vec![Some(8), Some(20_003)]
    );
}

#[test]
fn anchors_of_a_rotated_or_emptied_file_are_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, numbered(1000)).unwrap();
    let session = open(&path);
    loaded(&session);
    let anchors = anchors_of(&session, &[3, 999]);
    // Rotated: the old lines are in app.log.1, app.log starts anew with other entries.
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(
        &path,
        (0..2000)
            .map(|i| format!("2026-01-16 11:00:00 WARN other {i}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let rotated = open(&path);
    loaded(&rotated);
    assert_eq!(rotated.resolve_anchors(&anchors).unwrap(), vec![None, None]);
    // Kept in the session that saw the rotation: the old lines are still there.
    wait("rotation seen", || session.stats().total_lines >= 3000);
    assert_eq!(
        session.resolve_anchors(&anchors).unwrap(),
        vec![Some(3), Some(999)]
    );
    // Emptied.
    fs::write(&path, "").unwrap();
    let empty = open(&path);
    loaded(&empty);
    assert_eq!(empty.resolve_anchors(&anchors).unwrap(), vec![None, None]);
}

#[test]
fn a_repeated_line_resolves_to_the_nearest() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let same = "INFO heartbeat\n";
    fs::write(&path, format!("{}{}", numbered(10), same.repeat(100))).unwrap();
    let session = open(&path);
    loaded(&session);
    let anchors = anchors_of(&session, &[60]);
    drop(session);
    // Two lines more at the start: the heartbeat at 60 is now at 62, its neighbours look the same.
    fs::write(
        &path,
        format!("INFO a\nINFO b\n{}{}", numbered(10), same.repeat(100)),
    )
    .unwrap();
    let again = open(&path);
    loaded(&again);
    // Line 60 has the same text: the number wins over the offset, both are within the window.
    assert_eq!(again.resolve_anchors(&anchors).unwrap(), vec![Some(60)]);
}

/// Export of 500 MB. Run with:
/// `cargo test --release --test export_integration -- --ignored --nocapture measure_`
#[test]
#[ignore]
fn measure_export_500mb() {
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
    let session = open(&path);
    wait("indexed", || session.stats().status == Status::Live);
    let columns: Vec<String> = session
        .columns()
        .columns
        .iter()
        .map(|c| c.id.clone())
        .collect();
    println!("columns: {columns:?}");
    for (format, ext, cols) in [
        (ExportFormat::Txt, "txt", Vec::new()),
        (ExportFormat::Csv, "csv", Vec::new()),
        (ExportFormat::Csv, "csv", columns.clone()),
        (ExportFormat::Jsonl, "jsonl", columns.clone()),
    ] {
        let target = dir.path().join(format!("out-{}.{ext}", cols.len()));
        let mut req = request(ExportRange::All, format, target.clone());
        req.columns = cols.clone();
        let cancel = AtomicBool::new(false);
        // The tail and the view must not wait: get_lines runs next to the export.
        let stop = AtomicBool::new(false);
        let (done, worst) = std::thread::scope(|scope| {
            let probe = scope.spawn(|| {
                let mut worst = Duration::ZERO;
                let mut n = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    let start = Instant::now();
                    session
                        .get_lines(true, (n * 7919 % 5_000_000) as usize, 200)
                        .unwrap();
                    worst = worst.max(start.elapsed());
                    n += 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                worst
            });
            let start = Instant::now();
            let done = run_export(&session, &req, 1, &cancel, |_| {}).unwrap();
            let elapsed = start.elapsed();
            stop.store(true, Ordering::Relaxed);
            ((done, elapsed), probe.join().unwrap())
        });
        let size = fs::metadata(&target).unwrap().len();
        println!(
            "export {format:?} with {} columns: {} lines, {} MB in {:?} ({:.0} MB/s written), get_lines max {:?} meanwhile",
            cols.len(),
            done.0.lines,
            size / 1024 / 1024,
            done.1,
            size as f64 / 1024.0 / 1024.0 / done.1.as_secs_f64(),
            worst
        );
        fs::remove_file(&target).unwrap();
    }
}
