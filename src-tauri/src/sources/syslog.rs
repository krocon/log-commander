//! Syslog over UDP (RFC 3164, RFC 5424) and TCP (RFC 6587: octet counting and newline framing) into
//! the spool (prompt 016). TLS (RFC 5425) is not part of it.
//!
//! Every message becomes **one** spool line: the time of receipt (ISO 8601, local zone), the sender's
//! address, then the message as received. Line breaks become `\n`/`\r`, other control characters and
//! bytes that are not UTF-8 `\xNN`, so one message never falls apart into continuation lines.
//! Messages over `MAX_MESSAGE` bytes are cut and marked. The built-in profile `syslog-received`
//! (`profile.rs`) reads the priority behind the prefix and splits RFC 3164/5424 into columns.
//!
//! Network input is untrusted: by default only loopback addresses may be bound (others need
//! `allowRemote`), an optional sender filter (addresses and networks), bounded message size,
//! bounded TCP connections, and a bounded queue to the spool that drops and counts instead of
//! growing. Nothing is ever sent back (no amplification).

use super::{Source, SourceContext, SourceMonitor};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::model::{SourceKind, SourceState};
use crate::spool::{SpoolWriter, StopToken};
use chrono::TimeZone;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The default port: 514 needs root (or administrator) rights.
pub const DEFAULT_PORT: u16 = 5514;
/// Longer messages are cut and marked (prompt 016).
pub const MAX_MESSAGE: usize = 64 * 1024;
/// Open TCP connections at most (see `TcpLimits`).
pub const MAX_CONNECTIONS: usize = 64;
/// Entries of the sender filter.
pub const MAX_ALLOW: usize = 64;
/// Receiving threads look at the stop token this often.
const POLL: Duration = Duration::from_millis(200);
const ACCEPT_POLL: Duration = Duration::from_millis(25);
/// How long TCP connections may hold a slot (security review of 016: slowloris).
#[derive(Debug, Clone, Copy)]
pub struct TcpLimits {
    /// Open connections at most.
    pub max_connections: usize,
    /// Connections from one sender address at most; more are refused and counted.
    pub max_per_sender: usize,
    /// A connection without data for this long is closed.
    pub idle: Duration,
    /// A frame (octet count or line) started but not finished for this long: the connection is closed,
    /// what came of the frame is written as cut.
    pub frame: Duration,
    /// At the limit, the longest idle connection is closed for a new one if it was idle this long;
    /// otherwise the new one is refused.
    pub evict_after: Duration,
}

impl Default for TcpLimits {
    fn default() -> Self {
        Self {
            max_connections: MAX_CONNECTIONS,
            max_per_sender: 8,
            idle: Duration::from_secs(120),
            frame: Duration::from_secs(30),
            evict_after: Duration::from_secs(5),
        }
    }
}

/// Appended to a cut message.
pub const TRUNCATED_MARK: &str = " …[gekürzt]";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    Udp,
    Tcp,
    /// UDP and TCP on the same port.
    Both,
}

impl Protocol {
    fn udp(self) -> bool {
        matches!(self, Protocol::Udp | Protocol::Both)
    }
    fn tcp(self) -> bool {
        matches!(self, Protocol::Tcp | Protocol::Both)
    }
}

/// What the dialog sends. No host names (no DNS): addresses only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyslogConfig {
    pub protocol: Protocol,
    /// Address to listen on; `127.0.0.1` by default.
    pub address: String,
    /// 0 lets the system choose (tests).
    pub port: u16,
    /// Senders allowed: addresses or networks (`10.0.0.0/8`, `fd00::/8`). Empty: everyone who can
    /// reach the port.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Listening on an address that is not loopback must be chosen explicitly.
    #[serde(default)]
    pub allow_remote: bool,
}

impl Default for SyslogConfig {
    fn default() -> Self {
        Self {
            protocol: Protocol::Udp,
            address: Ipv4Addr::LOCALHOST.to_string(),
            port: DEFAULT_PORT,
            allow: Vec::new(),
            allow_remote: false,
        }
    }
}

/// An address or a network of the sender filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Net {
    addr: IpAddr,
    prefix: u8,
}

impl Net {
    pub fn parse(text: &str) -> Option<Net> {
        let text = text.trim();
        let (addr, prefix) = match text.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (text, None),
        };
        let addr = canonical(addr.parse::<IpAddr>().ok()?);
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(p) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && p.len() <= 3 => {
                p.parse::<u8>().ok().filter(|p| *p <= max)?
            }
            Some(_) => return None,
            None => max,
        };
        Some(Net { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, canonical(ip)) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

/// IPv4 senders on a dual-stack socket arrive as `::ffff:a.b.c.d`.
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    }
}

/// The sender filter; empty lets everyone in.
#[derive(Debug, Clone, Default)]
pub struct Allow(Vec<Net>);

impl Allow {
    pub fn parse(entries: &[String]) -> AppResult<Self> {
        let entries: Vec<&String> = entries.iter().filter(|e| !e.trim().is_empty()).collect();
        if entries.len() > MAX_ALLOW {
            return Err(AppError::new(
                ErrorCode::InvalidSource,
                format!("at most {MAX_ALLOW} sender entries"),
            ));
        }
        entries
            .into_iter()
            .map(|e| {
                Net::parse(e).ok_or_else(|| {
                    AppError::new(ErrorCode::InvalidSource, format!("not an address: {e}"))
                })
            })
            .collect::<AppResult<Vec<_>>>()
            .map(Allow)
    }

    pub fn permits(&self, ip: IpAddr) -> bool {
        self.0.is_empty() || self.0.iter().any(|n| n.contains(ip))
    }
}

/// Checks the address of a configuration: an IP address, loopback unless remote listening was
/// chosen.
pub fn listen_address(config: &SyslogConfig) -> AppResult<IpAddr> {
    let text = config.address.trim();
    let text = text
        .strip_prefix('[')
        .and_then(|t| t.strip_suffix(']'))
        .unwrap_or(text);
    let ip: IpAddr = text.parse().map_err(|_| {
        AppError::new(
            ErrorCode::InvalidSource,
            format!("not an IP address: {}", config.address),
        )
    })?;
    if !ip.is_loopback() && !config.allow_remote {
        return Err(AppError::new(
            ErrorCode::InvalidSource,
            format!("listening on {ip} reaches beyond this computer and must be chosen explicitly"),
        ));
    }
    Ok(ip)
}

