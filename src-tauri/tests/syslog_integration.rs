//! Prompt 016: a syslog source writes a spool, the session follows it. Real sockets on ephemeral
//! ports of 127.0.0.1, real files, no Tauri.

use log_commander_lib::error::ErrorCode;
use log_commander_lib::level::Level;
use log_commander_lib::model::{SessionInfo, SessionUpdate, SourceState};
use log_commander_lib::session::{OpenOptions, SessionManager};
use log_commander_lib::sources::syslog::{Protocol, SyslogConfig, SyslogSource, TRUNCATED_MARK};
use log_commander_lib::sources::SourceConfig;
use log_commander_lib::spool::{SpoolConfig, SpoolRoot};
use std::io::Write;
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "../src/test_support.rs"]
mod test_support;
use test_support::{wait_until, wait_until_or};

struct Fixture {
    _cache: tempfile::TempDir,
    manager: SessionManager,
}

fn fixture() -> Fixture {
    let cache = tempfile::tempdir().unwrap();
    let manager = SessionManager::default();
    manager.set_spool_root(Arc::new(SpoolRoot::prepare(cache.path()).unwrap()));
    Fixture {
        _cache: cache,
        manager,
    }
}

fn udp_config(protocol: Protocol) -> SyslogConfig {
    SyslogConfig {
        protocol,
        port: 0,
        ..SyslogConfig::default()
    }
}

fn port_of(info: &SessionInfo) -> u16 {
    info.source.as_ref().unwrap().config["port"]
        .as_u64()
        .unwrap() as u16
}

fn spool_dir(info: &SessionInfo) -> PathBuf {
    Path::new(&info.source.as_ref().unwrap().spool_path)
        .parent()
        .unwrap()
        .to_path_buf()
}

impl Fixture {
    fn open(&self, config: SyslogConfig, keep: bool) -> SessionInfo {
        self.manager
            .open_source(
                SourceConfig::Syslog(config),
                keep,
                Default::default(),
                OpenOptions::default(),
                Box::new(|_| {}),
            )
            .unwrap()
    }

    /// With small spool files, to see rotation and the total limit.
    fn open_small(&self, rotate: u64, files: usize) -> SessionInfo {
        let root = self.manager.spool_root().unwrap();
        let source = SyslogSource::bind(udp_config(Protocol::Udp)).unwrap();
        self.manager
            .open_prepared_source(
                Box::new(source),
                SpoolConfig::sized(root.new_dir(), rotate, files),
                false,
                OpenOptions::default(),
                Box::new(|_| {}),
            )
            .unwrap()
    }

    fn stats(&self, info: &SessionInfo) -> SessionUpdate {
        self.manager.session(info.session_id).unwrap().stats()
    }

    #[track_caller]
    fn wait(&self, info: &SessionInfo, what: &str, done: impl Fn(&SessionUpdate) -> bool) {
        wait_until_or(
            what,
            || {
                let stats = self.stats(info);
                format!(
                    "{:?} lines, epoch {}, {:?}",
                    stats.total_lines, stats.epoch, stats.source_status
                )
            },
            || done(&self.stats(info)),
        );
    }

    /// Datagrams the source has taken from its socket so far, accepted or not.
    fn taken(&self, info: &SessionInfo) -> u64 {
        let status = self.stats(info).source_status.unwrap();
        status.received + status.rejected
    }

    /// Sends datagrams and waits after every `burst` of them until the source has taken them
    /// from its socket: the kernel drops datagrams when its receive buffer is full, and how fast
    /// the receiving thread runs is not what the tests are about.
    #[track_caller]
    fn send_udp(
        &self,
        info: &SessionInfo,
        messages: impl Iterator<Item = Vec<u8>>,
        burst: usize,
    ) -> u64 {
        let socket = sender();
        let port = port_of(info);
        let before = self.taken(info);
        let mut sent = 0u64;
        let taken = |sent: u64| {
            wait_until_or(
                "the source to take what was sent",
                || format!("sent {sent}, {:?}", self.stats(info).source_status),
                || self.taken(info) - before >= sent,
            );
        };
        for message in messages {
            socket.send_to(&message, ("127.0.0.1", port)).unwrap();
            sent += 1;
            if sent.is_multiple_of(burst as u64) {
                taken(sent);
            }
        }
        taken(sent);
        sent
    }

