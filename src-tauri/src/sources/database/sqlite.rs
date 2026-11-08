//! SQLite over the bundled `rusqlite` of the dashboard (prompt 012; `sqlx-sqlite` would bring a
//! second `libsqlite3-sys`, which cannot be linked into the same binary). Guarded like the
//! dashboard's query connections: opened with `SQLITE_OPEN_READ_ONLY` (= `mode=ro`, without a URI
//! that a path could extend), `PRAGMA query_only`, the authorizer of `report_db.rs` (reading and
//! functions only, no `ATTACH`, no `PRAGMA`, no `load_extension`), limits, and a progress handler
//! for the time limit and closing the tab. `prepare` refuses a second statement.

use super::driver::{
    Budget, Driver, Query, Request, Rows, Stop, TableName, MAX_TABLES, PREVIEW_ROWS, QUERY_TIMEOUT,
};
use super::sql::Dialect;
use super::value::{ColKind, Column, Key, Value, MAX_COLUMNS};
use super::DbConfig;
use crate::error::{AppError, AppResult, ErrorCode};
use rusqlite::limits::Limit;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub struct Lite {
    conn: Connection,
    query: Query,
    /// Set while a request runs: the progress handler ends it when the source stops.
    stop: Arc<AtomicBool>,
    deadline: Arc<parking_lot::Mutex<Option<Instant>>>,
}

fn sql_error(e: rusqlite::Error) -> AppError {
    let text = super::clean(&e.to_string());
    match e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::OperationInterrupted =>
        {
            AppError::new(
                ErrorCode::ConnectionFailed,
                "Abfrage abgebrochen (Zeitlimit)",
            )
        }
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(
                f.code,
                rusqlite::ErrorCode::CannotOpen
                    | rusqlite::ErrorCode::NotADatabase
                    | rusqlite::ErrorCode::DatabaseBusy
                    | rusqlite::ErrorCode::DatabaseLocked
                    | rusqlite::ErrorCode::SystemIoFailure
            ) =>
        {
            AppError::new(ErrorCode::ConnectionFailed, text)
        }
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::AuthorizationForStatementDenied =>
        {
            AppError::new(ErrorCode::InvalidQuery, "Nur lesende Abfragen sind erlaubt")
        }
        rusqlite::Error::MultipleStatement => {
            AppError::new(ErrorCode::InvalidQuery, "Nur eine Anweisung ist erlaubt")
        }
        _ => AppError::new(ErrorCode::InvalidQuery, text),
    }
}

pub fn connect(config: &DbConfig, query: Query) -> AppResult<Lite> {
    let path = std::path::Path::new(config.path.trim());
    let meta = std::fs::metadata(path).map_err(|e| AppError::from_io(&e, path))?;
    if !meta.is_file() {
        return Err(AppError::new(
            ErrorCode::InvalidSource,
            "keine SQLite-Datei (Ordner oder Gerät)",
        ));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut conn = Connection::open_with_flags(path, flags).map_err(sql_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(sql_error)?;
    // Before the authorizer, which refuses every PRAGMA.
    conn.execute_batch(
        "PRAGMA query_only = 1; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -8192;",
    )
    .map_err(sql_error)?;
    let set = |limit, value| conn.set_limit(limit, value).map(|_| ());
    set(Limit::SQLITE_LIMIT_ATTACHED, 0).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_COLUMN, MAX_COLUMNS as i32).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_SQL_LENGTH, 256 * 1024).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_EXPR_DEPTH, 200).map_err(sql_error)?;
    conn.authorizer(Some(crate::report_db::authorize))
        .map_err(sql_error)?;
    let stop = Arc::new(AtomicBool::new(false));
    let deadline: Arc<parking_lot::Mutex<Option<Instant>>> = Arc::default();
    {
        let stop = Arc::clone(&stop);
        let deadline = Arc::clone(&deadline);
        conn.progress_handler(
            1000,
            Some(move || {
                stop.load(Ordering::Relaxed) || deadline.lock().is_some_and(|d| Instant::now() > d)
            }),
        )
        .map_err(sql_error)?;
    }
    // Is it a database at all? (Opening is lazy.)
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .map_err(sql_error)?;
    Ok(Lite {
        conn,
        query,
        stop,
        deadline,
    })
}

/// SQLite types are per value; the declared type of a column only hints.
fn kind_of_decl(decl: Option<&str>) -> ColKind {
    let d = decl.unwrap_or_default().to_ascii_uppercase();
    if d.contains("INT") {
        ColKind::Int
    } else if d.contains("CHAR") || d.contains("CLOB") || d.contains("TEXT") {
        ColKind::Text
    } else if d.contains("BLOB") {
        ColKind::Bytes
    } else if d.contains("REAL") || d.contains("FLOA") || d.contains("DOUB") {
        ColKind::Float
    } else if d.contains("DATE") || d.contains("TIME") {
        // Stored as text (ISO 8601) or numbers; compared as such.
        ColKind::Text
    } else if d.contains("BOOL") {
        ColKind::Int
    } else if d.is_empty() {
        // An expression or a column without type: assume it orders (as text or number).
        ColKind::Text
    } else {
        ColKind::Decimal
    }
}

fn value(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::I64(n),
        ValueRef::Real(f) => Value::F64(f),
        ValueRef::Text(t) => Value::Text(super::value::text_bytes(t)),
        ValueRef::Blob(b) => Value::Bytes(b.len()),
    }
}