fn bind_error(err: &io::Error, port: u16) -> AppError {
    match err.kind() {
        io::ErrorKind::AddrInUse => AppError::new(
            ErrorCode::PortInUse,
            format!("port {port} is in use by another program"),
        ),
        io::ErrorKind::PermissionDenied => AppError::new(
            ErrorCode::PermissionDenied,
            format!(
                "port {port}: no permission (ports below 1024 need administrator rights): {err}"
            ),
        ),
        io::ErrorKind::AddrNotAvailable => AppError::new(
            ErrorCode::InvalidSource,
            format!("address not available on this computer: {err}"),
        ),
        _ => AppError::new(ErrorCode::Io, format!("port {port}: {err}")),
    }
}

/// A syslog listener with its sockets bound.
pub struct SyslogSource {
    config: SyslogConfig,
    allow: Allow,
    udp: Option<UdpSocket>,
    tcp: Option<TcpListener>,
    port: u16,
    limits: TcpLimits,
}

impl SyslogSource {
    /// Other TCP limits (tests use short timeouts).
    pub fn with_tcp_limits(mut self, limits: TcpLimits) -> Self {
        self.limits = limits;
        self
    }

    /// Binds the sockets, so a port in use or a missing right is an error of the open dialog.
    pub fn bind(config: SyslogConfig) -> AppResult<Self> {
        let ip = listen_address(&config)?;
        let allow = Allow::parse(&config.allow)?;
        let (udp, tcp) = bind_sockets(ip, config.port, config.protocol)?;
        let port = udp
            .as_ref()
            .map(|s| s.local_addr().map(|a| a.port()))
            .or_else(|| tcp.as_ref().map(|s| s.local_addr().map(|a| a.port())))
            .transpose()
            .map_err(|e| bind_error(&e, config.port))?
            .unwrap_or(config.port);
        Ok(Self {
            config,
            allow,
            udp,
            tcp,
            port,
            limits: TcpLimits::default(),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

fn bind_sockets(
    ip: IpAddr,
    port: u16,
    protocol: Protocol,
) -> AppResult<(Option<UdpSocket>, Option<TcpListener>)> {
    // Port 0 for both: TCP gets the port the system chose for UDP; it may be taken for TCP.
    let attempts = if port == 0 && protocol == Protocol::Both {
        8
    } else {
        1
    };
    let mut last = None;
    for _ in 0..attempts {
        let udp = if protocol.udp() {
            Some(UdpSocket::bind(SocketAddr::new(ip, port)).map_err(|e| bind_error(&e, port))?)
        } else {
            None
        };
        let tcp_port = match &udp {
            Some(s) => s.local_addr().map_err(|e| bind_error(&e, port))?.port(),
            None => port,
        };
        if !protocol.tcp() {
            return Ok((udp, None));
        }
        match TcpListener::bind(SocketAddr::new(ip, tcp_port)) {
            Ok(tcp) => return Ok((udp, Some(tcp))),
            Err(e) => last = Some(bind_error(&e, tcp_port)),
        }
    }
    Err(last.unwrap_or_else(|| AppError::new(ErrorCode::Io, "no port")))
}

impl Source for SyslogSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Syslog
    }

    fn label(&self) -> String {
        let proto = match self.config.protocol {
            Protocol::Udp => "",
            Protocol::Tcp => " TCP",
            Protocol::Both => " UDP+TCP",
        };
        match listen_address(&self.config) {
            Ok(ip) if ip.is_loopback() => format!("Syslog{proto} :{}", self.port),
            Ok(IpAddr::V6(ip)) => format!("Syslog{proto} [{ip}]:{}", self.port),
            Ok(ip) => format!("Syslog{proto} {ip}:{}", self.port),
            Err(_) => format!("Syslog{proto} :{}", self.port),
        }
    }

    fn config(&self) -> serde_json::Value {
        let mut config = self.config.clone();
        config.port = self.port;
        let mut value = serde_json::to_value(config).unwrap_or_default();
        if let Some(map) = value.as_object_mut() {
            map.insert("kind".into(), "syslog".into());
        }
        value
    }

    fn profile(&self) -> Option<&'static str> {
        Some(crate::profile::SYSLOG_RECEIVED_PROFILE)
    }

    fn run(self: Box<Self>, ctx: SourceContext) {
        let SyslogSource {
            allow,
            udp,
            tcp,
            limits,
            ..
        } = *self;
        let allow = Arc::new(allow);
        ctx.monitor.set_state(SourceState::Listening);
        let tcp_thread: Option<JoinHandle<()>> = tcp.and_then(|listener| {
            let allow = Arc::clone(&allow);
            let writer = ctx.writer.clone();
            let stop = ctx.stop.clone();
            let monitor = Arc::clone(&ctx.monitor);
            let spawned = std::thread::Builder::new()
                .name("syslog-tcp".into())
                .spawn(move || {
                    let accept = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        accept_loop(&listener, &allow, &writer, &stop, &monitor, limits)
                    }));
                    if accept.is_err() {
                        monitor.set_state(SourceState::Error {
                            message: "TCP receiving stopped unexpectedly".into(),
                        });
                    }
                });
            match spawned {
                Ok(thread) => Some(thread),
                Err(e) => {
                    // UDP may go on, but the missing TCP must not go unnoticed.
                    ctx.monitor.set_state(SourceState::Error {
                        message: format!("TCP not started: {e}"),
                    });
                    None
                }
            }
        });
        if let Some(socket) = udp {
            udp_loop(&socket, &allow, &ctx.writer, &ctx.stop, &ctx.monitor);
        }
        if let Some(thread) = tcp_thread {
            let _ = thread.join();
        }
        ctx.monitor.flush();
    }
}

/// One message as a spool line: time of receipt, sender, message.
pub struct Receiver<'a> {
    allow: &'a Allow,
    writer: &'a SpoolWriter,
    monitor: &'a SourceMonitor,
    clock: ReceiveClock,
    line: Vec<u8>,
}

