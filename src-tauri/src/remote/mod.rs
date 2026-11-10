//! SSH/SFTP connections for remote logs (prompt 017), with `russh` + `russh-sftp` (pure Rust, spike in
//! `prompts/done/017-remote-sftp.design.md`). Free of Tauri like everything but `commands.rs`/`lib.rs`.
//!
//! - [`Hub`]: the known_hosts files, `~/.ssh/config`, the keychain and the pool of connections.
//!   Files of the same server share one connection ([`Shared`]); the dialog's folder browser too.
//! - Only the `sftp` subsystem is ever requested: no shell, no exec, no PTY, no forwarding.
//! - Host keys: [`trust`]. An unknown key is accepted only with the fingerprint the user confirmed for
//!   exactly this key; a changed key is refused without a way around it.
//! - Secrets ([`secrets::Secret`]) come from the dialog or from the keychain, are kept in memory while
//!   the connection lives (for reconnecting) and go into the keychain only on request and only after
//!   the login worked. They never appear in errors, states or updates.
//!
//! All async code runs on a small runtime of its own ([`runtime`]); each call waits at most
//! [`CALL_TIMEOUT`]. Callers are plain threads (the source) or `spawn_blocking` (commands).

pub mod secrets;
pub mod ssh_config;
#[cfg(debug_assertions)]
pub mod testserver;
pub mod trust;
pub mod watch;

use crate::error::{AppError, AppResult, ErrorCode, RemoteDetail};
use parking_lot::Mutex;
use russh::keys::PublicKey;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::StatusCode;
use secrets::{account, Secret, SecretKind, SecretStore};
use serde::{Deserialize, Serialize};
use ssh_config::{Environment, HostConfig, SshConfig};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use trust::{fingerprint, HostKeyCheck, KnownHosts};

/// Longest wait for one network call (connect, stat, read of a chunk).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// A connection nobody uses any more is closed after this.
pub const IDLE_CLOSE: Duration = Duration::from_secs(60);
/// Entries of a folder listing shown in the dialog.
pub const MAX_LIST_ENTRIES: usize = 10_000;
/// Symbolic links of a listing resolved to their kind and size; the rest show as unknown.
pub const MAX_LINK_STATS: usize = 200;
/// One deadline for a whole folder listing.
pub const LIST_DEADLINE: Duration = Duration::from_secs(20);
/// Agent identities offered to a server at most (servers drop clients after a few failures).
pub const MAX_AGENT_TRIES: usize = 6;
const MAX_HOST: usize = 255;
const MAX_USER: usize = 64;
pub const MAX_REMOTE_PATH: usize = 4096;

/// The runtime all SSH connections run on (2 workers, never Tauri's).
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("lc-remote")
            .enable_all()
            .build()
            .expect("tokio runtime for SSH connections")
    })
}

/// Runs `f` on the SSH runtime for at most `timeout`.
fn block<T>(timeout: Duration, what: &str, f: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    runtime().block_on(async move {
        match tokio::time::timeout(timeout, f).await {
            Ok(r) => r,
            Err(_) => Err(AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{what}: no answer within {} s", timeout.as_secs()),
            )),
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    /// SSH agent (`SSH_AUTH_SOCK`; Windows: OpenSSH agent pipe, then Pageant).
    Agent,
    /// A key file, with a passphrase if it is encrypted.
    Key,
    Password,
}

/// Where to connect and how (part of the source's configuration; never a secret).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// A host name, an address or an alias of `~/.ssh/config`.
    pub host: String,
    /// 0: from `~/.ssh/config`, else 22.
    #[serde(default)]
    pub port: u16,
    /// Empty: from `~/.ssh/config`, else the local user.
    #[serde(default)]
    pub user: String,
    pub auth: AuthKind,
    /// The key file (auth `key`); none: `IdentityFile` of the config, else `~/.ssh/id_ed25519` …
    #[serde(default)]
    pub key_file: Option<String>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidSource, message)
}

fn plain_text(text: &str) -> bool {
    !text.chars().any(|c| c.is_control())
}

impl Target {
    /// Checks the fields (they may come from a workspace someone else wrote).
    pub fn validate(&self) -> AppResult<()> {
        let host = self.host.trim();
        if host.is_empty() || host.len() > MAX_HOST || !plain_text(host) {
            return Err(invalid("a host name is needed"));
        }
        if host.starts_with('-') || host.contains(char::is_whitespace) || host.contains(['/', '@'])
        {
            return Err(invalid(format!("not a host name: {host}")));
        }
        let user = self.user.trim();
        if user.len() > MAX_USER || !plain_text(user) || user.contains(['@', ':', ' ']) {
            return Err(invalid("not a user name"));
        }
        if let Some(file) = &self.key_file {
            if file.len() > MAX_REMOTE_PATH
                || !plain_text(file)
                || (!file.trim().is_empty() && !std::path::Path::new(file.trim()).is_absolute())
            {
                return Err(invalid("the key file needs an absolute path"));
            }
        }
        Ok(())
    }
}

