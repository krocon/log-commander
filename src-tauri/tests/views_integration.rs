//! Several views of one file (prompt 013): each view filters the result of its parent further, live.
//! Every view must show what a single session with the composed filter shows, through tail,
//! provisional line, rotation, truncation, freeze, a changed parent and a closed parent.

use log_commander_lib::error::ErrorCode;
use log_commander_lib::filter::{LevelMask, SearchQuery};
use log_commander_lib::filter_expr::{Cond, FilterExpr};
use log_commander_lib::level::Level;
use log_commander_lib::model::{SessionUpdate, Status};
use log_commander_lib::profile::{builtin_profiles, Profile, GENERIC_PROFILE};
use log_commander_lib::session::{LogSession, OpenOptions};
use log_commander_lib::views::{compose, ViewFilter, MAX_VIEWS};
use parking_lot::Mutex;
use std::fs::{self, OpenOptions as FsOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(15);

fn profile() -> Profile {
    builtin_profiles()
        .into_iter()
        .find(|p| p.id == GENERIC_PROFILE)
        .unwrap()
}

type Updates = Arc<Mutex<Vec<SessionUpdate>>>;

fn sink(updates: &Updates) -> Box<dyn Fn(SessionUpdate) + Send + Sync> {
    let updates = Arc::clone(updates);
    Box::new(move |u| updates.lock().push(u))
}

fn open(path: &Path, keep_on_rotate: bool) -> LogSession {
    LogSession::open(
        1,
        path,
        OpenOptions {
            keep_on_rotate,
            ..OpenOptions::default()
        },
        &profile(),
        Box::new(|_| {}),
    )
    .unwrap()
}

fn append(path: &Path, text: &str) {
    let mut file = FsOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

fn wait(what: &str, condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < TIMEOUT, "timeout: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Done with its job and at `total` lines.
fn settled(session: &LogSession, view: u32, total: u64) -> bool {
    session.stats_of(view).is_ok_and(|s| {
        !s.filter_pending && s.total_lines == total && !matches!(s.status, Status::Loading { .. })
    })
}

fn lines_of(session: &LogSession, view: u32) -> Vec<u32> {
    session
        .get_lines_of(view, true, 0, 5000)
        .unwrap()
        .into_iter()
        .map(|l| l.line)
        .collect()
}

fn text(t: &str) -> FilterExpr {
    FilterExpr::Cond {
        id: format!("t-{t}"),
        negate: false,
        cond: Cond::Text(SearchQuery {
            text: t.into(),
            is_regex: false,
            case_sensitive: false,
        }),
    }
}

fn levels(levels: &[Level]) -> ViewFilter {
    ViewFilter {
        levels: LevelMask::from_levels(levels),
        ..ViewFilter::default()
    }
}

fn search(t: &str) -> ViewFilter {
    ViewFilter {
        query: SearchQuery {
            text: t.into(),
            is_regex: false,
            case_sensitive: false,
        },
        ..ViewFilter::default()
    }
}

fn tree(t: &str) -> ViewFilter {
    ViewFilter {
        expr: Some(text(t)),
        ..ViewFilter::default()
    }
}

/// What a single session with the composed filter of `chain` + `own` shows.
fn reference(path: &Path, chain: &[&ViewFilter], own: &ViewFilter) -> Vec<u32> {
    let single = open(path, true);
    let total = fs::read_to_string(path).unwrap().lines().count() as u64;
    wait("reference loaded", || single.stats().total_lines == total);
    let c = compose(chain, own);
    single
        .set_view_filter(
            0,
            ViewFilter {
                levels: c.levels,
                query: c.query,
                mode: c.mode,
                sources: c.sources,
                expr: c.expr,
            },
        )
        .unwrap();
    wait("reference filtered", || settled(&single, 0, total));
    lines_of(&single, 0)
}

fn log_line(i: usize) -> String {
    let level = ["INFO", "ERROR", "WARN", "ERROR", "DEBUG"][i % 5];
    let service = if i.is_multiple_of(3) {
        "OrderService"
    } else {
        "UserService"
    };
    let request = if i.is_multiple_of(7) { "4711" } else { "1234" };
    format!(
        "2024-01-15 10:00:{:02} {level} [{service}] request {request} step {i} äöü 🚀\n",
        i % 60
    )
}

fn write_log(path: &Path, from: usize, to: usize) {
    let text: String = (from..to).map(log_line).collect();
    append(path, &text);
}

fn lines_in(path: &Path) -> u64 {
    fs::read_to_string(path).unwrap().lines().count() as u64
}

#[test]
fn a_chain_of_two_views_filters_the_parent_further_and_follows_the_tail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "").unwrap();
    write_log(&path, 0, 400);
    let session = open(&path, true);
    wait("loaded", || settled(&session, 0, 400));
    let root = levels(&[Level::Error, Level::Warn]);
    session.set_view_filter(0, root.clone()).unwrap();
    let updates: Updates = Arc::default();
    let child = search("OrderService");
    let info = session.open_view(0, child.clone(), sink(&updates)).unwrap();
    assert_eq!(info.view_id, 1);
    assert_eq!(info.parent_view_id, Some(0));
    wait("child filtered", || settled(&session, 1, 400));

    let parent_lines = lines_of(&session, 0);
    let child_lines = lines_of(&session, 1);
    assert!(!child_lines.is_empty());
    assert!(child_lines.len() < parent_lines.len());
    assert!(child_lines.iter().all(|l| parent_lines.contains(l)));
    assert_eq!(child_lines, reference(&path, &[&root], &child));

    // The tail feeds both views.
    write_log(&path, 400, 700);
    wait("tail", || {
        settled(&session, 1, 700) && settled(&session, 0, 700)
    });
    assert_eq!(lines_of(&session, 1), reference(&path, &[&root], &child));
    assert_eq!(lines_of(&session, 0), reference(&path, &[], &root));
    // Its own channel heard of it.
    wait("child updates", || {
        updates.lock().iter().any(|u| u.total_lines == 700)
    });
}

#[test]
fn eight_views_each_with_a_filter_follow_the_tail_and_a_ninth_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "").unwrap();
    write_log(&path, 0, 300);
    let session = open(&path, true);
    wait("loaded", || settled(&session, 0, 300));
    // A chain of four and three siblings: 1 + 7 views.
    let filters = [
        levels(&[Level::Error, Level::Warn, Level::Info]),
        search("request"),
        tree("OrderService"),
        search("4711"),
        levels(&[Level::Error]),
        tree("UserService"),
        search("step 1"),
    ];
    let parents = [0u32, 1, 2, 3, 0, 0, 5];
    let updates: Updates = Arc::default();
    for (filter, parent) in filters.iter().zip(parents) {
        session
            .open_view(parent, filter.clone(), sink(&updates))
            .unwrap();
    }
    assert_eq!(filters.len() + 1, MAX_VIEWS);
    let err = session
        .open_view(0, ViewFilter::default(), sink(&updates))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::TooManyViews);
    write_log(&path, 300, 600);
    let total = lines_in(&path);
    wait("all views", || (0..8).all(|v| settled(&session, v, total)));
    let own = |v: u32| {
        if v == 0 {
            ViewFilter::default()
        } else {
            filters[v as usize - 1].clone()
        }
    };
    for view in 1..8u32 {
        // The chain above `view`, outermost first.
        let mut chain = Vec::new();
        let mut at = parents[view as usize - 1];
        loop {
            chain.insert(0, own(at));
            if at == 0 {
                break;
            }
            at = parents[at as usize - 1];
        }
        let refs: Vec<&ViewFilter> = chain.iter().collect();
        assert_eq!(
            lines_of(&session, view),
            reference(&path, &refs, &own(view)),
            "view {view}"
        );
    }
}