impl<'a> Receiver<'a> {
    pub fn new(allow: &'a Allow, writer: &'a SpoolWriter, monitor: &'a SourceMonitor) -> Self {
        Self {
            allow,
            writer,
            monitor,
            clock: ReceiveClock::default(),
            line: Vec::with_capacity(1024),
        }
    }

    pub fn message(&mut self, sender: IpAddr, payload: &[u8], cut: bool) {
        self.line.clear();
        self.clock.stamp(&mut self.line);
        let truncated = format_message(&mut self.line, sender, payload, cut);
        if truncated {
            self.monitor.truncated.fetch_add(1, Ordering::Relaxed);
        }
        self.monitor.received.fetch_add(1, Ordering::Relaxed);
        self.writer.try_line(self.line.clone());
        self.monitor.counted();
    }

    pub fn permits(&self, sender: IpAddr) -> bool {
        if self.allow.permits(sender) {
            return true;
        }
        self.monitor.rejected.fetch_add(1, Ordering::Relaxed);
        self.monitor.counted();
        false
    }
}

fn would_block(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
    )
}

fn udp_loop(
    socket: &UdpSocket,
    allow: &Allow,
    writer: &SpoolWriter,
    stop: &StopToken,
    monitor: &SourceMonitor,
) {
    if let Err(e) = socket.set_read_timeout(Some(POLL)) {
        monitor.set_state(SourceState::Error {
            message: e.to_string(),
        });
        return;
    }
    // Larger than any datagram (65 507 bytes of payload).
    let mut buf = vec![0u8; 65_536];
    let mut receiver = Receiver::new(allow, writer, monitor);
    while !stop.is_stopped() {
        match socket.recv_from(&mut buf) {
            Ok((n, from)) => {
                monitor.recovered(SourceState::Listening);
                let sender = canonical(from.ip());
                if receiver.permits(sender) {
                    receiver.message(sender, &buf[..n], false);
                }
            }
            Err(e) if would_block(&e) => monitor.flush(),
            // Windows reports ICMP "port unreachable" of earlier datagrams here; nothing to do.
            Err(e) if e.kind() == io::ErrorKind::ConnectionReset => {}
            Err(e) => {
                monitor.set_state(SourceState::Error {
                    message: e.to_string(),
                });
                std::thread::sleep(POLL);
            }
        }
    }
}

/// The open TCP connections: who, since when idle, and a handle to close them from outside.
#[derive(Default)]
struct Connections {
    open: Mutex<Vec<Arc<Slot>>>,
    next: AtomicU64,
}

struct Slot {
    id: u64,
    sender: IpAddr,
    /// Last data, as milliseconds since `started`.
    last_data: AtomicU64,
    started: Instant,
    /// A clone of the stream, to close it when evicted.
    stream: TcpStream,
}

impl Slot {
    fn idle(&self) -> Duration {
        let last = Duration::from_millis(self.last_data.load(Ordering::Relaxed));
        self.started.elapsed().saturating_sub(last)
    }

    fn touch(&self) {
        self.last_data
            .store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
}

/// Removes a connection from `Connections` when its thread ends, also by a panic.
struct SlotGuard<'a> {
    connections: &'a Connections,
    monitor: &'a SourceMonitor,
    id: u64,
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        let left = {
            let mut open = self.connections.open.lock();
            open.retain(|s| s.id != self.id);
            open.len()
        };
        self.monitor
            .connections
            .store(left as u32, Ordering::SeqCst);
        self.monitor.counted();
        self.monitor.flush();
    }
}

impl Connections {
    /// Takes a new connection, or says why not. At the limit the longest idle connection (idle
    /// at least `evict_after`) is closed for it.
    fn admit(&self, stream: &TcpStream, sender: IpAddr, limits: &TcpLimits) -> Option<Arc<Slot>> {
        let mut open = self.open.lock();
        if open.iter().filter(|s| s.sender == sender).count() >= limits.max_per_sender {
            return None;
        }
        if open.len() >= limits.max_connections {
            let (index, idle) = open
                .iter()
                .enumerate()
                .map(|(i, s)| (i, s.idle()))
                .max_by_key(|(_, idle)| *idle)?;
            if idle < limits.evict_after {
                return None;
            }
            let evicted = open.remove(index);
            // Its thread sees the closed stream and ends; its guard finds it gone already.
            let _ = evicted.stream.shutdown(std::net::Shutdown::Both);
        }
        let slot = Arc::new(Slot {
            id: self.next.fetch_add(1, Ordering::Relaxed),
            sender,
            last_data: AtomicU64::new(0),
            started: Instant::now(),
            stream: stream.try_clone().ok()?,
        });
        open.push(Arc::clone(&slot));
        Some(slot)
    }

    fn len(&self) -> usize {
        self.open.lock().len()
    }
}

fn accept_loop(
    listener: &TcpListener,
    allow: &Arc<Allow>,
    writer: &SpoolWriter,
    stop: &StopToken,
    monitor: &Arc<SourceMonitor>,
    limits: TcpLimits,
) {
    if let Err(e) = listener.set_nonblocking(true) {
        monitor.set_state(SourceState::Error {
            message: e.to_string(),
        });
        return;
    }
    let connections = Arc::new(Connections::default());
    let mut threads: Vec<JoinHandle<()>> = Vec::new();
    while !stop.is_stopped() {
        match listener.accept() {
            Ok((stream, from)) => {
                monitor.recovered(SourceState::Listening);
                threads.retain(|c| !c.is_finished());
                let sender = canonical(from.ip());
                let slot = if allow.permits(sender) {
                    connections.admit(&stream, sender, &limits)
                } else {
                    None
                };
                let Some(slot) = slot else {
                    // Closed without a word.
                    drop(stream);
                    monitor.rejected.fetch_add(1, Ordering::Relaxed);
                    monitor.counted();
                    continue;
                };
                monitor
                    .connections
                    .store(connections.len() as u32, Ordering::SeqCst);
                monitor.counted();
                let allow = Arc::clone(allow);
                let writer = writer.clone();
                let stop = stop.clone();
                let monitor_c = Arc::clone(monitor);
                let connections_c = Arc::clone(&connections);
                let id = slot.id;
                let spawned = std::thread::Builder::new()
                    .name("syslog-conn".into())
                    .spawn(move || {
                        let _guard = SlotGuard {
                            connections: &connections_c,
                            monitor: &monitor_c,
                            id,
                        };
                        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            connection(stream, &slot, &allow, &writer, &stop, &monitor_c, &limits)
                        }));
                        if run.is_err() {
                            monitor_c.set_state(SourceState::Error {
                                message: "a TCP connection ended unexpectedly".into(),
                            });
                        }
                    });
                match spawned {
                    Ok(handle) => threads.push(handle),
                    Err(_) => {
                        connections.open.lock().retain(|s| s.id != id);
                        monitor
                            .connections
                            .store(connections.len() as u32, Ordering::SeqCst);
                    }
                }
            }
            Err(e) if would_block(&e) => {
                monitor.flush();
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(e) => {
                monitor.set_state(SourceState::Error {
                    message: e.to_string(),
                });
                std::thread::sleep(POLL);
            }
        }
    }
    for c in threads {
        let _ = c.join();
    }
}

