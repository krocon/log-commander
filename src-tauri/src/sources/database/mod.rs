//! Logs from database tables (prompt 019): a `SELECT` on PostgreSQL, MySQL/MariaDB, SQL Server or
//! SQLite as a source of 016. The rows go as JSON lines (`value.rs`) into the spool, so the JSON
//! profile, level detection, columns, filters and search need no special path.
//!
//! Live by polling: every `interval_ms` the rows with `key >= last key` in key order, at most
//! 10 000 per batch; rows at the edge (same key) are remembered, so equal times lose or double
//! nothing (`value::Edge`). After a broken connection it reconnects with a growing pause and goes on
//! from the last key (`follow.rs`).
//!
//! Nothing writes: the query is checked to be one `SELECT` (`sql.rs`) and wrapped in a derived
//! table; every database runs it read-only (PostgreSQL and MySQL in a read-only session and
//! transaction, SQL Server in a transaction that is always rolled back, SQLite opened read-only
//! with the dashboard's authorizer), with a time limit and bounded batches.
//!
//! The password comes from the dialog for this connect or from the OS keychain (only on request,
//! only after it worked, like SFTP in 017); it is never in a configuration, workspace, log, error or
//! update. TLS is on and verified by default; switching the check off shows a warning in the dialog.

pub mod driver;
mod follow;
pub mod mssql;
pub mod mysql;
pub mod pg;
pub mod sql;
pub mod sqlite;
pub mod value;

#[cfg(test)]
pub(crate) mod fake;

use self::driver::{Driver, Query, Request, Rows, Stop, TableName};
use self::sql::Dialect;
use self::value::{Column, Shape, MAX_COLUMNS};
use super::{Source, SourceContext};
use crate::error::{AppError, AppResult, ErrorCode, RemoteDetail};
use crate::model::SourceKind;
use crate::remote::secrets::{scoped_account, Secret, SecretKind, SecretStore};
use crate::remote::Credentials;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Poll every 2 s by default (prompt 019).
pub const DEFAULT_INTERVAL_MS: u32 = 2000;
pub const MIN_INTERVAL_MS: u32 = 500;
pub const MAX_INTERVAL_MS: u32 = 3_600_000;
/// Start with the last 1000 rows by default.
pub const DEFAULT_START_LAST: u32 = 1000;
pub const MAX_START_LAST: u32 = 1_000_000;
const MAX_NAME: usize = 128;
const MAX_HOST: usize = 253;
const MAX_PATH: usize = 4096;
/// Keychain accounts of this source: `db:password:<hash of engine:user@host:port/database>`.
const KEYCHAIN_SCOPE: &str = "db";

/// How the server is logged on to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbAuth {
    /// User and password (dialog or keychain).
    #[default]
    Password,
    /// User without password (trust, peer setups).
    None,
}

/// TLS of the connection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TlsMode {
    /// Encrypted, the certificate checked against the OS roots (and the CA file).
    #[default]
    Verify,
    /// Encrypted, any certificate (the dialog warns).
    NoVerify,
    /// Not encrypted (the dialog warns; SQL Server still encrypts the login).
    Off,
}

fn default_interval() -> u32 {
    DEFAULT_INTERVAL_MS
}

fn default_start_last() -> Option<u32> {
    Some(DEFAULT_START_LAST)
}

/// What the dialog configures (and settings or a workspace keep): never a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConfig {
    pub engine: Dialect,
    #[serde(default)]
    pub host: String,
    /// 0: the default port of the engine.
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub auth: DbAuth,
    #[serde(default)]
    pub tls: TlsMode,
    /// A PEM file with the CA of the server (TLS `verify`), in addition to the OS roots.
    #[serde(default)]
    pub ca_file: String,
    /// SQLite: the database file.
    #[serde(default)]
    pub path: String,
    pub query: String,
    pub key_column: String,
    #[serde(default)]
    pub time_column: String,
    #[serde(default)]
    pub level_column: String,
    #[serde(default = "default_interval")]
    pub interval_ms: u32,
    /// Start with the last N rows; None: all rows.
    #[serde(default = "default_start_last")]
    pub start_last: Option<u32>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidSource, message)
}