/// A target with `~/.ssh/config` applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// As typed (tab label).
    pub alias: String,
    /// `HostName` of the config, else the alias: what is connected to and checked in known_hosts.
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthKind,
    pub key_files: Vec<PathBuf>,
}

impl Resolved {
    /// `user@host:port`: the pool key and the keychain subject of the password.
    pub fn key(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
}

/// What the dialog sends with a connect; never stored as such.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    /// Password (auth `password`) or passphrase of the key file (auth `key`).
    #[serde(default)]
    pub secret: Option<Secret>,
    /// Put the secret into the keychain once the login worked.
    #[serde(default)]
    pub remember: bool,
    /// The fingerprint the user confirmed for an unknown host key (`SHA256:…`).
    #[serde(default)]
    pub trust_fingerprint: Option<String>,
}

/// The attributes of a remote file that matter here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RemoteStat {
    pub size: u64,
    /// Seconds (SFTP v3).
    pub mtime: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub permissions: Option<u32>,
    pub is_dir: bool,
    pub is_file: bool,
}

impl RemoteStat {
    fn of(a: &russh_sftp::protocol::FileAttributes) -> Self {
        Self {
            size: a.size.unwrap_or(0),
            mtime: a.mtime,
            uid: a.uid,
            gid: a.gid,
            permissions: a.permissions,
            is_dir: a.is_dir(),
            is_file: a.is_regular(),
        }
    }
}

/// One entry of a folder listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub dir: bool,
    pub size: Option<u64>,
    pub modified_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListing {
    /// The folder, absolute (the home folder for an empty request).
    pub path: String,
    pub entries: Vec<RemoteEntry>,
    /// More entries than `MAX_LIST_ENTRIES`.
    pub truncated: bool,
}

fn sftp_error(e: SftpError, what: &str) -> AppError {
    match e {
        SftpError::Status(s) => {
            let code = match s.status_code {
                StatusCode::NoSuchFile => ErrorCode::NotFound,
                StatusCode::PermissionDenied => ErrorCode::PermissionDenied,
                StatusCode::OpUnsupported => ErrorCode::Unsupported,
                _ => ErrorCode::ConnectionFailed,
            };
            let mut err = AppError::new(code, format!("{what}: {}", s.status_code));
            err.path = Some(what.into());
            err
        }
        SftpError::Timeout => {
            AppError::new(ErrorCode::ConnectionFailed, format!("{what}: timeout"))
        }
        other => AppError::new(ErrorCode::ConnectionFailed, format!("{what}: {other}")),
    }
}

fn ssh_error(e: &russh::Error, label: &str) -> AppError {
    AppError::new(ErrorCode::ConnectionFailed, format!("{label}: {e}"))
}

/// What the host key check saw, for the error after a refused connect.
#[derive(Debug, Clone)]
enum Seen {
    Unknown {
        key_type: String,
        fingerprint: String,
    },
    Changed {
        key_type: String,
        fingerprint: String,
        file: PathBuf,
        line: usize,
        /// `other_key`, `revoked`, `unusable`, `cert_authority`, `unknown_marker`, `unreadable`.
        reason: &'static str,
    },
    LearnFailed(String),
}

pub struct Client {
    host: String,
    port: u16,
    known: KnownHosts,
    trust: Option<String>,
    seen: Arc<Mutex<Option<Seen>>>,
}

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key: PublicKey = match server_public_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            // Host certificates count as their key (no @cert-authority).
            russh::keys::PublicKeyOrCertificate::Certificate(c) => {
                PublicKey::from(c.public_key().clone())
            }
        };
        let print = fingerprint(&key);
        let key_type = key.algorithm().to_string();
        let seen = match self.known.check(&self.host, self.port, &key) {
            HostKeyCheck::Known => return Ok(true),
            HostKeyCheck::Unknown if self.trust.as_deref() == Some(print.as_str()) => {
                // Confirmed for exactly this key: recorded in the app's file.
                match self.known.learn(&self.host, self.port, &key) {
                    Ok(()) => return Ok(true),
                    Err(e) => Seen::LearnFailed(e.to_string()),
                }
            }
            HostKeyCheck::Unknown => Seen::Unknown {
                key_type,
                fingerprint: print,
            },
            HostKeyCheck::Changed { file, line, reason } => Seen::Changed {
                key_type,
                fingerprint: print,
                file,
                line,
                reason: reason.as_str(),
            },
            HostKeyCheck::Revoked { file, line } => Seen::Changed {
                key_type,
                fingerprint: print,
                file,
                line,
                reason: "revoked",
            },
        };
        *self.seen.lock() = Some(seen);
        Ok(false)
    }

    // Security review 017 L1: the server may not open channels towards us (agent, X11, forwarded
    // ports, sessions). Dropping the reply rejects; russh's defaults would accept.
    async fn server_channel_open_agent_forward(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.refused_channel();
        Ok(())
    }

    async fn server_channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.refused_channel();
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.refused_channel();
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.refused_channel();
        Ok(())
    }

    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.refused_channel();
        Ok(())
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _socket_path: &str,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.refused_channel();
        Ok(())
    }

    async fn server_channel_open_direct_streamlocal(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _socket_path: &str,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.refused_channel();
        Ok(())
    }
}