fn connection(
    mut stream: TcpStream,
    slot: &Slot,
    allow: &Allow,
    writer: &SpoolWriter,
    stop: &StopToken,
    monitor: &SourceMonitor,
    limits: &TcpLimits,
) {
    // Accepted sockets may inherit non-blocking mode from the listener.
    let poll = POLL.min(limits.idle).min(limits.frame);
    if stream.set_nonblocking(false).is_err() || stream.set_read_timeout(Some(poll)).is_err() {
        return;
    }
    let sender = slot.sender;
    let mut receiver = Receiver::new(allow, writer, monitor);
    let mut framer = TcpFramer::default();
    let mut buf = vec![0u8; 64 * 1024];
    // Since when the current frame is open.
    let mut frame_since: Option<Instant> = None;
    let mut cut_frame = false;
    while !stop.is_stopped() {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                slot.touch();
                framer.push(&buf[..n], &mut |msg, cut| {
                    receiver.message(sender, msg, cut)
                });
                frame_since = match (framer.in_frame(), frame_since) {
                    (false, _) => None,
                    (true, None) => Some(Instant::now()),
                    (true, since) => since,
                };
            }
            Err(e) if would_block(&e) => monitor.flush(),
            Err(_) => break,
        }
        if frame_since.is_some_and(|t| t.elapsed() >= limits.frame) {
            cut_frame = true;
            break;
        }
        if slot.idle() >= limits.idle {
            break;
        }
    }
    if cut_frame {
        framer.abandon(&mut |msg| receiver.message(sender, msg, true));
    } else {
        framer.finish(&mut |msg, cut| receiver.message(sender, msg, cut));
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

// ------------------------------------------------------------------------------------------------
// TCP framing (RFC 6587)
// ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Frame {
    /// Between messages.
    #[default]
    Start,
    /// Digits of an octet count so far (kept in the buffer).
    Count(usize),
    /// Octet counting: bytes still to come.
    Octets(usize),
    /// Newline framing: until `\n`.
    Line,
    /// A line over the limit: dropped until `\n`.
    SkipLine,
}

/// Splits a TCP stream into messages: `MSG-LEN SP MSG` (octet counting) when a frame starts with a
/// digit, otherwise up to `\n` (a `\r` before it is dropped). At most `MAX_MESSAGE` bytes per
/// message are kept; the rest is skipped and the message reported as cut. Memory stays bounded by
/// `MAX_MESSAGE` whatever the peer sends.
#[derive(Debug, Default)]
pub struct TcpFramer {
    state: Frame,
    buf: Vec<u8>,
    cut: bool,
}

/// More digits are no octet count (RFC 6587 allows any length, but no message is that long).
const MAX_COUNT_DIGITS: usize = 9;

impl TcpFramer {
    pub fn push(&mut self, mut data: &[u8], emit: &mut dyn FnMut(&[u8], bool)) {
        while !data.is_empty() {
            match self.state {
                Frame::Start => {
                    let b = data[0];
                    if matches!(b, b'\n' | b'\r' | 0) {
                        // Empty frames and trailers between messages.
                        data = &data[1..];
                    } else if b.is_ascii_digit() {
                        self.buf.clear();
                        self.buf.push(b);
                        self.state = Frame::Count(1);
                        data = &data[1..];
                    } else {
                        self.buf.clear();
                        self.state = Frame::Line;
                    }
                }
                Frame::Count(digits) => {
                    let b = data[0];
                    if b.is_ascii_digit() && digits < MAX_COUNT_DIGITS {
                        self.buf.push(b);
                        self.state = Frame::Count(digits + 1);
                        data = &data[1..];
                    } else if b == b' ' {
                        let len: usize = std::str::from_utf8(&self.buf)
                            .ok()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0);
                        self.buf.clear();
                        self.cut = false;
                        self.state = if len == 0 {
                            Frame::Start
                        } else {
                            Frame::Octets(len)
                        };
                        data = &data[1..];
                    } else {
                        // Not a count: a line that starts with digits.
                        self.state = Frame::Line;
                    }
                }
                Frame::Octets(rest) => {
                    let take = rest.min(data.len());
                    let room = MAX_MESSAGE.saturating_sub(self.buf.len());
                    if take > room {
                        self.cut = true;
                    }
                    self.buf.extend_from_slice(&data[..take.min(room)]);
                    data = &data[take..];
                    if rest == take {
                        emit(&self.buf, self.cut);
                        self.reset();
                    } else {
                        self.state = Frame::Octets(rest - take);
                    }
                }
                Frame::Line => {
                    let end = memchr::memchr(b'\n', data);
                    let chunk = &data[..end.unwrap_or(data.len())];
                    let room = MAX_MESSAGE.saturating_sub(self.buf.len());
                    if chunk.len() > room {
                        self.buf.extend_from_slice(&chunk[..room]);
                        emit(&self.buf, true);
                        self.buf.clear();
                        self.state = Frame::SkipLine;
                        data = &data[room..];
                        continue;
                    }
                    self.buf.extend_from_slice(chunk);
                    match end {
                        Some(end) => {
                            if self.buf.last() == Some(&b'\r') {
                                self.buf.pop();
                            }
                            emit(&self.buf, false);
                            self.reset();
                            data = &data[end + 1..];
                        }
                        None => data = &[],
                    }
                }
                Frame::SkipLine => match memchr::memchr(b'\n', data) {
                    Some(end) => {
                        self.reset();
                        data = &data[end + 1..];
                    }
                    None => data = &[],
                },
            }
        }
    }

    /// Inside a message (octet count, its bytes or a line without its end).
    pub fn in_frame(&self) -> bool {
        self.state != Frame::Start
    }

    /// The frame took too long: what came of it is a cut message (nothing if it was skipped).
    pub fn abandon(&mut self, emit: &mut dyn FnMut(&[u8])) {
        if !self.buf.is_empty() && !matches!(self.state, Frame::Count(_) | Frame::SkipLine) {
            emit(&self.buf);
        }
        self.reset();
    }

    /// The connection ended: a message without its end is still a message (cut if octets were
    /// missing).
    pub fn finish(&mut self, emit: &mut dyn FnMut(&[u8], bool)) {
        match self.state {
            Frame::Line | Frame::Count(_) if !self.buf.is_empty() => emit(&self.buf, false),
            Frame::Octets(_) if !self.buf.is_empty() => emit(&self.buf, true),
            _ => {}
        }
        self.reset();
    }

    fn reset(&mut self) {
        self.state = Frame::Start;
        self.buf.clear();
        self.cut = false;
    }
}