#[test]
fn the_provisional_line_reaches_every_view_and_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(
        &path,
        "2024-01-01 ERROR first OrderService\n2024-01-01 ERROR no newline Order",
    )
    .unwrap();
    let session = open(&path, true);
    let updates: Updates = Arc::default();
    session.set_view_filter(0, levels(&[Level::Error])).unwrap();
    session
        .open_view(0, search("OrderService"), sink(&updates))
        .unwrap();
    wait("provisional", || {
        settled(&session, 1, 2) && settled(&session, 0, 2)
    });
    assert_eq!(lines_of(&session, 0), vec![0, 1]);
    assert_eq!(lines_of(&session, 1), vec![0]);
    append(&path, "Service\n2024-01-01 INFO later\n");
    wait("completed", || {
        settled(&session, 1, 3) && settled(&session, 0, 3)
    });
    assert_eq!(lines_of(&session, 0), vec![0, 1]);
    assert_eq!(lines_of(&session, 1), vec![0, 1]);
    let texts = session.get_lines_of(1, true, 0, 10).unwrap();
    assert_eq!(texts[1].text, "2024-01-01 ERROR no newline OrderService");
}

#[test]
fn rotation_and_truncation_keep_all_views_consistent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "").unwrap();
    write_log(&path, 0, 100);
    let session = open(&path, true);
    wait("loaded", || settled(&session, 0, 100));
    let updates: Updates = Arc::default();
    let child = search("4711");
    session.open_view(0, child.clone(), sink(&updates)).unwrap();
    wait("child", || settled(&session, 1, 100));
    let before = lines_of(&session, 1).len();
    // Rotation, keeping the old lines.
    fs::rename(&path, dir.path().join("app.log.1")).unwrap();
    fs::write(&path, "").unwrap();
    write_log(&path, 100, 170);
    wait("rotated", || settled(&session, 1, 170));
    let after = lines_of(&session, 1);
    assert!(after.len() > before);
    let expected: Vec<u32> = (0..170usize)
        .filter(|i| log_line(*i).contains("4711"))
        .map(|i| i as u32)
        .collect();
    assert_eq!(after, expected);
    // Truncation: every view starts over.
    let epoch = session.stats_of(1).unwrap().epoch;
    fs::write(&path, "").unwrap();
    wait("truncated", || session.stats_of(1).unwrap().epoch > epoch);
    write_log(&path, 0, 30);
    wait("refilled", || {
        settled(&session, 1, 30) && settled(&session, 0, 30)
    });
    assert_eq!(
        lines_of(&session, 1),
        reference(&path, &[&ViewFilter::default()], &child)
    );
    assert_eq!(lines_of(&session, 0).len(), 30);
}

