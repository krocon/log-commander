//! What a database connection does for the source (prompt 019), behind a trait so the polling
//! logic (`follow.rs`) is tested against a fake (`fake.rs`) and every driver only renders SQL and
//! reads values.
//!
//! Every request runs in a read-only transaction that is rolled back afterwards, within the time
//! limit, and can be cancelled (closing the tab).

use super::sql::{self, Bound, Dialect};
use super::value::{Column, Key, Value};
use crate::error::{AppError, AppResult, ErrorCode};
use std::future::Future;
use std::time::Duration;

/// Rows per batch (prompt 019).
pub const BATCH_ROWS: u32 = 10_000;
/// Memory of one batch at most; the rest comes with the next one.
pub const BATCH_BYTES: usize = 32 * 1024 * 1024;
/// Rows of the preview.
pub const PREVIEW_ROWS: u32 = 20;
/// One request at most (server side where the database has it, and here).
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
/// Connecting at most.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Tables listed for „Tabelle wählen“.
pub const MAX_TABLES: u32 = 2000;

/// What the source asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum Request<'a> {
    /// The columns of the query, no rows.
    Probe,
    /// The first rows as they come.
    Preview,
    /// A batch in key order.
    Batch {
        bound: Bound,
        key: Option<&'a Key>,
        limit: u32,
    },
    /// The key of the n-th newest row (one row of one column), or none.
    NthNewest(u32),
}

/// A result: columns and rows (values in column order).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Rows {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
}

/// A table or view for „Tabelle wählen“.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableName {
    pub schema: Option<String>,
    pub name: String,
}

/// `true` when the source is stopped: requests end with `cancelled()`.
pub type Stop<'a> = &'a (dyn Fn() -> bool + Sync);

pub trait Driver: Send {
    fn dialect(&self) -> Dialect;
    /// The key column's name as the result has it.
    fn set_key(&mut self, key: String);
    /// Runs a request for the query (with its key column) of this connection.
    fn run(&mut self, request: &Request, stop: Stop) -> AppResult<Rows>;
    /// Tables and views (app SQL, also read-only).
    fn tables(&mut self, stop: Stop) -> AppResult<Vec<TableName>>;
}

/// The query of a connection: what the user wrote (checked) and the key column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    pub sql: String,
    /// Empty: no batches yet (only probe, preview, tables).
    pub key: String,
}

impl Query {
    /// The SQL of a request; the parameter (if any) is the key.
    pub fn render(&self, request: &Request, dialect: Dialect) -> String {
        match request {
            Request::Probe => sql::probe_sql(&self.sql),
            Request::Preview => sql::preview_sql(&self.sql, dialect, PREVIEW_ROWS),
            Request::Batch { bound, limit, .. } => {
                sql::batch_sql(&self.sql, &self.key, dialect, *bound, *limit)
            }
            Request::NthNewest(n) => sql::nth_newest_sql(&self.sql, &self.key, dialect, *n),
        }
    }
}

/// The parameter of a request.
pub fn param<'a>(request: &'a Request) -> Option<&'a Key> {
    match request {
        Request::Batch {
            bound: Bound::AtLeast | Bound::After,
            key,
            ..
        } => *key,
        _ => None,
    }
}

pub fn cancelled() -> AppError {
    AppError::new(ErrorCode::Io, "abgebrochen")
}

pub fn timed_out() -> AppError {
    AppError::new(
        ErrorCode::ConnectionFailed,
        format!("keine Antwort innerhalb von {} s", QUERY_TIMEOUT.as_secs()),
    )
}

/// Runs `f` on the shared runtime (the one of the SSH connections, prompt 017) until it ends, the
/// time is up or the source stops.
pub fn block<T>(
    timeout: Duration,
    stop: Stop,
    f: impl Future<Output = AppResult<T>>,
) -> AppResult<T> {
    crate::remote::runtime().block_on(async move {
        let stopped = async {
            loop {
                if stop() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        tokio::select! {
            r = tokio::time::timeout(timeout, f) => r.unwrap_or_else(|_| Err(timed_out())),
            _ = stopped => Err(cancelled()),
        }
    })
}

/// Makes sure rustls has its process-wide provider (ring) before any TLS connection: tiberius
/// asks for the installed one and would otherwise take aws-lc-rs.
pub fn install_crypto() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Counts what a batch holds; true while there is room for another row.
#[derive(Debug, Default)]
pub struct Budget {
    pub bytes: usize,
}

impl Budget {
    pub fn add(&mut self, row: &[Value]) -> bool {
        self.bytes += row.iter().map(Value::size).sum::<usize>();
        self.bytes < BATCH_BYTES
    }
}
