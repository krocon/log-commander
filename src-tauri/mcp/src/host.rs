//! The bridge server the app runs (AppIconic design 018 E1/E3): listens on 127.0.0.1 on a random port,
//! writes the endpoint file with a fresh token, checks the token as the first line of every
//! connection and hands each request to a [`Handler`]. Stops on drop (port closed, file removed,
//! connections cut). Taken over from editlicious `src-tauri/src/mcp.rs` (`Server`, design 016) and
//! made generic, so it is testable without Tauri.

use crate::bridge::{
    self, BridgeError, Endpoint, Hello, HelloAnswer, Request, Response, MAX_LINE_BYTES,
};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Most open sockets at a time (connected clients and ones still saying hello; AppIconic prompt 031).
pub const MAX_OPEN: usize = 8;
/// Most connected clients at a time (design 022 E8).
pub const MAX_CONNECTIONS: usize = 4;
/// Calls per second and connection (token bucket, design 022 E8); a burst may use the whole second.
pub const CALLS_PER_SECOND: f64 = 20.0;
/// Time a new connection has for its hello line.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// Longest hello line (a token is 64 hex digits).
pub const MAX_HELLO_BYTES: usize = 1024;

/// The authenticated connections, by id (for `disconnect`); removed when they end.
type Streams = Arc<Mutex<HashMap<u64, TcpStream>>>;

/// What runs the tools in the app.
pub trait Handler: Send + Sync + 'static {
    fn call(&self, tool: &str, args: &Value) -> Result<Value, BridgeError>;
    /// The number of connected clients changed.
    fn status(&self, _connections: usize) {}
}

/// The running bridge.
pub struct Host {
    pub port: u16,
    endpoint_file: PathBuf,
    stop: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    streams: Streams,
}

impl Host {
    pub fn start(handler: Arc<dyn Handler>, endpoint_file: &Path) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let token = bridge::new_token();
        bridge::write_endpoint(
            endpoint_file,
            &Endpoint {
                port,
                token: token.clone(),
                pid: std::process::id(),
            },
        )?;
        let stop = Arc::new(AtomicBool::new(false));
        let connections = Arc::new(AtomicUsize::new(0));
        let streams: Streams = Arc::new(Mutex::new(HashMap::new()));
        {
            let (stop, connections, streams) = (stop.clone(), connections.clone(), streams.clone());
            let open = Arc::new(AtomicUsize::new(0));
            let ids = AtomicU64::new(0);
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    // a cap on open sockets: a flood of connections cannot use up the app's
                    // file descriptors or threads (AppIconic prompt 031)
                    if open.fetch_add(1, Ordering::SeqCst) >= MAX_OPEN {
                        open.fetch_sub(1, Ordering::SeqCst);
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    let id = ids.fetch_add(1, Ordering::SeqCst);
                    let (handler, token, connections, streams, open, stop) = (
                        handler.clone(),
                        token.clone(),
                        connections.clone(),
                        streams.clone(),
                        open.clone(),
                        stop.clone(),
                    );
                    std::thread::spawn(move || {
                        let ctx = Conn {
                            id,
                            handler: &*handler,
                            token: &token,
                            connections: &connections,
                            streams: &streams,
                            stop: &stop,
                        };
                        serve(stream, &ctx);
                        open.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            });
        }
        Ok(Self {
            port,
            endpoint_file: endpoint_file.to_path_buf(),
            stop,
            connections,
            streams,
        })
    }

    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    /// Closes every connection (the listener stays).
    pub fn disconnect(&self) {
        for (_, s) in self
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.disconnect();
        // wake the accept loop so it sees `stop`
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        let _ = std::fs::remove_file(&self.endpoint_file);
    }
}

