//! An SFTP server in the process, for tests and `npm run e2e` (debug builds only, prompt 017): no
//! Docker, the same on every OS. It serves a folder; user [`USER`], password [`PASSWORD`], and the
//! public key passed to [`start`]. It counts what a client asked for besides SFTP (it must never ask
//! for a shell or a command) and can drop all connections (reconnect tests).
//! After files-and-folders-tauri (`remote/testserver.rs`).

use super::runtime;
use parking_lot::Mutex;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

pub const USER: &str = "e2e";
/// Long and unusual, so tests can search for it in files and messages.
pub const PASSWORD: &str = "testSecretQx7-sftp";

#[derive(Default)]
pub struct Counters {
    /// Requests for exec, shell, PTY, env, forwarding: must stay 0.
    pub forbidden: AtomicUsize,
    pub logins: AtomicUsize,
    pub refused: AtomicUsize,
    /// Refuse every login while set.
    pub refuse_all: AtomicBool,
    handles: Mutex<Vec<russh::server::Handle>>,
}

/// A running test server.
pub struct TestSftp {
    pub port: u16,
    pub root: PathBuf,
    pub host_key: PrivateKey,
    pub counters: Arc<Counters>,
    task: tokio::task::JoinHandle<()>,
}

impl TestSftp {
    /// Stops listening and drops every connection (a server that went away).
    pub fn stop(&self) {
        self.task.abort();
        self.kick();
    }

    /// Tries to open channels towards every connected client (agent, X11, forwarded and direct TCP,
    /// session, as a hostile server would); returns how many the clients accepted.
    pub fn open_channels_to_clients(&self) -> usize {
        let handles: Vec<_> = self.counters.handles.lock().clone();
        runtime().block_on(async {
            let mut accepted = 0;
            for h in handles {
                let wait = std::time::Duration::from_secs(5);
                let tries = [
                    tokio::time::timeout(wait, h.channel_open_agent()).await,
                    tokio::time::timeout(wait, h.channel_open_x11("127.0.0.1", 6000)).await,
                    tokio::time::timeout(
                        wait,
                        h.channel_open_forwarded_tcpip("127.0.0.1", 80, "127.0.0.1", 1),
                    )
                    .await,
                    tokio::time::timeout(
                        wait,
                        h.channel_open_direct_tcpip("127.0.0.1", 80, "127.0.0.1", 1),
                    )
                    .await,
                    tokio::time::timeout(wait, h.channel_open_session()).await,
                ];
                accepted += tries.iter().filter(|t| matches!(t, Ok(Ok(_)))).count();
            }
            accepted
        })
    }

    /// Drops every connection (the server keeps listening).
    pub fn kick(&self) {
        let handles: Vec<_> = self.counters.handles.lock().drain(..).collect();
        runtime().block_on(async {
            for h in handles {
                let _ = h
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "kicked".into(),
                        "en".into(),
                    )
                    .await;
            }
        });
    }
}

impl Drop for TestSftp {
    fn drop(&mut self) {
        self.task.abort();
        self.kick();
    }
}

/// A host key from a seed (the same seed is the same server).
pub fn host_key(seed: u8) -> PrivateKey {
    PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(
        &[seed; 32],
    ))
}

/// Starts a server for `root` on `port` (0: any) with host key `seed`.
pub fn start(
    root: PathBuf,
    port: u16,
    seed: u8,
    client_key: Option<PublicKey>,
) -> std::io::Result<TestSftp> {
    let key = host_key(seed);
    let config = Arc::new(russh::server::Config {
        keys: vec![key.clone()],
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        ..Default::default()
    });
    let counters = Arc::new(Counters::default());
    let mut server = SshServer {
        root: root.clone(),
        client_key,
        counters: Arc::clone(&counters),
    };
    let listener = runtime().block_on(tokio::net::TcpListener::bind(("127.0.0.1", port)))?;
    let port = listener.local_addr()?.port();
    let task = runtime().spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    Ok(TestSftp {
        port,
        root,
        host_key: key,
        counters,
        task,
    })
}

#[derive(Clone)]
struct SshServer {
    root: PathBuf,
    client_key: Option<PublicKey>,
    counters: Arc<Counters>,
}

impl russh::server::Server for SshServer {
    type Handler = SshSession;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> SshSession {
        SshSession {
            root: self.root.clone(),
            client_key: self.client_key.clone(),
            counters: Arc::clone(&self.counters),
            channels: HashMap::new(),
        }
    }
}

struct SshSession {
    root: PathBuf,
    client_key: Option<PublicKey>,
    counters: Arc<Counters>,
    channels: HashMap<ChannelId, Channel<Msg>>,
}