    /// The text of the last line shown, empty without lines.
    fn last_text(&self, info: &SessionInfo) -> String {
        let session = self.manager.session(info.session_id).unwrap();
        let total = session.stats().total_lines as usize;
        // The session may start over between the two calls: then there is no such line.
        session
            .get_lines(false, total.saturating_sub(1), 1)
            .ok()
            .and_then(|mut lines| lines.pop())
            .map_or_else(String::new, |line| line.text)
    }

    /// Waits until the session shows a line ending in `end` as its last one: it has read
    /// everything written so far, and has seen the rotation of the spool if there was one.
    #[track_caller]
    fn wait_last(&self, info: &SessionInfo, end: &str) {
        wait_until_or(
            &format!("the last line to end in {end:?}"),
            || {
                let stats = self.stats(info);
                format!(
                    "last {:?}, {} lines, epoch {}, {:?}",
                    self.last_text(info),
                    stats.total_lines,
                    stats.epoch,
                    stats.source_status
                )
            },
            || self.last_text(info).ends_with(end),
        );
    }

    fn texts(&self, info: &SessionInfo, start: usize, count: usize) -> Vec<(String, Level)> {
        self.manager
            .session(info.session_id)
            .unwrap()
            .get_lines(false, start, count)
            .unwrap()
            .into_iter()
            .map(|l| (l.text, l.level))
            .collect()
    }
}

fn sender() -> UdpSocket {
    UdpSocket::bind("127.0.0.1:0").unwrap()
}

#[test]
fn ten_thousand_udp_messages_arrive_with_levels_and_fields() {
    let fx = fixture();
    let info = fx.open(udp_config(Protocol::Udp), false);
    assert_eq!(info.file_name, format!("Syslog :{}", port_of(&info)));
    assert_eq!(info.suggested_profile_id, "syslog-received");
    assert!(info.path.ends_with("spool.log"));
    assert!(matches!(
        info.update.source_status.as_ref().unwrap().state,
        SourceState::Listening
    ));
    let messages = (0..10_000).map(|i| {
        // Severities cycle: 3 = ERROR, 4 = WARN, 6 = INFO (facility 1: +8).
        let pri = 8 + [3, 4, 6][i % 3];
        format!("<{pri}>Oct 11 22:14:15 host app[{i}]: message {i}\n").into_bytes()
    });
    fx.send_udp(&info, messages, 200);
    fx.wait(&info, "10 000 lines", |s| s.total_lines >= 10_000);
    let stats = fx.stats(&info);
    assert_eq!(stats.total_lines, 10_000);
    let status = stats.source_status.unwrap();
    assert_eq!(
        (status.received, status.dropped, status.spooled),
        (10_000, 0, 10_000)
    );
    assert_eq!(stats.counts.error, 3334);
    assert_eq!(stats.counts.warn, 3333);
    assert_eq!(stats.counts.info, 3333);
    let lines = fx.texts(&info, 0, 3);
    assert!(
        lines[0]
            .0
            .ends_with(" 127.0.0.1 <11>Oct 11 22:14:15 host app[0]: message 0"),
        "{}",
        lines[0].0
    );
    assert_eq!(
        lines.iter().map(|l| l.1).collect::<Vec<_>>(),
        [Level::Error, Level::Warn, Level::Info]
    );
    // Columns of the received format.
    let session = fx.manager.session(info.session_id).unwrap();
    let columns: Vec<String> = session
        .columns()
        .columns
        .iter()
        .map(|c| c.id.clone())
        .collect();
    for id in [
        "timestamp",
        "sender",
        "pri",
        "sent",
        "host",
        "logger",
        "pid",
        "message",
    ] {
        assert!(columns.contains(&id.to_string()), "{id} in {columns:?}");
    }
    // The timeline has times (time of receipt).
    let timeline = session.timeline(None, None, 10).unwrap();
    assert!(timeline.has_times, "{timeline:?}");
}

