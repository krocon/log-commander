//! The timeline (prompt 014) through real files: times per chunk while indexing, gaps, unordered
//! files, files without times, the provisional line, truncation, merges and `position_at_time`.

use log_commander_lib::merge::MergeSource;
use log_commander_lib::model::{SessionUpdate, Status, Timeline};
use log_commander_lib::profile::{builtin_profiles, Profile, GENERIC_PROFILE};
use log_commander_lib::session::{LogSession, OpenOptions};
use std::fmt::Write as _;
use std::fs::{self, OpenOptions as FsOptions};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

/// Generous: debug builds on a busy machine.
const TIMEOUT: Duration = Duration::from_secs(20);
const S: i64 = 1_000_000;

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

fn wait(session: &LogSession, what: &str, condition: impl Fn(&SessionUpdate) -> bool) {
    let start = Instant::now();
    loop {
        let stats = session.stats();
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

fn live(session: &LogSession, lines: u64) {
    wait(session, "loaded", |s| {
        s.status == Status::Live && s.total_lines == lines
    });
}

fn append(path: &Path, text: &str) {
    let mut file = FsOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

/// `HH:MM:SS` of second `s` of 2024-01-15 (local time, like the log).
fn stamp(s: i64) -> String {
    format!(
        "2024-01-15 {:02}:{:02}:{:02}",
        s / 3600,
        s / 60 % 60,
        s % 60
    )
}

/// One entry per given second (from 00:00:00), every fifth an ERROR.
fn log_at(seconds: impl IntoIterator<Item = i64>) -> String {
    let mut out = String::new();
    for (i, s) in seconds.into_iter().enumerate() {
        let level = if i % 5 == 4 { "ERROR" } else { "INFO" };
        writeln!(out, "{} {level} request {i}", stamp(s)).unwrap();
    }
    out
}

fn whole(session: &LogSession, buckets: usize) -> Timeline {
    session.timeline(None, None, buckets).unwrap()
}

fn sum(timeline: &Timeline) -> f32 {
    timeline.buckets.iter().map(|b| b.all).sum()
}

#[test]
fn entries_over_time_with_a_gap_and_exact_jumps() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    // 10:00:00–10:04:59 one entry per second, nothing until 10:51, then until 10:55:59.
    let before: Vec<i64> = (36_000..36_300).collect();
    let after: Vec<i64> = (39_060..39_360).collect();
    fs::write(&path, log_at(before.iter().chain(&after).copied())).unwrap();
    let session = open(&path);
    live(&session, 600);

    let t = whole(&session, 200);
    assert!(t.has_times);
    assert_eq!(t.entries, 600);
    assert!((sum(&t) - 600.0).abs() < 1.0, "{}", sum(&t));
    let errors: f32 = t.buckets.iter().map(|b| b.error).sum();
    assert!((errors - 120.0).abs() < 1.0, "{errors}");
    let start = t.min.unwrap();
    assert_eq!(t.max.unwrap() - start, (39_359 - 36_000) * S);
    assert_eq!((t.from, t.to), (start, t.max.unwrap()));
    // The gap 10:04:59–10:51:00 lies inside a chunk: known to the sampled heads (every 32 lines)
    // less the time the lines between them would take at the rate of the rest.
    assert_eq!(t.gaps.len(), 1, "{:?}", t.gaps);
    let (gap_from, gap_to) = (t.gaps[0].from - start, t.gaps[0].to - start);
    assert!((290 * S..=320 * S).contains(&gap_from), "{gap_from}");
    assert!((3_040 * S..=3_070 * S).contains(&gap_to), "{gap_to}");
    let empty = t.buckets.iter().filter(|b| b.all == 0.0).count();
    assert!(empty > 150, "{empty}");
    assert_eq!(t.anchors.first().map(|a| (a.line, a.ts)), Some((0, start)));

    // Jumps: exact heads, the boundaries, a time inside the gap, past the end.
    let hit = |offset: i64| {
        session
            .position_at_time(0, start + offset * S)
            .unwrap()
            .unwrap()
    };
    assert_eq!(hit(0).line, 0);
    assert!(hit(0).exact);
    assert_eq!(hit(-100).line, 0);
    assert_eq!(hit(255).line, 255);
    assert_eq!(hit(256).line, 256);
    assert_eq!(hit(299).line, 299);
    assert_eq!(hit(1_000).line, 300);
    assert_eq!(hit(3_060).line, 300);
    assert_eq!(hit(3_359).line, 599);
    let past = hit(10_000);
    assert_eq!((past.line, past.exact), (599, false));

    // A zoom into the first five minutes: the rest is counted after it.
    let zoom = session
        .timeline(Some(start), Some(start + 300 * S), 30)
        .unwrap();
    assert!((sum(&zoom) - 300.0).abs() < 2.0, "{}", sum(&zoom));
    assert!((zoom.after as i64 - 300).abs() <= 2, "{}", zoom.after);
}

#[test]
fn the_timeline_grows_with_the_tail_and_starts_over_after_truncation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, log_at(0..100)).unwrap();
    let session = open(&path);
    live(&session, 100);
    let first = whole(&session, 50);
    append(&path, &log_at(100..1000));
    live(&session, 1000);
    let grown = whole(&session, 50);
    assert_eq!(grown.entries, 1000);
    assert!(grown.max.unwrap() > first.max.unwrap());
    assert_eq!(grown.epoch, first.epoch);

    fs::write(&path, log_at(0..10)).unwrap();
    wait(&session, "truncated", |s| s.total_lines == 10);
    let fresh = whole(&session, 50);
    assert_eq!(fresh.entries, 10);
    assert!(fresh.epoch > first.epoch);
    assert_eq!(fresh.max.unwrap() - fresh.min.unwrap(), 9 * S);
}