// ------------------------------------------------------------------------------------------------
// The spool line
// ------------------------------------------------------------------------------------------------

/// Formats the time of receipt, cached per second (the zone offset is looked up once a second).
#[derive(Default)]
pub struct ReceiveClock {
    second: i64,
    /// `2026-11-07T10:15:30` of `second`, and the offset `+01:00`.
    head: String,
    offset: String,
}

impl ReceiveClock {
    pub fn stamp(&mut self, out: &mut Vec<u8>) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        self.stamp_at(now.as_secs() as i64, now.subsec_millis(), out);
    }

    pub fn stamp_at(&mut self, secs: i64, millis: u32, out: &mut Vec<u8>) {
        if secs != self.second || self.head.is_empty() {
            let local = chrono::Local
                .timestamp_opt(secs, 0)
                .single()
                .unwrap_or_else(chrono::Local::now);
            self.head = local.format("%Y-%m-%dT%H:%M:%S").to_string();
            self.offset = local.format("%:z").to_string();
            self.second = secs;
        }
        out.extend_from_slice(self.head.as_bytes());
        out.push(b'.');
        let ms = millis.min(999);
        out.extend_from_slice(&[
            b'0' + (ms / 100) as u8,
            b'0' + (ms / 10 % 10) as u8,
            b'0' + (ms % 10) as u8,
        ]);
        out.extend_from_slice(self.offset.as_bytes());
    }
}

/// Appends ` <sender> <message>` to `out` (which holds the time already): the message without its
/// trailing line end, at most `MAX_MESSAGE` bytes, escaped to one line. Returns whether it was cut
/// (here or by the framing, `cut`).
pub fn format_message(out: &mut Vec<u8>, sender: IpAddr, payload: &[u8], cut: bool) -> bool {
    out.push(b' ');
    match canonical(sender) {
        IpAddr::V4(ip) => out.extend_from_slice(ip.to_string().as_bytes()),
        IpAddr::V6(ip) => out.extend_from_slice(ip.to_string().as_bytes()),
    }
    out.push(b' ');
    let mut payload = payload;
    let mut truncated = cut;
    if payload.len() > MAX_MESSAGE {
        payload = &payload[..utf8_floor(payload, MAX_MESSAGE)];
        truncated = true;
    }
    while let Some((&last, rest)) = payload.split_last() {
        if matches!(last, b'\n' | b'\r' | 0) {
            payload = rest;
        } else {
            break;
        }
    }
    escape_into(out, payload);
    if truncated {
        out.extend_from_slice(TRUNCATED_MARK.as_bytes());
    }
    truncated
}

/// A cut that does not split a UTF-8 sequence (if the text is UTF-8 there).
fn utf8_floor(bytes: &[u8], max: usize) -> usize {
    let mut end = max.min(bytes.len());
    let mut back = 0;
    while end > 0 && back < 3 && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
        back += 1;
    }
    if back == 3 && (bytes[end] & 0xC0) == 0x80 {
        return max;
    }
    end
}

/// Escapes one message into one unambiguous line. Valid UTF-8 stays as it is, except:
///
/// - `\` → `\\`, line feed → `\n`, carriage return → `\r` (a tab stays),
/// - other C0 controls and DEL (ESC, NUL …) → `\xNN`, and every byte that is not UTF-8 → `\xNN`,
/// - C1 controls (U+0080–U+009F: CSI, OSC, NEL …), bidi marks and overrides (U+200E, U+200F,
///   U+202A–U+202E, U+2066–U+2069) and the line/paragraph separators U+2028, U+2029 → `\u{XXXX}`.
///
/// Nothing in a line can then move the cursor, reorder text or start a new line.
pub fn escape_into(out: &mut Vec<u8>, bytes: &[u8]) {
    escape_with(out, bytes, true);
}

/// `escape_into` for lines of a remote file (prompt 017): `\` and the FIX separator SOH stay as they
/// are, so a JSON line with `\"` stays JSON and FIX stays FIX; everything that could move the
/// cursor, reorder text or start a line is escaped as in `escape_into`.
pub fn escape_controls_into(out: &mut Vec<u8>, bytes: &[u8]) {
    escape_with(out, bytes, false);
}

