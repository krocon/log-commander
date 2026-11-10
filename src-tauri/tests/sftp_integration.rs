//! Prompt 017: a file on an SFTP server followed into a spool. Against the SFTP server in the process
//! (`remote::testserver`, debug builds) on 127.0.0.1, real files, no Tauri, no Docker. The same live
//! cases against a real OpenSSH in Docker are at the end (`#[ignore]`, see `tests/sshd/README.md`).
#![cfg(debug_assertions)]

use log_commander_lib::error::{AppError, ErrorCode};
use log_commander_lib::model::{SessionInfo, SessionUpdate, SourceState};
use log_commander_lib::remote::secrets::{MemoryStore, Secret, SecretKind};
use log_commander_lib::remote::testserver::{self, TestSftp, PASSWORD, USER};
use log_commander_lib::remote::trust::{fingerprint, KnownHosts};
use log_commander_lib::remote::{AuthKind, Credentials, Hub, Target};
use log_commander_lib::session::{OpenOptions, SessionManager};
use log_commander_lib::sources::sftp::SftpConfig;
use log_commander_lib::sources::SourceConfig;
use log_commander_lib::spool::SpoolRoot;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[path = "../src/test_support.rs"]
mod test_support;
use test_support::{wait_until, wait_until_or};

fn data(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/sftp")
        .join(name)
}

struct Fixture {
    dir: tempfile::TempDir,
    manager: SessionManager,
    hub: Arc<Hub>,
    store: Arc<MemoryStore>,
    server: TestSftp,
}

fn fixture() -> Fixture {
    fixture_with_key(None)
}

fn fixture_with_key(client_key: Option<russh::keys::PublicKey>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let served = dir.path().join("served");
    std::fs::create_dir_all(served.join("logs")).unwrap();
    let server = testserver::start(served, 0, 1, client_key).unwrap();
    let store = Arc::new(MemoryStore::default());
    let hub = Arc::new(
        Hub::new(
            KnownHosts {
                user: Some(dir.path().join("user_known_hosts")),
                app: dir.path().join("config").join("known_hosts"),
            },
            None,
            store.clone(),
        )
        // Long: a connection must not close between two steps of a test just because the
        // machine is slow. Tests that need it closed say so (`close_unused_connections`).
        .with_idle_close(Duration::from_secs(60)),
    );
    let manager = SessionManager::default();
    manager.set_spool_root(Arc::new(
        SpoolRoot::prepare(&dir.path().join("cache")).unwrap(),
    ));
    manager.set_remote(Arc::clone(&hub));
    Fixture {
        dir,
        manager,
        hub,
        store,
        server,
    }
}

fn target(port: u16, auth: AuthKind) -> Target {
    Target {
        host: "127.0.0.1".into(),
        port,
        user: USER.into(),
        auth,
        key_file: None,
    }
}

fn password() -> Credentials {
    Credentials {
        secret: Some(Secret::new(PASSWORD)),
        ..Default::default()
    }
}

impl Fixture {
    fn file(&self, rel: &str) -> PathBuf {
        self.server.root.join(rel)
    }

    fn append(&self, rel: &str, text: &str) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file(rel))
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    fn config(&self, path: &str) -> SftpConfig {
        SftpConfig {
            host: "127.0.0.1".into(),
            port: self.server.port,
            user: USER.into(),
            auth: AuthKind::Password,
            key_file: None,
            path: path.into(),
            start_mb: Some(50),
            poll_ms: 200,
        }
    }

    /// Records the server's host key (as after a confirmation).
    fn trust(&self) {
        self.hub
            .known_hosts()
            .learn(
                "127.0.0.1",
                self.server.port,
                self.server.host_key.public_key(),
            )
            .unwrap();
    }

    fn open(&self, config: SftpConfig, creds: Credentials) -> Result<SessionInfo, AppError> {
        self.manager.open_source(
            SourceConfig::Sftp(config),
            false,
            creds,
            OpenOptions::default(),
            Box::new(|_| {}),
        )
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
                format!("{:?} lines, {:?}", stats.total_lines, stats.source_status)
            },
            || done(&self.stats(info)),
        );
    }

    /// Closes the connections nobody uses any more, as the sweeper does after the idle time.
    /// A source that was closed lets go of its connection when its thread has ended.
    #[track_caller]
    fn close_unused_connections(&self) {
        wait_until_or(
            "the unused connections to close",
            || format!("{} open", self.hub.open_connections()),
            || {
                self.hub.sweep_now();
                self.hub.open_connections() == 0
            },
        );
    }

    fn texts(&self, info: &SessionInfo) -> Vec<String> {
        let total = self.stats(info).total_lines as usize;
        self.lines(info, 0, total)
    }

    fn lines(&self, info: &SessionInfo, start: usize, count: usize) -> Vec<String> {
        self.manager
            .session(info.session_id)
            .unwrap()
            .get_lines(false, start, count)
            .unwrap()
            .into_iter()
            .map(|l| l.text)
            .collect()
    }
}