/// Channels the servers tried to open towards this app (all refused; tests).
pub static REFUSED_CHANNELS: AtomicU64 = AtomicU64::new(0);

impl Client {
    fn refused_channel(&self) {
        REFUSED_CHANNELS.fetch_add(1, Ordering::Relaxed);
    }
}

fn host_key_error(seen: Seen, r: &Resolved) -> AppError {
    let place = if r.port == 22 {
        r.host.clone()
    } else {
        format!("[{}]:{}", r.host, r.port)
    };
    match seen {
        Seen::Unknown {
            key_type,
            fingerprint,
        } => AppError::new(
            ErrorCode::HostKeyUnknown,
            format!("unknown host key of {place}: {key_type} {fingerprint}"),
        )
        .with_remote(RemoteDetail {
            key_type: Some(key_type),
            fingerprint: Some(fingerprint),
            ..Default::default()
        }),
        Seen::Changed {
            key_type,
            fingerprint,
            file,
            line,
            reason,
        } => {
            let at = if line > 0 {
                format!("{}:{line}", file.display())
            } else {
                file.display().to_string()
            };
            let why = match reason {
                "revoked" => format!("the host key of {place} is marked @revoked in {at}"),
                "unusable" => format!("{at} has an entry for {place} whose key cannot be read"),
                "cert_authority" => format!(
                    "{at} has an @cert-authority entry for {place}; host certificates are not supported"
                ),
                "unknown_marker" => format!("{at} has an entry with an unknown marker for {place}"),
                "unreadable" => format!("{at} cannot be read, so the host key of {place} cannot be checked"),
                _ => format!("the host key of {place} differs from the one in {at}"),
            };
            AppError::new(
                ErrorCode::HostKeyChanged,
                format!("{why} (server shows {key_type} {fingerprint})"),
            )
            .with_remote(RemoteDetail {
                key_type: Some(key_type),
                fingerprint: Some(fingerprint),
                known_hosts: Some(file.display().to_string()),
                known_hosts_line: (line > 0).then_some(line),
                reason: Some(reason.into()),
                ..Default::default()
            })
        }
        Seen::LearnFailed(e) => AppError::new(ErrorCode::Io, format!("host key not recorded: {e}")),
    }
}

fn secret_required(kind: SecretKind, wrong: bool, what: &str) -> AppError {
    let message = match (kind, wrong) {
        (SecretKind::Password, false) => format!("{what}: password needed"),
        (SecretKind::Password, true) => format!("{what}: password not accepted"),
        (SecretKind::Passphrase, false) => format!("{what}: the key file is encrypted"),
        (SecretKind::Passphrase, true) => format!("{what}: wrong passphrase"),
    };
    AppError::new(ErrorCode::SecretRequired, message).with_remote(RemoteDetail {
        secret: Some(kind),
        wrong,
        ..Default::default()
    })
}

/// An open SSH connection with its SFTP session.
pub struct Conn {
    handle: russh::client::Handle<Client>,
    sftp: SftpSession,
    label: String,
}

impl Conn {
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// The attributes of `path` (following links); None if it does not exist.
    pub fn stat(&self, path: &str) -> AppResult<Option<RemoteStat>> {
        let sftp = &self.sftp;
        let r = block(CALL_TIMEOUT, &self.label, async move {
            Ok(sftp.metadata(path).await)
        })?;
        match r {
            Ok(a) => Ok(Some(RemoteStat::of(&a))),
            Err(e) => {
                let e = sftp_error(e, path);
                if e.code == ErrorCode::NotFound {
                    Ok(None)
                } else {
                    Err(e)
                }
            }
        }
    }

    pub fn open(&self, path: &str) -> AppResult<RemoteFile> {
        let sftp = &self.sftp;
        let file = block(CALL_TIMEOUT, &self.label, async move {
            sftp.open(path).await.map_err(|e| sftp_error(e, path))
        })?;
        Ok(RemoteFile {
            file: Some(file),
            label: self.label.clone(),
        })
    }

    /// The folder `path` (empty: the home folder), folders first, then by name.
    pub fn list(&self, path: &str) -> AppResult<RemoteListing> {
        self.list_with(path, MAX_LIST_ENTRIES, MAX_LINK_STATS)
    }

