//! Order of the commands that change a session (prompt 023): commands arrive as separate tasks,
//! in any order. A change must not build on a state another one replaces in between, and an
//! older call arriving after a newer one of the same kind must change nothing.

#[path = "../src/test_support.rs"]
mod test_support;

use log_commander_lib::error::ErrorCode;
use log_commander_lib::filter::SearchQuery;
use log_commander_lib::level::Level;
use log_commander_lib::model::Status;
use log_commander_lib::profile::{builtin_profiles, Profile, GENERIC_PROFILE};
use log_commander_lib::session::{LogSession, OpenOptions};
use log_commander_lib::views::ViewFilter;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::Duration;
use test_support::{holds_within, wait_until_or};

fn profile() -> Profile {
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
        &profile(),
        Box::new(|_| {}),
    )
    .unwrap()
}

fn levels(session: &LogSession, levels: &[Level]) -> ViewFilter {
    session.view_filter(
        levels,
        &SearchQuery::default(),
        Default::default(),
        None,
        None,
    )
}

fn text(session: &LogSession, text: &str) -> ViewFilter {
    let query = SearchQuery {
        text: text.into(),
        ..SearchQuery::default()
    };
    session.view_filter(&Level::ALL, &query, Default::default(), None, None)
}

fn settle(session: &LogSession, view: u32, what: &str) {
    wait_until_or(
        what,
        || format!("{:?}", session.stats_of(view)),
        || {
            session
                .stats_of(view)
                .is_ok_and(|s| !s.filter_pending && !matches!(s.status, Status::Loading { .. }))
        },
    );
}

fn lines_of(session: &LogSession, view: u32) -> Vec<u32> {
    session
        .get_lines_of(view, true, 0, 100)
        .unwrap()
        .into_iter()
        .map(|l| l.line)
        .collect()
}

/// Line 0: ERROR with x, 1: ERROR, 2: INFO with x, 3: INFO.
const LOG: &str = "2026-01-01 10:00:00 ERROR x one\n\
                   2026-01-01 10:00:01 ERROR two\n\
                   2026-01-01 10:00:02 INFO x three\n\
                   2026-01-01 10:00:03 INFO four\n";

#[test]
fn a_filter_of_a_child_set_while_the_parent_compiles_is_not_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, LOG).unwrap();
    let session = Arc::new(open(&path));
    settle(&session, 0, "the file is read");
    let child = session
        .open_view(0, ViewFilter::default(), Box::new(|_| {}))
        .unwrap()
        .view_id;
    settle(&session, child, "the child shows everything");
    assert_eq!(lines_of(&session, child), [0, 1, 2, 3]);

    // The parent's call stops between compiling the chains and storing them; meanwhile the
    // child gets its own filter. Without the lock around both steps the parent then stores the
    // child's chain as compiled before: "ERROR and nothing else" instead of "ERROR and x".
    let (compiled_tx, compiled_rx) = channel::<()>();
    let child_done = Arc::new(AtomicBool::new(false));
    let first = AtomicBool::new(true);
    let seen = Arc::clone(&child_done);
    session.on_compiled(move || {
        if first.swap(false, Ordering::SeqCst) {
            compiled_tx.send(()).unwrap();
            // Either the child's call gets through meanwhile (the bug), or it waits for this
            // call to end: then the pause runs out and proves nothing got in between.
            holds_within(Duration::from_millis(400), || seen.load(Ordering::SeqCst));
        }
    });
    let parent_call = {
        let session = Arc::clone(&session);
        std::thread::spawn(move || {
            let own = levels(&session, &[Level::Error]);
            session.set_view_filter(0, own).unwrap();
        })
    };
    compiled_rx.recv().unwrap();
    session.set_view_filter(child, text(&session, "x")).unwrap();
    child_done.store(true, Ordering::SeqCst);
    parent_call.join().unwrap();

    settle(&session, 0, "the parent filters");
    settle(&session, child, "the child filters");
    assert_eq!(lines_of(&session, 0), [0, 1], "parent: ERROR");
    assert_eq!(lines_of(&session, child), [0], "child: ERROR and x");
}

