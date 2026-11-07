//! Filter expressions (prompt 010) through a real file: the incremental way in the tail gives the
//! same lines as the background job, also with a negation that takes entries out again, while the
//! filter changes during ingest, and across rotation, truncation and freeze.

use log_commander_lib::error::ErrorCode;
use log_commander_lib::filter::{SearchMode, SearchQuery};
use log_commander_lib::filter_expr::{Cond, FilterExpr, GroupOp};
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

const TIMEOUT: Duration = Duration::from_secs(15);

struct Fixture {
    session: LogSession,
    updates: Arc<Mutex<Vec<SessionUpdate>>>,
}

fn open(path: &Path, keep_on_rotate: bool) -> Fixture {
    let profile: Profile = builtin_profiles()
        .into_iter()
        .find(|p| p.id == GENERIC_PROFILE)
        .unwrap();
    let updates = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&updates);
    let session = LogSession::open(
        1,
        path,
        OpenOptions {
            keep_on_rotate,
            ..OpenOptions::default()
        },
        &profile,
        Box::new(move |u| sink.lock().push(u)),
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
            assert!(start.elapsed() < TIMEOUT, "timeout: {what}: {stats:?}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn set(&self, expr: Option<&FilterExpr>) {
        let info = self
            .session
            .set_filter_expr(
                &Level::ALL,
                &SearchQuery::default(),
                SearchMode::Filter,
                None,
                expr,
            )
            .unwrap();
        self.wait("filter", |s| {
            !s.filter_pending && s.view_generation == info.view_generation
        });
    }

    /// Line numbers of the view.
    fn shown(&self) -> Vec<u32> {
        let mut out = Vec::new();
        loop {
            let page = self.session.get_lines(true, out.len(), 5000).unwrap();
            if page.is_empty() {
                return out;
            }
            out.extend(page.iter().map(|l| l.line));
        }
    }

    /// The view now, and the view a fresh job builds for the same expression.
    fn incremental_and_job(&self, expr: &FilterExpr) -> (Vec<u32>, Vec<u32>, u64, u64) {
        let incremental = self.shown();
        let counts = view_sum(&self.session.stats());
        self.set(Some(expr));
        (
            incremental,
            self.shown(),
            counts,
            view_sum(&self.session.stats()),
        )
    }
}

fn view_sum(stats: &SessionUpdate) -> u64 {
    let c = stats.view_counts;
    c.unknown + c.trace + c.debug + c.info + c.warn + c.error + c.fatal
}

fn append(path: &Path, text: &str) {
    let mut file = FsOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

fn q(text: &str) -> SearchQuery {
    SearchQuery {
        text: text.into(),
        is_regex: false,
        case_sensitive: false,
    }
}

fn text(id: &str, negate: bool, t: &str) -> FilterExpr {
    FilterExpr::Cond {
        id: id.into(),
        negate,
        cond: Cond::Text(q(t)),
    }
}

fn group(op: GroupOp, children: Vec<FilterExpr>) -> FilterExpr {
    FilterExpr::Group {
        id: "g".into(),
        op,
        negate: false,
        children,
    }
}

fn range(start: &str, end: &str) -> FilterExpr {
    FilterExpr::Cond {
        id: "r".into(),
        negate: false,
        cond: Cond::Range {
            start: q(start),
            end: Some(q(end)),
            inclusive: true,
        },
    }
}

/// A small deterministic generator (no extra dependency).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const WORDS: [&str; 8] = [
    "timeout",
    "order",
    "größe",
    "🚀",
    "retry",
    "billing",
    "request-42",
    "caused",
];

fn random_expr(rng: &mut Rng, depth: u32, id: &mut u32) -> FilterExpr {
    *id += 1;
    let me = format!("n{id}");
    if depth < 3 && rng.below(3) == 0 {
        let children = (0..1 + rng.below(3))
            .map(|_| random_expr(rng, depth + 1, id))
            .collect();
        return FilterExpr::Group {
            id: me,
            op: if rng.below(2) == 0 {
                GroupOp::And
            } else {
                GroupOp::Or
            },
            negate: rng.below(5) == 0,
            children,
        };
    }
    let cond = match rng.below(5) {
        0 | 1 => Cond::Text(q(WORDS[rng.below(WORDS.len() as u64) as usize])),
        2 => Cond::Level {
            levels: vec![[Level::Warn, Level::Error, Level::Info][rng.below(3) as usize]],
        },
        3 => Cond::Range {
            start: q("BEGIN"),
            end: (rng.below(3) > 0).then(|| q("END")),
            inclusive: rng.below(2) == 0,
        },
        _ => Cond::Lines {
            first: Some(rng.below(400) as u32),
            last: (rng.below(2) == 0).then(|| 300 + rng.below(2000) as u32),
        },
    };
    FilterExpr::Cond {
        id: me,
        negate: rng.below(3) == 0,
        cond,
    }
}