/// One line, at most `max` bytes; a longer line is an error (the connection ends).
/// Token bucket of one connection: `CALLS_PER_SECOND` tokens, refilled continuously.
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new() -> Self {
        Self {
            tokens: CALLS_PER_SECOND,
            at: Instant::now(),
        }
    }

    fn take(&mut self) -> bool {
        self.take_at(Instant::now())
    }

    /// `take` at the time `now` (the tests pass it).
    fn take_at(&mut self, now: Instant) -> bool {
        let refill = now.duration_since(self.at).as_secs_f64() * CALLS_PER_SECOND;
        self.tokens = (self.tokens + refill).min(CALLS_PER_SECOND);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// One line in one write (`writeln!` writes the newline on its own, a second small segment).
fn send_line(w: &mut TcpStream, mut text: String) -> io::Result<()> {
    text.push('\n');
    w.write_all(text.as_bytes())
}

fn read_line(r: &mut BufReader<TcpStream>, line: &mut String, max: usize) -> io::Result<usize> {
    line.clear();
    let n = r.by_ref().take(max as u64 + 1).read_line(line)?;
    if n > max {
        return Err(io::Error::other("line too long"));
    }
    Ok(n)
}

/// One connection: token first (short line, short time), then requests until it closes. Never
/// logs contents.
/// What a connection thread needs from the host.
struct Conn<'a> {
    id: u64,
    handler: &'a dyn Handler,
    token: &'a str,
    connections: &'a AtomicUsize,
    streams: &'a Streams,
    stop: &'a AtomicBool,
}

