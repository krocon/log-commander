//! Tests of the database source (prompt 019): configuration, passwords, column checks, and the
//! flow through spool and session against the fake (`fake.rs`) and a real SQLite file. The
//! servers (PostgreSQL, MySQL, MariaDB, SQL Server) are covered by `tests/db_integration.rs`
//! (`--ignored`, Docker).

use super::fake::FakeDb;
use super::value::{ColKind, Column, Value};
use super::*;
use crate::level::Level;
use crate::model::{SessionInfo, SourceState};
use crate::remote::secrets::MemoryStore;
use crate::session::{OpenOptions, SessionManager};
use crate::spool::{SpoolConfig, SpoolRoot};
use crate::test_support::{stays_false, wait_until, wait_until_or};
use std::time::Duration;

fn pg() -> DbConfig {
    serde_json::from_value(serde_json::json!({
        "engine": "postgres",
        "host": "db.example",
        "database": "app",
        "user": "reader",
        "query": "SELECT * FROM app.logs",
        "keyColumn": "id",
        "timeColumn": "ts",
        "levelColumn": "sev",
        "intervalMs": 500,
    }))
    .unwrap()
}

fn col(name: &str, kind: ColKind) -> Column {
    Column {
        name: name.into(),
        type_name: format!("{kind:?}"),
        kind,
    }
}

#[test]
fn configs_are_checked() {
    let c = pg();
    assert_eq!(c.validate().unwrap(), "SELECT * FROM app.logs");
    assert_eq!(c.label(), "db:app.logs");
    assert_eq!(c.port_or_default(), 5432);
    assert_eq!(c.tls, TlsMode::Verify);
    assert_eq!(c.auth, DbAuth::Password);
    assert_eq!(c.start_last, Some(DEFAULT_START_LAST));
    assert_eq!(c.where_label(), "db.example:5432/app");
    let bad = |f: fn(&mut DbConfig)| {
        let mut c = pg();
        f(&mut c);
        c.validate().is_err()
    };
    assert!(bad(|c| c.host = String::new()));
    assert!(bad(|c| c.host = "-oProxyCommand".into()));
    assert!(bad(|c| c.host = "db host".into()));
    assert!(bad(|c| c.user = String::new()));
    assert!(bad(|c| c.user = "a\nb".into()));
    assert!(bad(|c| c.query = "DELETE FROM logs".into()));
    assert!(bad(|c| c.query = "SELECT 1; DROP TABLE logs".into()));
    assert!(bad(|c| c.key_column = " ".into()));
    assert!(bad(|c| c.interval_ms = 10));
    assert!(bad(|c| c.start_last = Some(0)));
    assert!(bad(|c| c.ca_file = "relative.pem".into()));
    let mut ms = pg();
    ms.engine = Dialect::Mssql;
    ms.auth = DbAuth::None;
    assert!(ms.validate().is_err());
    let mut lite = pg();
    lite.engine = Dialect::Sqlite;
    lite.path = "relative.db".into();
    assert!(lite.validate().is_err());
    // Absolute on every platform ("/var/log/app.db" is not absolute on Windows).
    lite.path = std::env::temp_dir()
        .join("app.db")
        .to_string_lossy()
        .into_owned();
    lite.query = "SELECT 1 AS id".into();
    assert!(lite.validate().is_ok());
    assert_eq!(lite.label(), "db:app.db");
    // No field for a secret, also not when one is sent.
    let parsed: DbConfig = serde_json::from_value(serde_json::json!({
        "engine": "mysql", "host": "h", "user": "u", "query": "SELECT 1", "keyColumn": "x",
        "password": "geheim",
    }))
    .unwrap();
    assert_eq!(parsed.interval_ms, DEFAULT_INTERVAL_MS);
    assert_eq!(parsed.port_or_default(), 3306);
    let v = serde_json::to_string(&parsed).unwrap();
    assert!(!v.contains("geheim") && !v.contains("\"password\":"), "{v}");
    // Keychain account: hashed, its own scope.
    let a = pg().account();
    assert!(a.starts_with("db:password:"), "{a}");
    assert!(!a.contains("reader") && !a.contains("db.example"));
    let mut other = pg();
    other.database = "other".into();
    assert_ne!(other.account(), a);
}