/// `syslog`: `\` doubled and SOH escaped (unambiguous); for files both stay.
fn escape_with(out: &mut Vec<u8>, bytes: &[u8], syslog: bool) {
    for chunk in bytes.utf8_chunks() {
        let valid = chunk.valid().as_bytes();
        let mut start = 0;
        let mut i = 0;
        while i < valid.len() {
            let b = valid[i];
            // (bytes the escape replaces, what to write)
            let escape: Option<(usize, Escape)> = match b {
                b'\\' if syslog => Some((1, Escape::Text(b"\\\\"))),
                0x01 if !syslog => None,
                b'\n' => Some((1, Escape::Text(b"\\n"))),
                b'\r' => Some((1, Escape::Text(b"\\r"))),
                b'\t' => None,
                0..=0x1f | 0x7f => Some((1, Escape::Hex(b))),
                // C1: U+0080–U+009F are C2 80–C2 9F.
                0xC2 if (0x80..=0x9F).contains(&valid[i + 1]) => {
                    Some((2, Escape::Unicode(u32::from(valid[i + 1]))))
                }
                0xE2 => {
                    let (b1, b2) = (valid[i + 1], valid[i + 2]);
                    let cp = 0x2000 + ((u32::from(b1) & 0x3F) << 6) + (u32::from(b2) & 0x3F);
                    let special = b1 & 0xF0 == 0x80
                        && matches!(cp, 0x200E | 0x200F | 0x2028..=0x202E | 0x2066..=0x2069);
                    special.then_some((3, Escape::Unicode(cp)))
                }
                _ => None,
            };
            match escape {
                Some((len, escape)) => {
                    out.extend_from_slice(&valid[start..i]);
                    match escape {
                        Escape::Text(text) => out.extend_from_slice(text),
                        Escape::Hex(b) => hex_escape(out, b),
                        Escape::Unicode(cp) => {
                            out.extend_from_slice(format!("\\u{{{cp:04X}}}").as_bytes())
                        }
                    }
                    i += len;
                    start = i;
                }
                None => i += 1,
            }
        }
        out.extend_from_slice(&valid[start..]);
        for &b in chunk.invalid() {
            hex_escape(out, b);
        }
    }
}

enum Escape {
    Text(&'static [u8]),
    Hex(u8),
    Unicode(u32),
}

fn hex_escape(out: &mut Vec<u8>, b: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.extend_from_slice(&[b'\\', b'x', HEX[(b >> 4) as usize], HEX[(b & 15) as usize]]);
}

/// Parsed head of a syslog message, for tests and checks: the priority and which RFC it follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Rfc5424,
    Rfc3164,
    /// No `<PRI>` or not one of the two shapes; written as it came.
    Other,
}

