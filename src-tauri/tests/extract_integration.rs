//! Extracted fields (prompt 011) through a real file: a rule adds a column without reading the file
//! again, spans are right also with umlauts and emoji, the revision goes up, other sessions of the
//! same profile follow, continuation lines stay without values, field conditions compare units.

use log_commander_lib::error::ErrorCode;
use log_commander_lib::extract::{ExtractRule, ValueKind};
use log_commander_lib::fields::ColumnKind;
use log_commander_lib::filter::{SearchMode, SearchQuery};
use log_commander_lib::filter_expr::{Cond, FieldOp, FilterExpr};
use log_commander_lib::level::Level;
use log_commander_lib::model::{LogLine, SessionUpdate, Status};
use log_commander_lib::session::{LogSession, OpenOptions, SessionManager};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

#[path = "../src/test_support.rs"]
mod test_support;

fn rule(name: &str, pattern: &str, kind: ValueKind, unit: Option<&str>) -> ExtractRule {
    ExtractRule {
        id: format!("r-{name}"),
        name: name.into(),
        column: "message".into(),
        pattern: pattern.into(),
        kind,
        unit: unit.map(Into::into),
    }
}

fn open(manager: &SessionManager, path: &Path) -> Arc<LogSession> {
    let info = manager
        .open(
            path,
            OpenOptions::default(),
            Box::new(|_: SessionUpdate| {}),
        )
        .unwrap();
    let session = manager.session(info.session_id).unwrap();
    wait(&session, "loaded", |s| s.status == Status::Live);
    session
}

#[track_caller]
fn wait(session: &LogSession, what: &str, condition: impl Fn(&SessionUpdate) -> bool) {
    test_support::wait_until_or(
        what,
        || format!("{:?}", session.stats()),
        || condition(&session.stats()),
    );
}

/// The text of a column of a line, by column id.
fn value(session: &LogSession, line: &LogLine, id: &str) -> String {
    let columns = session.columns().columns;
    let index = columns.iter().position(|c| c.id == id).unwrap();
    let [s, e] = line.fields[index];
    let units: Vec<u16> = line.text.encode_utf16().collect();
    String::from_utf16(&units[s as usize..e as usize]).unwrap()
}

const LOG: &str = "\
2026-01-15 10:00:00,001 INFO [main] c.a.Shop - Grüße 🎉 cpu=72.3% mem=1.2GB took 340ms
2026-01-15 10:00:01,002 WARN [main] c.a.Shop - Überlast 🔥🔥 cpu=99% took 1.2s
java.lang.IllegalStateException: cpu=11% took 5ms
\tat com.acme.Pool.acquire(Pool.java:142)
2026-01-15 10:00:02,003 INFO [main] c.a.Shop - nothing here
";