#[test]
fn multi_line_broken_and_huge_messages_stay_one_line_each() {
    let fx = fixture();
    let info = fx.open(udp_config(Protocol::Udp), false);
    let port = port_of(&info);
    let socket = sender();
    socket
        .send_to(b"<11>first\nsecond\r\nthird", ("127.0.0.1", port))
        .unwrap();
    socket
        .send_to(b"<14>bad \xff bytes \x1b[31m", ("127.0.0.1", port))
        .unwrap();
    socket
        .send_to("<14>Grüße 😀".as_bytes(), ("127.0.0.1", port))
        .unwrap();
    fx.wait(&info, "3 lines", |s| s.total_lines >= 3);
    let lines = fx.texts(&info, 0, 10);
    assert_eq!(lines.len(), 3);
    assert!(lines[0].0.ends_with("<11>first\\nsecond\\r\\nthird"));
    assert_eq!(lines[0].1, Level::Error);
    assert!(lines[1].0.ends_with("<14>bad \\xFF bytes \\x1B[31m"));
    assert!(lines[2].0.ends_with("<14>Grüße 😀"));

    // TCP: a frame over 64 KB is cut and marked, the next one arrives whole.
    let info = fx.open(udp_config(Protocol::Tcp), false);
    let port = port_of(&info);
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let big = vec![b'x'; 70_000];
    write!(stream, "{} ", big.len() + 4).unwrap();
    stream.write_all(b"<14>").unwrap();
    stream.write_all(&big).unwrap();
    stream.write_all(b"9 <11>after").unwrap();
    stream.write_all(b"<12>by newline\n").unwrap();
    stream.flush().unwrap();
    fx.wait(&info, "3 TCP lines", |s| s.total_lines >= 3);
    let lines = fx.texts(&info, 0, 10);
    assert!(lines[0].0.ends_with(TRUNCATED_MARK), "cut and marked");
    assert!(lines[1].0.ends_with(" 127.0.0.1 <11>after"));
    assert_eq!(lines[1].1, Level::Error);
    assert!(lines[2].0.ends_with("<12>by newline"));
    assert_eq!(lines[2].1, Level::Warn);
    let status = fx.stats(&info).source_status.unwrap();
    assert_eq!((status.truncated, status.connections), (1, 1));
    drop(stream);
    fx.wait(&info, "connection closed", |s| {
        s.source_status.as_ref().unwrap().connections == 0
    });
}

#[test]
fn closing_stops_the_listener_and_deletes_the_spool() {
    let fx = fixture();
    let info = fx.open(udp_config(Protocol::Both), false);
    let port = port_of(&info);
    let dir = spool_dir(&info);
    fx.send_udp(&info, std::iter::once(b"<14>x".to_vec()), 1);
    fx.wait(&info, "1 line", |s| s.total_lines >= 1);
    assert!(dir.join("spool.log").exists());
    fx.manager.close(info.session_id).unwrap();
    assert!(!dir.exists(), "spool deleted");
    // The ports are free again (the system may need a moment to hand them out anew).
    wait_until("the UDP port to be free", || {
        UdpSocket::bind(("127.0.0.1", port)).is_ok()
    });
    wait_until("the TCP port to be free", || {
        TcpListener::bind(("127.0.0.1", port)).is_ok()
    });
}

#[test]
fn a_kept_spool_survives_closing() {
    let fx = fixture();
    let info = fx.open(udp_config(Protocol::Udp), false);
    fx.send_udp(&info, std::iter::once(b"<14>keep me".to_vec()), 1);
    fx.wait(&info, "1 line", |s| s.total_lines >= 1);
    let session = fx.manager.session(info.session_id).unwrap();
    session.set_spool_keep(true).unwrap();
    drop(session);
    fx.manager.close(info.session_id).unwrap();
    let kept = fx.manager.spool_root().unwrap().kept.clone();
    let moved: Vec<_> = std::fs::read_dir(&kept).unwrap().flatten().collect();
    assert_eq!(moved.len(), 1);
    let text = std::fs::read_to_string(moved[0].path().join("spool.log")).unwrap();
    assert!(text.trim_end().ends_with("<14>keep me"), "{text}");
}

#[test]
fn a_port_in_use_is_reported_and_leaves_nothing_behind() {
    let fx = fixture();
    let taken = UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let err = fx
        .manager
        .open_source(
            SourceConfig::Syslog(SyslogConfig {
                port,
                ..SyslogConfig::default()
            }),
            false,
            Default::default(),
            OpenOptions::default(),
            Box::new(|_| {}),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::PortInUse);
    assert!(err.message.contains(&port.to_string()));
    let root = fx.manager.spool_root().unwrap();
    let left: Vec<_> = std::fs::read_dir(&root.path)
        .unwrap()
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    assert!(left.is_empty(), "no spool folder: {left:?}");
}

