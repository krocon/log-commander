//! A log file on a server over SSH/SFTP (prompt 017), followed by polling into the spool of 016.
//!
//! Each round (`pollMs`, 500 ms by default): `fstat` of the open handle and `stat` of the path
//! ([`Watch`] tells growth, truncation and rotation apart), then new bytes from the offset (at most
//! `MAX_READ` per round). Truncation and rotation become a new spool file, so the session sees a
//! rotation and `tail.rs` needs nothing new. After a rotation the old file is read to its end
//! through the handle first. A broken connection is retried after 1, 2, 4 … 60 s and continues at
//! the offset; a smaller file then counts as truncated.
//!
//! The remote content is foreign data: lines are split like a local file (`LineSplitter`: LF, CRLF,
//! UTF-16), decoded, ANSI colours removed and every control character escaped (`escape_controls_into`),
//! longer lines than `MAX_LINE` are cut and marked.

use super::syslog::{escape_controls_into, TRUNCATED_MARK};
use super::{Source, SourceContext};
use crate::encoding::{strip_ansi, Encoding};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::indexer::LineSplitter;
use crate::model::{SourceKind, SourceState};
use crate::remote::watch::{Change, Watch};
use crate::remote::{AuthKind, Conn, Credentials, Hub, Lease, RemoteFile, Target, MAX_REMOTE_PATH};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const DEFAULT_POLL_MS: u32 = 500;
pub const MIN_POLL_MS: u32 = 200;
pub const MAX_POLL_MS: u32 = 60_000;
/// The first fetch takes the last 50 MB by default (prompt 017).
pub const DEFAULT_START_MB: u32 = 50;
pub const MAX_START_MB: u32 = 10_000;
/// Bytes read per round, so that stopping and status never wait long.
const MAX_READ: usize = 8 * 1024 * 1024;
/// A spool line from a remote file; longer ones are cut and marked.
pub const MAX_LINE: usize = 1024 * 1024;
/// An incomplete last line is written after this long without growth.
const PARTIAL_AFTER: Duration = Duration::from_secs(2);
/// Waits between reconnect attempts: 1, 2, 4 … at most 60 s.
const MAX_BACKOFF_S: u32 = 60;
/// Bytes of the file's start used to tell its encoding.
const SNIFF: usize = 64 * 1024;

fn default_start() -> Option<u32> {
    Some(DEFAULT_START_MB)
}

fn default_poll() -> u32 {
    DEFAULT_POLL_MS
}

/// What the dialog configures (and settings or a workspace keep): never a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpConfig {
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    pub auth: AuthKind,
    #[serde(default)]
    pub key_file: Option<String>,
    /// Absolute path on the server.
    pub path: String,
    /// The first fetch takes at most the last `start_mb` MB; None: the whole file.
    #[serde(default = "default_start")]
    pub start_mb: Option<u32>,
    #[serde(default = "default_poll")]
    pub poll_ms: u32,
}

impl SftpConfig {
    pub fn target(&self) -> Target {
        Target {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            auth: self.auth,
            key_file: self.key_file.clone(),
        }
    }

    pub fn validate(&self) -> AppResult<()> {
        self.target().validate()?;
        let path = &self.path;
        if !path.starts_with('/')
            || path.len() > MAX_REMOTE_PATH
            || path.chars().any(|c| c.is_control())
            || path.ends_with('/')
        {
            return Err(AppError::new(
                ErrorCode::InvalidSource,
                "the remote path must be an absolute file path",
            ));
        }
        if !(MIN_POLL_MS..=MAX_POLL_MS).contains(&self.poll_ms) {
            return Err(AppError::new(
                ErrorCode::InvalidSource,
                format!("poll interval {MIN_POLL_MS}–{MAX_POLL_MS} ms"),
            ));
        }
        if self.start_mb.is_some_and(|mb| mb == 0 || mb > MAX_START_MB) {
            return Err(AppError::new(
                ErrorCode::InvalidSource,
                format!("start 1–{MAX_START_MB} MB or the whole file"),
            ));
        }
        Ok(())
    }