#[test]
fn a_rule_adds_a_column_with_the_right_spans() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.log");
    fs::write(&path, LOG).unwrap();
    let manager = SessionManager::default();
    let session = open(&manager, &path);
    let before = session.columns();
    assert_eq!(before.profile_id, "log4j");
    let view_before = session.stats().view_generation;

    let rules = vec![
        rule("cpu", r"cpu=([\d.]+)%", ValueKind::Percent, Some("%")),
        rule(
            "took",
            r"took (\d+(?:\.\d+)?(?:ms|s))",
            ValueKind::Duration,
            None,
        ),
    ];
    let columns = manager.set_extract_rules(1, rules.clone()).unwrap();
    assert_eq!(columns.revision, before.revision + 1);
    let ids: Vec<&str> = columns.columns.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(&ids[ids.len() - 2..], ["cpu", "took"]);
    let cpu = &columns.columns[ids.len() - 2];
    assert_eq!(cpu.kind, ColumnKind::Percent);
    assert_eq!(cpu.rule.as_deref(), Some("r-cpu"));
    assert_ne!(session.stats().view_generation, view_before);
    assert_eq!(session.stats().columns_revision, columns.revision);

    let lines = session.get_lines(false, 0, 10).unwrap();
    assert_eq!(lines.len(), 5);
    // Umlauts and emoji before the value: spans in UTF-16 code units.
    assert_eq!(value(&session, &lines[0], "cpu"), "72.3");
    assert_eq!(value(&session, &lines[0], "took"), "340ms");
    assert_eq!(value(&session, &lines[1], "cpu"), "99");
    assert_eq!(value(&session, &lines[1], "took"), "1.2s");
    // The value stays in the message as well: the spans overlap.
    let message = value(&session, &lines[0], "message");
    assert!(message.contains("cpu=72.3%"), "{message}");
    // A continuation line is no entry: no extraction, although it has `cpu=`.
    assert!(lines[2].is_continuation);
    assert_eq!(value(&session, &lines[2], "cpu"), "");
    // No match: empty, `[0, 0]`.
    let index = session
        .columns()
        .columns
        .iter()
        .position(|c| c.id == "cpu")
        .unwrap();
    assert_eq!(lines[4].fields[index], [0, 0]);

    // Field conditions compare in the base unit: `took > 500 ms` keeps 1.2 s, not 340 ms.
    let expr = FilterExpr::Cond {
        id: "c".into(),
        negate: false,
        cond: Cond::Field {
            column: "took".into(),
            op: FieldOp::Gt,
            value: "500 ms".into(),
            value2: None,
            case_sensitive: false,
        },
    };
    let info = session
        .set_filter_expr(
            &Level::ALL,
            &SearchQuery::default(),
            SearchMode::Filter,
            None,
            Some(&expr),
        )
        .unwrap();
    wait(&session, "filtered by took", |s| {
        s.view_generation == info.view_generation && !s.filter_pending
    });
    let texts: Vec<String> = session
        .get_lines(true, 0, 10)
        .unwrap()
        .into_iter()
        .map(|l| l.text)
        .collect();
    // The whole entry: the head and its stack trace.
    assert_eq!(texts.len(), 3, "{texts:?}");
    assert!(texts[0].contains("Überlast"));
    let cpu_over = FilterExpr::Cond {
        id: "c".into(),
        negate: false,
        cond: Cond::Field {
            column: "cpu".into(),
            op: FieldOp::Gt,
            value: "70".into(),
            value2: None,
            case_sensitive: false,
        },
    };
    let info = session
        .set_filter_expr(
            &Level::ALL,
            &SearchQuery::default(),
            SearchMode::Filter,
            None,
            Some(&cpu_over),
        )
        .unwrap();
    wait(&session, "filtered by cpu", |s| {
        s.view_generation == info.view_generation && !s.filter_pending
    });
    // Both heads, each with its stack trace; the continuation's `cpu=11%` does not count.
    assert_eq!(session.get_lines(true, 0, 10).unwrap().len(), 4);

    // The tail: new lines get the column too.
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(
        file,
        "2026-01-15 10:00:03,004 INFO [main] c.a.Shop - cpu=5.5% took 2ms"
    )
    .unwrap();
    wait(&session, "tail", |s| s.total_lines == 6);
    let last = &session.get_lines(false, 5, 1).unwrap()[0];
    assert_eq!(value(&session, last, "cpu"), "5.5");

    // Removing the rules removes the columns.
    let columns = manager.set_extract_rules(1, Vec::new()).unwrap();
    assert_eq!(columns.columns.len(), before.columns.len());
}

#[test]
fn rules_apply_to_other_sessions_of_the_profile_and_are_checked() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.log");
    let b = dir.path().join("b.log");
    let c = dir.path().join("c.jsonl");
    fs::write(&a, LOG).unwrap();
    fs::write(&b, LOG.replace("72.3", "12.5")).unwrap();
    fs::write(&c, "{\"level\":\"info\",\"msg\":\"cpu=1%\",\"cpu\":3}\n{\"level\":\"warn\",\"msg\":\"cpu=2%\",\"cpu\":4}\n").unwrap();
    let manager = SessionManager::default();
    let sa = open(&manager, &a);
    let sb = open(&manager, &b);
    let sc = open(&manager, &c);
    let other_revision = sc.columns().revision;
    let rules = vec![rule("cpu", r"cpu=([\d.]+)%", ValueKind::Percent, None)];
    manager.set_extract_rules(sa.id, rules.clone()).unwrap();
    // Same profile: the column is there without opening the file again.
    wait(&sb, "b has cpu", |_| {
        sb.columns().columns.iter().any(|c| c.id == "cpu")
    });
    let line = &sb.get_lines(false, 0, 1).unwrap()[0];
    assert_eq!(value(&sb, line, "cpu"), "12.5");
    // Another profile stays as it is.
    assert_eq!(sc.columns().revision, other_revision);

    // A name that is a column already: an error at the rule, nothing renamed, nothing changed.
    let err = manager.set_extract_rules(sc.id, rules.clone()).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRule);
    assert_eq!(err.node_id.as_deref(), Some("r-cpu"));
    assert_eq!(sc.columns().revision, other_revision);
    let err = manager
        .set_extract_rules(sa.id, vec![rule("x", r"x=\d+", ValueKind::Number, None)])
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRule);
    let err = manager
        .set_extract_rules(sa.id, vec![rule("x", r"x=(\d+", ValueKind::Number, None)])
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRule);
    // The good rules stayed.
    assert!(sa.columns().columns.iter().any(|c| c.id == "cpu"));

    // Loading from the settings (start): a new session of the profile has them right away.
    let mut all = HashMap::new();
    all.insert(
        "log4j".to_string(),
        vec![rule("took", r"took (\d+ms)", ValueKind::Duration, None)],
    );
    manager.load_extract_rules(all);
    wait(&sa, "a has took", |_| {
        sa.columns().columns.iter().any(|c| c.id == "took")
    });
    assert!(!sa.columns().columns.iter().any(|c| c.id == "cpu"));
    let d = dir.path().join("d.log");
    fs::write(&d, LOG).unwrap();
    let sd = open(&manager, &d);
    let line = &sd.get_lines(false, 0, 1).unwrap()[0];
    assert_eq!(value(&sd, line, "took"), "340ms");
}