impl Lite {
    fn exec(&mut self, sql: &str, key: Option<&Key>, max_rows: usize) -> AppResult<Rows> {
        let mut statement = self.conn.prepare(sql).map_err(sql_error)?;
        let columns: Vec<Column> = statement
            .columns()
            .map(|c| {
                let decl = c.decl_type();
                Column {
                    name: c.name().to_string(),
                    type_name: decl.unwrap_or("").to_string(),
                    kind: kind_of_decl(decl),
                }
            })
            .collect();
        let n = columns.len();
        let bind: Vec<rusqlite::types::Value> = match key {
            None => Vec::new(),
            Some(Key::I64(v)) => vec![(*v).into()],
            Some(Key::U64(v)) => vec![i64::try_from(*v).unwrap_or(i64::MAX).into()],
            Some(Key::F64(v)) => vec![(*v).into()],
            Some(Key::Text(v)) => vec![v.clone().into()],
            Some(Key::Ts(v)) => vec![v.format("%Y-%m-%dT%H:%M:%S%.f").to_string().into()],
            Some(Key::TsTz(v)) => vec![v.to_rfc3339().into()],
            Some(Key::Date(v)) => vec![v.format("%Y-%m-%d").to_string().into()],
        };
        let mut rows = statement
            .query(rusqlite::params_from_iter(bind))
            .map_err(sql_error)?;
        let mut out = Rows {
            columns,
            rows: Vec::new(),
        };
        let mut budget = Budget::default();
        while let Some(row) = rows.next().map_err(sql_error)? {
            let values: Vec<Value> = (0..n)
                .map(|i| row.get_ref(i).map(value).unwrap_or(Value::Null))
                .collect();
            let room = budget.add(&values);
            out.rows.push(values);
            if out.rows.len() >= max_rows || !room {
                break;
            }
        }
        // The first row decides the kind of an untyped column (`SELECT ts AS t`).
        if let Some(first) = out.rows.first() {
            for (c, v) in out.columns.iter_mut().zip(first) {
                if c.type_name.is_empty() {
                    c.kind = match v {
                        Value::I64(_) => ColKind::Int,
                        Value::F64(_) => ColKind::Float,
                        Value::Bytes(_) => ColKind::Bytes,
                        _ => c.kind,
                    };
                }
            }
        }
        Ok(out)
    }

    fn guarded<T>(
        &mut self,
        stop: Stop,
        f: impl FnOnce(&mut Self) -> AppResult<T>,
    ) -> AppResult<T> {
        // The progress handler cannot call `stop` (not 'static): a watcher sets the flag.
        *self.deadline.lock() = Some(Instant::now() + QUERY_TIMEOUT);
        let flag = Arc::clone(&self.stop);
        flag.store(stop(), Ordering::Relaxed);
        let result = std::thread::scope(|scope| {
            let finished = Arc::new(AtomicBool::new(false));
            let watcher_finished = Arc::clone(&finished);
            let watcher_flag = Arc::clone(&flag);
            scope.spawn(move || {
                while !watcher_finished.load(Ordering::Relaxed) {
                    if stop() {
                        watcher_flag.store(true, Ordering::Relaxed);
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            });
            let r = f(self);
            finished.store(true, Ordering::Relaxed);
            r
        });
        *self.deadline.lock() = None;
        let stopped = self.stop.swap(false, Ordering::Relaxed);
        match result {
            Err(_) if stopped => Err(super::driver::cancelled()),
            r => r,
        }
    }
}

impl Driver for Lite {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn set_key(&mut self, key: String) {
        self.query.key = key;
    }

    fn run(&mut self, request: &Request, stop: Stop) -> AppResult<Rows> {
        let sql = self.query.render(request, Dialect::Sqlite);
        let key = super::driver::param(request).cloned();
        let max = match request {
            Request::Batch { limit, .. } => *limit as usize,
            Request::Preview => PREVIEW_ROWS as usize,
            Request::Probe => 0,
            Request::NthNewest(_) => 1,
        };
        self.guarded(stop, |s| {
            if max == 0 {
                // Columns only: preparing is enough.
                let statement = s.conn.prepare(&sql).map_err(sql_error)?;
                let columns = statement
                    .columns()
                    .map(|c| Column {
                        name: c.name().to_string(),
                        type_name: c.decl_type().unwrap_or("").to_string(),
                        kind: kind_of_decl(c.decl_type()),
                    })
                    .collect();
                return Ok(Rows {
                    columns,
                    rows: Vec::new(),
                });
            }
            s.exec(&sql, key.as_ref(), max)
        })
    }

    fn tables(&mut self, stop: Stop) -> AppResult<Vec<TableName>> {
        let sql = format!(
            "SELECT NULL, name FROM sqlite_schema WHERE type IN ('table', 'view') \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name LIMIT {MAX_TABLES}"
        );
        let rows = self.guarded(stop, |s| s.exec(&sql, None, MAX_TABLES as usize))?;
        Ok(super::table_names(rows))
    }
}

#[cfg(test)]
impl Lite {
    /// Runs SQL as it is (no wrapping, no check): for the tests that the connection refuses writes.
    pub fn raw_for_tests(&mut self, sql: &str) -> AppResult<()> {
        self.conn.execute_batch(sql).map_err(sql_error)
    }
}