    /// `host:/var/log/app.log`
    pub fn label(&self) -> String {
        format!("{}:{}", self.host.trim(), self.path)
    }
}

/// Where the first fetch begins: `(offset, skip_first_line)`. Past the start of the file the first
/// (partial) line is skipped; reading starts one code unit early so that a line beginning exactly
/// at the limit is kept (its predecessor's line end is the skipped "line").
pub fn start_offset(size: u64, start_mb: Option<u32>, unit: u64, bom: u64) -> (u64, bool) {
    let Some(mb) = start_mb else {
        return (bom, false);
    };
    let limit = u64::from(mb) * 1024 * 1024;
    if size <= limit + bom {
        return (bom, false);
    }
    let start = size - limit;
    let start = start - start % unit;
    (start.saturating_sub(unit).max(bom), true)
}

/// One raw line of the remote file as a spool line; true if it was cut.
pub fn spool_line(raw: &[u8], encoding: Encoding, out: &mut Vec<u8>) -> bool {
    out.clear();
    let text = encoding.decode(raw);
    let text = strip_ansi(&text);
    escape_controls_into(out, text.as_bytes());
    if out.len() <= MAX_LINE {
        return false;
    }
    let mut end = MAX_LINE;
    while end > 0 && (out[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    out.truncate(end);
    out.extend_from_slice(TRUNCATED_MARK.as_bytes());
    true
}

/// The source: prepared (connected, file open, start found), then run on its own thread.
pub struct SftpSource {
    config: SftpConfig,
    lease: Lease,
    conn: Arc<Conn>,
    file: RemoteFile,
    offset: u64,
    skip_first: bool,
    encoding: Encoding,
    size: u64,
}

fn not_a_file(config: &SftpConfig, code: ErrorCode, what: &str) -> AppError {
    let mut e = AppError::new(code, format!("{}: {what}", config.label()));
    e.path = Some(config.label());
    e
}

impl SftpSource {
    /// Connects (or shares the connection), checks the path and finds where to start.
    pub fn connect(config: SftpConfig, hub: &Hub, creds: &Credentials) -> AppResult<Self> {
        config.validate()?;
        let lease = hub.lease(&config.target(), creds)?;
        let conn = lease.get()?;
        let stat = conn.stat(&config.path)?.ok_or_else(|| {
            not_a_file(&config, ErrorCode::NotFound, "no such file on the server")
        })?;
        if stat.is_dir {
            return Err(not_a_file(&config, ErrorCode::IsADirectory, "is a folder"));
        }
        if !stat.is_file {
            return Err(not_a_file(
                &config,
                ErrorCode::InvalidSource,
                "not a regular file",
            ));
        }
        let mut file = conn.open(&config.path)?;
        let head = file.read_at(0, SNIFF)?;
        let (encoding, bom) = Encoding::detect(&head);
        let size = file.fstat()?.size;
        let (offset, skip_first) = start_offset(
            size,
            config.start_mb,
            encoding.code_unit() as u64,
            bom as u64,
        );
        Ok(Self {
            config,
            lease,
            conn,
            file,
            offset,
            skip_first,
            encoding,
            size,
        })
    }

    /// The connection this source uses (tests: shared with the other files of the server).
    pub fn lease(&self) -> &Lease {
        &self.lease
    }
}

impl Source for SftpSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Sftp
    }

    fn label(&self) -> String {
        self.config.label()
    }

    fn config(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(&self.config).unwrap_or_default();
        if let Some(o) = v.as_object_mut() {
            o.insert("kind".into(), "sftp".into());
        }
        v
    }

    fn run(self: Box<Self>, ctx: SourceContext) {
        let s = *self;
        let monitor = Arc::clone(&ctx.monitor);
        monitor
            .pending_bytes
            .store(s.size.saturating_sub(s.offset), Ordering::Relaxed);
        monitor.set_state(SourceState::Connected);
        let mut follow = Follow {
            splitter: LineSplitter::new(s.encoding, s.offset),
            config: s.config,
            lease: s.lease,
            conn: Some(s.conn),
            file: Some(s.file),
            offset: s.offset,
            skip_first: s.skip_first,
            encoding: s.encoding,
            watch: Watch::default(),
            last_growth: Instant::now(),
            line: Vec::new(),
            ctx,
        };
        follow.run();
    }
}