#[test]
fn suggestions_come_from_the_whole_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("metrics.log");
    let mut text = String::new();
    // The first half has no measurements: a sample of the start would find nothing.
    for i in 0..3000 {
        text.push_str(&format!(
            "2026-01-15 10:00:00,{:03} INFO [main] c.a.Job - step {i} done\n",
            i % 1000
        ));
    }
    for i in 0..3000 {
        text.push_str(&format!(
            "2026-01-15 10:00:01,{:03} INFO [main] c.a.Job - id={} cpu={}.{}% took {}ms\n",
            i % 1000,
            900_000 + i,
            i % 90,
            i % 10,
            3 + (i * 7) % 500
        ));
    }
    fs::write(&path, text).unwrap();
    let manager = SessionManager::default();
    let session = open(&manager, &path);
    let found = session.suggest_fields().unwrap();
    let names: Vec<&str> = found.iter().map(|s| s.rule.name.as_str()).collect();
    assert!(
        names.contains(&"cpu") && names.contains(&"took"),
        "{names:?}"
    );
    assert!(
        !names.contains(&"id") && !names.contains(&"step"),
        "{names:?}"
    );
    let cpu = found.iter().find(|s| s.rule.name == "cpu").unwrap();
    assert!((cpu.share - 0.5).abs() < 0.05, "{}", cpu.share);
    // Accepting works without reading the file again.
    let rules: Vec<ExtractRule> = found.iter().map(|s| s.rule.clone()).collect();
    manager.set_extract_rules(session.id, rules).unwrap();
    let line = &session.get_lines(false, 3000, 1).unwrap()[0];
    assert_eq!(value(&session, line, "took"), "3ms");
    // Accepted names are columns now: no second suggestion of them.
    assert!(session.suggest_fields().unwrap().is_empty());
}

/// `get_lines` with 0, 4 and 16 rules. Run with:
/// `cargo test --release --test extract_integration -- --ignored --nocapture measure_`
#[test]
#[ignore]
fn measure_get_lines_with_rules() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rules.log");
    let mut text = String::new();
    for i in 0..200_000u64 {
        text.push_str(&format!(
            "2024-01-15 10:00:00,123 INFO [worker-{}] com.acme.service.Handler - request {i} cpu={}.{}% mem={}MB finished in {} ms\n",
            i % 16,
            i % 100,
            i % 10,
            100 + i % 900,
            i % 977
        ));
    }
    fs::write(&path, text).unwrap();
    let manager = SessionManager::default();
    let session = open(&manager, &path);
    let mut all = vec![
        rule("cpu", r"cpu=([\d.]+)%", ValueKind::Percent, None),
        rule("mem", r"mem=(\d+MB)", ValueKind::Size, None),
        rule(
            "took",
            r"finished in (\d+) ms",
            ValueKind::Duration,
            Some("ms"),
        ),
        rule("request", r"request (\d+)", ValueKind::Number, None),
    ];
    for i in 0..12 {
        all.push(rule(
            &format!("absent{i}"),
            &format!(r"absent{i}=(\d+)"),
            ValueKind::Number,
            None,
        ));
    }
    for n in [0usize, 4, 16] {
        manager
            .set_extract_rules(session.id, all[..n].to_vec())
            .unwrap();
        let start = Instant::now();
        let calls = 20;
        for call in 0..calls {
            let lines = session.get_lines(false, call * 9000, 5000).unwrap();
            assert_eq!(lines.len(), 5000);
        }
        println!(
            "get_lines (5000 lines, {n} rules): {:?} each",
            start.elapsed() / calls as u32
        );
    }
}

#[test]
fn the_metrics_sample_suggests_cpu_mem_and_took() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/metrics.log");
    let manager = SessionManager::default();
    let session = open(&manager, &path);
    assert_eq!(session.columns().profile_id, "log4j");
    let found = session.suggest_fields().unwrap();
    let mut names: Vec<&str> = found.iter().map(|s| s.rule.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["cpu", "mem", "took"]);
    let took = found.iter().find(|s| s.rule.name == "took").unwrap();
    assert_eq!(took.rule.kind, ValueKind::Duration);
}