#[test]
fn a_file_without_times_has_no_timeline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plain.log");
    let mut text = String::new();
    for i in 0..700 {
        writeln!(text, "INFO just words {i}").unwrap();
    }
    fs::write(&path, text).unwrap();
    let session = open(&path);
    live(&session, 700);
    let t = whole(&session, 100);
    assert!(!t.has_times);
    assert!(t.buckets.is_empty());
    assert_eq!((t.entries, t.untimed), (700, 700));
    assert_eq!(session.position_at_time(0, 0).unwrap(), None);
}

#[test]
fn an_unordered_file_keeps_every_entry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixed.log");
    // Blocks of 300 entries alternating between morning and evening.
    let seconds: Vec<i64> = (0..1200)
        .map(|i| {
            if (i / 300) % 2 == 0 {
                30_000 + i
            } else {
                70_000 + i
            }
        })
        .collect();
    fs::write(&path, log_at(seconds)).unwrap();
    let session = open(&path);
    live(&session, 1200);
    let t = whole(&session, 100);
    assert_eq!(t.entries, 1200);
    assert!((sum(&t) + (t.before + t.after) as f32 - 1200.0).abs() < 2.0);
    assert!(t.max.unwrap() - t.min.unwrap() >= 40_000 * S);
}

#[test]
fn a_chunk_ending_in_a_stack_trace_takes_the_time_of_its_last_head() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("trace.log");
    let mut text = log_at(0..250);
    // Line 250: a head at 00:16:40 with a stack trace beyond the end of the first chunk (256 lines).
    writeln!(text, "{} ERROR boom", stamp(1_000)).unwrap();
    for i in 0..100 {
        writeln!(text, "    at com.acme.Frame{i}.run(Frame.java:{i})").unwrap();
    }
    writeln!(text, "{} INFO later", stamp(2_000)).unwrap();
    fs::write(&path, text).unwrap();
    let session = open(&path);
    live(&session, 352);
    let t = whole(&session, 100);
    assert_eq!(t.entries, 252);
    let start = t.min.unwrap();
    // Without reading back the head of line 250 the first chunk would end at 00:04:09. Two
    // pauses: 00:04:09–00:16:40 inside the first chunk (sampled), 00:16:40–00:33:20 between chunks.
    assert_eq!(t.gaps.len(), 2, "{:?}", t.gaps);
    assert!(
        (220 * S..=270 * S).contains(&(t.gaps[0].from - start)),
        "{:?}",
        t.gaps
    );
    assert!(
        (970 * S..=1_000 * S).contains(&(t.gaps[0].to - start)),
        "{:?}",
        t.gaps
    );
    assert_eq!(t.gaps[1].from - start, 1_000 * S);
    assert_eq!(t.gaps[1].to - start, 2_000 * S);
    // The jump lands on the head, not in its trace.
    let hit = session
        .position_at_time(0, start + 500 * S)
        .unwrap()
        .unwrap();
    assert_eq!(hit.line, 250);
}

#[test]
fn a_provisional_last_line_is_replaced_with_its_time() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("partial.log");
    let mut text = log_at(0..9);
    // The tenth line has no end yet.
    write!(text, "{} INFO no end", stamp(100)).unwrap();
    fs::write(&path, &text).unwrap();
    let session = open(&path);
    live(&session, 10);
    let t = whole(&session, 10);
    assert_eq!(t.entries, 10);
    assert_eq!(t.max.unwrap() - t.min.unwrap(), 100 * S);
    append(&path, &format!(" yet\n{} ERROR next\n", stamp(200)));
    wait(&session, "completed", |s| {
        s.total_lines == 11 && s.counts.error >= 2
    });
    let t = whole(&session, 10);
    assert_eq!(t.entries, 11);
    assert_eq!(t.max.unwrap() - t.min.unwrap(), 200 * S);
    assert_eq!(
        session
            .position_at_time(0, t.min.unwrap() + 150 * S)
            .unwrap()
            .unwrap()
            .line,
        10
    );
}

