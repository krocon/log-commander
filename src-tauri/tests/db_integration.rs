//! The database source against real servers with TLS (prompt 019): PostgreSQL, MySQL, MariaDB and
//! SQL Server in Docker. Ignored by default; the servers come from `scripts/db-test-servers.sh`:
//!
//! ```sh
//! sh scripts/db-test-servers.sh up
//! cd src-tauri && LC_DB_TEST_DIR=${TMPDIR:-/tmp}/lc-db-test cargo test --test db_integration -- --ignored --test-threads=1
//! sh scripts/db-test-servers.sh down
//! ```
//!
//! Per server: first fetch (last N), new rows, equal timestamps (no loss, no doubles), TLS checked
//! against the test CA (and refused without it), a wrong password, a killed connection (reconnect
//! from the last key), and writes that must not reach the database: through a function called in
//! the `SELECT` (the read-only transaction refuses) and past the checker (the driver itself).
//! SQLite runs in the normal tests (`sources/database/tests.rs`), without Docker.

use log_commander_lib::error::ErrorCode;
use log_commander_lib::model::{SessionInfo, SourceState};
use log_commander_lib::remote::secrets::Secret;
use log_commander_lib::remote::Credentials;
use log_commander_lib::session::{OpenOptions, SessionManager};
use log_commander_lib::sources::database::driver::{Query, Request};
use log_commander_lib::sources::database::{self, DbConfig, DbSource};
use log_commander_lib::spool::{SpoolConfig, SpoolRoot};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

const PASSWORD: &str = "Lc-test-019!";
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq)]
enum Engine {
    Pg,
    My,
    Maria,
    Ms,
}