fn plain(text: &str) -> bool {
    !text.chars().any(char::is_control)
}

/// A message from a driver or server: one line, no control characters, bounded.
pub fn clean(text: &str) -> String {
    let one: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let one = one.trim();
    match one.char_indices().nth(400) {
        Some((end, _)) => format!("{}…", &one[..end]),
        None => one.to_string(),
    }
}

impl DbConfig {
    pub fn port_or_default(&self) -> u16 {
        if self.port != 0 {
            return self.port;
        }
        match self.engine {
            Dialect::Postgres => 5432,
            Dialect::Mysql => 3306,
            Dialect::Mssql => 1433,
            Dialect::Sqlite => 0,
        }
    }

    /// `host:port/database` or the SQLite file's name, for texts.
    pub fn where_label(&self) -> String {
        if self.engine == Dialect::Sqlite {
            return std::path::Path::new(self.path.trim())
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.path.trim().to_string());
        }
        let db = self.database.trim();
        if db.is_empty() {
            format!("{}:{}", self.host.trim(), self.port_or_default())
        } else {
            format!("{}:{}/{db}", self.host.trim(), self.port_or_default())
        }
    }

    /// Server, login and TLS (not the query): for connecting, listing tables.
    pub fn validate_connection(&self) -> AppResult<()> {
        if self.engine == Dialect::Sqlite {
            let path = self.path.trim();
            if path.is_empty() || path.len() > MAX_PATH || !plain(path) {
                return Err(invalid("SQLite-Datei fehlt"));
            }
            if !std::path::Path::new(path).is_absolute() {
                return Err(invalid("SQLite-Datei mit vollem Pfad angeben"));
            }
            return Ok(());
        }
        let host = self.host.trim();
        if host.is_empty()
            || host.len() > MAX_HOST
            || host.starts_with(['-', '.'])
            || !host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
        {
            return Err(invalid("kein Hostname oder keine IP-Adresse"));
        }
        let user = self.user.trim();
        if user.is_empty() || user.len() > MAX_NAME || !plain(user) {
            return Err(invalid("Benutzer fehlt"));
        }
        if self.database.len() > MAX_NAME || !plain(&self.database) {
            return Err(invalid("kein Datenbankname"));
        }
        if self.engine == Dialect::Mssql && self.auth == DbAuth::None {
            return Err(invalid("SQL Server braucht ein Passwort (SQL-Anmeldung)"));
        }
        let ca = self.ca_file.trim();
        if !ca.is_empty()
            && (ca.len() > MAX_PATH || !plain(ca) || !std::path::Path::new(ca).is_absolute())
        {
            return Err(invalid("CA-Datei mit vollem Pfad angeben"));
        }
        Ok(())
    }

    /// Everything, the query included; returns the checked query.
    pub fn validate(&self) -> AppResult<String> {
        self.validate_connection()?;
        let query = sql::check_select(&self.query, self.engine)?;
        let column = |name: &str, what: &str, needed: bool| {
            if name.len() > MAX_NAME || !plain(name) || (needed && name.trim().is_empty()) {
                Err(invalid(format!("{what} fehlt")))
            } else {
                Ok(())
            }
        };
        column(&self.key_column, "Schlüsselspalte", true)?;
        column(&self.time_column, "Zeitspalte", false)?;
        column(&self.level_column, "Level-Spalte", false)?;
        if !(MIN_INTERVAL_MS..=MAX_INTERVAL_MS).contains(&self.interval_ms) {
            return Err(invalid(format!(
                "Abstand {MIN_INTERVAL_MS} ms bis {} h",
                MAX_INTERVAL_MS / 3_600_000
            )));
        }
        if self
            .start_last
            .is_some_and(|n| n == 0 || n > MAX_START_LAST)
        {
            return Err(invalid(format!(
                "Startpunkt 1–{MAX_START_LAST} Zeilen oder alle"
            )));
        }
        Ok(query)
    }

    /// `db:schema.table` (the first table of the query), else `db:database`.
    pub fn label(&self) -> String {
        if let Some(table) = sql::table_of(&self.query, self.engine) {
            return format!("db:{table}");
        }
        match self.engine {
            Dialect::Sqlite => format!("db:{}", self.where_label()),
            _ if !self.database.trim().is_empty() => format!("db:{}", self.database.trim()),
            _ => format!("db:{}", self.host.trim()),
        }
    }

    /// The keychain account of the password (host and user hashed, like 017), for the current
    /// TLS mode: a password stored with certificate check is never sent over a weaker connection
    /// (review 019 #2: a workspace could otherwise switch the check off and use it).
    pub fn account(&self) -> String {
        self.account_for(self.tls)
    }

    /// Accounts whose password may be used now: stored with this TLS mode or a weaker one.
    pub fn usable_accounts(&self) -> Vec<String> {
        let weaker: &[TlsMode] = match self.tls {
            TlsMode::Verify => &[TlsMode::Verify, TlsMode::NoVerify, TlsMode::Off],
            TlsMode::NoVerify => &[TlsMode::NoVerify, TlsMode::Off],
            TlsMode::Off => &[TlsMode::Off],
        };
        weaker.iter().map(|m| self.account_for(*m)).collect()
    }

    /// All accounts of this server, whatever the TLS mode (for „vergessen“).
    pub fn all_accounts(&self) -> Vec<String> {
        [TlsMode::Verify, TlsMode::NoVerify, TlsMode::Off]
            .iter()
            .map(|m| self.account_for(*m))
            .collect()
    }

    fn account_for(&self, tls: TlsMode) -> String {
        let tls = match tls {
            TlsMode::Verify => "verify",
            TlsMode::NoVerify => "noverify",
            TlsMode::Off => "off",
        };
        let engine = match self.engine {
            Dialect::Postgres => "postgres",
            Dialect::Mysql => "mysql",
            Dialect::Mssql => "mssql",
            Dialect::Sqlite => "sqlite",
        };
        scoped_account(
            KEYCHAIN_SCOPE,
            SecretKind::Password,
            &format!(
                "{engine}:{}@{}:{}/{}#{tls}",
                self.user.trim(),
                self.host.trim().to_lowercase(),
                self.port_or_default(),
                self.database.trim()
            ),
        )
    }

    fn needs_password(&self) -> bool {
        self.engine != Dialect::Sqlite && self.auth == DbAuth::Password
    }
}