#[test]
fn a_freeze_holds_every_view_and_resuming_catches_up() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "").unwrap();
    write_log(&path, 0, 50);
    let session = open(&path, true);
    wait("loaded", || settled(&session, 0, 50));
    let updates: Updates = Arc::default();
    session
        .open_view(0, search("4711"), sink(&updates))
        .unwrap();
    wait("child", || settled(&session, 1, 50));
    session.set_frozen(true);
    wait("frozen update", || updates.lock().iter().any(|u| u.frozen));
    write_log(&path, 50, 120);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(session.stats_of(1).unwrap().total_lines, 50);
    assert!(session.stats_of(1).unwrap().frozen);
    session.set_frozen(false);
    wait("caught up", || settled(&session, 1, 120));
    assert!(!session.stats_of(1).unwrap().frozen);
    let expected: Vec<u32> = (0..120usize)
        .filter(|i| log_line(*i).contains("4711"))
        .map(|i| i as u32)
        .collect();
    assert_eq!(lines_of(&session, 1), expected);
}

#[test]
fn a_changed_parent_filter_is_followed_by_the_views_below() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "").unwrap();
    write_log(&path, 0, 500);
    let session = open(&path, true);
    wait("loaded", || settled(&session, 0, 500));
    let updates: Updates = Arc::default();
    let child = search("OrderService");
    let grandchild = tree("4711");
    session.open_view(0, child.clone(), sink(&updates)).unwrap();
    session
        .open_view(1, grandchild.clone(), sink(&updates))
        .unwrap();
    wait("views", || {
        settled(&session, 2, 500) && settled(&session, 1, 500)
    });
    let unfiltered = lines_of(&session, 2);
    let root = levels(&[Level::Error]);
    let generation = session.stats_of(2).unwrap().view_generation;
    session.set_view_filter(0, root.clone()).unwrap();
    wait("grandchild followed", || {
        settled(&session, 2, 500) && session.stats_of(2).unwrap().view_generation != generation
    });
    let followed = lines_of(&session, 2);
    assert!(followed.len() < unfiltered.len());
    assert_eq!(followed, reference(&path, &[&root, &child], &grandchild));
    // An invalid filter in the parent changes nothing anywhere.
    let bad = ViewFilter {
        query: SearchQuery {
            text: "(".into(),
            is_regex: true,
            case_sensitive: false,
        },
        ..ViewFilter::default()
    };
    assert_eq!(
        session.set_view_filter(1, bad).unwrap_err().code,
        ErrorCode::InvalidSearch
    );
    assert_eq!(lines_of(&session, 2), followed);
}