#[test]
fn an_older_call_arriving_late_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, LOG).unwrap();
    let session = open(&path);
    settle(&session, 0, "the file is read");

    // Sent as 1: ERROR, 2: INFO. They arrive the other way round.
    session
        .set_view_filter_at(0, levels(&session, &[Level::Info]), Some(2))
        .unwrap();
    let late = session
        .set_view_filter_at(0, levels(&session, &[Level::Error]), Some(1))
        .unwrap_err();
    assert_eq!(late.code, ErrorCode::Superseded);
    settle(&session, 0, "the newer filter");
    assert_eq!(lines_of(&session, 0), [2, 3], "the filter sent last stays");

    // Freeze on (3), off (4), arriving as off, on: the file is read on.
    session.set_frozen_at(false, Some(4)).unwrap();
    let late = session.set_frozen_at(true, Some(3)).unwrap_err();
    assert_eq!(late.code, ErrorCode::Superseded);
    assert!(!session.stats().frozen);

    session.set_keep_on_rotate_at(false, Some(6)).unwrap();
    assert_eq!(
        session
            .set_keep_on_rotate_at(true, Some(5))
            .unwrap_err()
            .code,
        ErrorCode::Superseded
    );

    // Another view has its own order; a closed view forgets its.
    let child = session
        .open_view(0, ViewFilter::default(), Box::new(|_| {}))
        .unwrap()
        .view_id;
    session
        .set_view_filter_at(child, text(&session, "x"), Some(1))
        .unwrap();
    settle(&session, child, "the child filters");
    assert_eq!(lines_of(&session, child), [2]);
}

#[test]
fn an_older_profile_change_arriving_late_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, LOG).unwrap();
    let session = open(&path);
    settle(&session, 0, "the file is read");
    let other = builtin_profiles()
        .into_iter()
        .find(|p| p.id != GENERIC_PROFILE)
        .unwrap();
    session.set_profile_at(&profile(), Some(9)).unwrap();
    let late = session.set_profile_at(&other, Some(8)).unwrap_err();
    assert_eq!(late.code, ErrorCode::Superseded);
    settle(&session, 0, "the levels are read again");
    assert_eq!(session.stats().profile_id, GENERIC_PROFILE);
}

#[test]
fn the_dashboard_stays_open_until_its_last_user_closes_in_any_order() {
    let dir = tempfile::tempdir().unwrap();
    let reports = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, LOG).unwrap();
    let session = LogSession::open(
        1,
        &path,
        OpenOptions {
            report_dir: Some(reports.path().to_path_buf()),
            ..OpenOptions::default()
        },
        &profile(),
        Box::new(|_| {}),
    )
    .unwrap();
    settle(&session, 0, "the file is read");

    // Two tabs of the file show a dashboard; switching from one to the other sends "close A" and
    // "open B". Arriving as "open B", "close A" the builder of B must go on.
    session
        .open_report_for("tab:1", Some(vec!["logger".into()]), false)
        .unwrap();
    session.open_report_for("tab:2", None, true).unwrap();
    session.close_report_for("tab:1");
    assert_eq!(
        session.report_active(),
        (true, true),
        "tab 2 still shows it"
    );
    // And the other way round: the close of a user that is not there (any more) stops nothing.
    session.close_report_for("tab:1");
    assert_eq!(session.report_active(), (true, true));

    // A call of the AI beside the dashboard of the user: it neither closes it nor changes its columns.
    let before = session.report_schema().unwrap();
    session.open_report_for("mcp:1", None, true).unwrap();
    let during = session.report_schema().unwrap();
    assert_eq!(
        format!("{:?}", during.columns),
        format!("{:?}", before.columns),
        "the AI leaves the chosen columns"
    );
    session.close_report_for("mcp:1");
    assert_eq!(session.report_active(), (true, true));

    // Opening again as the same user (other fields) is still one user.
    session.open_report_for("tab:2", None, false).unwrap();
    session.close_report_for("tab:2");
    assert_eq!(
        session.report_active(),
        (true, false),
        "the last one closed"
    );
}