/// A refused login: with a password the dialog asks again („nicht angenommen“), never retried.
pub fn auth_error(config: &DbConfig, message: &str) -> AppError {
    if config.needs_password() {
        AppError::new(ErrorCode::SecretRequired, message).with_remote(RemoteDetail {
            secret: Some(SecretKind::Password),
            wrong: true,
            ..RemoteDetail::default()
        })
    } else {
        AppError::new(ErrorCode::AuthFailed, message)
    }
}

fn is_tls(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("certificate")
        || t.contains("tls")
        || t.contains("unknownissuer")
        || t.contains("handshake")
}

/// A TLS error in words, with what to do.
pub fn tls_text(on: &str, message: &str) -> String {
    let m = clean(message);
    let lower = m.to_lowercase();
    if lower.contains("certificate")
        || lower.contains("unknownissuer")
        || lower.contains("notvalidforname")
    {
        format!(
            "TLS: Das Zertifikat von {on} wurde nicht anerkannt ({m}). Eine CA-Datei angeben oder – nur \
             wenn das Netz vertrauenswürdig ist – die Zertifikatsprüfung abschalten."
        )
    } else {
        format!("TLS mit {on} fehlgeschlagen: {m}")
    }
}

/// Errors of sqlx (PostgreSQL, MySQL) in words; they never hold the password.
pub fn db_error(config: &DbConfig, e: &sqlx_core::error::Error) -> AppError {
    use sqlx_core::error::Error as E;
    let on = config.where_label();
    match e {
        E::Database(d) => {
            let code = d.code().map(|c| c.to_string()).unwrap_or_default();
            let message = clean(d.message());
            let has = |w: &str| message.to_lowercase().contains(w);
            if code.starts_with("28") {
                auth_error(config, &format!("Anmeldung an {on} abgelehnt: {message}"))
            } else if code == "3D000" || has("unknown database") {
                AppError::new(ErrorCode::NotFound, format!("{on}: {message}"))
            } else if code == "42501" || has("command denied") || has("permission denied") {
                AppError::new(
                    ErrorCode::PermissionDenied,
                    format!("Kein Zugriff: {message}"),
                )
            } else if code == "25006" {
                AppError::new(
                    ErrorCode::InvalidQuery,
                    format!("Schreibversuch abgelehnt (schreibgeschützt): {message}"),
                )
            } else if code == "57014"
                || has("statement timeout")
                || has("execution time exceeded")
                || has("max_statement_time")
            {
                AppError::new(ErrorCode::ConnectionFailed, format!("Zeitlimit: {message}"))
            } else {
                AppError::new(ErrorCode::InvalidQuery, format!("{message} ({code})"))
            }
        }
        E::Tls(t) => AppError::new(ErrorCode::ConnectionFailed, tls_text(&on, &t.to_string())),
        E::Io(io) if is_tls(&io.to_string()) => {
            AppError::new(ErrorCode::ConnectionFailed, tls_text(&on, &io.to_string()))
        }
        E::Io(io) => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on} nicht erreichbar: {}", clean(&io.to_string())),
        ),
        E::Configuration(c) => AppError::new(ErrorCode::InvalidSource, clean(&c.to_string())),
        other => {
            let text = clean(&other.to_string());
            if is_tls(&text) {
                AppError::new(ErrorCode::ConnectionFailed, tls_text(&on, &text))
            } else {
                AppError::new(ErrorCode::ConnectionFailed, format!("{on}: {text}"))
            }
        }
    }
}