/// A chunk of log: heads of several levels, stack traces, umlauts, emoji, CRLF, section markers.
fn chunk(rng: &mut Rng, lines: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    while n < lines {
        let level = ["INFO", "WARN", "ERROR", "DEBUG"][rng.below(4) as usize];
        let word = WORDS[rng.below(WORDS.len() as u64) as usize];
        let marker = match rng.below(12) {
            0 => " BEGIN",
            1 => " END",
            _ => "",
        };
        let end = if rng.below(5) == 0 { "\r\n" } else { "\n" };
        out.push_str(&format!(
            "2024-01-15 10:00:{:02},000 {level} [main] App - {word} {n}{marker}{end}",
            n % 60
        ));
        n += 1;
        for _ in 0..rng.below(4) {
            let word = WORDS[rng.below(WORDS.len() as u64) as usize];
            out.push_str(&format!("    at com.acme.{word}.Handler{end}"));
            n += 1;
        }
    }
    out
}

#[test]
fn incremental_equals_the_job_for_generated_expressions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    fs::write(&path, chunk(&mut rng, 200)).unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);
    let mut id = 0;
    let mut partial = 0;
    for round in 0..40 {
        let expr = random_expr(&mut rng, 0, &mut id);
        fx.set(Some(&expr));
        let total = fx.session.stats().total_lines;
        let text = chunk(&mut rng, 150);
        let added = text.lines().count() as u64;
        // In pieces, so entries also span two reads of the tail.
        let cut = text.len() / 2;
        let cut = (cut..text.len())
            .find(|i| text.is_char_boundary(*i))
            .unwrap();
        append(&path, &text[..cut]);
        append(&path, &text[cut..]);
        fx.wait("chunk", |s| s.total_lines == total + added);
        let (incremental, job, counts, job_counts) = fx.incremental_and_job(&expr);
        assert_eq!(incremental, job, "round {round}: {expr:?}");
        assert_eq!(counts, job_counts, "round {round}: view counts");
        assert_eq!(job.len() as u64, job_counts);
        let total = fx.session.stats().total_lines as usize;
        partial += usize::from(!job.is_empty() && job.len() < total);
    }
    // The generator is no use if it only produces everything or nothing.
    assert!(partial >= 15, "only {partial} rounds with a partial view");
}

#[test]
fn a_negation_takes_an_entry_out_of_the_tail_and_tells_the_view() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-15 INFO start\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);
    let expr = group(
        GroupOp::And,
        vec![text("a", false, "timeout"), text("b", true, "retry")],
    );
    fx.set(Some(&expr));
    append(
        &path,
        "2024-01-15 ERROR Timeout in OrderService\n    at a.B\n",
    );
    fx.wait("entry in", |s| s.filtered_lines == 2 && s.total_lines == 3);
    fx.updates.lock().clear();
    append(&path, "    at retry.Policy\n");
    fx.wait("entry out", |s| s.filtered_lines == 0 && s.total_lines == 4);
    fx.wait("an update says from where", |_| {
        fx.updates
            .lock()
            .iter()
            .any(|u| u.retracted_from == Some(0))
    });
    append(&path, "2024-01-15 WARN timeout again\n");
    fx.wait("next entry", |s| s.filtered_lines == 1);
    let (incremental, job, _, _) = fx.incremental_and_job(&expr);
    assert_eq!(incremental, job);
    assert_eq!(job, vec![4]);
}

#[test]
fn a_provisional_line_under_a_negation_is_withdrawn_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-15 ERROR Timeout\n    at a\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);
    let expr = group(
        GroupOp::And,
        vec![text("a", false, "timeout"), text("b", true, "retry")],
    );
    fx.set(Some(&expr));
    assert_eq!(fx.shown(), vec![0, 1]);
    // Shown after the pause as a provisional line, without retry yet: the entry stays ...
    append(&path, "    at retr");
    fx.wait("provisional", |s| s.total_lines == 3);
    assert_eq!(fx.shown(), vec![0, 1, 2]);
    append(&path, "y\n");
    // ... and when it is complete it says retry: out.
    fx.wait("completed", |s| s.total_lines == 3 && s.filtered_lines == 0);
    append(&path, "    at retr");
    fx.wait("provisional 2", |s| s.total_lines == 4);
    append(&path, "ieve\n2024-01-15 INFO timeout\n");
    fx.wait("rest", |s| s.total_lines == 5);
    let (incremental, job, counts, job_counts) = fx.incremental_and_job(&expr);
    assert_eq!(incremental, job);
    assert_eq!(counts, job_counts);
    assert_eq!(job, vec![4]);
}

#[test]
fn a_provisional_line_that_took_an_entry_out_is_withdrawn_and_taken_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-15 ERROR Timeout\n    at a\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);
    let expr = group(
        GroupOp::And,
        vec![text("a", false, "timeout"), text("b", true, "retry")],
    );
    fx.set(Some(&expr));
    // The provisional line says retry: the entry goes out.
    append(&path, "    at retry");
    fx.wait("provisional out", |s| {
        s.total_lines == 3 && s.filtered_lines == 0
    });
    // It grows: withdrawing it puts the entry back (checkpoint), the complete line takes it out again.
    append(&path, "_x\n");
    fx.wait("completed", |s| s.total_lines == 3);
    let (incremental, job, _, _) = fx.incremental_and_job(&expr);
    assert_eq!(incremental, job);
    assert!(job.is_empty());
}