#[test]
fn remote_listening_needs_the_explicit_choice() {
    let fx = fixture();
    let err = fx
        .manager
        .open_source(
            SourceConfig::Syslog(SyslogConfig {
                address: "0.0.0.0".into(),
                port: 0,
                ..SyslogConfig::default()
            }),
            false,
            Default::default(),
            OpenOptions::default(),
            Box::new(|_| {}),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidSource);
}

#[test]
fn the_sender_filter_rejects_and_counts() {
    let fx = fixture();
    let info = fx.open(
        SyslogConfig {
            allow: vec!["10.0.0.0/8".into()],
            ..udp_config(Protocol::Udp)
        },
        false,
    );
    fx.send_udp(&info, (0..5).map(|_| b"<14>x".to_vec()), 5);
    fx.wait(&info, "rejected", |s| {
        s.source_status.as_ref().unwrap().rejected == 5
    });
    let stats = fx.stats(&info);
    assert_eq!(stats.total_lines, 0);
    assert_eq!(stats.source_status.unwrap().received, 0);
}

#[test]
fn the_spool_rotates_and_stays_within_its_limit() {
    let fx = fixture();
    // 4 KB files, at most 3: the session starts over when a fourth would be needed.
    let info = fx.open_small(4096, 3);
    let dir = spool_dir(&info);
    let port = port_of(&info);
    let socket = sender();
    let mut max_files = 0;
    let mut max_bytes = 0u64;
    let mut sent = 0u64;
    for i in 0..600 {
        let message = format!("<14>rotation message {i:05}");
        socket
            .send_to(message.as_bytes(), ("127.0.0.1", port))
            .unwrap();
        sent += 1;
        if i % 20 == 19 {
            // The tail notices a rotation by polling and sees only the newest file: it has to
            // follow each rotation to count the files it holds. 20 lines fit a file three times,
            // so at most one rotation lies between two waits.
            fx.wait_last(&info, &message);
            let (files, bytes) = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("spool"))
                .fold((0, 0u64), |(n, b), e| {
                    (n + 1, b + e.metadata().map_or(0, |m| m.len()))
                });
            max_files = max_files.max(files);
            max_bytes = max_bytes.max(bytes);
        }
    }
    fx.wait(&info, "all received", |s| {
        s.source_status.as_ref().unwrap().spooled == sent
    });
    assert!(max_files <= 3, "{max_files} files");
    assert!(max_bytes <= 3 * 4096, "{max_bytes} bytes");
    // ~60 bytes per line, ~68 lines per file, 600 lines: rotated eight times. The session holds
    // at most 3 files, so it started over at least once, and the newest line is shown.
    fx.wait_last(&info, "rotation message 00599");
    let stats = fx.stats(&info);
    assert!(stats.epoch > 0, "epoch {}", stats.epoch);
    assert!(stats.total_lines < 600, "{} lines", stats.total_lines);
}

#[test]
fn freeze_holds_the_view_while_the_spool_keeps_receiving() {
    let fx = fixture();
    let info = fx.open(udp_config(Protocol::Udp), false);
    fx.send_udp(
        &info,
        (0..10).map(|i| format!("<14>before {i}").into_bytes()),
        10,
    );
    fx.wait(&info, "10 lines", |s| s.total_lines == 10);
    let session = fx.manager.session(info.session_id).unwrap();
    session.set_frozen(true);
    fx.send_udp(
        &info,
        (0..20).map(|i| format!("<14>during {i}").into_bytes()),
        20,
    );
    // Written to the file and seen by the frozen worker: it tells what waits and reads nothing.
    fx.wait(&info, "spooled while frozen", |s| {
        s.source_status.as_ref().unwrap().spooled == 30 && s.pending_bytes > 0
    });
    assert!(test_support::stays_false(
        Duration::from_millis(400),
        || { fx.stats(&info).total_lines != 10 }
    ));
    session.set_frozen(false);
    fx.wait(&info, "caught up", |s| s.total_lines == 30);
}