#[test]
fn columns_are_checked_before_the_start() {
    let columns = vec![
        col("ID", ColKind::Int),
        col("ts", ColKind::TimestampTz),
        col("sev", ColKind::Text),
        col("payload", ColKind::Bytes),
    ];
    let l = layout(&pg(), columns.clone()).unwrap();
    assert_eq!((l.key, l.time, l.level), (0, Some(1), Some(2)));
    let mut c = pg();
    c.key_column = "nope".into();
    let e = layout(&c, columns.clone()).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidQuery);
    assert!(e.message.contains("ID, ts, sev, payload"), "{}", e.message);
    c.key_column = "payload".into();
    assert!(layout(&c, columns.clone())
        .unwrap_err()
        .message
        .contains("nicht sortierbar"));
    c.key_column = "id".into();
    c.time_column = "zeit".into();
    assert!(layout(&c, columns.clone()).is_err());
    assert!(layout(&pg(), Vec::new()).is_err());
    let many: Vec<Column> = (0..=MAX_COLUMNS)
        .map(|i| col(&format!("c{i}"), ColKind::Int))
        .collect();
    let mut c = pg();
    c.key_column = "c0".into();
    c.time_column = String::new();
    c.level_column = String::new();
    assert!(layout(&c, many).is_err());
}

fn table() -> FakeDb {
    let db = FakeDb::default();
    {
        let mut s = db.state.lock();
        s.columns = vec![
            col("id", ColKind::Int),
            col("ts", ColKind::Text),
            col("sev", ColKind::Text),
            col("msg", ColKind::Text),
        ];
    }
    db
}

fn row(id: i64, ts: &str, sev: &str, msg: &str) -> Vec<Value> {
    vec![
        Value::I64(id),
        Value::Text(ts.into()),
        Value::Text(sev.into()),
        Value::Text(msg.into()),
    ]
}

#[test]
fn passwords_are_asked_for_and_kept_only_on_request() {
    let db = table();
    db.state.lock().password = Some("pässwört 🔑".into());
    let opener = db.opener();
    let store = MemoryStore::default();
    let e = DbSource::open_with(
        pg(),
        &Credentials::default(),
        Some(&store),
        Arc::clone(&opener),
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::SecretRequired);
    assert!(!e.remote.unwrap().wrong);
    let wrong = Credentials {
        secret: Some(Secret::new("falsch")),
        remember: true,
        trust_fingerprint: None,
    };
    let e = DbSource::open_with(pg(), &wrong, Some(&store), Arc::clone(&opener)).unwrap_err();
    assert_eq!(e.code, ErrorCode::SecretRequired);
    assert!(e.remote.as_ref().unwrap().wrong);
    assert!(!e.message.contains("falsch"));
    assert!(store.is_empty());
    let right = Credentials {
        secret: Some(Secret::new("pässwört 🔑")),
        remember: false,
        trust_fingerprint: None,
    };
    assert!(DbSource::open_with(pg(), &right, Some(&store), Arc::clone(&opener)).is_ok());
    assert!(store.is_empty());
    let keep = Credentials {
        remember: true,
        ..right
    };
    let source = DbSource::open_with(pg(), &keep, Some(&store), Arc::clone(&opener)).unwrap();
    assert_eq!(store.len(), 1);
    assert!(!format!("{source:?}").contains("pässwört"));
    assert!(!source.config().to_string().contains("pässwört"));
    assert!(DbSource::open_with(
        pg(),
        &Credentials::default(),
        Some(&store),
        Arc::clone(&opener)
    )
    .is_ok());
    forget(&pg(), &store).unwrap();
    assert!(store.is_empty());
    // Review 019 #2: a password stored with certificate check is not used with a weaker TLS mode
    // (a workspace could switch it off); one stored with a weaker mode works with a stricter one.
    let keep_verify = Credentials {
        secret: Some(Secret::new("pässwört 🔑")),
        remember: true,
        trust_fingerprint: None,
    };
    DbSource::open_with(pg(), &keep_verify, Some(&store), Arc::clone(&opener)).unwrap();
    for weaker in [TlsMode::NoVerify, TlsMode::Off] {
        let mut c = pg();
        c.tls = weaker;
        let e = DbSource::open_with(
            c,
            &Credentials::default(),
            Some(&store),
            Arc::clone(&opener),
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::SecretRequired, "{weaker:?}");
    }
    forget(&pg(), &store).unwrap();
    let mut off = pg();
    off.tls = TlsMode::Off;
    DbSource::open_with(off.clone(), &keep_verify, Some(&store), Arc::clone(&opener)).unwrap();
    assert!(DbSource::open_with(
        pg(),
        &Credentials::default(),
        Some(&store),
        Arc::clone(&opener)
    )
    .is_ok());
    forget(&pg(), &store).unwrap();
    assert!(store.is_empty());
    // Without a password the keychain is never asked.
    let mut none = pg();
    none.auth = DbAuth::None;
    db.state.lock().password = None;
    assert!(DbSource::open_with(none, &Credentials::default(), None, opener).is_ok());
}

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