#[test]
fn the_filter_changing_during_ingest_ends_like_the_job() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);
    let mut rng = Rng(42);
    let text_a = chunk(&mut rng, 150_000);
    let expected = text_a.lines().count() as u64;
    let writer = {
        let path = path.clone();
        std::thread::spawn(move || {
            for part in text_a
                .split_inclusive('\n')
                .collect::<Vec<_>>()
                .chunks(5000)
            {
                append(&path, &part.concat());
            }
        })
    };
    let exprs = [
        text("a", false, "timeout"),
        group(
            GroupOp::Or,
            vec![text("a", true, "retry"), range("BEGIN", "END")],
        ),
        group(
            GroupOp::And,
            vec![text("a", false, "größe"), text("b", true, "caused")],
        ),
    ];
    for expr in exprs.iter().cycle().take(9) {
        fx.session
            .set_filter_expr(&Level::ALL, &q(""), SearchMode::Filter, None, Some(expr))
            .unwrap();
        std::thread::sleep(Duration::from_millis(15));
    }
    writer.join().unwrap();
    fx.wait("all lines", |s| {
        s.total_lines == expected && !s.filter_pending
    });
    let last = &exprs[(9 - 1) % exprs.len()];
    let (incremental, job, counts, job_counts) = fx.incremental_and_job(last);
    assert_eq!(incremental, job);
    assert_eq!(counts, job_counts);
}

#[test]
fn rotation_truncation_and_freeze_keep_the_tail_and_the_job_equal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-15 INFO a\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.status == Status::Live);
    let expr = group(
        GroupOp::Or,
        vec![range("BEGIN", "END"), text("x", false, "ERROR")],
    );
    fx.set(Some(&expr));
    append(&path, "2024-01-15 INFO BEGIN\n2024-01-15 INFO in\n");
    fx.wait("open section", |s| s.total_lines == 3);
    // Rotation keeping the old lines: the section stays open into the new file.
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(
        &path,
        "2024-01-15 INFO still in\n2024-01-15 INFO END\n2024-01-15 INFO out\n",
    )
    .unwrap();
    fx.wait("rotated", |s| s.total_lines == 6);
    let (incremental, job, _, _) = fx.incremental_and_job(&expr);
    assert_eq!(incremental, job);
    assert_eq!(job, vec![1, 2, 3, 4]);

    // Truncation: everything starts over, the section closed.
    let epoch = fx.session.stats().epoch;
    File::create(&path).unwrap();
    fx.wait("truncated", |s| s.epoch > epoch && s.total_lines == 0);
    append(&path, "2024-01-15 INFO in?\n2024-01-15 ERROR x\n");
    fx.wait("after truncation", |s| s.total_lines == 2);
    let (incremental, job, _, _) = fx.incremental_and_job(&expr);
    assert_eq!(incremental, job);
    assert_eq!(job, vec![1]);

    // Freeze: a new filter finishes on the frozen index, resuming catches up incrementally.
    fx.session.set_frozen(true);
    fx.wait("frozen", |s| s.frozen);
    append(&path, "2024-01-15 INFO BEGIN\n2024-01-15 INFO z\n");
    let other = group(GroupOp::And, vec![range("BEGIN", "END")]);
    fx.set(Some(&other));
    assert_eq!(fx.session.stats().total_lines, 2);
    fx.session.set_frozen(false);
    fx.wait("resumed", |s| !s.frozen && s.total_lines == 4);
    let (incremental, job, _, _) = fx.incremental_and_job(&other);
    assert_eq!(incremental, job);
    assert_eq!(job, vec![2, 3]);
}

#[test]
fn an_invalid_expression_names_its_node_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-15 INFO a\n2024-01-15 ERROR b\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 2);
    let bad = group(
        GroupOp::And,
        vec![
            text("ok", false, "a"),
            FilterExpr::Cond {
                id: "broken".into(),
                negate: false,
                cond: Cond::Text(SearchQuery {
                    text: "([".into(),
                    is_regex: true,
                    case_sensitive: false,
                }),
            },
        ],
    );
    let err = fx
        .session
        .set_filter_expr(&Level::ALL, &q(""), SearchMode::Filter, None, Some(&bad))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidSearch);
    assert_eq!(err.node_id.as_deref(), Some("broken"));
    assert_eq!(fx.session.stats().filtered_lines, 2);
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["nodeId"], "broken");
}

#[test]
fn text_conditions_are_highlighted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "2024-01-15 INFO request-42 done\n").unwrap();
    let fx = open(&path, true);
    fx.wait("loaded", |s| s.total_lines == 1);
    fx.set(Some(&text("a", false, "request-42")));
    let line = &fx.session.get_lines(true, 0, 1).unwrap()[0];
    assert_eq!(line.matches, vec![[16, 26]]);
}