/// `cargo test --release --test syslog_integration -- --ignored --nocapture measure_`
#[test]
#[ignore]
fn measure_syslog_ingest() {
    let fx = fixture();
    let info = fx.open(udp_config(Protocol::Udp), false);
    let port = port_of(&info);
    let message = |i: u64| {
        format!("<14>Nov  7 10:15:30 host app[4711]: request {i} handled in 12 ms for user 42 path /api/items").into_bytes()
    };
    // Paced: `rate` messages per second for `seconds`.
    for (rate, seconds) in [(50_000u64, 4u64), (100_000, 3)] {
        let before = fx.stats(&info).total_lines;
        let total = rate * seconds;
        let socket = sender();
        let start = Instant::now();
        let step = rate / 1000; // per millisecond
        let mut sent = 0u64;
        while sent < total {
            let due = (start.elapsed().as_micros() as u64 * rate / 1_000_000).min(total);
            while sent < due {
                socket.send_to(&message(sent), ("127.0.0.1", port)).unwrap();
                sent += 1;
            }
            if sent < due + step {
                std::thread::sleep(Duration::from_micros(200));
            }
        }
        let send_time = start.elapsed();
        let deadline = Instant::now();
        loop {
            let stats = fx.stats(&info);
            if stats.total_lines - before >= total || deadline.elapsed() > Duration::from_secs(5) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let stats = fx.stats(&info);
        let status = stats.source_status.unwrap();
        let shown = stats.total_lines - before;
        println!(
            "MEASURE syslog udp {rate}/s for {seconds} s: sent {total} in {:.2} s, shown {shown} ({:.3} % lost), dropped by the queue {}, all shown {:.2} s after the start",
            send_time.as_secs_f64(),
            (total - shown.min(total)) as f64 * 100.0 / total as f64,
            status.dropped,
            start.elapsed().as_secs_f64(),
        );
    }
    // Unpaced burst: what one sender thread pushes through.
    {
        let before = fx.stats(&info).total_lines;
        let total = 200_000u64;
        let socket = sender();
        let start = Instant::now();
        for i in 0..total {
            socket.send_to(&message(i), ("127.0.0.1", port)).unwrap();
        }
        let send_time = start.elapsed();
        std::thread::sleep(Duration::from_secs(2));
        let stats = fx.stats(&info);
        let shown = stats.total_lines - before;
        println!(
            "MEASURE syslog udp burst: {total} in {:.2} s ({:.0}/s offered), shown {shown}, dropped by the queue {}",
            send_time.as_secs_f64(),
            total as f64 / send_time.as_secs_f64(),
            stats.source_status.unwrap().dropped,
        );
    }
    // Delay until a message is in the session (index), single messages at a time.
    let socket = sender();
    let mut delays = Vec::new();
    for i in 0..20 {
        let before = fx.stats(&info).total_lines;
        let start = Instant::now();
        socket
            .send_to(format!("<14>latency {i}").as_bytes(), ("127.0.0.1", port))
            .unwrap();
        while fx.stats(&info).total_lines == before {
            std::thread::sleep(Duration::from_millis(1));
        }
        delays.push(start.elapsed().as_millis());
        std::thread::sleep(Duration::from_millis(137));
    }
    delays.sort_unstable();
    println!(
        "MEASURE syslog delay until indexed: median {} ms, max {} ms",
        delays[delays.len() / 2],
        delays[delays.len() - 1]
    );
}

#[test]
fn a_spool_merges_with_a_file_by_time_of_receipt() {
    use log_commander_lib::merge::{inspect, MergeSource};
    let fx = fixture();
    let info = fx.open(udp_config(Protocol::Udp), false);
    fx.send_udp(
        &info,
        (0..5).map(|i| format!("<11>Nov  7 10:15:30 host app: received {i}").into_bytes()),
        5,
    );
    fx.wait(&info, "5 lines", |s| s.total_lines == 5);
    let spool = PathBuf::from(&info.path);
    let candidate = inspect(&spool).unwrap();
    assert_eq!(candidate.suggested_profile_id, "syslog-received");
    assert!(candidate.first_time.is_some());
    // A file written now, in local time like the time of receipt.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("app.log");
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S,000");
    std::fs::write(&file, format!("{now} - app - INFO - from the file\n")).unwrap();
    let merged = fx
        .manager
        .open_merged(
            vec![
                MergeSource {
                    path: spool,
                    profile: None,
                },
                MergeSource {
                    path: file,
                    profile: None,
                },
            ],
            OpenOptions::default(),
            Box::new(|_| {}),
        )
        .unwrap();
    fx.wait(&merged, "6 merged lines", |s| s.total_lines == 6);
    assert_eq!(merged.sources[0].profile_id, "syslog-received");
}

#[test]
fn a_merge_holds_no_more_spool_files_than_the_spool_keeps() {
    use log_commander_lib::merge::MergeSource;
    let fx = fixture();
    let info = fx.open_small(4096, 3);
    let port = port_of(&info);
    let socket = sender();
    socket
        .send_to(b"<14>Nov  7 10:15:30 host app: first", ("127.0.0.1", port))
        .unwrap();
    fx.wait(&info, "first line", |s| s.total_lines == 1);
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("app.log");
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S,000");
    std::fs::write(&file, format!("{now} - app - INFO - from the file\n")).unwrap();
    let merged = fx
        .manager
        .open_merged(
            vec![
                MergeSource {
                    path: PathBuf::from(&info.path),
                    profile: None,
                },
                MergeSource {
                    path: file,
                    profile: None,
                },
            ],
            OpenOptions::default(),
            Box::new(|_| {}),
        )
        .unwrap();
    fx.wait(&merged, "2 merged lines", |s| s.total_lines == 2);
    // ~68 lines per 4 KB file: 400 lines rotate the spool five times, past its 3 files.
    for i in 0..400 {
        let message = format!("<14>merge message {i:05}");
        socket
            .send_to(message.as_bytes(), ("127.0.0.1", port))
            .unwrap();
        if i % 20 == 19 {
            // The merge notices a rotation by polling, like the tail: it follows each one (at
            // most one lies between two waits, 20 lines fit a file three times).
            fx.wait_last(&merged, &message);
        }
    }
    // The merge started over (new epoch) instead of holding deleted spool files.
    fx.wait_last(&merged, "merge message 00399");
    let epoch = fx.stats(&merged).epoch;
    assert!(epoch > 0, "epoch {epoch}");
}

/// A TCP source with short limits (prompt 016, security review: slowloris).
fn open_tcp(fx: &Fixture, limits: log_commander_lib::sources::syslog::TcpLimits) -> SessionInfo {
    let root = fx.manager.spool_root().unwrap();
    let source = SyslogSource::bind(udp_config(Protocol::Tcp))
        .unwrap()
        .with_tcp_limits(limits);
    fx.manager
        .open_prepared_source(
            Box::new(source),
            SpoolConfig::sized(root.new_dir(), 1024 * 1024, 4),
            false,
            OpenOptions::default(),
            Box::new(|_| {}),
        )
        .unwrap()
}

/// The peer closed the connection (read returns 0 or fails). The limit only ends a hang.
fn closed_by_peer(stream: &mut TcpStream) -> bool {
    use std::io::Read;
    // Fails (EINVAL on macOS) when the peer reset the socket already: closed, too.
    if stream
        .set_read_timeout(Some(test_support::timeout()))
        .is_err()
    {
        return true;
    }
    let mut buf = [0u8; 16];
    match stream.read(&mut buf) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => !matches!(
            e.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ),
    }
}