    /// `list` with its limits (security review 017 L3): one deadline for everything, entries capped
    /// while reading (one `readdir` packet at a time on a channel of its own), at most `max_links`
    /// symbolic links resolved; the rest show without kind and size.
    pub fn list_with(
        &self,
        path: &str,
        max_entries: usize,
        max_links: usize,
    ) -> AppResult<RemoteListing> {
        let dir = if path.trim().is_empty() { "." } else { path };
        let label = self.label.clone();
        block(LIST_DEADLINE, &self.label, async move {
            let channel = self
                .handle
                .channel_open_session()
                .await
                .map_err(|e| ssh_error(&e, &label))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| ssh_error(&e, &label))?;
            let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
            raw.set_timeout(CALL_TIMEOUT.as_secs());
            raw.init().await.map_err(|e| sftp_error(e, &label))?;
            let result = list_raw(&raw, dir, max_entries, max_links).await;
            let _ = raw.close_session();
            result
        })
    }

    fn close(&self) {
        let _ = block(Duration::from_secs(2), &self.label, async {
            let _ = self.sftp.close().await;
            let _ = self
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(())
        });
    }
}

async fn list_raw(
    raw: &russh_sftp::client::RawSftpSession,
    dir: &str,
    max_entries: usize,
    max_links: usize,
) -> AppResult<RemoteListing> {
    let canonical = raw
        .realpath(dir)
        .await
        .map_err(|e| sftp_error(e, dir))?
        .files
        .into_iter()
        .next()
        .map(|f| f.filename)
        .ok_or_else(|| AppError::new(ErrorCode::ConnectionFailed, format!("{dir}: no path")))?;
    let handle = raw
        .opendir(canonical.as_str())
        .await
        .map_err(|e| sftp_error(e, &canonical))?
        .handle;
    let mut out: Vec<RemoteEntry> = Vec::new();
    let mut links: Vec<usize> = Vec::new();
    let mut truncated = false;
    'read: loop {
        match raw.readdir(handle.as_str()).await {
            Ok(name) => {
                for f in name.files {
                    let name = f.filename;
                    if name == "." || name == ".." || name.is_empty() || name.contains('/') {
                        continue;
                    }
                    if out.len() >= max_entries {
                        truncated = true;
                        break 'read;
                    }
                    let a = &f.attrs;
                    if a.is_symlink() {
                        links.push(out.len());
                    }
                    out.push(RemoteEntry {
                        name,
                        dir: a.is_dir(),
                        size: a.is_regular().then_some(a.size).flatten(),
                        modified_ms: a.mtime.map(|t| i64::from(t) * 1000),
                    });
                }
            }
            Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => break,
            Err(e) => {
                let _ = raw.close(handle.as_str()).await;
                return Err(sftp_error(e, &canonical));
            }
        }
    }
    let _ = raw.close(handle.as_str()).await;
    for &i in links.iter().take(max_links) {
        let full = join_remote(&canonical, &out[i].name);
        if let Ok(target) = raw.stat(full).await {
            let t = RemoteStat::of(&target.attrs);
            out[i].dir = t.is_dir;
            out[i].size = t.is_file.then_some(t.size);
        }
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
    Ok(RemoteListing {
        path: canonical,
        entries: out,
        truncated,
    })
}

pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// An open remote file; the handle stays open (rotation: the old file can be read to its end).
pub struct RemoteFile {
    file: Option<russh_sftp::client::fs::File>,
    label: String,
}

impl RemoteFile {
    /// The attributes of the open file (`fstat`).
    pub fn fstat(&mut self) -> AppResult<RemoteStat> {
        let file = self.file.as_ref().expect("open");
        let label = self.label.clone();
        block(CALL_TIMEOUT, &self.label, async move {
            file.metadata()
                .await
                .map(|a| RemoteStat::of(&a))
                .map_err(|e| sftp_error(e, &label))
        })
    }

    /// Up to `max` bytes from `offset` (fewer at the end of the file).
    pub fn read_at(&mut self, offset: u64, max: usize) -> AppResult<Vec<u8>> {
        let file = self.file.as_mut().expect("open");
        let label = self.label.clone();
        block(CALL_TIMEOUT, &self.label, async move {
            let io = |e: std::io::Error| {
                AppError::new(ErrorCode::ConnectionFailed, format!("{label}: {e}"))
            };
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(io)?;
            let mut out = vec![0u8; max];
            let mut filled = 0;
            while filled < max {
                let n = file.read(&mut out[filled..]).await.map_err(io)?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            out.truncate(filled);
            Ok(out)
        })
    }
}

impl Drop for RemoteFile {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            runtime().spawn(async move {
                let _ = file.close().await;
            });
        }
    }
}

/// The connection to one `user@host:port`, shared by its files and the folder browser.
pub struct Shared {
    resolved: Resolved,
    known: KnownHosts,
    store: Arc<dyn SecretStore>,
    /// For reconnecting; wiped when the last user is gone and the connection closes.
    secret: Mutex<Option<Secret>>,
    conn: Mutex<Option<Arc<Conn>>>,
    users: AtomicUsize,
    idle_since: Mutex<Instant>,
    connects: AtomicU64,
}