/// Error codes after which reconnecting is pointless (or dangerous: locked accounts).
fn permanent(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::HostKeyChanged
            | ErrorCode::HostKeyUnknown
            | ErrorCode::AuthFailed
            | ErrorCode::SecretRequired
            | ErrorCode::Unsupported
    )
}

struct Follow {
    config: SftpConfig,
    lease: Lease,
    conn: Option<Arc<Conn>>,
    file: Option<RemoteFile>,
    offset: u64,
    skip_first: bool,
    encoding: Encoding,
    splitter: LineSplitter,
    watch: Watch,
    last_growth: Instant,
    line: Vec<u8>,
    ctx: SourceContext,
}

enum Round {
    /// More to read right away.
    Busy,
    Idle,
}

impl Follow {
    fn run(&mut self) {
        let mut attempt: u32 = 0;
        while !self.ctx.stop.is_stopped() {
            match self.round() {
                Ok(round) => {
                    if attempt > 0 {
                        attempt = 0;
                        self.ctx.monitor.set_state(SourceState::Connected);
                    }
                    self.ctx.monitor.flush();
                    if matches!(round, Round::Idle) {
                        self.sleep(Duration::from_millis(u64::from(self.config.poll_ms)));
                    }
                }
                Err(e) if permanent(e.code) => {
                    self.ctx
                        .monitor
                        .set_state(SourceState::Error { message: e.message });
                    // Nothing more to do; the lines stay. Waits for the tab to close.
                    while !self.ctx.stop.is_stopped() {
                        self.sleep(Duration::from_millis(200));
                    }
                }
                Err(e) => {
                    if let Some(conn) = self.conn.take() {
                        if e.code == ErrorCode::ConnectionFailed {
                            self.lease.invalidate(&conn);
                        }
                    }
                    self.file = None;
                    let wait = (1u32 << attempt.min(6)).min(MAX_BACKOFF_S);
                    attempt += 1;
                    for left in (1..=wait).rev() {
                        if self.ctx.stop.is_stopped() {
                            break;
                        }
                        self.ctx.monitor.set_state(SourceState::Reconnecting {
                            message: e.message.clone(),
                            retry_in_s: left,
                        });
                        self.sleep(Duration::from_secs(1));
                    }
                }
            }
        }
        // Whatever is left of an incomplete line.
        self.flush_partial();
    }

    fn sleep(&self, total: Duration) {
        let start = Instant::now();
        while !self.ctx.stop.is_stopped() && start.elapsed() < total {
            std::thread::sleep((total - start.elapsed()).min(Duration::from_millis(50)));
        }
    }

    /// The connection and the open file, connecting and opening again after an error.
    fn ensure(&mut self) -> AppResult<()> {
        if self.conn.as_ref().is_some_and(|c| c.is_closed()) {
            self.conn = None;
            self.file = None;
        }
        if self.conn.is_none() {
            self.conn = Some(self.lease.get()?);
            self.file = None;
        }
        if self.file.is_none() {
            let conn = self.conn.as_ref().expect("connected");
            match conn.stat(&self.config.path)? {
                Some(stat) if stat.is_file => {
                    let mut file = conn.open(&self.config.path)?;
                    let size = file.fstat()?.size;
                    self.file = Some(file);
                    self.watch = Watch::default();
                    if size < self.offset {
                        // Shorter than what was read: truncated (or another file) meanwhile.
                        self.restart()?;
                    }
                }
                _ => {
                    return Err(AppError::new(
                        ErrorCode::NotFound,
                        format!("{}: no such file on the server", self.config.label()),
                    ))
                }
            }
        }
        Ok(())
    }