fn no_password(mut c: DbConfig) -> DbConfig {
    c.auth = DbAuth::None;
    c
}

impl Fixture {
    fn open(&self, config: DbConfig, opener: Arc<Opener>) -> SessionInfo {
        let source = DbSource::open_with(config, &Credentials::default(), None, opener).unwrap();
        let root = self.manager.spool_root().unwrap();
        self.manager
            .open_prepared_source(
                Box::new(source),
                SpoolConfig::sized(root.new_dir(), 1 << 20, 4),
                false,
                OpenOptions::default(),
                Box::new(|_| {}),
            )
            .unwrap()
    }

    fn lines(&self, info: &SessionInfo) -> Vec<(String, Level)> {
        let session = self.manager.session(info.session_id).unwrap();
        let total = session.stats().total_lines as usize;
        session
            .get_lines(false, 0, total)
            .unwrap()
            .into_iter()
            .map(|l| (l.text, l.level))
            .collect()
    }

    fn ids(&self, info: &SessionInfo) -> Vec<i64> {
        self.lines(info)
            .iter()
            .map(|(t, _)| {
                serde_json::from_str::<serde_json::Value>(t).unwrap()["id"]
                    .as_i64()
                    .unwrap()
            })
            .collect()
    }

    #[track_caller]
    fn wait(&self, info: &SessionInfo, what: &str, done: impl Fn(&Self) -> bool) {
        wait_until_or(
            what,
            || {
                let stats = self.manager.session(info.session_id).unwrap().stats();
                format!("{} lines, {:?}", stats.total_lines, stats.source_status)
            },
            || done(self),
        );
    }

    /// Waits until `count` more queries have ended than now. A query that was under way may be the
    /// first of them, so ask for one more than the test needs.
    #[track_caller]
    fn wait_for_polls(&self, info: &SessionInfo, count: usize) {
        let polled = || {
            let stats = self.manager.session(info.session_id).unwrap().stats();
            stats.source_status.unwrap().polled_at_ms
        };
        for n in 1..=count {
            let before = polled();
            wait_until(&format!("query {n} of {count} to end"), || {
                polled() != before
            });
        }
    }

    fn state(&self, info: &SessionInfo) -> SourceState {
        self.manager
            .session(info.session_id)
            .unwrap()
            .stats()
            .source_status
            .unwrap()
            .state
    }
}