impl Engine {
    fn container(self) -> &'static str {
        match self {
            Engine::Pg => "lc-dbtest-pg",
            Engine::My => "lc-dbtest-my",
            Engine::Maria => "lc-dbtest-maria",
            Engine::Ms => "lc-dbtest-ms",
        }
    }

    /// Runs SQL as the administrator inside the container; the output without headers.
    fn admin(self, sql: &str) -> String {
        let mut cmd = Command::new("docker");
        cmd.args(["exec", self.container()]);
        match self {
            Engine::Pg => cmd.args([
                "psql",
                "-U",
                "postgres",
                "-At",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                sql,
            ]),
            Engine::My => cmd.args([
                "mysql",
                "-uroot",
                &format!("-p{PASSWORD}"),
                "--default-character-set=utf8mb4",
                "-N",
                "-B",
                "logs",
                "-e",
                sql,
            ]),
            Engine::Maria => cmd.args([
                "mariadb",
                "-uroot",
                &format!("-p{PASSWORD}"),
                "--default-character-set=utf8mb4",
                "-N",
                "-B",
                "logs",
                "-e",
                sql,
            ]),
            Engine::Ms => cmd.args([
                "/opt/mssql-tools18/bin/sqlcmd",
                "-C",
                "-S",
                "localhost",
                "-U",
                "sa",
                "-P",
                PASSWORD,
                "-b",
                "-h",
                "-1",
                "-W",
                "-Q",
                &format!("SET NOCOUNT ON; {sql}"),
            ]),
        };
        let out = cmd.output().expect("docker");
        assert!(
            out.status.success(),
            "{sql}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn count(self) -> i64 {
        self.admin("SELECT COUNT(*) FROM logs")
            .lines()
            .last()
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    fn setup(self) {
        let ddl = match self {
            Engine::Pg => "DROP TABLE IF EXISTS logs; DROP FUNCTION IF EXISTS wr(); \
                CREATE TABLE logs (id bigserial PRIMARY KEY, ts timestamptz NOT NULL, level text, msg text, data bytea, amount numeric(10,2)); \
                CREATE FUNCTION wr() RETURNS bigint LANGUAGE sql AS $$ INSERT INTO logs (ts, msg) VALUES (now(), 'hacked') RETURNING id $$;",
            Engine::My | Engine::Maria => "DROP TABLE IF EXISTS logs; DROP FUNCTION IF EXISTS wr; \
                CREATE TABLE logs (id bigint AUTO_INCREMENT PRIMARY KEY, ts datetime(3) NOT NULL, level varchar(10), msg text, data blob, amount decimal(10,2));",
            Engine::Ms => "IF OBJECT_ID('logs') IS NOT NULL DROP TABLE logs; \
                CREATE TABLE logs (id bigint IDENTITY PRIMARY KEY, ts datetime2(3) NOT NULL, level nvarchar(10), msg nvarchar(max), data varbinary(max), amount decimal(10,2));",
        };
        self.admin(ddl);
        if matches!(self, Engine::My | Engine::Maria) {
            // A compound body: the client must not split it at the inner `;`.
            let client = if self == Engine::My {
                "mysql"
            } else {
                "mariadb"
            };
            let out = Command::new("docker")
                .args(["exec", self.container(), client, "-uroot", &format!("-p{PASSWORD}"), "--default-character-set=utf8mb4", "--delimiter=//", "logs", "-e"])
                .arg("CREATE FUNCTION wr() RETURNS bigint MODIFIES SQL DATA BEGIN INSERT INTO logs (ts, msg) VALUES (NOW(), 'hacked'); RETURN 1; END//")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        self.insert(&[
            ("2026-11-08 10:00:00", "INFO", "Start"),
            ("2026-11-08 10:00:01", "ERROR", "Grüße 🎉"),
            ("2026-11-08 10:00:01", "WARN", "gleiche Zeit"),
        ]);
    }

    fn insert(self, rows: &[(&str, &str, &str)]) {
        let values: Vec<String> = rows
            .iter()
            .map(|(ts, level, msg)| {
                let n = if self == Engine::Ms { "N" } else { "" };
                format!("('{ts}', '{level}', {n}'{msg}', 12.50)")
            })
            .collect();
        self.admin(&format!(
            "INSERT INTO logs (ts, level, msg, amount) VALUES {}",
            values.join(", ")
        ));
    }

    /// Ends the source's connections on the server.
    fn kill_clients(self) {
        match self {
            Engine::Pg => {
                self.admin(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'Log Commander'",
                );
            }
            Engine::My | Engine::Maria => {
                let ids = self.admin(
                    "SELECT id FROM information_schema.processlist WHERE id <> CONNECTION_ID() AND db = 'logs' AND command <> 'Daemon'",
                );
                for id in ids.lines().filter(|l| !l.trim().is_empty()) {
                    let _ = Command::new("docker")
                        .args(["exec", self.container()])
                        .args(if self == Engine::My {
                            ["mysql"]
                        } else {
                            ["mariadb"]
                        })
                        .args([
                            "-uroot",
                            &format!("-p{PASSWORD}"),
                            "-e",
                            &format!("KILL {}", id.trim()),
                        ])
                        .output();
                }
            }
            Engine::Ms => {
                let ids = self.admin(
                    "SELECT session_id FROM sys.dm_exec_sessions WHERE program_name = 'Log Commander'",
                );
                for id in ids.lines().filter(|l| l.trim().parse::<u32>().is_ok()) {
                    self.admin(&format!("KILL {}", id.trim()));
                }
            }
        }
    }

    fn config(self) -> DbConfig {
        let dir = std::env::var("LC_DB_TEST_DIR")
            .expect("LC_DB_TEST_DIR (see scripts/db-test-servers.sh)");
        let (engine, port, user, database, query) = match self {
            Engine::Pg => (
                "postgres",
                15432,
                "postgres",
                "postgres",
                "SELECT * FROM public.logs",
            ),
            Engine::My => ("mysql", 13306, "root", "logs", "SELECT * FROM logs"),
            Engine::Maria => ("mysql", 13307, "root", "logs", "SELECT * FROM logs"),
            Engine::Ms => ("mssql", 11433, "sa", "master", "SELECT * FROM dbo.logs"),
        };
        serde_json::from_value(serde_json::json!({
            "engine": engine,
            "host": "localhost",
            "port": port,
            "database": database,
            "user": user,
            "caFile": format!("{dir}/ca.pem"),
            "query": query,
            "keyColumn": "ts",
            "timeColumn": "ts",
            "levelColumn": "level",
            "intervalMs": 500,
            "startLast": 2,
        }))
        .unwrap()
    }
}

fn creds(secret: &str) -> Credentials {
    Credentials {
        secret: Some(Secret::new(secret)),
        remember: false,
        trust_fingerprint: None,
    }
}

struct Fixture {
    _cache: tempfile::TempDir,
    manager: SessionManager,
}

impl Fixture {
    fn new() -> Self {
        let cache = tempfile::tempdir().unwrap();
        let manager = SessionManager::default();
        manager.set_spool_root(Arc::new(SpoolRoot::prepare(cache.path()).unwrap()));
        Self {
            _cache: cache,
            manager,
        }
    }

    fn open(&self, config: DbConfig) -> SessionInfo {
        let source = DbSource::open_with(
            config,
            &creds(PASSWORD),
            None,
            Arc::new(database::system_open),
        )
        .unwrap();
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

    fn lines(&self, info: &SessionInfo) -> Vec<String> {
        let session = self.manager.session(info.session_id).unwrap();
        let total = session.stats().total_lines as usize;
        session
            .get_lines(false, 0, total)
            .unwrap()
            .into_iter()
            .map(|l| l.text)
            .collect()
    }

    fn msgs(&self, info: &SessionInfo) -> Vec<String> {
        let mut m: Vec<String> = self
            .lines(info)
            .iter()
            .map(|t| {
                serde_json::from_str::<serde_json::Value>(t).unwrap()["msg"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        m.sort();
        m
    }

    fn wait(&self, info: &SessionInfo, what: &str, done: impl Fn(&Self) -> bool) {
        let start = Instant::now();
        while !done(self) {
            let stats = self.manager.session(info.session_id).unwrap().stats();
            assert!(
                start.elapsed() < TIMEOUT,
                "timeout waiting for {what}: {:?}",
                stats.source_status
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn suite(engine: Engine) {
    engine.setup();
    let fx = Fixture::new();
    let config = engine.config();

    // TLS is checked: without the test CA the server's certificate is refused.
    let mut no_ca = config.clone();
    no_ca.ca_file = String::new();
    let e = database::preview(&no_ca, &creds(PASSWORD), None).unwrap_err();
    assert_eq!(e.code, ErrorCode::ConnectionFailed, "{}", e.message);
    assert!(e.message.contains("Zertifikat"), "{}", e.message);
    // A wrong password: asked again, not retried.
    let e = database::preview(&config, &creds("falsch"), None).unwrap_err();
    assert_eq!(e.code, ErrorCode::SecretRequired, "{}", e.message);
    assert!(!e.message.contains("falsch") && !e.message.contains(PASSWORD));

    // Preview: values as JSON, binary as a hint, numbers as numbers.
    let preview = database::preview(&config, &creds(PASSWORD), None).unwrap();
    assert_eq!(preview.lines.len(), 3);
    let first: serde_json::Value = serde_json::from_str(&preview.lines[0]).unwrap();
    assert_eq!(first["level"], "INFO");
    assert!(
        first["timestamp"]
            .as_str()
            .unwrap()
            .starts_with("2026-11-08T"),
        "{first}"
    );
    assert_eq!(first["amount"], serde_json::json!(12.50));
    let tables = database::tables(&config, &creds(PASSWORD), None).unwrap();
    assert!(tables.iter().any(|t| t.name == "logs"), "{tables:?}");

    // Start with the last two rows: both have the same time, so the key of the 2nd newest is it.
    let info = fx.open(config.clone());
    fx.wait(&info, "last two", |f| {
        f.msgs(&info) == ["Grüße 🎉", "gleiche Zeit"]
    });
    // New rows, some with the time of the edge.
    engine.insert(&[
        ("2026-11-08 10:00:01", "INFO", "auch gleiche Zeit"),
        ("2026-11-08 10:00:02", "DEBUG", "später"),
    ]);
    fx.wait(&info, "new rows", |f| f.lines(&info).len() == 4);
    // A killed connection: the source reconnects and goes on from the last key.
    engine.kill_clients();
    engine.insert(&[("2026-11-08 10:00:02", "INFO", "nach dem Abbruch")]);
    fx.wait(&info, "after the reconnect", |f| f.lines(&info).len() == 5);
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(
        fx.msgs(&info),
        [
            "Grüße 🎉",
            "auch gleiche Zeit",
            "gleiche Zeit",
            "nach dem Abbruch",
            "später"
        ]
    );
    let status = fx
        .manager
        .session(info.session_id)
        .unwrap()
        .stats()
        .source_status
        .unwrap();
    assert!(
        matches!(
            status.state,
            SourceState::Connected | SourceState::Reconnecting { .. }
        ),
        "{status:?}"
    );

    // Writes never reach the database.
    let before = engine.count();
    if engine != Engine::Ms {
        // A function that writes, called in an allowed SELECT: the read-only transaction refuses.
        let mut c = config.clone();
        c.query = "SELECT wr() AS ts".into();
        c.time_column = String::new();
        c.level_column = String::new();
        let e = database::preview(&c, &creds(PASSWORD), None).unwrap_err();
        assert!(
            e.message.contains("read-only") || e.message.contains("READ ONLY"),
            "{}",
            e.message
        );
    }
    // Past the checker: a second statement smuggled into the wrapped query.
    let never = || false;
    let smuggled = match engine {
        Engine::Pg => "SELECT 1 AS ts) x; INSERT INTO logs (ts, msg) VALUES (now(), 'hacked'); SELECT * FROM (SELECT 1 AS ts",
        Engine::My | Engine::Maria => "SELECT 1 AS ts) x; INSERT INTO logs (ts, msg) VALUES (NOW(), 'hacked'); SELECT * FROM (SELECT 1 AS ts",
        Engine::Ms => "SELECT 1 AS ts) x; INSERT INTO logs (ts, msg) VALUES (SYSDATETIME(), N'hacked'); SELECT * FROM (SELECT 1 AS ts",
    };
    assert!(database::sql::check_select(smuggled, config.engine).is_err());
    let mut driver = database::system_open(
        &config,
        Some(&Secret::new(PASSWORD)),
        Query {
            sql: smuggled.into(),
            key: "ts".into(),
        },
        &never,
    )
    .unwrap();
    let _ = driver.run(&Request::Preview, &never);
    // SQL Server runs both statements, but in the transaction that is rolled back.
    assert_eq!(engine.count(), before, "a write reached the database");
    assert_eq!(
        engine
            .admin("SELECT COUNT(*) FROM logs WHERE msg = 'hacked'")
            .lines()
            .last()
            .unwrap()
            .trim(),
        "0"
    );
}

/// Runs SQL past the checker (as if it had a hole) through the real driver; the error, if any.
fn bypass(engine: Engine, sql: &str, reader: bool) -> Option<String> {
    let never = || false;
    let mut config = engine.config();
    if reader {
        config.user = READER.into();
    }
    let mut driver = database::system_open(
        &config,
        Some(&Secret::new(PASSWORD)),
        Query {
            sql: sql.into(),
            key: "ts".into(),
        },
        &never,
    )
    .unwrap();
    driver
        .run(&Request::Preview, &never)
        .err()
        .map(|e| e.message)
}

/// A database account with read rights on the log table only (the recommended setup).
const READER: &str = "lc_reader";

fn create_reader(engine: Engine) {
    if engine == Engine::Pg {
        engine.admin(&format!(
            "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{READER}') THEN \
                 DROP OWNED BY {READER} CASCADE; DROP ROLE {READER}; END IF; END $$"
        ));
    }
    let sql = match engine {
        Engine::Pg => format!(
            "CREATE ROLE {READER} LOGIN PASSWORD '{PASSWORD}'; GRANT SELECT ON logs TO {READER}"
        ),
        Engine::My | Engine::Maria => format!(
            "DROP USER IF EXISTS '{READER}'@'%'; CREATE USER '{READER}'@'%' IDENTIFIED BY '{PASSWORD}'; \
             GRANT SELECT ON logs.logs TO '{READER}'@'%'"
        ),
        Engine::Ms => unreachable!(),
    };
    engine.admin(&sql);
}

fn file_exists(engine: Engine, path: &str) -> bool {
    Command::new("docker")
        .args(["exec", engine.container(), "test", "-e", path])
        .status()
        .unwrap()
        .success()
}

/// Review 019 #1: `SELECT … INTO OUTFILE` through the subquery breakout. The checker refuses it.
/// Past the checker (as if it had a hole), the read-only transaction does **not** stop it for an
/// account with the FILE privilege (root here): the file is written. An account with SELECT only
/// cannot (the recommended setup).
fn no_outfile(engine: Engine) {
    engine.setup();
    create_reader(engine);
    let dir = if engine == Engine::My {
        "/var/lib/mysql-files"
    } else {
        "/tmp"
    };
    let target = format!("{dir}/lc-outfile-{}", std::process::id());
    let breakout = format!("SELECT 1 AS id--1) lc INTO OUTFILE '{target}' #");
    assert!(database::sql::check_select(&breakout, database::sql::Dialect::Mysql).is_err());
    let raw = format!("SELECT 1 AS ts) lc INTO OUTFILE '{target}' #");
    let clean = |t: &str| {
        let _ = Command::new("docker")
            .args(["exec", "-u", "root", engine.container(), "rm", "-f", t])
            .status();
    };
    let error = bypass(engine, &raw, false);
    let written = file_exists(engine, &target);
    eprintln!(
        "{} INTO OUTFILE past the checker as root: error {error:?}, written {written}",
        engine.container()
    );
    clean(&target);
    assert!(
        written,
        "documented behaviour changed: READ ONLY now stops INTO OUTFILE"
    );
    let error = bypass(engine, &raw, true);
    let written = file_exists(engine, &target);
    eprintln!(
        "{} INTO OUTFILE past the checker as {READER}: error {error:?}, written {written}",
        engine.container()
    );
    clean(&target);
    assert!(
        error.is_some() && !written,
        "a SELECT-only account wrote a file"
    );
}

#[test]
#[ignore = "needs Docker: sh scripts/db-test-servers.sh up"]
fn mysql_never_writes_files() {
    no_outfile(Engine::My);
}

#[test]
#[ignore = "needs Docker: sh scripts/db-test-servers.sh up"]
fn mariadb_never_writes_files() {
    no_outfile(Engine::Maria);
}

/// Review 019: `lo_export` writes a server file: refused by the checker; past it, only the account's
/// rights stop it.
#[test]
#[ignore = "needs Docker: sh scripts/db-test-servers.sh up"]
fn postgres_lo_export() {
    let engine = Engine::Pg;
    engine.setup();
    engine.admin("SELECT lo_unlink(4711) FROM pg_largeobject_metadata WHERE oid = 4711; SELECT lo_from_bytea(4711, 'geheim')");
    let target = format!("/tmp/lc-lo-{}", std::process::id());
    let q = format!("SELECT lo_export(4711, '{target}') AS ts");
    assert!(database::sql::check_select(&q, database::sql::Dialect::Postgres).is_err());
    // Past the checker as superuser: `BEGIN READ ONLY` does not stop `lo_export`.
    create_reader(engine);
    let error = bypass(engine, &q, false);
    let written = file_exists(engine, &target);
    eprintln!("lo_export past the checker in BEGIN READ ONLY as postgres: error {error:?}, written {written}");
    let _ = Command::new("docker")
        .args(["exec", engine.container(), "rm", "-f", &target])
        .status();
    assert!(
        written,
        "documented behaviour changed: READ ONLY now stops lo_export"
    );
    // An account with SELECT on the table only cannot.
    let error = bypass(engine, &q, true);
    let written = file_exists(engine, &target);
    eprintln!("lo_export past the checker as {READER}: error {error:?}, written {written}");
    assert!(
        error.is_some() && !written,
        "a SELECT-only role exported a file"
    );
}

/// Review 019 #5: a query cancelled on the client (tab closed, time limit) closes the connection;
/// does SQL Server go on running it?
#[test]
#[ignore = "needs Docker: sh scripts/db-test-servers.sh up"]
fn sql_server_stops_after_disconnect() {
    let engine = Engine::Ms;
    engine.setup();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let stopped = || stop.load(std::sync::atomic::Ordering::Relaxed);
    let mut config = engine.config();
    config.query = "SELECT SUM(CAST(a.object_id AS bigint) * b.object_id % 7 + c.object_id) AS ts \
        FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c"
        .into();
    let mut driver = database::system_open(
        &config,
        Some(&Secret::new(PASSWORD)),
        Query {
            sql: config.query.clone(),
            key: "ts".into(),
        },
        &stopped,
    )
    .unwrap();
    let started = Instant::now();
    std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_secs(2));
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        });
        let e = driver.run(&Request::Preview, &stopped).unwrap_err();
        assert_eq!(e.message, "abgebrochen");
    });
    assert!(started.elapsed() < Duration::from_secs(5));
    drop(driver);
    let running = || {
        engine
            .admin("SELECT COUNT(*) FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id WHERE s.program_name = 'Log Commander'")
            .lines()
            .last()
            .unwrap()
            .trim()
            .to_string()
    };
    let start = Instant::now();
    let mut last = running();
    while last != "0" && start.elapsed() < Duration::from_secs(15) {
        std::thread::sleep(Duration::from_millis(500));
        last = running();
    }
    eprintln!(
        "SQL Server requests of the app after disconnect: {last} after {:?}",
        start.elapsed()
    );
    assert_eq!(
        last, "0",
        "the server still runs the query after the client left"
    );
}

#[test]
#[ignore = "needs Docker: sh scripts/db-test-servers.sh up"]
fn postgres() {
    suite(Engine::Pg);
}

#[test]
#[ignore = "needs Docker: sh scripts/db-test-servers.sh up"]
fn mysql() {
    suite(Engine::My);
}

#[test]
#[ignore = "needs Docker: sh scripts/db-test-servers.sh up"]
fn mariadb() {
    suite(Engine::Maria);
}

#[test]
#[ignore = "needs Docker: sh scripts/db-test-servers.sh up"]
fn sql_server() {
    suite(Engine::Ms);
}