#[test]
fn a_filtered_view_jumps_to_its_next_visible_line() {
    use log_commander_lib::filter::{SearchMode, SearchQuery};
    use log_commander_lib::level::Level;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, log_at(0..50)).unwrap();
    let session = open(&path);
    live(&session, 50);
    let info = session
        .set_filter(&[Level::Error], &SearchQuery::default(), SearchMode::Filter)
        .unwrap();
    wait(&session, "filter", |s| {
        s.view_generation == info.view_generation
    });
    let start = whole(&session, 10).min.unwrap();
    // 00:00:10 is an INFO line; the next ERROR is line 14 (position 2 of the view).
    let hit = session
        .position_at_time(0, start + 10 * S)
        .unwrap()
        .unwrap();
    assert_eq!((hit.line, hit.position), (14, 2));
    // The timeline still shows every entry.
    assert_eq!(whole(&session, 10).entries, 50);
}

#[test]
fn a_merge_has_a_timeline_in_merge_order() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.log");
    let b = dir.path().join("b.log");
    fs::write(&a, log_at((0..300).map(|i| i * 2))).unwrap();
    fs::write(&b, log_at((0..300).map(|i| i * 2 + 1))).unwrap();
    let session = LogSession::open_merged(
        1,
        vec![
            MergeSource {
                path: a,
                profile: None,
            },
            MergeSource {
                path: b,
                profile: None,
            },
        ],
        OpenOptions::default(),
        Box::new(|_| {}),
    )
    .unwrap();
    live(&session, 600);
    let t = whole(&session, 60);
    assert_eq!(t.entries, 600);
    assert_eq!(t.max.unwrap() - t.min.unwrap(), 599 * S);
    assert!((sum(&t) - 600.0).abs() < 1.0);
    assert!(t.gaps.is_empty());
    assert_eq!(
        session
            .position_at_time(0, t.min.unwrap() + 301 * S)
            .unwrap()
            .unwrap()
            .line,
        301
    );
}

#[test]
fn too_many_buckets_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    fs::write(&path, log_at(0..3)).unwrap();
    let session = open(&path);
    live(&session, 3);
    assert!(session.timeline(None, None, 100_000).is_err());
}

#[test]
fn utf16_with_crlf_umlauts_and_emoji_has_times() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("utf16.log");
    let mut text = String::new();
    for i in 0..300 {
        // A stack trace now and then, ANSI colour on the level.
        write!(
            text,
            "{} \u{1b}[31mERROR\u{1b}[0m größe 🚀 {i}\r\n",
            stamp(i * 10)
        )
        .unwrap();
        if i % 7 == 0 {
            text.push_str("\tat com.acme.Ä.run\r\n");
        }
    }
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    fs::write(&path, bytes).unwrap();
    let session = open(&path);
    live(&session, 343);
    let t = whole(&session, 30);
    assert_eq!(t.entries, 300);
    assert_eq!(t.max.unwrap() - t.min.unwrap(), 2_990 * S);
    assert!(t.gaps.is_empty(), "{:?}", t.gaps);
    let errors: f32 = t.buckets.iter().map(|b| b.error).sum();
    assert!((errors - 300.0).abs() < 1.0, "{errors}");
    let hit = session
        .position_at_time(0, t.min.unwrap() + 1_000 * S)
        .unwrap()
        .unwrap();
    // Entry 100 starts after 15 continuation lines (entries 0, 7, …, 98).
    assert_eq!(hit.line, 115);
}

#[test]
fn a_profile_change_counts_the_new_levels() {
    use log_commander_lib::level::Level;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    let mut text = String::new();
    for i in 0..400 {
        writeln!(text, "{} OOPS {i}", stamp(i)).unwrap();
    }
    fs::write(&path, text).unwrap();
    let session = open(&path);
    live(&session, 400);
    assert_eq!(
        whole(&session, 10)
            .buckets
            .iter()
            .map(|b| b.fatal)
            .sum::<f32>(),
        0.0
    );
    let profile = Profile {
        id: "mine".into(),
        name: "Mine".into(),
        builtin: false,
        patterns: vec![" (?P<level>OOPS) ".into()],
        mapping: [("oops".to_string(), Level::Fatal)].into(),
        json: false,
        syslog_pri: false,
        head: None,
        ..Profile::default()
    };
    let info = session.set_profile(&profile).unwrap();
    wait(&session, "relevel", |s| {
        s.view_generation == info.view_generation && !s.filter_pending
    });
    let t = whole(&session, 10);
    let fatal: f32 = t.buckets.iter().map(|b| b.fatal).sum();
    assert!((fatal - 400.0).abs() < 1.0, "{fatal}");
    assert_eq!(t.max.unwrap() - t.min.unwrap(), 399 * S);
}