/// The priority (0–191) and the shape of a message; never panics, whatever the bytes.
pub fn classify(payload: &[u8]) -> (Option<u8>, Flavor) {
    let Some(rest) = payload.strip_prefix(b"<") else {
        return (None, Flavor::Other);
    };
    let Some(end) = rest.iter().take(4).position(|b| *b == b'>') else {
        return (None, Flavor::Other);
    };
    let digits = &rest[..end];
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return (None, Flavor::Other);
    }
    let pri: u16 = std::str::from_utf8(digits)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(u16::MAX);
    if pri > 191 {
        return (None, Flavor::Other);
    }
    let body = &rest[end + 1..];
    let flavor = if body.starts_with(b"1 ") {
        Flavor::Rfc5424
    } else if body.len() >= 15
        && body[0].is_ascii_uppercase()
        && body[3] == b' '
        && body[6] == b' '
        && body[9] == b':'
    {
        Flavor::Rfc3164
    } else {
        Flavor::Other
    };
    (Some(pri as u8), flavor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(sender: &str, payload: &[u8]) -> (String, bool) {
        let mut out = Vec::new();
        let cut = format_message(&mut out, sender.parse().unwrap(), payload, false);
        (String::from_utf8(out).unwrap(), cut)
    }

    #[test]
    fn messages_become_one_line() {
        // (payload, expected after the sender, cut)
        let cases: &[(&[u8], &str)] = &[
            // RFC 3164
            (
                b"<34>Oct 11 22:14:15 mymachine su: 'su root' failed for lonvick on /dev/pts/8",
                "<34>Oct 11 22:14:15 mymachine su: 'su root' failed for lonvick on /dev/pts/8",
            ),
            // RFC 5424 with structured data and a BOM before the message
            (
                "<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 [exampleSDID@32473 iut=\"3\"] \u{feff}An application event".as_bytes(),
                "<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 [exampleSDID@32473 iut=\"3\"] \u{feff}An application event",
            ),
            // trailing line ends go, inner ones are escaped
            (b"<13>hello\n", "<13>hello"),
            (b"<13>a\r\nb\nc\r\n\0", "<13>a\\r\\nb\\nc"),
            // umlauts, emoji and tabs stay
            ("<14>Grüße 😀\tok".as_bytes(), "<14>Grüße 😀\tok"),
            // broken bytes, ESC (ANSI), NUL, DEL
            (b"<14>bad \xff\xfe end", "<14>bad \\xFF\\xFE end"),
            (b"<14>\x1b[31mred\x1b[0m", "<14>\\x1B[31mred\\x1B[0m"),
            (b"<14>a\0b\x7f", "<14>a\\x00b\\x7F"),
            // a cut UTF-8 sequence at the end
            (b"<14>half \xc3", "<14>half \\xC3"),
            // backslashes are doubled, so every escape is unambiguous
            (b"<14>C:\\temp\\new", "<14>C:\\\\temp\\\\new"),
            (b"<14>a\\nb", "<14>a\\\\nb"),
            // C1 controls (CSI, OSC, NEL), bidi marks and overrides, line and paragraph separators
            ("<14>a\u{9b}31m b\u{9d}0;x c\u{85}d".as_bytes(), "<14>a\\u{009B}31m b\\u{009D}0;x c\\u{0085}d"),
            ("<14>\u{80}\u{9f}\u{a0}".as_bytes(), "<14>\\u{0080}\\u{009F}\u{a0}"),
            ("<14>x\u{200e}\u{200f}\u{202a}\u{202e}\u{2066}\u{2069}y".as_bytes(), "<14>x\\u{200E}\\u{200F}\\u{202A}\\u{202E}\\u{2066}\\u{2069}y"),
            ("<14>l1\u{2028}l2\u{2029}p".as_bytes(), "<14>l1\\u{2028}l2\\u{2029}p"),
            // neighbours stay: zero-width joiner, en dash, euro, U+206A
            ("<14>\u{200d}\u{2013}\u{20ac}\u{206a}".as_bytes(), "<14>\u{200d}\u{2013}\u{20ac}\u{206a}"),
            // no priority at all
            (b"just text", "just text"),
            (b"", ""),
        ];
        for (payload, expected) in cases {
            let (text, cut) = line("127.0.0.1", payload);
            assert_eq!(text, format!(" 127.0.0.1 {expected}"), "{payload:?}");
            assert!(!text.contains('\n'));
            assert!(!cut);
        }
    }

    #[test]
    fn long_messages_are_cut_and_marked() {
        let payload = vec![b'a'; MAX_MESSAGE + 10];
        let (text, cut) = line("10.0.0.1", &payload);
        assert!(cut);
        assert!(text.ends_with(TRUNCATED_MARK));
        assert_eq!(
            text.len(),
            " 10.0.0.1 ".len() + MAX_MESSAGE + TRUNCATED_MARK.len()
        );
        // Not inside a character.
        let mut payload = vec![b'a'; MAX_MESSAGE - 1];
        payload.extend_from_slice("ü".as_bytes());
        payload.extend_from_slice(b"rest");
        let (text, cut) = line("10.0.0.1", &payload);
        assert!(cut);
        assert!(!text.contains("\\x"), "{}", &text[text.len() - 20..]);
        // Exactly at the limit: whole.
        let (_, cut) = line("10.0.0.1", &vec![b'b'; MAX_MESSAGE]);
        assert!(!cut);
    }

    #[test]
    fn senders_are_written_canonically() {
        let (text, _) = line("::ffff:192.168.1.7", b"x");
        assert_eq!(text, " 192.168.1.7 x");
        let (text, _) = line("::1", b"x");
        assert_eq!(text, " ::1 x");
    }

    #[test]
    fn the_clock_writes_iso_8601_with_millis_and_zone() {
        let mut clock = ReceiveClock::default();
        let mut out = Vec::new();
        clock.stamp_at(1_762_510_530, 7, &mut out);
        let text = String::from_utf8(out).unwrap();
        let parsed = chrono::DateTime::parse_from_rfc3339(&text).unwrap();
        assert_eq!(parsed.timestamp(), 1_762_510_530);
        assert_eq!(parsed.timestamp_subsec_millis(), 7);
        assert_eq!(text.len(), "2025-11-07T10:15:30.007+01:00".len());
        // Same second: cached head, new millis.
        let mut out = Vec::new();
        clock.stamp_at(1_762_510_530, 999, &mut out);
        assert!(String::from_utf8(out).unwrap().contains(".999"));
    }

    fn frames(chunks: &[&[u8]]) -> Vec<(String, bool)> {
        let mut framer = TcpFramer::default();
        let mut out = Vec::new();
        for chunk in chunks {
            framer.push(chunk, &mut |m, cut| {
                out.push((String::from_utf8_lossy(m).into_owned(), cut));
            });
        }
        framer.finish(&mut |m, cut| out.push((String::from_utf8_lossy(m).into_owned(), cut)));
        out
    }

    fn whole(texts: &[&str]) -> Vec<(String, bool)> {
        texts.iter().map(|t| ((*t).to_string(), false)).collect()
    }

    #[test]
    fn tcp_framing_table() {
        // octet counting, two frames in one read
        assert_eq!(frames(&[b"5 <1>ab3 <2>"]), whole(&["<1>ab", "<2>"]));
        // octet counting keeps newlines inside the message
        assert_eq!(frames(&[b"7 <1>a\nb\n"]), whole(&["<1>a\nb\n"]));
        // split anywhere, also inside the count
        assert_eq!(
            frames(&[b"1", b"0 <1>012", b"3456"]),
            whole(&["<1>0123456"])
        );
        // newline framing, CRLF, empty lines between
        assert_eq!(
            frames(&[b"<1>a\r\n\n<2>b\n<3>c"]),
            whole(&["<1>a", "<2>b", "<3>c"])
        );
        // a line starting with digits but no count
        assert_eq!(frames(&[b"12:00 hello\n"]), whole(&["12:00 hello"]));
        assert_eq!(frames(&[b"1234567890123 x\n"]), whole(&["1234567890123 x"]));
        // a zero count is an empty frame
        assert_eq!(frames(&[b"0 <1>a\n"]), whole(&["<1>a"]));
        // NUL trailers (some senders) separate too
        assert_eq!(frames(&[b"<1>a\n\0\0<2>b\n"]), whole(&["<1>a", "<2>b"]));
        // the connection ends inside a counted frame: cut
        assert_eq!(frames(&[b"10 <1>ab"]), vec![("<1>ab".to_string(), true)]);
    }

    #[test]
    fn tcp_frames_over_the_limit_are_cut_and_the_stream_stays_in_step() {
        let mut big = format!("{} ", MAX_MESSAGE + 100).into_bytes();
        big.extend(std::iter::repeat_n(b'x', MAX_MESSAGE + 100));
        big.extend_from_slice(b"3 <1>");
        let out = frames(&[&big]);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].0.len(), out[0].1), (MAX_MESSAGE, true));
        assert_eq!(out[1], ("<1>".to_string(), false));

        let mut line = vec![b'y'; MAX_MESSAGE * 3];
        line.extend_from_slice(b"\n<2>next\n");
        let out = frames(&[&line[..1000], &line[1000..]]);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].0.len(), out[0].1), (MAX_MESSAGE, true));
        assert_eq!(out[1], ("<2>next".to_string(), false));
    }

    /// A small deterministic generator (xorshift), so the garbage is the same on every run.
    fn garbage(seed: u64, len: usize) -> Vec<u8> {
        let mut state = seed.max(1);
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                // Bias towards the bytes the parsers care about.
                match state % 8 {
                    0 => b"0123456789"[(state >> 8) as usize % 10],
                    1 => b"<> \n\r\0"[(state >> 8) as usize % 6],
                    _ => (state >> 16) as u8,
                }
            })
            .collect()
    }

    #[test]
    fn garbage_never_panics_and_stays_one_line() {
        for seed in 1..2000u64 {
            let data = garbage(seed, (seed as usize * 37) % 3000);
            let (text, _) = line("192.0.2.1", &data);
            assert!(!text.contains('\n') && !text.contains('\r'));
            assert!(text.len() <= 10 + MAX_MESSAGE * 4 + TRUNCATED_MARK.len() + 20);
            let _ = classify(&data);
            let mut framer = TcpFramer::default();
            let mut total = 0usize;
            for chunk in data.chunks((seed as usize % 7) + 1) {
                framer.push(chunk, &mut |m, _| {
                    assert!(m.len() <= MAX_MESSAGE);
                    total += m.len();
                });
            }
            framer.finish(&mut |m, _| {
                assert!(m.len() <= MAX_MESSAGE);
                total += m.len();
            });
            assert!(total <= data.len());
        }
    }

    #[test]
    fn classify_table() {
        let cases: &[(&[u8], Option<u8>, Flavor)] = &[
            (b"<34>Oct 11 22:14:15 host su: x", Some(34), Flavor::Rfc3164),
            (
                b"<165>1 2003-10-11T22:14:15.003Z h a - - - x",
                Some(165),
                Flavor::Rfc5424,
            ),
            (b"<0>x", Some(0), Flavor::Other),
            (b"<191>x", Some(191), Flavor::Other),
            (b"<192>x", None, Flavor::Other),
            (b"<>x", None, Flavor::Other),
            (b"<1a>x", None, Flavor::Other),
            (b"<99999>x", None, Flavor::Other),
            (b"<", None, Flavor::Other),
            (b"", None, Flavor::Other),
            (b"no pri", None, Flavor::Other),
        ];
        for (payload, pri, flavor) in cases {
            assert_eq!(classify(payload), (*pri, *flavor), "{payload:?}");
        }
    }

    #[test]
    fn sender_filter() {
        let allow = Allow::parse(&[
            "10.0.0.0/8".into(),
            "192.168.1.5".into(),
            "fd00::/8".into(),
            " ".into(),
        ])
        .unwrap();
        assert!(allow.permits("10.1.2.3".parse().unwrap()));
        assert!(allow.permits("::ffff:10.1.2.3".parse().unwrap()));
        assert!(allow.permits("192.168.1.5".parse().unwrap()));
        assert!(!allow.permits("192.168.1.6".parse().unwrap()));
        assert!(allow.permits("fd12::1".parse().unwrap()));
        assert!(!allow.permits("fe80::1".parse().unwrap()));
        assert!(!allow.permits("127.0.0.1".parse().unwrap()));
        assert!(Allow::default().permits("8.8.8.8".parse().unwrap()));
        assert!(Allow::parse(&["0.0.0.0/0".into()])
            .unwrap()
            .permits("8.8.8.8".parse().unwrap()));
        for bad in [
            "host.example",
            "10.0.0.0/33",
            "10.0.0.0/",
            "10.0.0.0/-1",
            "::/129",
            "1.2.3",
        ] {
            let err = Allow::parse(&[bad.into()]).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidSource, "{bad}");
        }
        let many: Vec<String> = (0..=MAX_ALLOW).map(|i| format!("10.0.0.{i}")).collect();
        assert!(Allow::parse(&many).is_err());
    }

    #[test]
    fn only_loopback_without_the_explicit_choice() {
        let mut config = SyslogConfig::default();
        assert_eq!(
            listen_address(&config).unwrap(),
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        );
        config.address = "[::1]".into();
        assert!(listen_address(&config).unwrap().is_loopback());
        for remote in ["0.0.0.0", "::", "192.168.1.10"] {
            config.address = remote.into();
            config.allow_remote = false;
            assert_eq!(
                listen_address(&config).unwrap_err().code,
                ErrorCode::InvalidSource,
                "{remote}"
            );
            config.allow_remote = true;
            assert!(listen_address(&config).is_ok());
        }
        config.address = "localhost".into();
        assert_eq!(
            listen_address(&config).unwrap_err().code,
            ErrorCode::InvalidSource
        );
    }

    #[test]
    fn the_default_binds_loopback_only() {
        let source = SyslogSource::bind(SyslogConfig {
            port: 0,
            protocol: Protocol::Both,
            ..SyslogConfig::default()
        })
        .unwrap();
        let udp = source.udp.as_ref().unwrap().local_addr().unwrap();
        let tcp = source.tcp.as_ref().unwrap().local_addr().unwrap();
        assert!(udp.ip().is_loopback() && tcp.ip().is_loopback());
        assert_eq!(udp.port(), tcp.port());
        assert_eq!(source.label(), format!("Syslog UDP+TCP :{}", udp.port()));
        assert_eq!(source.config()["port"], udp.port());
        assert_eq!(source.config()["kind"], "syslog");
    }

    #[test]
    fn a_port_in_use_is_an_error_with_the_port() {
        let taken = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let err = SyslogSource::bind(SyslogConfig {
            port,
            ..SyslogConfig::default()
        })
        .err()
        .unwrap();
        assert_eq!(err.code, ErrorCode::PortInUse);
        assert!(err.message.contains(&port.to_string()));
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let err = SyslogSource::bind(SyslogConfig {
            port,
            protocol: Protocol::Tcp,
            ..SyslogConfig::default()
        })
        .err()
        .unwrap();
        assert_eq!(err.code, ErrorCode::PortInUse);
    }
}

#[cfg(test)]
mod slot_tests {
    use super::*;
    use crate::spool::SpoolStats;

    #[test]
    fn a_panicking_connection_thread_frees_its_slot() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (stream, from) = listener.accept().unwrap();
        let connections = Arc::new(Connections::default());
        let monitor = Arc::new(SourceMonitor::new(Arc::new(SpoolStats::default())));
        let slot = connections
            .admit(&stream, from.ip(), &TcpLimits::default())
            .unwrap();
        monitor.connections.store(1, Ordering::SeqCst);
        let (c, m, id) = (Arc::clone(&connections), Arc::clone(&monitor), slot.id);
        let joined = std::thread::spawn(move || {
            let _guard = SlotGuard {
                connections: &c,
                monitor: &m,
                id,
            };
            panic!("a bug while reading");
        })
        .join();
        assert!(joined.is_err());
        assert_eq!(connections.len(), 0);
        assert_eq!(monitor.connections.load(Ordering::SeqCst), 0);
    }
}