fn secret_required(config: &DbConfig) -> AppError {
    AppError::new(
        ErrorCode::SecretRequired,
        format!(
            "Passwort für {} auf {} nötig",
            config.user.trim(),
            config.where_label()
        ),
    )
    .with_remote(RemoteDetail {
        secret: Some(SecretKind::Password),
        wrong: false,
        ..RemoteDetail::default()
    })
}

/// The password: none without one, else typed (true) or from the keychain (false).
fn password(
    config: &DbConfig,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) -> AppResult<Option<(Secret, bool)>> {
    if !config.needs_password() {
        return Ok(None);
    }
    if let Some(secret) = creds.secret.as_ref().filter(|s| !s.is_empty()) {
        return Ok(Some((secret.clone(), true)));
    }
    if let Some(store) = store.filter(|s| s.available()) {
        for account in config.usable_accounts() {
            if let Ok(Some(secret)) = store.get(&account) {
                return Ok(Some((secret, false)));
            }
        }
    }
    Err(secret_required(config))
}

/// After it worked: a typed password goes into the keychain if the user asked for it.
fn remember(
    config: &DbConfig,
    secret: &Option<(Secret, bool)>,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) {
    if let (Some((secret, true)), true, Some(store)) = (secret, creds.remember, store) {
        if let Err(e) = store.set(&config.account(), secret) {
            eprintln!("keychain: {}", e.0);
        }
    }
}

/// Connects (the drivers, or a fake in tests).
pub type Opener =
    dyn Fn(&DbConfig, Option<&Secret>, Query, Stop) -> AppResult<Box<dyn Driver>> + Send + Sync;

/// The drivers of this build.
pub fn system_open(
    config: &DbConfig,
    secret: Option<&Secret>,
    query: Query,
    stop: Stop,
) -> AppResult<Box<dyn Driver>> {
    Ok(match config.engine {
        Dialect::Postgres => Box::new(pg::connect(config, secret, query, stop)?),
        Dialect::Mysql => Box::new(mysql::connect(config, secret, query, stop)?),
        Dialect::Mssql => Box::new(mssql::connect(config, secret, query, stop)?),
        Dialect::Sqlite => Box::new(sqlite::connect(config, query)?),
    })
}