fn limits() -> log_commander_lib::sources::syslog::TcpLimits {
    log_commander_lib::sources::syslog::TcpLimits {
        max_connections: 64,
        max_per_sender: 8,
        idle: Duration::from_secs(60),
        frame: Duration::from_secs(60),
        evict_after: Duration::from_secs(60),
    }
}

#[test]
fn idle_tcp_connections_and_unfinished_frames_are_closed() {
    let fx = fixture();
    let info = open_tcp(
        &fx,
        log_commander_lib::sources::syslog::TcpLimits {
            idle: Duration::from_millis(400),
            frame: Duration::from_millis(400),
            ..limits()
        },
    );
    let port = port_of(&info);
    // Idle: nothing sent at all.
    // That the source closes it is the proof: it does so only after it took the connection, and
    // by then the count of open connections may be back at 0 already.
    let mut idle = TcpStream::connect(("127.0.0.1", port)).unwrap();
    assert!(closed_by_peer(&mut idle));
    fx.wait(&info, "slot free again", |s| {
        s.source_status.as_ref().unwrap().connections == 0
    });
    // A counted frame that never ends, trickled so the connection is never idle: closed after the
    // frame limit, what came is written as cut.
    let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
    slow.write_all(b"1000 <11>slow").unwrap();
    // Trickles on until the source has closed the connection (far fewer than the 1000 bytes of
    // the frame): writing fails then, or the message is there.
    wait_until("the source to close the slow connection", || {
        std::thread::sleep(Duration::from_millis(100));
        slow.write_all(b"x").is_err() || fx.stats(&info).total_lines == 1
    });
    assert!(closed_by_peer(&mut slow));
    fx.wait(&info, "the unfinished frame as a cut message", |s| {
        let st = s.source_status.as_ref().unwrap();
        s.total_lines == 1 && st.truncated == 1 && st.connections == 0
    });
    let lines = fx.texts(&info, 0, 1);
    assert!(lines[0].0.contains("<11>slow"), "{}", lines[0].0);
}