impl SshSession {
    fn verdict(&self, ok: bool) -> Auth {
        if ok && !self.counters.refuse_all.load(Ordering::SeqCst) {
            self.counters.logins.fetch_add(1, Ordering::SeqCst);
            Auth::Accept
        } else {
            self.counters.refused.fetch_add(1, Ordering::SeqCst);
            Auth::reject()
        }
    }

    fn forbidden(&self, session: &mut Session, channel: ChannelId) -> Result<(), russh::Error> {
        self.counters.forbidden.fetch_add(1, Ordering::SeqCst);
        session.channel_failure(channel)
    }
}

impl russh::server::Handler for SshSession {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(self.verdict(user == USER && password == PASSWORD))
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let ok = user == USER
            && self
                .client_key
                .as_ref()
                .is_some_and(|k| k.key_data() == key.key_data());
        Ok(self.verdict(ok))
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.counters.handles.lock().push(session.handle());
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.forbidden(session, channel)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.forbidden(session, channel)
    }

    #[allow(clippy::too_many_arguments)]
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.forbidden(session, channel)
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        _value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.forbidden(session, channel)
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        match (name, self.channels.remove(&channel_id)) {
            ("sftp", Some(channel)) => {
                session.channel_success(channel_id)?;
                let handler = Sftp {
                    root: self.root.clone(),
                    handles: HashMap::new(),
                    next: 0,
                };
                tokio::spawn(russh_sftp::server::run(channel.into_stream(), handler));
            }
            _ => self.forbidden(session, channel_id)?,
        }
        Ok(())
    }
}

enum H {
    File(std::fs::File),
    Dir(Option<Vec<File>>),
}

/// Read-only SFTP over a folder: `/` is its root.
struct Sftp {
    root: PathBuf,
    handles: HashMap<String, H>,
    next: u64,
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".into(),
        language_tag: "en".into(),
    }
}

fn code_of(e: &std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

impl Sftp {
    fn real(&self, p: &str) -> Result<PathBuf, StatusCode> {
        let mut out = self.root.clone();
        for seg in p.split('/') {
            match seg {
                "" | "." => {}
                ".." => return Err(StatusCode::PermissionDenied),
                s => out.push(s),
            }
        }
        Ok(out)
    }
    fn handle(&mut self, h: H) -> String {
        self.next += 1;
        let k = self.next.to_string();
        self.handles.insert(k.clone(), h);
        k
    }
}

impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }

    async fn init(&mut self, _v: u32, _e: HashMap<String, String>) -> Result<Version, StatusCode> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        let mut parts: Vec<&str> = Vec::new();
        for seg in path.split('/') {
            match seg {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                s => parts.push(s),
            }
        }
        Ok(Name {
            id,
            files: vec![File::dummy(format!("/{}", parts.join("/")))],
        })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _a: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        if pflags.intersects(OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE) {
            return Err(StatusCode::PermissionDenied);
        }
        let f = std::fs::File::open(self.real(&filename)?).map_err(|e| code_of(&e))?;
        Ok(Handle {
            id,
            handle: self.handle(H::File(f)),
        })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        self.handles.remove(&handle);
        Ok(ok(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        let Some(H::File(f)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::Failure);
        };
        f.seek(SeekFrom::Start(offset)).map_err(|e| code_of(&e))?;
        let mut buf = vec![0u8; len.min(256 * 1024) as usize];
        let n = f.read(&mut buf).map_err(|e| code_of(&e))?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(Data { id, data: buf })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        let m = std::fs::symlink_metadata(self.real(&path)?).map_err(|e| code_of(&e))?;
        Ok(Attrs {
            id,
            attrs: FileAttributes::from(&m),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        let m = std::fs::metadata(self.real(&path)?).map_err(|e| code_of(&e))?;
        Ok(Attrs {
            id,
            attrs: FileAttributes::from(&m),
        })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, StatusCode> {
        let Some(H::File(f)) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        let m = f.metadata().map_err(|e| code_of(&e))?;
        Ok(Attrs {
            id,
            attrs: FileAttributes::from(&m),
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        let real = self.real(&path)?;
        let mut files = Vec::new();
        for e in std::fs::read_dir(&real).map_err(|e| code_of(&e))? {
            let e = e.map_err(|e| code_of(&e))?;
            let m = std::fs::symlink_metadata(e.path()).map_err(|e| code_of(&e))?;
            files.push(File::new(
                e.file_name().to_string_lossy(),
                FileAttributes::from(&m),
            ));
        }
        Ok(Handle {
            id,
            handle: self.handle(H::Dir(Some(files))),
        })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        match self.handles.get_mut(&handle) {
            Some(H::Dir(files)) => match files.take() {
                Some(files) => Ok(Name { id, files }),
                None => Err(StatusCode::Eof),
            },
            _ => Err(StatusCode::Failure),
        }
    }
}