    /// The file starts over (truncated or a new one): what is left of a line, a new spool file.
    fn restart(&mut self) -> AppResult<()> {
        self.flush_partial();
        if !self.ctx.writer.rotate_blocking(&self.ctx.stop) {
            return Ok(());
        }
        self.offset = 0;
        self.skip_first = false;
        self.splitter = LineSplitter::new(self.encoding, 0);
        Ok(())
    }

    fn round(&mut self) -> AppResult<Round> {
        self.ensure()?;
        let conn = Arc::clone(self.conn.as_ref().expect("connected"));
        let file = self.file.as_mut().expect("open");
        let started = Instant::now();
        let handle = file.fstat()?;
        let rtt = started.elapsed().as_millis().min(u128::from(u32::MAX - 1)) as u32;
        self.ctx.monitor.latency_ms.store(rtt, Ordering::Relaxed);
        let path = conn.stat(&self.config.path)?;
        let again = if Watch::needs_again(&handle, path.as_ref()) {
            Some(file.fstat()?)
        } else {
            None
        };
        let change = self.watch.step(self.offset, handle, path, again);
        match change {
            Change::Grown { size } => self.read_to(size),
            Change::Rotated { size } if size > self.offset => self.read_to(size),
            Change::Rotated { .. } => {
                // The old file is read to its end: on to the new one.
                self.file = None;
                self.restart()?;
                Ok(Round::Busy)
            }
            Change::Truncated => {
                self.restart()?;
                Ok(Round::Busy)
            }
            Change::Unchanged | Change::Gone => {
                self.ctx.monitor.pending_bytes.store(0, Ordering::Relaxed);
                if self.splitter.has_partial() && self.last_growth.elapsed() >= PARTIAL_AFTER {
                    self.flush_partial();
                }
                Ok(Round::Idle)
            }
        }
    }

    /// Reads up to `MAX_READ` towards `size` and writes the complete lines.
    fn read_to(&mut self, size: u64) -> AppResult<Round> {
        let want = (size - self.offset).min(MAX_READ as u64) as usize;
        let file = self.file.as_mut().expect("open");
        let block = file.read_at(self.offset, want)?;
        if block.is_empty() {
            return Ok(Round::Idle);
        }
        self.offset += block.len() as u64;
        self.last_growth = Instant::now();
        let monitor = Arc::clone(&self.ctx.monitor);
        monitor
            .bytes
            .fetch_add(block.len() as u64, Ordering::Relaxed);
        monitor
            .pending_bytes
            .store(size.saturating_sub(self.offset), Ordering::Relaxed);
        let mut lines: Vec<Vec<u8>> = Vec::new();
        self.splitter
            .feed(&block, |_, raw| lines.push(raw.to_vec()));
        for raw in lines {
            if !self.emit(&raw) {
                break;
            }
        }
        Ok(if size > self.offset {
            Round::Busy
        } else {
            Round::Idle
        })
    }

    fn flush_partial(&mut self) {
        if let Some((_, raw)) = self.splitter.take_partial() {
            self.emit(&raw);
        }
    }