#[test]
fn closing_a_parent_leaves_its_children_as_they_are() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "").unwrap();
    write_log(&path, 0, 400);
    let session = open(&path, true);
    wait("loaded", || settled(&session, 0, 400));
    let root = levels(&[Level::Error, Level::Warn]);
    session.set_view_filter(0, root.clone()).unwrap();
    let child_updates: Updates = Arc::default();
    let grand_updates: Updates = Arc::default();
    session
        .open_view(0, search("OrderService"), sink(&child_updates))
        .unwrap();
    session
        .open_view(1, tree("4711"), sink(&grand_updates))
        .unwrap();
    wait("views", || {
        settled(&session, 2, 400) && settled(&session, 0, 400)
    });
    let before = lines_of(&session, 2);
    assert!(!before.is_empty());

    session.close_view(1).unwrap();
    assert_eq!(
        session.stats_of(1).unwrap_err().code,
        ErrorCode::UnknownView
    );
    // No job: the effective filter is the same.
    assert!(!session.stats_of(2).unwrap().filter_pending);
    assert_eq!(lines_of(&session, 2), before);
    let heard = child_updates.lock().len();

    // View 0 closes as a hidden identity: the grandchild keeps everything above it.
    session.close_view(0).unwrap();
    assert_eq!(
        session.stats_of(0).unwrap_err().code,
        ErrorCode::UnknownView
    );
    assert_eq!(lines_of(&session, 2), before);
    write_log(&path, 400, 600);
    wait("tail after closing", || settled(&session, 2, 600));
    let expected = reference(&path, &[&root, &search("OrderService")], &tree("4711"));
    assert_eq!(lines_of(&session, 2), expected);
    // A closed view hears nothing more.
    assert_eq!(child_updates.lock().len(), heard);
    // A filter of the grandchild still goes on top of the inherited chain.
    let warn = ViewFilter {
        levels: LevelMask::from_levels(&[Level::Warn]),
        ..tree("4711")
    };
    session.set_view_filter(2, warn).unwrap();
    wait("own filter", || settled(&session, 2, 600));
    let warn_only = lines_of(&session, 2);
    assert!(warn_only.len() < expected.len());
    assert!(warn_only.iter().all(|l| expected.contains(l)));
}

#[test]
fn a_relevel_refilters_every_view() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, "").unwrap();
    write_log(&path, 0, 200);
    let session = open(&path, true);
    wait("loaded", || settled(&session, 0, 200));
    let updates: Updates = Arc::default();
    session
        .open_view(0, levels(&[Level::Error]), sink(&updates))
        .unwrap();
    wait("child", || settled(&session, 1, 200));
    let errors = lines_of(&session, 1).len();
    assert!(errors > 0);
    // A profile that knows no level: everything is UNKNOWN, the ERROR view becomes empty.
    let plain = Profile {
        id: "plain".into(),
        name: "Plain".into(),
        patterns: vec![r"(?P<level>NEVERMATCHES)".into()],
        ..Profile::default()
    };
    session.set_profile(&plain).unwrap();
    wait("relevelled", || {
        settled(&session, 1, 200) && session.stats_of(1).unwrap().filtered_lines == 0
    });
    assert_eq!(session.stats().view_counts.error, 0);
}

/// Reading 500 MB with 1, 4 and 8 views (prompt 013). Run with:
/// `cargo test --release --test views_integration -- --ignored --nocapture measure_`
#[test]
#[ignore]
fn measure_views_500mb() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.log");
    {
        let mut writer = std::io::BufWriter::new(fs::File::create(&path).unwrap());
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
    }
    let filters = [
        levels(&[Level::Error, Level::Warn]),
        search("worker-3]"),
        tree("finished in 9"),
        levels(&[Level::Info]),
        search("request 1"),
        tree("worker-1"),
        levels(&[Level::Debug]),
    ];
    for count in [1usize, 4, 8] {
        let start = Instant::now();
        let session = open(&path, true);
        let updates: Updates = Arc::default();
        // The views open while the file is being read: their jobs and the tail run together.
        for filter in filters.iter().take(count - 1) {
            session
                .open_view(0, filter.clone(), sink(&updates))
                .unwrap();
        }
        wait_long(|| {
            let s = session.stats();
            s.status == Status::Live
                && (0..count as u32).all(|v| session.stats_of(v).is_ok_and(|s| !s.filter_pending))
        });
        let total = session.stats().total_lines;
        let list_mb: u64 = (0..count as u32)
            .map(|v| {
                let s = session.stats_of(v).unwrap();
                if s.filtered_lines == s.total_lines {
                    0
                } else {
                    s.filtered_lines * 4
                }
            })
            .sum::<u64>()
            / 1024
            / 1024;
        println!(
            "{count} view(s): read and filtered {total} lines in {:?}, lists {list_mb} MB",
            start.elapsed()
        );
        // Tail with 10 000 lines/s for 3 s.
        let mut file = FsOptions::new().append(true).open(&path).unwrap();
        let tail_start = Instant::now();
        let line = "2024-01-15 10:00:00,123 ERROR [worker-3] c.a.H - tailing request 1\n";
        for _ in 0..30 {
            file.write_all(line.repeat(1000).as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        wait_long(|| session.stats().total_lines == total + 30_000);
        println!(
            "{count} view(s): tail 30 000 lines caught up after {:?}, {} updates of the other views",
            tail_start.elapsed(),
            updates.lock().len()
        );
        drop(session);
        // Back to the original size for the next round.
        let len = fs::metadata(&path).unwrap().len() - 30_000 * line.len() as u64;
        FsOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(len)
            .unwrap();
    }
}

fn wait_long(condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < Duration::from_secs(120), "timeout");
        std::thread::sleep(Duration::from_millis(10));
    }
}