/// Where the key, time and level columns are in the result.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub columns: Vec<Column>,
    pub key: usize,
    pub time: Option<usize>,
    pub level: Option<usize>,
}

impl Layout {
    pub fn shape(&self) -> Shape {
        Shape::new(&self.columns, self.key, self.time, self.level)
    }
}

/// A column by name: exactly, else the one that matches ignoring case.
fn find(columns: &[Column], name: &str) -> Option<usize> {
    let name = name.trim();
    columns.iter().position(|c| c.name == name).or_else(|| {
        let same: Vec<usize> = columns
            .iter()
            .enumerate()
            .filter(|(_, c)| c.name.eq_ignore_ascii_case(name))
            .map(|(i, _)| i)
            .collect();
        (same.len() == 1).then(|| same[0])
    })
}

/// Checks the probe's columns against the configuration (prompt 019, item 2).
pub fn layout(config: &DbConfig, columns: Vec<Column>) -> AppResult<Layout> {
    let bad = |m: String| AppError::new(ErrorCode::InvalidQuery, m);
    if columns.is_empty() {
        return Err(bad("Die Abfrage liefert keine Spalten".into()));
    }
    if columns.len() > MAX_COLUMNS {
        return Err(bad(format!("Höchstens {MAX_COLUMNS} Spalten")));
    }
    let names = || {
        columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let key = find(&columns, &config.key_column).ok_or_else(|| {
        bad(format!(
            "Schlüsselspalte „{}“ nicht im Ergebnis (Spalten: {})",
            config.key_column.trim(),
            names()
        ))
    })?;
    if !columns[key].kind.sortable() {
        return Err(bad(format!(
            "Schlüsselspalte „{}“ ({}) ist nicht sortierbar: Zahl, Text oder Zeit nehmen",
            columns[key].name, columns[key].type_name
        )));
    }
    let optional = |name: &str, what: &str| -> AppResult<Option<usize>> {
        if name.trim().is_empty() {
            return Ok(None);
        }
        find(&columns, name).map(Some).ok_or_else(|| {
            bad(format!(
                "{what} „{}“ nicht im Ergebnis (Spalten: {})",
                name.trim(),
                names()
            ))
        })
    };
    let time = optional(&config.time_column, "Zeitspalte")?;
    let level = optional(&config.level_column, "Level-Spalte")?;
    Ok(Layout {
        columns,
        key,
        time,
        level,
    })
}

/// Rows of the table listing (schema, name).
pub fn table_names(rows: Rows) -> Vec<TableName> {
    use self::value::Value;
    rows.rows
        .into_iter()
        .filter_map(|r| {
            let text = |v: Option<&Value>| match v {
                Some(Value::Text(s)) => Some(s.clone()),
                _ => None,
            };
            let name = text(r.get(1))?;
            (plain(&name) && !name.is_empty()).then(|| TableName {
                schema: text(r.first()).filter(|s| !s.is_empty() && plain(s)),
                name,
            })
        })
        .collect()
}

/// What the dialog shows before opening (prompt 019: the first 20 rows).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbPreview {
    pub columns: Vec<Column>,
    /// The lines as they will be in the spool (JSON, escaped).
    pub lines: Vec<String>,
    /// Kind of the key column, for the dialog.
    pub key_type: String,
}

/// A connected, checked database: what `prepare` and the preview share.
struct Connected {
    driver: Box<dyn Driver>,
    layout: Layout,
    secret: Option<Secret>,
}

fn connect_checked(
    config: &DbConfig,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
    opener: &Opener,
) -> AppResult<Connected> {
    let query = config.validate()?;
    let secret = password(config, creds, store)?;
    let never = || false;
    let mut driver = opener(
        config,
        secret.as_ref().map(|(s, _)| s),
        Query {
            sql: query,
            key: find_name(config),
        },
        &never,
    )?;
    let probe = driver.run(&Request::Probe, &never)?;
    let layout = layout(config, probe.columns)?;
    // The real name when it was found ignoring case.
    driver.set_key(layout.columns[layout.key].name.clone());
    remember(config, &secret, creds, store);
    Ok(Connected {
        driver,
        layout,
        secret: secret.map(|(s, _)| s),
    })
}