impl Shared {
    pub fn resolved(&self) -> &Resolved {
        &self.resolved
    }

    /// Connections made (tests: shared files make one).
    pub fn connects(&self) -> u64 {
        self.connects.load(Ordering::Relaxed)
    }

    /// The open connection, or a new one with what is known (no trust prompt: an unknown key is an
    /// error now, a changed one too).
    pub fn get(&self) -> AppResult<Arc<Conn>> {
        self.get_with(&Credentials::default())
    }

    fn get_with(&self, creds: &Credentials) -> AppResult<Arc<Conn>> {
        let mut slot = self.conn.lock();
        if let Some(conn) = slot.as_ref() {
            if !conn.is_closed() {
                return Ok(Arc::clone(conn));
            }
        }
        let conn = Arc::new(self.connect(creds)?);
        *slot = Some(Arc::clone(&conn));
        Ok(conn)
    }

    /// `conn` failed: the next `get` connects again (unless someone already did).
    pub fn invalidate(&self, conn: &Arc<Conn>) {
        let mut slot = self.conn.lock();
        if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, conn)) {
            *slot = None;
        }
    }

    fn close(&self) {
        if let Some(conn) = self.conn.lock().take() {
            conn.close();
        }
        *self.secret.lock() = None;
    }

    /// The secret for `kind`: from the dialog, from memory (reconnect), from the keychain.
    fn secret_for(
        &self,
        kind: SecretKind,
        subject: &str,
        creds: &Credentials,
    ) -> (Option<Secret>, bool) {
        if let Some(s) = creds.secret.clone().filter(|s| !s.is_empty()) {
            return (Some(s), true);
        }
        if let Some(s) = self.secret.lock().clone() {
            return (Some(s), false);
        }
        match self.store.get(&account(kind, subject)) {
            Ok(s) => (s, false),
            Err(_) => (None, false),
        }
    }

    fn connect(&self, creds: &Credentials) -> AppResult<Conn> {
        let r = &self.resolved;
        let label = r.key();
        // Key files are read before connecting: a wrong passphrase needs no round trip.
        let mut used: Option<(Secret, bool, SecretKind, String)> = None;
        let key = match r.auth {
            AuthKind::Key => {
                let Some(file) = r.key_files.iter().find(|f| f.is_file()) else {
                    return Err(AppError::new(
                        ErrorCode::NotFound,
                        "no key file (none given, none in ~/.ssh)",
                    ));
                };
                let subject = file.display().to_string();
                match russh::keys::load_secret_key(file, None) {
                    Ok(k) => Some(Arc::new(k)),
                    Err(russh::keys::Error::KeyIsEncrypted) => {
                        let (secret, typed) =
                            self.secret_for(SecretKind::Passphrase, &subject, creds);
                        let Some(secret) = secret else {
                            return Err(secret_required(SecretKind::Passphrase, false, &subject));
                        };
                        match russh::keys::load_secret_key(file, Some(secret.expose())) {
                            Ok(k) => {
                                used = Some((secret, typed, SecretKind::Passphrase, subject));
                                Some(Arc::new(k))
                            }
                            Err(_) => {
                                return Err(secret_required(SecretKind::Passphrase, true, &subject))
                            }
                        }
                    }
                    Err(e) => {
                        return Err(AppError::new(
                            ErrorCode::AuthFailed,
                            format!("{subject}: not a usable key ({e})"),
                        ))
                    }
                }
            }
            _ => None,
        };
        // Without a password the host key is checked first (connect, compare, hang up): nobody is
        // asked for a password for a server whose key is unknown or changed.
        let mut probe = false;
        let password = if r.auth == AuthKind::Password {
            let (secret, typed) = self.secret_for(SecretKind::Password, &label, creds);
            match secret {
                Some(secret) => {
                    used = Some((secret.clone(), typed, SecretKind::Password, label.clone()));
                    Some(secret)
                }
                None => {
                    probe = true;
                    None
                }
            }
        } else {
            None
        };
        let preferred = if r.auth == AuthKind::Agent {
            public_keys_of(&r.key_files)
        } else {
            Vec::new()
        };
        let seen = Arc::new(Mutex::new(None));
        let client = Client {
            host: r.host.clone(),
            port: r.port,
            known: self.known.clone(),
            trust: creds.trust_fingerprint.clone(),
            seen: Arc::clone(&seen),
        };
        let config = russh::client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            preferred: russh::Preferred {
                key: std::borrow::Cow::Owned(self.known.preferred_algorithms(&r.host, r.port)),
                ..Default::default()
            },
            ..Default::default()
        };
        let host = r.host.clone();
        let port = r.port;
        let user = r.user.clone();
        let auth = r.auth;
        let lbl = label.clone();
        let result = block(CALL_TIMEOUT, &label, async move {
            let mut handle =
                match russh::client::connect(Arc::new(config), (host.as_str(), port), client).await
                {
                    Ok(h) => h,
                    Err(e) => return Ok(Err(e)),
                };
            if probe {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
                return Err(secret_required(SecretKind::Password, false, &lbl));
            }
            let ok = match auth {
                AuthKind::Password => {
                    let pw = password.expect("checked above");
                    handle
                        .authenticate_password(user.clone(), pw.expose())
                        .await
                        .map(|r| r.success())
                        .map_err(|e| ssh_error(&e, &lbl))?
                }
                AuthKind::Key => {
                    let key = key.expect("loaded above");
                    let hash = if key.algorithm().is_rsa() {
                        handle
                            .best_supported_rsa_hash()
                            .await
                            .ok()
                            .flatten()
                            .flatten()
                    } else {
                        None
                    };
                    handle
                        .authenticate_publickey(
                            user.clone(),
                            russh::keys::PrivateKeyWithHashAlg::new(key, hash),
                        )
                        .await
                        .map(|r| r.success())
                        .map_err(|e| ssh_error(&e, &lbl))?
                }
                AuthKind::Agent => agent_auth(&mut handle, &user, &lbl, &preferred).await?,
            };
            if !ok {
                return Ok(Ok((handle, None)));
            }
            let channel = handle
                .channel_open_session()
                .await
                .map_err(|e| ssh_error(&e, &lbl))?;
            // The only request ever made on a channel: the SFTP subsystem.
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| ssh_error(&e, &lbl))?;
            let sftp = SftpSession::new(channel.into_stream())
                .await
                .map_err(|e| sftp_error(e, &lbl))?;
            sftp.set_timeout(CALL_TIMEOUT.as_secs());
            Ok(Ok((handle, Some(sftp))))
        });
        let seen = seen.lock().take();
        let (handle, sftp) = match result {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => {
                return Err(match seen {
                    Some(s) => host_key_error(s, r),
                    None => ssh_error(&e, &label),
                })
            }
            Err(e) => {
                return Err(match seen {
                    Some(s) => host_key_error(s, r),
                    None => e,
                })
            }
        };
        let Some(sftp) = sftp else {
            return Err(match r.auth {
                AuthKind::Password => secret_required(SecretKind::Password, true, &label),
                AuthKind::Agent => AppError::new(
                    ErrorCode::AuthFailed,
                    format!("{label}: the agent has no key the server accepts"),
                ),
                AuthKind::Key => AppError::new(
                    ErrorCode::AuthFailed,
                    format!("{label}: the server does not accept this key"),
                ),
            });
        };
        if let Some((secret, typed, kind, subject)) = used {
            if typed && creds.remember {
                if let Err(e) = self.store.set(&account(kind, &subject), &secret) {
                    eprintln!("keychain: secret not stored ({})", e.0);
                }
            }
            *self.secret.lock() = Some(secret);
        }
        self.connects.fetch_add(1, Ordering::Relaxed);
        Ok(Conn {
            handle,
            sftp,
            label,
        })
    }
}