#[test]
fn last_rows_first_then_new_ones_with_level_and_columns() {
    let fx = fixture();
    let db = table();
    {
        let mut s = db.state.lock();
        for i in 1..=10 {
            s.rows
                .push(row(i, &format!("2026-11-08T10:00:{i:02}"), "INFO", "alt"));
        }
    }
    let mut c = no_password(pg());
    c.start_last = Some(3);
    let info = fx.open(c, db.opener());
    let source = info.source.as_ref().unwrap();
    assert_eq!(source.label, "db:app.logs");
    assert_eq!(source.kind, SourceKind::Database);
    assert!(source.config.get("password").is_none());
    assert_eq!(info.update.profile_id, "jsonl");
    fx.wait(&info, "the last three", |f| f.ids(&info) == [8, 9, 10]);
    {
        let mut s = db.state.lock();
        s.rows.push(row(
            11,
            "2026-11-08T10:01:00",
            "ERROR",
            "Grüße 🎉\nzweite Zeile",
        ));
        s.rows.push(row(12, "2026-11-08T10:01:01", "WARN", "w"));
    }
    fx.wait(&info, "new rows", |f| f.ids(&info) == [8, 9, 10, 11, 12]);
    let lines = fx.lines(&info);
    assert_eq!(lines[3].1, Level::Error);
    assert_eq!(lines[4].1, Level::Warn);
    assert!(
        lines[3]
            .0
            .starts_with("{\"timestamp\":\"2026-11-08T10:01:00\",\"level\":\"ERROR\",\"id\":11,"),
        "{}",
        lines[3].0
    );
    assert!(lines[3].0.contains("\\n"));
    let status = fx
        .manager
        .session(info.session_id)
        .unwrap()
        .stats()
        .source_status
        .unwrap();
    assert!(status.polled_at_ms.is_some() && status.latency_ms.is_some());
    assert_eq!(status.received, 5);
    fx.wait(&info, "idle", |f| f.state(&info) == SourceState::Connected);
}

#[test]
fn equal_keys_are_neither_lost_nor_doubled() {
    let fx = fixture();
    let db = table();
    {
        let mut s = db.state.lock();
        // A time key with many equal values; the fake returns ties in changing order.
        s.columns[0] = col("id", ColKind::Int);
        for i in 0..5 {
            s.rows
                .push(row(i, "2026-11-08T10:00:00", "INFO", &format!("a{i}")));
        }
    }
    let mut c = no_password(pg());
    c.key_column = "ts".into();
    c.time_column = String::new();
    c.start_last = None;
    let info = fx.open(c, db.opener());
    fx.wait(&info, "first", |f| f.lines(&info).len() == 5);
    {
        let mut s = db.state.lock();
        // More with the same time, and later ones.
        for i in 5..8 {
            s.rows
                .push(row(i, "2026-11-08T10:00:00", "INFO", &format!("a{i}")));
        }
        s.rows.push(row(8, "2026-11-08T10:00:01", "INFO", "b"));
    }
    fx.wait(&info, "more", |f| f.lines(&info).len() >= 9);
    let batches = db.state.lock().batches;
    wait_until("three more batches", || {
        db.state.lock().batches >= batches + 3
    });
    let mut ids = fx.ids(&info);
    ids.sort();
    assert_eq!(ids, (0..9).collect::<Vec<_>>());
}

#[test]
fn a_broken_connection_goes_on_from_the_last_key() {
    let fx = fixture();
    let db = table();
    db.state.lock().rows.push(row(1, "t", "INFO", "x"));
    let mut c = no_password(pg());
    c.start_last = None;
    let info = fx.open(c, db.opener());
    fx.wait(&info, "first", |f| f.ids(&info) == [1]);
    {
        let mut s = db.state.lock();
        s.fail_requests = 1;
        s.down = true;
        s.rows.push(row(2, "t", "INFO", "y"));
    }
    fx.wait(&info, "reconnecting", |f| {
        matches!(f.state(&info), SourceState::Reconnecting { .. })
    });
    db.state.lock().rows.push(row(3, "t", "INFO", "z"));
    db.state.lock().down = false;
    fx.wait(&info, "after reconnect", |f| f.ids(&info) == [1, 2, 3]);
    assert!(db.state.lock().connects >= 2);
}