fn find_name(config: &DbConfig) -> String {
    config.key_column.trim().to_string()
}

/// The first rows as lines, for the dialog.
pub fn preview_with(
    config: &DbConfig,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
    opener: &Opener,
) -> AppResult<DbPreview> {
    let mut c = connect_checked(config, creds, store, opener)?;
    let never = || false;
    let rows = c.driver.run(&Request::Preview, &never)?;
    let shape = c.layout.shape();
    let zone = chrono::Local;
    let mut line = String::new();
    let lines = rows
        .rows
        .iter()
        .map(|row| {
            value::json_line(&shape, row, &zone, &mut line);
            line.clone()
        })
        .collect();
    Ok(DbPreview {
        key_type: c.layout.columns[c.layout.key].type_name.clone(),
        columns: c.layout.columns,
        lines,
    })
}

pub fn preview(
    config: &DbConfig,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) -> AppResult<DbPreview> {
    preview_with(config, creds, store, &system_open)
}

/// Tables and views of the database (connection settings only).
pub fn tables_with(
    config: &DbConfig,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
    opener: &Opener,
) -> AppResult<Vec<TableName>> {
    config.validate_connection()?;
    let secret = password(config, creds, store)?;
    let never = || false;
    let mut driver = opener(
        config,
        secret.as_ref().map(|(s, _)| s),
        Query {
            sql: String::new(),
            key: String::new(),
        },
        &never,
    )?;
    let list = driver.tables(&never)?;
    remember(config, &secret, creds, store);
    Ok(list)
}

pub fn tables(
    config: &DbConfig,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) -> AppResult<Vec<TableName>> {
    tables_with(config, creds, store, &system_open)
}

/// Removes the stored password of a server from the keychain.
pub fn forget(config: &DbConfig, store: &dyn SecretStore) -> AppResult<()> {
    for account in config.all_accounts() {
        store
            .delete(&account)
            .map_err(|e| AppError::new(ErrorCode::Io, format!("Schlüsselbund: {}", e.0)))?;
    }
    Ok(())
}

/// The source, prepared: connected and checked (errors show in the dialog), then run on its thread.
pub struct DbSource {
    config: DbConfig,
    connected: Connected,
    opener: Arc<Opener>,
}

impl std::fmt::Debug for DbSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbSource")
            .field("config", &self.config)
            .finish()
    }
}

impl DbSource {
    pub fn open_with(
        config: DbConfig,
        creds: &Credentials,
        store: Option<&dyn SecretStore>,
        opener: Arc<Opener>,
    ) -> AppResult<Self> {
        let connected = connect_checked(&config, creds, store, opener.as_ref())?;
        Ok(Self {
            config,
            connected,
            opener,
        })
    }
}

/// Prepares a source from the dialog's configuration.
pub fn prepare(
    config: DbConfig,
    creds: &Credentials,
    store: Option<&dyn SecretStore>,
) -> AppResult<DbSource> {
    DbSource::open_with(config, creds, store, Arc::new(system_open))
}

impl Source for DbSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Database
    }

    fn label(&self) -> String {
        self.config.label()
    }

    fn config(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(&self.config).unwrap_or_default();
        if let Some(o) = v.as_object_mut() {
            o.insert("kind".into(), "database".into());
        }
        v
    }

    fn profile(&self) -> Option<&'static str> {
        Some("jsonl")
    }

    fn run(self: Box<Self>, ctx: SourceContext) {
        let s = *self;
        let key_name = s.connected.layout.columns[s.connected.layout.key]
            .name
            .clone();
        follow::run(
            follow::Follow {
                config: s.config,
                driver: Some(s.connected.driver),
                layout: s.connected.layout,
                secret: s.connected.secret,
                opener: s.opener,
                key_name,
            },
            ctx,
        );
    }
}

#[cfg(test)]
mod tests;