async fn agent_auth(
    handle: &mut russh::client::Handle<Client>,
    user: &str,
    label: &str,
    preferred: &[PublicKey],
) -> AppResult<bool> {
    let failed = |e: russh::keys::Error| {
        AppError::new(ErrorCode::AuthFailed, format!("{label}: SSH agent: {e}"))
    };
    #[cfg(unix)]
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(failed)?
        .dynamic();
    #[cfg(windows)]
    let mut agent = match russh::keys::agent::client::AgentClient::connect_named_pipe(
        r"\\.\pipe\openssh-ssh-agent",
    )
    .await
    {
        Ok(a) => a.dynamic(),
        Err(_) => russh::keys::agent::client::AgentClient::connect_pageant()
            .await
            .map_err(failed)?
            .dynamic(),
    };
    let ids = agent.request_identities().await.map_err(failed)?;
    let rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let keys: Vec<PublicKey> = ids
        .into_iter()
        .filter_map(|id| match id {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => Some(key),
            _ => None,
        })
        .collect();
    for key in order_identities(keys, preferred, MAX_AGENT_TRIES) {
        let hash = if key.algorithm().is_rsa() {
            rsa_hash
        } else {
            None
        };
        if let Ok(r) = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            if r.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// The agent's keys in the order to offer (security review 017 L2): those of the `IdentityFile`s
/// (their `.pub`) first, in that order, then the rest; at most `cap`.
pub fn order_identities(
    keys: Vec<PublicKey>,
    preferred: &[PublicKey],
    cap: usize,
) -> Vec<PublicKey> {
    let rank = |k: &PublicKey| {
        preferred
            .iter()
            .position(|p| p.key_data() == k.key_data())
            .unwrap_or(usize::MAX)
    };
    let mut keys: Vec<(usize, usize, PublicKey)> = keys
        .into_iter()
        .enumerate()
        .map(|(i, k)| (rank(&k), i, k))
        .collect();
    keys.sort_by_key(|(rank, i, _)| (*rank, *i));
    keys.into_iter().take(cap).map(|(_, _, k)| k).collect()
}

/// The public keys next to the key files (`<file>.pub`) that exist and can be read.
fn public_keys_of(files: &[PathBuf]) -> Vec<PublicKey> {
    files
        .iter()
        .filter_map(|f| {
            let mut pub_path = f.clone().into_os_string();
            pub_path.push(".pub");
            let text = std::fs::read_to_string(PathBuf::from(pub_path)).ok()?;
            PublicKey::from_openssh(text.trim()).ok()
        })
        .collect()
}

/// A user of a shared connection (a source, a listing); the connection closes after the last one
/// is gone for `IDLE_CLOSE`.
pub struct Lease(Arc<Shared>);

impl Lease {
    pub fn shared(&self) -> &Arc<Shared> {
        &self.0
    }
}

impl std::ops::Deref for Lease {
    type Target = Shared;
    fn deref(&self) -> &Shared {
        &self.0
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.0.users.fetch_sub(1, Ordering::SeqCst) == 1 {
            *self.0.idle_since.lock() = Instant::now();
        }
    }
}

/// Known hosts, `~/.ssh/config`, keychain and the connections.
pub struct Hub {
    known: KnownHosts,
    env: Option<Environment>,
    store: Arc<dyn SecretStore>,
    pool: Mutex<HashMap<String, Arc<Shared>>>,
    idle_close: Duration,
}

impl Hub {
    pub fn new(known: KnownHosts, env: Option<Environment>, store: Arc<dyn SecretStore>) -> Self {
        Self {
            known,
            env,
            store,
            pool: Mutex::new(HashMap::new()),
            idle_close: IDLE_CLOSE,
        }
    }

    /// Tests: close idle connections sooner.
    pub fn with_idle_close(mut self, idle: Duration) -> Self {
        self.idle_close = idle;
        self
    }

    pub fn known_hosts(&self) -> &KnownHosts {
        &self.known
    }

    fn config(&self) -> SshConfig {
        self.env.as_ref().map(SshConfig::load).unwrap_or_default()
    }

    /// The hosts of `~/.ssh/config` for the dialog (no wildcards).
    pub fn hosts(&self) -> Vec<HostConfig> {
        let Some(env) = &self.env else {
            return Vec::new();
        };
        let config = self.config();
        config
            .aliases()
            .into_iter()
            .map(|alias| config.resolve(&alias, env))
            .collect()
    }

    /// Applies `~/.ssh/config`; a proxy in it is refused (never run).
    pub fn resolve(&self, t: &Target) -> AppResult<Resolved> {
        t.validate()?;
        let alias = t.host.trim().to_string();
        let (host_config, local_user, home) = match &self.env {
            Some(env) => (
                self.config().resolve(&alias, env),
                env.local_user.clone(),
                Some(env.home.clone()),
            ),
            None => (
                HostConfig {
                    alias: alias.clone(),
                    host_name: alias.clone(),
                    ..Default::default()
                },
                String::new(),
                None,
            ),
        };
        if host_config.proxy {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                format!("{alias}: ProxyJump/ProxyCommand in ~/.ssh/config is not supported"),
            ));
        }
        let user = Some(t.user.trim().to_string())
            .filter(|u| !u.is_empty())
            .or(host_config.user.clone())
            .unwrap_or(local_user);
        if user.is_empty() {
            return Err(invalid("a user name is needed"));
        }
        let port = if t.port > 0 {
            t.port
        } else {
            host_config.port.unwrap_or(22)
        };
        let mut key_files: Vec<PathBuf> = Vec::new();
        if let Some(file) = t.key_file.as_ref().filter(|f| !f.trim().is_empty()) {
            key_files.push(PathBuf::from(file.trim()));
        } else {
            key_files.extend(host_config.identity_files.iter().map(PathBuf::from));
            if let Some(home) = home {
                for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                    key_files.push(home.join(".ssh").join(name));
                }
            }
        }
        Ok(Resolved {
            alias,
            // Host names are case-insensitive (known_hosts, pool key): lower case like OpenSSH.
            host: host_config.host_name.to_lowercase(),
            port,
            user,
            auth: t.auth,
            key_files,
        })
    }

    /// The shared connection to `t`, connected (with `creds` if it has to connect now).
    pub fn lease(&self, t: &Target, creds: &Credentials) -> AppResult<Lease> {
        let resolved = self.resolve(t)?;
        self.sweep();
        let shared = {
            let mut pool = self.pool.lock();
            let shared = pool.entry(resolved.key()).or_insert_with(|| {
                Arc::new(Shared {
                    resolved: resolved.clone(),
                    known: self.known.clone(),
                    store: Arc::clone(&self.store),
                    secret: Mutex::new(None),
                    conn: Mutex::new(None),
                    users: AtomicUsize::new(0),
                    idle_since: Mutex::new(Instant::now()),
                    connects: AtomicU64::new(0),
                })
            });
            shared.users.fetch_add(1, Ordering::SeqCst);
            Arc::clone(shared)
        };
        let lease = Lease(shared);
        lease.get_with(creds)?;
        Ok(lease)
    }

    /// Lists a remote folder over the shared connection.
    pub fn list(&self, t: &Target, creds: &Credentials, path: &str) -> AppResult<RemoteListing> {
        if path.len() > MAX_REMOTE_PATH || !plain_text(path) {
            return Err(invalid("not a remote path"));
        }
        let lease = self.lease(t, creds)?;
        let conn = lease.get()?;
        conn.list(path).inspect_err(|e| {
            if e.code == ErrorCode::ConnectionFailed {
                lease.invalidate(&conn);
            }
        })
    }

    /// Removes the password (of `user@host:port`) and the passphrase (of the key file) of `t`
    /// from the keychain and from memory.
    pub fn forget(&self, t: &Target) -> AppResult<()> {
        let r = self.resolve(t)?;
        let mut errors = Vec::new();
        if let Err(e) = self.store.delete(&account(SecretKind::Password, &r.key())) {
            errors.push(e.0);
        }
        for file in &r.key_files {
            if let Err(e) = self.store.delete(&account(
                SecretKind::Passphrase,
                &file.display().to_string(),
            )) {
                errors.push(e.0);
            }
        }
        if let Some(shared) = self.pool.lock().get(&r.key()) {
            *shared.secret.lock() = None;
        }
        match errors.into_iter().next() {
            Some(e) => Err(AppError::new(ErrorCode::Io, format!("keychain: {e}"))),
            None => Ok(()),
        }
    }

    /// Closes connections nobody used for `idle_close`.
    pub fn sweep(&self) {
        self.close_unused(self.idle_close);
    }

    /// Closes every connection nobody uses right now, however short it has been idle (tests:
    /// the next lease has to log in again).
    #[doc(hidden)]
    pub fn sweep_now(&self) {
        self.close_unused(Duration::ZERO);
    }

    fn close_unused(&self, idle_for: Duration) {
        let idle: Vec<Arc<Shared>> = {
            let mut pool = self.pool.lock();
            let keys: Vec<String> = pool
                .iter()
                .filter(|(_, s)| {
                    s.users.load(Ordering::SeqCst) == 0 && s.idle_since.lock().elapsed() >= idle_for
                })
                .map(|(k, _)| k.clone())
                .collect();
            keys.iter().filter_map(|k| pool.remove(k)).collect()
        };
        for shared in idle {
            shared.close();
        }
    }

    /// Open connections (tests).
    pub fn open_connections(&self) -> usize {
        self.pool
            .lock()
            .values()
            .filter(|s| s.conn.lock().as_ref().is_some_and(|c| !c.is_closed()))
            .count()
    }

    /// The keychain behind the hub (Windows events of prompt 018 keep their password there too).
    pub fn secret_store(&self) -> Arc<dyn SecretStore> {
        Arc::clone(&self.store)
    }

    /// Closes everything (app exit).
    pub fn close_all(&self) {
        let all: Vec<Arc<Shared>> = self.pool.lock().drain().map(|(_, s)| s).collect();
        for shared in all {
            shared.close();
        }
    }
}