#[test]
fn tcp_connections_are_capped_per_sender() {
    let fx = fixture();
    let info = open_tcp(
        &fx,
        log_commander_lib::sources::syslog::TcpLimits {
            max_per_sender: 2,
            ..limits()
        },
    );
    let port = port_of(&info);
    let _a = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let _b = TcpStream::connect(("127.0.0.1", port)).unwrap();
    fx.wait(&info, "two connections", |s| {
        s.source_status.as_ref().unwrap().connections == 2
    });
    let mut third = TcpStream::connect(("127.0.0.1", port)).unwrap();
    assert!(closed_by_peer(&mut third));
    fx.wait(&info, "the third refused", |s| {
        let st = s.source_status.as_ref().unwrap();
        st.rejected == 1 && st.connections == 2
    });
}

#[test]
fn at_the_limit_the_longest_idle_connection_makes_room() {
    let fx = fixture();
    let two = |evict_after: Duration| {
        open_tcp(
            &fx,
            log_commander_lib::sources::syslog::TcpLimits {
                max_connections: 2,
                evict_after,
                ..limits()
            },
        )
    };
    // Nobody has been idle long enough (a minute, far longer than this test runs): the new
    // connection is refused.
    let info = two(Duration::from_secs(60));
    let port = port_of(&info);
    let _first = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let _second = TcpStream::connect(("127.0.0.1", port)).unwrap();
    fx.wait(&info, "two connections", |s| {
        s.source_status.as_ref().unwrap().connections == 2
    });
    let mut early = TcpStream::connect(("127.0.0.1", port)).unwrap();
    assert!(closed_by_peer(&mut early));
    fx.wait(&info, "the third refused", |s| {
        let st = s.source_status.as_ref().unwrap();
        st.rejected == 1 && st.connections == 2
    });

    // Any idle time is enough: the longest idle connection goes. That is the oldest one, which
    // never sent anything, not the one that sent after both were open.
    let info = two(Duration::ZERO);
    let port = port_of(&info);
    let mut oldest = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut busy = TcpStream::connect(("127.0.0.1", port)).unwrap();
    fx.wait(&info, "two connections", |s| {
        s.source_status.as_ref().unwrap().connections == 2
    });
    busy.write_all(b"<14>busy\n").unwrap();
    fx.wait(&info, "busy message", |s| s.total_lines == 1);
    let mut new = TcpStream::connect(("127.0.0.1", port)).unwrap();
    new.write_all(b"<14>new one\n").unwrap();
    fx.wait(&info, "the new connection is served", |s| {
        s.total_lines == 2
    });
    // The longest idle one went, the busy one stays.
    assert!(closed_by_peer(&mut oldest));
    busy.write_all(b"<14>still here\n").unwrap();
    fx.wait(&info, "busy still served", |s| s.total_lines == 3);
    let status = fx.stats(&info).source_status.unwrap();
    assert_eq!((status.rejected, status.connections), (0, 2));
}

#[test]
fn at_most_eight_sources_at_a_time() {
    let fx = fixture();
    let open: Vec<_> = (0..log_commander_lib::sources::MAX_SOURCES)
        .map(|_| fx.open(udp_config(Protocol::Udp), false))
        .collect();
    let err = fx
        .manager
        .open_source(
            SourceConfig::Syslog(udp_config(Protocol::Udp)),
            false,
            Default::default(),
            OpenOptions::default(),
            Box::new(|_| {}),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::TooLarge);
    fx.manager.close(open[0].session_id).unwrap();
    fx.open(udp_config(Protocol::Udp), false);
}