#[test]
fn a_refused_login_is_not_retried() {
    let fx = fixture();
    let db = table();
    db.state.lock().rows.push(row(1, "t", "INFO", "x"));
    let mut c = pg();
    c.start_last = None;
    let creds = Credentials {
        secret: Some(Secret::new("richtig")),
        remember: false,
        trust_fingerprint: None,
    };
    db.state.lock().password = Some("richtig".into());
    let source = DbSource::open_with(c, &creds, None, db.opener()).unwrap();
    let root = fx.manager.spool_root().unwrap();
    let info = fx
        .manager
        .open_prepared_source(
            Box::new(source),
            SpoolConfig::sized(root.new_dir(), 1 << 20, 4),
            false,
            OpenOptions::default(),
            Box::new(|_| {}),
        )
        .unwrap();
    fx.wait(&info, "first", |f| f.ids(&info) == [1]);
    {
        let mut s = db.state.lock();
        s.fail_requests = 1;
        s.password = Some("geändert".into());
    }
    fx.wait(&info, "error", |f| {
        matches!(f.state(&info), SourceState::Error { .. })
    });
    // The error state is the signal; a retry would come after 1 s of backoff.
    let connects = db.state.lock().connects;
    assert!(stays_false(Duration::from_millis(1500), || {
        db.state.lock().connects != connects
    }));
}

// --- SQLite, a real file (no Docker needed) ---

fn sqlite_file(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("app.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE logs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, level TEXT, msg TEXT, data BLOB);
         CREATE TABLE secrets (x TEXT);
         INSERT INTO logs (ts, level, msg, data) VALUES
           ('2026-11-08T10:00:00', 'INFO', 'Start', NULL),
           ('2026-11-08T10:00:01', 'ERROR', 'Grüße 🎉 \u{202E}', x'00ff'),
           ('2026-11-08T10:00:01', 'WARN', 'gleiche Zeit', NULL);",
    )
    .unwrap();
    path
}

fn lite(path: &std::path::Path) -> DbConfig {
    serde_json::from_value(serde_json::json!({
        "engine": "sqlite",
        "path": path.display().to_string(),
        "query": "SELECT * FROM logs",
        "keyColumn": "ts",
        "timeColumn": "ts",
        "levelColumn": "level",
        "intervalMs": 500,
        "startLast": null,
    }))
    .unwrap()
}

#[test]
fn sqlite_rows_live_with_equal_times() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path());
    let fx = fixture();
    let preview = preview(&lite(&path), &Credentials::default(), None).unwrap();
    assert_eq!(preview.lines.len(), 3);
    assert!(
        preview.lines[1].contains("\"data\":\"(binär, 2 Byte)\""),
        "{}",
        preview.lines[1]
    );
    assert!(preview.lines[1].contains("\\u202E"));
    let listed = tables(&lite(&path), &Credentials::default(), None).unwrap();
    assert_eq!(
        listed.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["logs", "secrets"]
    );
    let info = fx.open(lite(&path), Arc::new(system_open));
    assert_eq!(info.source.as_ref().unwrap().label, "db:logs");
    fx.wait(&info, "three", |f| f.lines(&info).len() == 3);
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer
        .execute_batch(
            "INSERT INTO logs (ts, level, msg) VALUES ('2026-11-08T10:00:01', 'INFO', 'noch eine');
             INSERT INTO logs (ts, level, msg) VALUES ('2026-11-08T10:00:02', 'DEBUG', 'später');",
        )
        .unwrap();
    fx.wait(&info, "new", |f| f.lines(&info).len() == 5);
    // Later queries see the rows of the last time again (same key) and must not write them twice:
    // after two more queries the source still has written five lines.
    fx.wait_for_polls(&info, 3);
    let status = fx.manager.session(info.session_id).unwrap().stats();
    assert_eq!(status.source_status.unwrap().received, 5);
    let lines = fx.lines(&info);
    assert_eq!(lines.len(), 5, "{lines:?}");
    assert_eq!(
        lines.iter().map(|l| l.1).collect::<Vec<_>>(),
        [
            Level::Info,
            Level::Error,
            Level::Warn,
            Level::Info,
            Level::Debug
        ]
    );
}