/// Sweeps the hub's pool every 15 s (started once by the app).
pub fn start_sweeper(hub: std::sync::Weak<Hub>) {
    let _ = std::thread::Builder::new()
        .name("lc-remote-sweep".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            match hub.upgrade() {
                Some(hub) => hub.sweep(),
                None => break,
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> PublicKey {
        russh::keys::PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(
            &[seed; 32],
        ))
        .public_key()
        .clone()
    }

    #[test]
    fn agent_keys_of_the_identity_files_go_first_and_are_capped() {
        let agent: Vec<PublicKey> = (1..=9).map(key).collect();
        let order = order_identities(agent.clone(), &[key(7), key(3)], MAX_AGENT_TRIES);
        assert_eq!(order.len(), MAX_AGENT_TRIES);
        assert_eq!(order[0], key(7));
        assert_eq!(order[1], key(3));
        assert_eq!(order[2], key(1));
        assert!(!order.contains(&key(9)));
        // Without preferences: the agent's order.
        assert_eq!(order_identities(agent, &[], 2), vec![key(1), key(2)]);
    }

    #[test]
    fn resolved_host_names_are_lower_case() {
        let hub = Hub::new(
            KnownHosts {
                user: None,
                app: PathBuf::new(),
            },
            None,
            Arc::new(secrets::MemoryStore::default()),
        );
        let r = hub
            .resolve(&Target {
                host: "Logs.Example.COM".into(),
                port: 22,
                user: "ops".into(),
                auth: AuthKind::Agent,
                key_file: None,
            })
            .unwrap();
        assert_eq!(r.host, "logs.example.com");
        assert_eq!(r.alias, "Logs.Example.COM");
    }
}