    /// One line into the spool; false when stopped.
    fn emit(&mut self, raw: &[u8]) -> bool {
        if std::mem::take(&mut self.skip_first) {
            return true;
        }
        let mut line = std::mem::take(&mut self.line);
        let cut = spool_line(raw, self.encoding, &mut line);
        let monitor = &self.ctx.monitor;
        monitor.received.fetch_add(1, Ordering::Relaxed);
        if cut {
            monitor.truncated.fetch_add(1, Ordering::Relaxed);
        }
        let ok = self.ctx.writer.line_blocking(line.clone(), &self.ctx.stop);
        monitor.counted();
        self.line = line;
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SftpConfig {
        SftpConfig {
            host: "logs.example.com".into(),
            port: 22,
            user: "ops".into(),
            auth: AuthKind::Agent,
            key_file: None,
            path: "/var/log/app.log".into(),
            start_mb: Some(50),
            poll_ms: 500,
        }
    }

    #[test]
    fn configs_are_checked() {
        assert!(config().validate().is_ok());
        assert_eq!(config().label(), "logs.example.com:/var/log/app.log");
        let bad = |f: fn(&mut SftpConfig)| {
            let mut c = config();
            f(&mut c);
            c.validate().is_err()
        };
        assert!(bad(|c| c.path = "var/log".into()));
        assert!(bad(|c| c.path = "/var/log/".into()));
        assert!(bad(|c| c.path = "/a\nb".into()));
        assert!(bad(|c| c.host = String::new()));
        assert!(bad(|c| c.host = "-oProxyCommand=x".into()));
        assert!(bad(|c| c.host = "a b".into()));
        assert!(bad(|c| c.user = "a@b".into()));
        assert!(bad(|c| c.poll_ms = 50));
        assert!(bad(|c| c.start_mb = Some(0)));
        assert!(bad(|c| c.key_file = Some("relative/key".into())));
        // Defaults for what a stored configuration may leave out.
        let parsed: SftpConfig =
            serde_json::from_str(r#"{"host":"h","auth":"password","path":"/x"}"#).unwrap();
        assert_eq!(parsed.start_mb, Some(DEFAULT_START_MB));
        assert_eq!(parsed.poll_ms, DEFAULT_POLL_MS);
        assert_eq!(parsed.port, 0);
        let whole: SftpConfig =
            serde_json::from_str(r#"{"host":"h","auth":"key","path":"/x","startMb":null}"#)
                .unwrap();
        assert_eq!(whole.start_mb, None);
        // No field for a secret: an unknown one is ignored, never stored back.
        let v = serde_json::to_value(config()).unwrap();
        assert!(v.get("password").is_none() && v.get("secret").is_none());
    }

    #[test]
    fn the_start_is_the_last_megabytes_from_a_line_start() {
        let mb = 1024 * 1024;
        assert_eq!(start_offset(100, Some(50), 1, 0), (0, false));
        assert_eq!(start_offset(100, None, 1, 3), (3, false));
        assert_eq!(start_offset(80 * mb, Some(50), 1, 0), (30 * mb - 1, true));
        assert_eq!(
            start_offset(80 * mb + 1, Some(50), 2, 2),
            (30 * mb - 2, true)
        );
        assert_eq!(start_offset(80 * mb, None, 1, 0), (0, false));
    }

    #[test]
    fn remote_lines_are_escaped_but_keep_their_text() {
        let mut out = Vec::new();
        let line = |raw: &[u8], enc: Encoding, out: &mut Vec<u8>| {
            spool_line(raw, enc, out);
            String::from_utf8(out.clone()).unwrap()
        };
        assert_eq!(
            line(
                "2026-01-15 ERROR Größe 😀\t{\"a\":\"b\\\"c\"}".as_bytes(),
                Encoding::Utf8,
                &mut out
            ),
            "2026-01-15 ERROR Größe 😀\t{\"a\":\"b\\\"c\"}"
        );
        // ANSI colours removed like the local display does, other escapes made visible.
        assert_eq!(
            line(
                b"\x1b[31mERROR\x1b[0m x\x1b]0;title\x07",
                Encoding::Utf8,
                &mut out
            ),
            "ERROR x]0;title\\x07"
        );
        assert_eq!(
            line(
                "a\u{202E}b\u{2028}c\rd\x01e".as_bytes(),
                Encoding::Utf8,
                &mut out
            ),
            "a\\u{202E}b\\u{2028}c\\rd\x01e"
        );
        assert_eq!(line(b"caf\xe9", Encoding::Latin1, &mut out), "café");
        let utf16: Vec<u8> = "Ä ok"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(line(&utf16, Encoding::Utf16Le, &mut out), "Ä ok");
        let long = "é".repeat(MAX_LINE);
        assert!(spool_line(long.as_bytes(), Encoding::Utf8, &mut out));
        let text = String::from_utf8(out.clone()).unwrap();
        assert!(text.ends_with(TRUNCATED_MARK));
        assert!(out.len() <= MAX_LINE + TRUNCATED_MARK.len());
    }
}