#[test]
fn sqlite_is_never_written() {
    let dir = tempfile::tempdir().unwrap();
    let path = sqlite_file(dir.path());
    let before = std::fs::read(&path).unwrap();
    let count = || -> i64 {
        rusqlite::Connection::open(&path)
            .unwrap()
            .query_row("SELECT count(*) FROM logs", [], |r| r.get(0))
            .unwrap()
    };
    // The check refuses writing queries before anything connects.
    for q in [
        "DELETE FROM logs",
        "SELECT 1; DELETE FROM logs",
        "UPDATE logs SET msg = 'x'",
        "WITH d AS (DELETE FROM logs RETURNING *) SELECT * FROM d",
        "SELECT * FROM logs; ATTACH 'x.db' AS x",
        "PRAGMA writable_schema = 1",
    ] {
        let mut c = lite(&path);
        c.query = q.into();
        let e = preview(&c, &Credentials::default(), None).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidQuery, "{q}: {}", e.message);
    }
    // Past the check (a driver bug or a missed word): the connection itself refuses to write.
    let never = || false;
    for q in [
        "DELETE FROM logs",
        "INSERT INTO logs (ts) VALUES ('x')",
        "DROP TABLE logs",
        "ATTACH DATABASE 'other.db' AS other",
        "PRAGMA query_only = 0",
        "CREATE TEMP TABLE t (x)",
        "SELECT load_extension('x')",
    ] {
        let mut driver = system_open(
            &lite(&path),
            None,
            Query {
                sql: q.into(),
                key: "ts".into(),
            },
            &never,
        )
        .unwrap();
        // `Preview` wraps it: a syntax error; run as it is, the authorizer or read-only refuses.
        assert!(driver.run(&Request::Preview, &never).is_err(), "{q}");
        let mut raw = sqlite::connect(
            &lite(&path),
            Query {
                sql: String::new(),
                key: String::new(),
            },
        )
        .unwrap();
        assert!(raw.raw_for_tests(q).is_err(), "{q}");
    }
    assert_eq!(count(), 3);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!dir.path().join("other.db").exists());
}

#[test]
fn sqlite_errors_and_stop() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = lite(&dir.path().join("missing.db"));
    assert_eq!(
        preview(&c, &Credentials::default(), None).unwrap_err().code,
        ErrorCode::NotFound
    );
    std::fs::write(
        dir.path().join("text.db"),
        "not a database at all, just text",
    )
    .unwrap();
    c.path = dir.path().join("text.db").display().to_string();
    assert!(preview(&c, &Credentials::default(), None).is_err());
    // A long query ends when the source stops.
    let path = sqlite_file(dir.path());
    let mut c = lite(&path);
    c.query =
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x AS ts FROM n"
            .into();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let stopped = || stop.load(std::sync::atomic::Ordering::Relaxed);
    let mut driver = system_open(
        &c,
        None,
        Query {
            sql: sql::check_select(&c.query, Dialect::Sqlite).unwrap(),
            key: "ts".into(),
        },
        &stopped,
    )
    .unwrap();
    // The query never ends by itself: that `run` returns at all, and with "abgebrochen", shows
    // that the stop ended it (whether it came before the first row or in the middle).
    std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_millis(200));
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        });
        let e = driver.run(&Request::NthNewest(1), &stopped).unwrap_err();
        assert_eq!(e.message, "abgebrochen");
    });
}