/// Every file below `dir` as text (secrets must not be in any).
fn all_text(dir: &Path) -> String {
    let mut out = String::new();
    for entry in walk(dir) {
        if let Ok(bytes) = std::fs::read(&entry) {
            out.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    out
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

#[test]
fn an_unknown_host_key_needs_the_confirmed_fingerprint() {
    let fx = fixture();
    fx.append("logs/app.log", "first\n");
    // The host key comes before the password: nobody types a password for an unknown server.
    let err = fx
        .open(fx.config("/logs/app.log"), Credentials::default())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::HostKeyUnknown, "{err:?}");
    let err = fx.open(fx.config("/logs/app.log"), password()).unwrap_err();
    assert_eq!(err.code, ErrorCode::HostKeyUnknown, "{err:?}");
    let detail = err.remote.as_ref().unwrap();
    let print = fingerprint(fx.server.host_key.public_key());
    assert_eq!(detail.fingerprint.as_deref(), Some(print.as_str()));
    assert_eq!(detail.key_type.as_deref(), Some("ssh-ed25519"));
    // Another fingerprint than the one shown does not count.
    let wrong = Credentials {
        trust_fingerprint: Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()),
        ..password()
    };
    assert_eq!(
        fx.open(fx.config("/logs/app.log"), wrong).unwrap_err().code,
        ErrorCode::HostKeyUnknown
    );
    assert!(!fx.hub.known_hosts().app.exists());
    let confirmed = Credentials {
        trust_fingerprint: Some(print),
        ..password()
    };
    let info = fx.open(fx.config("/logs/app.log"), confirmed).unwrap();
    assert_eq!(info.file_name, "127.0.0.1:/logs/app.log");
    fx.wait(&info, "the first line", |s| s.total_lines >= 1);
    // Recorded in the app's file, the user's file untouched.
    let recorded = std::fs::read_to_string(&fx.hub.known_hosts().app).unwrap();
    assert!(
        recorded.contains(&format!("[127.0.0.1]:{}", fx.server.port)),
        "{recorded}"
    );
    assert!(!fx.dir.path().join("user_known_hosts").exists());
}

#[test]
fn a_changed_host_key_is_refused_even_with_a_fingerprint() {
    let fx = fixture();
    fx.append("logs/app.log", "x\n");
    // Another server (other host key) was recorded for this host and port.
    fx.hub
        .known_hosts()
        .learn(
            "127.0.0.1",
            fx.server.port,
            testserver::host_key(9).public_key(),
        )
        .unwrap();
    let print = fingerprint(fx.server.host_key.public_key());
    for creds in [
        Credentials::default(),
        password(),
        Credentials {
            trust_fingerprint: Some(print.clone()),
            ..password()
        },
    ] {
        let err = fx.open(fx.config("/logs/app.log"), creds).unwrap_err();
        assert_eq!(err.code, ErrorCode::HostKeyChanged, "{err:?}");
        let detail = err.remote.as_ref().unwrap();
        assert_eq!(detail.fingerprint.as_deref(), Some(print.as_str()));
        // Line 1 is the app's comment.
        assert_eq!(detail.known_hosts_line, Some(2));
    }
    // Nothing logged in, nothing changed in the file.
    assert_eq!(
        fx.server
            .counters
            .logins
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    let recorded = std::fs::read_to_string(&fx.hub.known_hosts().app).unwrap();
    assert_eq!(recorded.lines().count(), 2);
}

#[test]
fn passwords_are_asked_for_and_kept_only_on_request() {
    let fx = fixture();
    fx.trust();
    fx.append("logs/app.log", "x\n");
    let err = fx
        .open(fx.config("/logs/app.log"), Credentials::default())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::SecretRequired);
    let detail = err.remote.as_ref().unwrap();
    assert_eq!(
        (detail.secret, detail.wrong),
        (Some(SecretKind::Password), false)
    );
    let wrong = Credentials {
        secret: Some(Secret::new("not-it")),
        remember: true,
        ..Default::default()
    };
    let err = fx.open(fx.config("/logs/app.log"), wrong).unwrap_err();
    assert_eq!(err.code, ErrorCode::SecretRequired);
    assert!(err.remote.as_ref().unwrap().wrong);
    // A wrong password never lands in the keychain.
    assert!(fx.store.is_empty());
    // Right, without "remember": nothing stored.
    let info = fx.open(fx.config("/logs/app.log"), password()).unwrap();
    assert!(fx.store.is_empty());
    fx.manager.close(info.session_id).unwrap();
    // With "remember": stored once the login worked, and the next connect needs no secret.
    let remember = Credentials {
        remember: true,
        ..password()
    };
    // The idle connection from before is closed first, so this logs in again.
    fx.close_unused_connections();
    let info = fx.open(fx.config("/logs/app.log"), remember).unwrap();
    assert_eq!(fx.store.len(), 1);
    fx.manager.close(info.session_id).unwrap();
    fx.close_unused_connections();
    let info = fx
        .open(fx.config("/logs/app.log"), Credentials::default())
        .unwrap();
    fx.wait(&info, "the line", |s| s.total_lines >= 1);
    // Forgetting removes it.
    fx.hub
        .forget(&target(fx.server.port, AuthKind::Password))
        .unwrap();
    assert!(fx.store.is_empty());
}

#[test]
fn a_key_with_a_passphrase() {
    let public = std::fs::read_to_string(data("id_ed25519_pass.pub")).unwrap();
    let fx = fixture_with_key(Some(
        russh::keys::PublicKey::from_openssh(public.trim()).unwrap(),
    ));
    fx.trust();
    fx.append("logs/app.log", "keyed\n");
    let config = SftpConfig {
        auth: AuthKind::Key,
        key_file: Some(data("id_ed25519_pass").display().to_string()),
        ..fx.config("/logs/app.log")
    };
    let err = fx.open(config.clone(), Credentials::default()).unwrap_err();
    assert_eq!(err.code, ErrorCode::SecretRequired);
    assert_eq!(
        err.remote.as_ref().unwrap().secret,
        Some(SecretKind::Passphrase)
    );
    let wrong = Credentials {
        secret: Some(Secret::new("nope")),
        ..Default::default()
    };
    let err = fx.open(config.clone(), wrong).unwrap_err();
    assert_eq!(err.code, ErrorCode::SecretRequired);
    assert!(err.remote.as_ref().unwrap().wrong);
    let right = Credentials {
        secret: Some(Secret::new("test-passphrase")),
        remember: true,
        ..Default::default()
    };
    let info = fx.open(config.clone(), right).unwrap();
    fx.wait(&info, "the line", |s| s.total_lines >= 1);
    assert_eq!(fx.texts(&info), ["keyed"]);
    assert_eq!(fx.store.len(), 1);
    // A key the server does not know: refused, no retry with a secret.
    let other = SftpConfig {
        key_file: Some(data("id_ed25519_plain").display().to_string()),
        user: "someone".into(),
        ..config
    };
    assert_eq!(
        fx.open(other, Credentials::default()).unwrap_err().code,
        ErrorCode::AuthFailed
    );
}

#[test]
fn live_lines_rotation_truncation_and_no_shell() {
    let fx = fixture();
    fx.trust();
    fx.append(
        "logs/app.log",
        "2026-01-15 10:00:00 INFO one\n2026-01-15 10:00:01 ERROR two\n",
    );
    let info = fx.open(fx.config("/logs/app.log"), password()).unwrap();
    let source = info.source.as_ref().unwrap();
    assert_eq!(source.label, "127.0.0.1:/logs/app.log");
    // The descriptor (settings, workspace) has no secret.
    let json = serde_json::to_string(&info).unwrap();
    assert!(!json.contains(PASSWORD), "{json}");
    fx.wait(&info, "2 lines", |s| s.total_lines >= 2);
    assert_eq!(fx.stats(&info).counts.error, 1);
    // Live, with umlauts, emoji, CRLF, an escape sequence and a line in two writes.
    fx.append("logs/app.log", "2026-01-15 10:00:02 WARN Größe 😀\r\n2026-01-15 10:00:03 INFO a\x1b]0;x\x07b\n2026-01-15 10:00:04 INFO hal");
    std::thread::sleep(Duration::from_millis(400));
    fx.append("logs/app.log", "f\n");
    fx.wait(&info, "5 lines", |s| s.total_lines >= 5);
    let texts = fx.texts(&info);
    assert_eq!(texts[2], "2026-01-15 10:00:02 WARN Größe 😀");
    assert_eq!(texts[3], "2026-01-15 10:00:03 INFO a]0;x\\x07b");
    assert_eq!(texts[4], "2026-01-15 10:00:04 INFO half");
    // Rotation: renamed away, a line still written to the old file, then a new file.
    std::fs::rename(fx.file("logs/app.log"), fx.file("logs/app.log.1")).unwrap();
    fx.append(
        "logs/app.log.1",
        "2026-01-15 10:00:05 INFO late in the old file\n",
    );
    fx.append("logs/app.log", "2026-01-15 10:00:06 INFO new file\n");
    fx.wait(&info, "7 lines", |s| s.total_lines >= 7);
    let texts = fx.texts(&info);
    assert_eq!(texts[5], "2026-01-15 10:00:05 INFO late in the old file");
    assert_eq!(texts[6], "2026-01-15 10:00:06 INFO new file");
    // Truncation (copytruncate): the old lines stay, the new ones follow. The source notices
    // it when the file is shorter than what it has read (34 bytes of the new file), whether it
    // looks while the file is empty or after the next line: that line is shorter.
    let cut = "2026-01-15 10:00:07 ERROR cut\n";
    assert!(cut.len() < "2026-01-15 10:00:06 INFO new file\n".len());
    std::fs::write(fx.file("logs/app.log"), "").unwrap();
    fx.append("logs/app.log", cut);
    fx.wait(&info, "8 lines", |s| s.total_lines >= 8);
    assert_eq!(fx.texts(&info)[7], "2026-01-15 10:00:07 ERROR cut");
    let status = fx.stats(&info).source_status.unwrap();
    assert_eq!(status.state, SourceState::Connected);
    assert!(status.bytes > 100 && status.latency_ms.is_some());
    assert_eq!(status.received, 8);
    // Only the SFTP subsystem was asked for.
    assert_eq!(
        fx.server
            .counters
            .forbidden
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    // Closing the tab deletes the spool, the connection is unused from then on and goes with
    // the next sweep after the idle time.
    let spool = PathBuf::from(&source.spool_path);
    fx.manager.close(info.session_id).unwrap();
    assert!(!spool.exists());
    assert_eq!(fx.hub.open_connections(), 1);
    fx.close_unused_connections();
}

#[test]
fn a_dropped_connection_comes_back_and_goes_on_at_the_offset() {
    let mut fx = fixture();
    fx.trust();
    fx.append("logs/app.log", "line 1\n");
    let info = fx.open(fx.config("/logs/app.log"), password()).unwrap();
    fx.wait(&info, "1 line", |s| s.total_lines >= 1);
    // Dropped while the server stays: back at once (the secret stayed in memory).
    fx.server.kick();
    fx.append("logs/app.log", "line 2\n");
    fx.wait(&info, "2 lines", |s| s.total_lines >= 2);
    assert_eq!(
        fx.server
            .counters
            .logins
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    fx.wait(&info, "connected again", |s| {
        s.source_status.as_ref().unwrap().state == SourceState::Connected
    });
    // The server goes away: waiting with growing pauses, the lines stay.
    let (root, port) = (fx.server.root.clone(), fx.server.port);
    fx.server.stop();
    fx.wait(&info, "reconnecting", |s| {
        matches!(
            s.source_status.as_ref().unwrap().state,
            SourceState::Reconnecting { .. }
        )
    });
    fx.append("logs/app.log", "line 3 written while away\n");
    // The system may need a moment until the port can be bound again.
    let mut server = None;
    wait_until("the port of the server to be free again", || {
        server = testserver::start(root.clone(), port, 1, None).ok();
        server.is_some()
    });
    fx.server = server.unwrap();
    fx.wait(&info, "3 lines", |s| s.total_lines >= 3);
    fx.wait(&info, "connected", |s| {
        s.source_status.as_ref().unwrap().state == SourceState::Connected
    });
    assert_eq!(
        fx.texts(&info),
        ["line 1", "line 2", "line 3 written while away"]
    );
    let status = fx.stats(&info).source_status.unwrap();
    assert!(!format!("{status:?}").contains(PASSWORD));
}

#[test]
fn a_refused_login_while_away_is_not_retried_and_says_so() {
    // Retrying a refused login would lock accounts (fail2ban): the source stops and says why.
    let fx = fixture();
    fx.trust();
    fx.append("logs/app.log", "line 1\n");
    let info = fx.open(fx.config("/logs/app.log"), password()).unwrap();
    fx.wait(&info, "1 line", |s| s.total_lines >= 1);
    // The server refuses the password now (changed) and drops the connection.
    fx.server
        .counters
        .refuse_all
        .store(true, std::sync::atomic::Ordering::SeqCst);
    fx.server.kick();
    fx.wait(&info, "an error", |s| {
        matches!(
            s.source_status.as_ref().unwrap().state,
            SourceState::Error { .. }
        )
    });
    let logins = fx
        .server
        .counters
        .logins
        .load(std::sync::atomic::Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(
        fx.server
            .counters
            .logins
            .load(std::sync::atomic::Ordering::SeqCst),
        logins
    );
}

#[test]
fn files_of_one_server_share_a_connection_and_the_browser_too() {
    let fx = fixture();
    fx.trust();
    fx.append("logs/a.log", "a\n");
    fx.append("logs/b.log", "b\n");
    std::fs::create_dir_all(fx.file("logs/archive")).unwrap();
    let listing = fx
        .hub
        .list(
            &target(fx.server.port, AuthKind::Password),
            &password(),
            "/logs",
        )
        .unwrap();
    assert_eq!(listing.path, "/logs");
    let names: Vec<_> = listing
        .entries
        .iter()
        .map(|e| (e.name.as_str(), e.dir))
        .collect();
    assert_eq!(
        names,
        [("archive", true), ("a.log", false), ("b.log", false)]
    );
    assert_eq!(listing.entries[1].size, Some(2));
    // The browser's connection serves the files: no new login, no secret needed.
    let a = fx
        .open(fx.config("/logs/a.log"), Credentials::default())
        .unwrap();
    let b = fx
        .open(fx.config("/logs/b.log"), Credentials::default())
        .unwrap();
    fx.wait(&a, "a", |s| s.total_lines >= 1);
    fx.wait(&b, "b", |s| s.total_lines >= 1);
    assert_eq!(
        fx.server
            .counters
            .logins
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(fx.hub.open_connections(), 1);
    // Errors for paths that are no files.
    assert_eq!(
        fx.open(fx.config("/logs/missing.log"), Credentials::default())
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        fx.open(fx.config("/logs/archive"), Credentials::default())
            .unwrap_err()
            .code,
        ErrorCode::IsADirectory
    );
}

#[test]
fn a_large_file_starts_at_the_last_megabytes_on_a_line_start() {
    let fx = fixture();
    fx.trust();
    let mut text = String::new();
    let mut i = 0;
    while text.len() < 3 * 1024 * 1024 {
        text.push_str(&format!("2026-01-15 10:00:00 INFO line {i:07}\n"));
        i += 1;
    }
    std::fs::write(fx.file("logs/big.log"), &text).unwrap();
    let config = SftpConfig {
        start_mb: Some(1),
        ..fx.config("/logs/big.log")
    };
    let info = fx.open(config, password()).unwrap();
    let expected = text[text.len() - 1024 * 1024..].matches('\n').count() as u64;
    // All of it is there when the last line of the file is: from the megabyte's first whole
    // line on, so one line fewer if the megabyte begins inside a line.
    let last_line = format!("2026-01-15 10:00:00 INFO line {:07}", i - 1);
    let last = || {
        let total = fx.stats(&info).total_lines as usize;
        fx.lines(&info, total.saturating_sub(1), 1).pop()
    };
    wait_until_or(
        "the last line of the file",
        || format!("{:?} of {} lines", last(), fx.stats(&info).total_lines),
        || last().as_deref() == Some(last_line.as_str()),
    );
    let total = fx.stats(&info).total_lines;
    assert!(total == expected || total == expected - 1, "{total}");
    let first = fx.lines(&info, 0, 1);
    assert!(
        first[0].starts_with("2026-01-15 10:00:00 INFO line "),
        "{}",
        first[0]
    );
    // The whole file.
    let whole = SftpConfig {
        start_mb: None,
        ..fx.config("/logs/big.log")
    };
    let info = fx.open(whole, Credentials::default()).unwrap();
    fx.wait(&info, "all lines, nothing left to fetch", |s| {
        s.total_lines >= i && s.source_status.as_ref().unwrap().pending_bytes == 0
    });
    assert_eq!(fx.stats(&info).total_lines, i);
}

#[test]
fn no_secret_in_spool_settings_errors_or_known_hosts() {
    let fx = fixture();
    fx.trust();
    fx.append("logs/app.log", "x\n");
    let mut seen = String::new();
    let err = fx
        .open(
            fx.config("/logs/app.log"),
            Credentials {
                secret: Some(Secret::new(format!("{PASSWORD}-wrong"))),
                ..Default::default()
            },
        )
        .unwrap_err();
    seen.push_str(&serde_json::to_string(&err).unwrap());
    let info = fx.open(fx.config("/logs/app.log"), password()).unwrap();
    fx.wait(&info, "the line", |s| s.total_lines >= 1);
    seen.push_str(&serde_json::to_string(&info).unwrap());
    seen.push_str(&serde_json::to_string(&fx.stats(&info)).unwrap());
    seen.push_str(&all_text(fx.dir.path().join("cache").as_path()));
    seen.push_str(&all_text(fx.dir.path().join("config").as_path()));
    assert!(!seen.contains(PASSWORD), "a secret leaked");
    assert!(!seen.contains("testSecretQx7"));
}

// ---- Against OpenSSH in Docker -------------------------------------------------------------

/// `LC_SSHD_TEST=127.0.0.1:2222` and the keys of `tests/sshd/start.sh`.
fn docker() -> Option<(String, u16, PathBuf)> {
    let addr = std::env::var("LC_SSHD_TEST").ok()?;
    let (host, port) = addr.rsplit_once(':')?;
    let keys = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/sshd-test");
    Some((host.to_string(), port.parse().ok()?, keys))
}

fn docker_exec(script: &str) {
    let status = std::process::Command::new("docker")
        .args(["exec", "lc-test-sshd", "sh", "-c", script])
        .status()
        .unwrap();
    assert!(status.success(), "{script}");
}

#[test]
#[ignore]
fn openssh_live_rotation_truncation_reconnect_and_changed_key() {
    let Some((host, port, keys)) = docker() else {
        eprintln!("LC_SSHD_TEST not set: skipped");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    let known = KnownHosts {
        user: None,
        app: dir.path().join("known_hosts"),
    };
    let hub = Arc::new(Hub::new(known.clone(), None, store.clone()));
    let manager = SessionManager::default();
    manager.set_spool_root(Arc::new(
        SpoolRoot::prepare(&dir.path().join("cache")).unwrap(),
    ));
    manager.set_remote(Arc::clone(&hub));
    docker_exec(
        "printf 'one\\ntwo\\n' > /var/log/app/live.log && chown test /var/log/app/live.log",
    );
    let config = SftpConfig {
        host: host.clone(),
        port,
        user: "test".into(),
        auth: AuthKind::Key,
        key_file: Some(keys.join("id_ed25519_pass").display().to_string()),
        path: "/var/log/app/live.log".into(),
        start_mb: Some(50),
        poll_ms: 200,
    };
    let open = |creds: Credentials| {
        manager.open_source(
            SourceConfig::Sftp(config.clone()),
            false,
            creds,
            OpenOptions::default(),
            Box::new(|_| {}),
        )
    };
    // The key file is read before connecting: the passphrase first.
    assert_eq!(
        open(Credentials::default()).unwrap_err().code,
        ErrorCode::SecretRequired
    );
    let passphrase = || Credentials {
        secret: Some(Secret::new("test-passphrase")),
        ..Default::default()
    };
    let err = open(passphrase()).unwrap_err();
    assert_eq!(err.code, ErrorCode::HostKeyUnknown);
    let print = err.remote.unwrap().fingerprint.unwrap();
    let creds = Credentials {
        secret: Some(Secret::new("test-passphrase")),
        trust_fingerprint: Some(print),
        ..Default::default()
    };
    let info = open(creds).unwrap();
    let session = manager.session(info.session_id).unwrap();
    let wait = |what: &str, n: u64| {
        wait_until_or(
            what,
            || format!("{:?}", session.stats().source_status),
            || session.stats().total_lines >= n,
        );
    };
    wait("2 lines", 2);
    docker_exec("echo three >> /var/log/app/live.log");
    wait("3 lines", 3);
    docker_exec("mv /var/log/app/live.log /var/log/app/live.log.1 && echo late >> /var/log/app/live.log.1 && echo four > /var/log/app/live.log && chown test /var/log/app/live.log");
    wait("rotation", 5);
    docker_exec(": > /var/log/app/live.log && sleep 1 && echo five >> /var/log/app/live.log");
    wait("truncation", 6);
    let texts: Vec<String> = session
        .get_lines(false, 0, 6)
        .unwrap()
        .into_iter()
        .map(|l| l.text)
        .collect();
    assert_eq!(texts, ["one", "two", "three", "late", "four", "five"]);
    // Reconnect: sshd restarted (container stays), the source goes on at the offset.
    docker_exec("pkill -f '^sshd: test' || true");
    docker_exec("echo six >> /var/log/app/live.log");
    wait("after reconnect", 7);
    // A changed host key: the recorded line now names another key.
    let other = testserver::host_key(77);
    std::fs::write(
        &known.app,
        format!(
            "[{host}]:{port} {}\n",
            other.public_key().to_openssh().unwrap()
        ),
    )
    .unwrap();
    hub.close_all();
    let err = open(passphrase()).unwrap_err();
    assert_eq!(err.code, ErrorCode::HostKeyChanged);
    assert!(store.len() <= 1);
}

/// The SSH agent, with a throwaway agent only (never your own):
/// `eval $(ssh-agent -a /tmp/lca.sock) && SSH_AUTH_SOCK=/tmp/lca.sock ssh-add tests/data/sftp/id_ed25519_plain`
/// `LC_AGENT_TEST=1 SSH_AUTH_SOCK=/tmp/lca.sock cargo test --test sftp_integration -- --ignored agent`
#[test]
#[ignore]
fn agent_login() {
    if std::env::var("LC_AGENT_TEST").is_err() {
        eprintln!("LC_AGENT_TEST not set: skipped");
        return;
    }
    let public = std::fs::read_to_string(data("id_ed25519_plain.pub")).unwrap();
    let fx = fixture_with_key(Some(
        russh::keys::PublicKey::from_openssh(public.trim()).unwrap(),
    ));
    fx.trust();
    fx.append("logs/app.log", "by agent\n");
    let config = SftpConfig {
        auth: AuthKind::Agent,
        ..fx.config("/logs/app.log")
    };
    let info = fx.open(config, Credentials::default()).unwrap();
    fx.wait(&info, "the line", |s| s.total_lines >= 1);
    assert_eq!(fx.texts(&info), ["by agent"]);
}

#[test]
fn a_revoked_key_is_refused_even_with_its_fingerprint_and_known() {
    let fx = fixture();
    fx.append("logs/app.log", "x\n");
    let key = fx.server.host_key.public_key().to_openssh().unwrap();
    // Trusted with a tab and mixed case, and revoked for every host.
    std::fs::write(
        fx.dir.path().join("user_known_hosts"),
        format!("[127.0.0.1]:{}\t{key}\n@revoked * {key}\n", fx.server.port),
    )
    .unwrap();
    let print = fingerprint(fx.server.host_key.public_key());
    for creds in [
        Credentials::default(),
        Credentials {
            trust_fingerprint: Some(print),
            ..password()
        },
    ] {
        let err = fx.open(fx.config("/logs/app.log"), creds).unwrap_err();
        assert_eq!(err.code, ErrorCode::HostKeyChanged, "{err:?}");
        assert_eq!(
            err.remote.as_ref().unwrap().reason.as_deref(),
            Some("revoked")
        );
        assert!(err.message.contains("@revoked"), "{}", err.message);
    }
    assert!(!fx.hub.known_hosts().app.exists());
}

#[test]
fn user_known_hosts_with_tabs_patterns_and_odd_lines() {
    let fx = fixture();
    fx.append("logs/app.log", "x\n");
    let key = fx.server.host_key.public_key().to_openssh().unwrap();
    let (kind, b64) = key.split_once(' ').unwrap();
    let user = fx.dir.path().join("user_known_hosts");
    // A broken line first must not hide the usable one; a tab separated pattern line matches.
    std::fs::write(
        &user,
        format!(
            "# mine\n\n[127.0.0.1]:{port} ssh-ed25519 !!broken\n[127.0.0.?]:{port},!other\t{kind}\t{b64}\n",
            port = fx.server.port
        ),
    )
    .unwrap();
    let info = fx.open(fx.config("/logs/app.log"), password()).unwrap();
    fx.wait(&info, "the line", |s| s.total_lines >= 1);
    fx.manager.close(info.session_id).unwrap();
    // Only the broken line: recorded, so refused instead of "unknown" (no one-click trust).
    std::fs::write(
        &user,
        format!("[127.0.0.1]:{} ssh-ed25519 !!broken\n", fx.server.port),
    )
    .unwrap();
    fx.hub.close_all();
    let err = fx.open(fx.config("/logs/app.log"), password()).unwrap_err();
    assert_eq!(err.code, ErrorCode::HostKeyChanged);
    assert_eq!(err.remote.unwrap().reason.as_deref(), Some("unusable"));
    // An @cert-authority line for the host: not supported, refused.
    std::fs::write(
        &user,
        format!(
            "@cert-authority [127.0.0.1]:* {}\n",
            testserver::host_key(5).public_key().to_openssh().unwrap()
        ),
    )
    .unwrap();
    let err = fx.open(fx.config("/logs/app.log"), password()).unwrap_err();
    assert_eq!(
        err.remote.unwrap().reason.as_deref(),
        Some("cert_authority")
    );
}

#[test]
fn the_server_cannot_open_channels_towards_the_app() {
    let fx = fixture();
    fx.trust();
    fx.append("logs/app.log", "x\n");
    let info = fx.open(fx.config("/logs/app.log"), password()).unwrap();
    fx.wait(&info, "the line", |s| s.total_lines >= 1);
    let before =
        log_commander_lib::remote::REFUSED_CHANNELS.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(fx.server.open_channels_to_clients(), 0);
    let after =
        log_commander_lib::remote::REFUSED_CHANNELS.load(std::sync::atomic::Ordering::SeqCst);
    // Agent, X11, forwarded and direct TCP, session: each refused (the counter is shared by tests).
    assert!(after >= before + 5, "{before} → {after}");
    // The source goes on.
    fx.append("logs/app.log", "y\n");
    fx.wait(&info, "the next line", |s| s.total_lines >= 2);
}

#[test]
fn listings_are_capped_and_resolve_a_bounded_number_of_links() {
    let fx = fixture();
    fx.trust();
    let dir = fx.file("many");
    std::fs::create_dir_all(dir.join("target")).unwrap();
    for i in 0..30 {
        std::fs::write(dir.join(format!("f{i:02}.log")), "x").unwrap();
    }
    #[cfg(unix)]
    for i in 0..12 {
        std::os::unix::fs::symlink(dir.join("target"), dir.join(format!("link{i:02}"))).unwrap();
    }
    let lease = fx
        .hub
        .lease(&target(fx.server.port, AuthKind::Password), &password())
        .unwrap();
    let conn = lease.get().unwrap();
    let capped = conn.list_with("/many", 10, 200).unwrap();
    assert_eq!(capped.entries.len(), 10);
    assert!(capped.truncated);
    let all = conn.list_with("/many", 1000, 5).unwrap();
    assert!(!all.truncated);
    assert_eq!(all.entries.len(), 31 + if cfg!(unix) { 12 } else { 0 });
    #[cfg(unix)]
    {
        // `target` plus 5 resolved links are folders; the other 7 links stay unknown (not folders).
        let dirs = all.entries.iter().filter(|e| e.dir).count();
        assert_eq!(dirs, 1 + 5, "{:?}", all.entries);
    }
}