fn serve(stream: TcpStream, ctx: &Conn<'_>) {
    let Conn {
        id,
        handler,
        token,
        connections,
        streams,
        stop,
    } = *ctx;
    let Ok(mut w) = stream.try_clone() else {
        return;
    };
    // The socket is known from the start, so turning off cuts it even before its hello (review 022 #3).
    if let Ok(c) = w.try_clone() {
        streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, c);
    }
    let forget = || {
        streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    };
    // The hello has one deadline, not a timeout per read: a byte every few seconds cannot hold the socket
    // (review 022 #7). A watchdog closes the socket when the deadline passes.
    // It ends as soon as the hello is read (dropping `said_hello` wakes it): sleeping out the deadline kept a
    // clone of every socket open for 5 s, past `MAX_OPEN`.
    let (said_hello, hello_done) = mpsc::channel::<()>();
    if let Ok(killer) = w.try_clone() {
        std::thread::spawn(move || {
            if hello_done.recv_timeout(HELLO_TIMEOUT) == Err(RecvTimeoutError::Timeout) {
                let _ = killer.shutdown(Shutdown::Both);
            }
        });
    }
    // Answers are small lines: without this, Nagle and a delayed ACK cost ~40 ms per call on Linux.
    let _ = w.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HELLO_TIMEOUT));
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    if read_line(&mut r, &mut line, MAX_HELLO_BYTES).unwrap_or(0) == 0
        || stop.load(Ordering::SeqCst)
    {
        drop(said_hello);
        forget();
        let _ = w.shutdown(Shutdown::Both);
        return;
    }
    drop(said_hello);
    let ok =
        serde_json::from_str::<Hello>(&line).is_ok_and(|h| bridge::same_token(&h.token, token));
    let full = ok && connections.load(Ordering::SeqCst) >= MAX_CONNECTIONS;
    let answer = serde_json::to_string(&HelloAnswer {
        ok: ok && !full,
        reason: full.then(|| {
            format!("Log Commander already has {MAX_CONNECTIONS} AI connections – close one")
        }),
    })
    .unwrap_or_default();
    if send_line(&mut w, answer).is_err() || !ok || full {
        forget();
        let _ = w.shutdown(Shutdown::Both);
        return;
    }
    let _ = r.get_ref().set_read_timeout(None);
    let n = connections.fetch_add(1, Ordering::SeqCst) + 1;
    handler.status(n);
    let mut bucket = Bucket::new();
    while read_line(&mut r, &mut line, MAX_LINE_BYTES).unwrap_or(0) > 0 {
        // Turned off meanwhile: no call reaches the app any more.
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let resp = match serde_json::from_str::<Request>(&line) {
            Ok(req) if !bucket.take() => Response {
                id: req.id,
                result: None,
                error: Some(BridgeError::new(
                    "limit_exceeded",
                    format!("more than {CALLS_PER_SECOND} calls per second – slow down"),
                )),
            },
            Ok(req) => match handler.call(&req.tool, &req.args) {
                Ok(v) => Response {
                    id: req.id,
                    result: Some(v),
                    error: None,
                },
                Err(e) => Response {
                    id: req.id,
                    result: None,
                    error: Some(e),
                },
            },
            Err(e) => Response {
                id: 0,
                result: None,
                error: Some(BridgeError::new("invalid_request", e.to_string())),
            },
        };
        let text = serde_json::to_string(&resp).unwrap_or_default();
        if send_line(&mut w, text).is_err() {
            break;
        }
    }
    // the clone kept for `disconnect` goes with the connection (no descriptor left behind)
    forget();
    let _ = w.shutdown(Shutdown::Both);
    let n = connections.fetch_sub(1, Ordering::SeqCst) - 1;
    handler.status(n);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::BridgeClient;
    use crate::server::Tools as _;
    use crate::test_support::{timeout, wait_until, wait_until_or};
    use serde_json::json;

    #[derive(Default)]
    struct Echo(Mutex<Vec<usize>>);

    impl Handler for Echo {
        fn call(&self, tool: &str, args: &Value) -> Result<Value, BridgeError> {
            match tool {
                "fail" => Err(BridgeError::new("revision_conflict", "changed")),
                _ => Ok(json!({"tool": tool, "args": args})),
            }
        }
        fn status(&self, n: usize) {
            self.0.lock().unwrap().push(n);
        }
    }

    #[test]
    fn the_sidecar_client_talks_to_the_host() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let echo = Arc::new(Echo::default());
        let host = Host::start(echo.clone(), &file).unwrap();
        let mut c = BridgeClient::new(Some(file.clone()));
        let r = c.call("get_tree", json!({"max_nodes": 3})).unwrap();
        assert_eq!(r, json!({"tool": "get_tree", "args": {"max_nodes": 3}}));
        let e = c.call("fail", json!({})).unwrap_err();
        assert_eq!(e.code, "revision_conflict");
        assert_eq!(host.connections(), 1);
        // a wrong token is turned away
        let mut ep = bridge::read_endpoint(&file).unwrap();
        ep.token = bridge::new_token();
        let other = dir.path().join("other.json");
        bridge::write_endpoint(&other, &ep).unwrap();
        let e = BridgeClient::new(Some(other))
            .call("get_tree", json!({}))
            .unwrap_err();
        assert!(e.message.contains("refused"));
        host.disconnect();
        drop(host);
        assert!(!file.exists(), "the endpoint file goes with the host");
        assert_eq!(echo.0.lock().unwrap()[0], 1);
        // nothing listens any more
        let e = BridgeClient::new(Some(file))
            .call("x", json!({}))
            .unwrap_err();
        assert_eq!(e.code, "not_running");
    }

    #[test]
    fn a_line_over_the_limit_ends_the_connection() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let _host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        let s = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        writeln!(
            w,
            "{}",
            serde_json::to_string(&Hello { token: ep.token }).unwrap()
        )
        .unwrap();
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        assert!(line.contains("true"));
        // more than the limit without a newline: the host stops reading and closes
        let chunk = vec![b'x'; 1 << 20];
        let mut written = 0;
        while written <= MAX_LINE_BYTES + (1 << 20) {
            if w.write_all(&chunk).is_err() {
                break;
            }
            written += chunk.len();
        }
        line.clear();
        assert_eq!(r.read_line(&mut line).unwrap_or(0), 0, "closed");
    }

    #[test]
    fn a_bad_request_line_gets_an_error_answer() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let _host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        let s = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        writeln!(
            w,
            "{}",
            serde_json::to_string(&Hello { token: ep.token }).unwrap()
        )
        .unwrap();
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        writeln!(w, "not json").unwrap();
        line.clear();
        r.read_line(&mut line).unwrap();
        let resp: Response = serde_json::from_str(&line).unwrap();
        assert_eq!(resp.error.unwrap().code, "invalid_request");
    }

    /// The host's answer to a hello, empty if it closed the socket (also before the hello could
    /// be written: a host without a free place closes at once, the write then fails).
    fn hello(w: &mut TcpStream, r: &mut BufReader<TcpStream>, token: &str) -> String {
        let hello = serde_json::to_string(&Hello {
            token: token.into(),
        })
        .unwrap();
        if writeln!(w, "{hello}").is_err() {
            return String::new();
        }
        let mut line = String::new();
        r.read_line(&mut line).unwrap_or(0);
        line
    }

    /// Open descriptors of this process that are TCP sockets on `port` (either end); Linux only.
    /// Only these: the other tests run in parallel and open descriptors of their own.
    fn port_sockets(port: u16) -> Option<usize> {
        let mut inodes = std::collections::HashSet::new();
        for table in ["/proc/self/net/tcp", "/proc/self/net/tcp6"] {
            let Ok(text) = std::fs::read_to_string(table) else {
                continue;
            };
            for row in text.lines().skip(1) {
                let f: Vec<&str> = row.split_whitespace().collect();
                let port_of = |a: &str| {
                    a.rsplit(':')
                        .next()
                        .and_then(|p| u16::from_str_radix(p, 16).ok())
                };
                // inode 0: no descriptor any more (TIME_WAIT)
                if f.len() > 9
                    && f[9] != "0"
                    && (port_of(f[1]) == Some(port) || port_of(f[2]) == Some(port))
                {
                    inodes.insert(format!("socket:[{}]", f[9]));
                }
            }
        }
        let fds = std::fs::read_dir("/proc/self/fd").ok()?;
        Some(
            fds.filter_map(|e| std::fs::read_link(e.ok()?.path()).ok())
                .filter(|l| inodes.contains(l.to_string_lossy().as_ref()))
                .count(),
        )
    }

    /// Connects and says hello with the right token; the socket halves, if the host took it.
    fn connect(ep: &Endpoint) -> Option<(TcpStream, BufReader<TcpStream>)> {
        let s = TcpStream::connect(("127.0.0.1", ep.port)).ok()?;
        let mut w = s.try_clone().ok()?;
        let mut r = BufReader::new(s);
        hello(&mut w, &mut r, &ep.token)
            .contains("true")
            .then_some((w, r))
    }

    #[test]
    fn closed_connections_leave_no_descriptors_behind() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        // The listener.
        let before = port_sockets(ep.port);
        for i in 0..50 {
            let s = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            // every other one with a wrong token
            let token = if i % 2 == 0 {
                ep.token.clone()
            } else {
                "x".repeat(64)
            };
            hello(&mut w, &mut r, &token);
        }
        let streams = host.streams.clone();
        wait_until_or(
            "no kept clones",
            || format!("{} kept", streams.lock().unwrap().len()),
            || streams.lock().unwrap().is_empty(),
        );
        wait_until_or(
            "no connection",
            || format!("{} connections", host.connections()),
            || host.connections() == 0,
        );
        if let Some(before) = before {
            // sockets close asynchronously
            wait_until_or(
                "the sockets of the port to close (descriptors leak)",
                || {
                    format!(
                        "{:?} sockets on the port, {before} before",
                        port_sockets(ep.port)
                    )
                },
                || port_sockets(ep.port).unwrap() <= before,
            );
        }
    }

    #[test]
    fn a_long_hello_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let _host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        let s = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        let _ = w.write_all(&vec![b'x'; MAX_HELLO_BYTES + 10]);
        let _ = writeln!(w);
        let mut line = String::new();
        assert_eq!(
            r.read_line(&mut line).unwrap_or(0),
            0,
            "closed without an answer"
        );
    }

    #[test]
    fn a_silent_client_is_dropped_after_the_hello_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let _host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        let s = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        // The read ends because the host closes the socket, not because the test gives up: its
        // own limit is far away and would end the read with an error of another kind.
        s.set_read_timeout(Some(timeout().max(HELLO_TIMEOUT * 4)))
            .unwrap();
        let mut line = String::new();
        match BufReader::new(s).read_line(&mut line) {
            Ok(n) => assert_eq!(n, 0, "closed without an answer: {line}"),
            Err(e) => assert!(
                !matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ),
                "the host did not drop the silent client: {e}"
            ),
        }
    }

    #[test]
    fn too_many_open_sockets_are_turned_away() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let _host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        // MAX_OPEN silent sockets hold every place
        let held: Vec<_> = (0..MAX_OPEN)
            .map(|_| TcpStream::connect(("127.0.0.1", ep.port)).unwrap())
            .collect();
        std::thread::sleep(Duration::from_millis(100));
        let s = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut line = String::new();
        let n = BufReader::new(s).read_line(&mut line).unwrap_or(0);
        assert_eq!(n, 0, "closed at once");
        drop(held);
        // places free up again
        wait_until("a place for a new client", || connect(&ep).is_some());
    }

    #[test]
    fn a_fifth_client_is_told_why() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let mut clients: Vec<_> = (0..MAX_CONNECTIONS)
            .map(|_| BridgeClient::new(Some(file.clone())))
            .collect();
        for c in &mut clients {
            c.call("x", json!({})).unwrap();
        }
        wait_until_or(
            "all clients connected",
            || format!("{} connections", host.connections()),
            || host.connections() == MAX_CONNECTIONS,
        );
        let e = BridgeClient::new(Some(file.clone()))
            .call("x", json!({}))
            .unwrap_err();
        assert_eq!(e.code, "limit_exceeded");
        drop(clients);
        wait_until_or(
            "the clients to be gone",
            || format!("{} connections", host.connections()),
            || host.connections() == 0,
        );
        BridgeClient::new(Some(file)).call("x", json!({})).unwrap();
    }

    #[test]
    fn the_bucket_allows_a_burst_and_refills_with_time() {
        // The clock is passed in: what the bucket allows must not depend on how fast the test runs.
        let mut bucket = Bucket::new();
        let start = bucket.at;
        let burst = CALLS_PER_SECOND as usize;
        // A burst may use the whole second at once, then it is over.
        assert!((0..burst).all(|_| bucket.take_at(start)));
        assert!(!bucket.take_at(start));
        // One call's worth of time gives one call, not two.
        let one = Duration::from_secs_f64(1.0 / CALLS_PER_SECOND);
        assert!(!bucket.take_at(start + one / 2));
        assert!(bucket.take_at(start + one + one / 2));
        assert!(!bucket.take_at(start + one + one / 2));
        // A long pause fills it up, but never beyond one second's worth.
        let later = start + Duration::from_secs(3600);
        assert!((0..burst).all(|_| bucket.take_at(later)));
        assert!(!bucket.take_at(later));
        // Half a second later: half of them.
        let half = later + Duration::from_millis(500);
        assert_eq!(
            (0..burst).filter(|_| bucket.take_at(half)).count(),
            burst / 2
        );
    }

    #[test]
    fn a_flood_of_calls_is_slowed_down() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let _host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        let (mut w, mut r) = connect(&ep).unwrap();
        // Three seconds' worth of calls in one write: the host finds them all in its buffer, so
        // how many it refuses does not depend on how fast this thread and the network are. Should
        // the host's thread be held up so long that the bucket refills in between, the next
        // flood comes.
        let burst = CALLS_PER_SECOND as usize * 3;
        let flood: String = (0..burst)
            .map(|id| format!("{}\n", json!({"id": id, "tool": "x", "args": {}})))
            .collect();
        let mut passed = 0;
        wait_until("a flood with refused calls", || {
            w.write_all(flood.as_bytes()).unwrap();
            let mut refused = 0;
            for _ in 0..burst {
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let resp: Response = serde_json::from_str(&line).unwrap();
                match resp.error {
                    Some(e) => {
                        assert_eq!(e.code, "limit_exceeded");
                        refused += 1;
                    }
                    None => passed += 1,
                }
            }
            refused > 0
        });
        // Not everything is refused: the calls the bucket had went through.
        assert!(
            passed >= CALLS_PER_SECOND as usize,
            "the burst passes: {passed}"
        );
        // The limit is per second, not for good: time fills the bucket again (300 ms: 6 calls).
        std::thread::sleep(Duration::from_millis(300));
        writeln!(w, "{}", json!({"id": 0, "tool": "x", "args": {}})).unwrap();
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        let resp: Response = serde_json::from_str(&line).unwrap();
        assert!(resp.error.is_none(), "{line}");
    }

    #[test]
    fn a_slow_hello_does_not_hold_the_socket() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let _host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        let s = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        let mut w = s.try_clone().unwrap();
        // one byte a second: each read is within the timeout, the whole hello is not. With a
        // timeout per read the socket would live as long as the bytes come; the number of bytes
        // is the limit here, a slow machine only gives the host more time.
        let mut closed = false;
        for _ in 0..(HELLO_TIMEOUT.as_secs() * 3) {
            if w.write_all(b"{").is_err() {
                closed = true;
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        assert!(closed, "closed by the deadline");
    }

    #[test]
    fn turning_off_cuts_a_socket_that_has_not_said_hello() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        let host = Host::start(Arc::new(Echo::default()), &file).unwrap();
        let ep = bridge::read_endpoint(&file).unwrap();
        let s = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        drop(host);
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        let _ = writeln!(
            w,
            "{}",
            serde_json::to_string(&Hello { token: ep.token }).unwrap()
        );
        let mut line = String::new();
        assert_eq!(
            r.read_line(&mut line).unwrap_or(0),
            0,
            "no answer after turning off"
        );
    }
}
