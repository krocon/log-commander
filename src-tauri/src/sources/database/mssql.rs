//! SQL Server over `tiberius` (prompt 019). SQL Server has no read-only session for a normal
//! database: `ApplicationIntent=ReadOnly` only routes to a readable replica of an availability
//! group (the spike showed a write going through on a standalone server). So every request runs
//! inside `BEGIN TRANSACTION` … `ROLLBACK`, after the checker (`sql.rs`) refused every writing word
//! and the query sits inside a derived table, where no statement can start. `LOCK_TIMEOUT` and the
//! client-side time limit end long requests (closing the connection makes the server stop).

use super::driver::{
    block, param, Budget, Driver, Query, Request, Rows, Stop, TableName, CONNECT_TIMEOUT,
    MAX_TABLES, PREVIEW_ROWS, QUERY_TIMEOUT,
};
use super::sql::Dialect;
use super::value::{text, ColKind, Column, Key, Value};
use super::{DbConfig, TlsMode};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::remote::secrets::Secret;
use futures_util::StreamExt;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type Conn = Client<Compat<TcpStream>>;

pub struct Ms {
    conn: Option<Conn>,
    query: Query,
    config: DbConfig,
}

/// Errors of tiberius in words; never holds the password (tiberius does not put it in errors).
pub fn ms_error(config: &DbConfig, e: &tiberius::error::Error) -> AppError {
    use tiberius::error::Error as E;
    let on = config.where_label();
    match e {
        E::Server(t) if matches!(t.code(), 18456 | 18452 | 18486 | 18487 | 18488) => {
            super::auth_error(
                config,
                &format!("Anmeldung an {on} abgelehnt ({})", t.code()),
            )
        }
        E::Server(t) if t.code() == 4060 => AppError::new(
            ErrorCode::NotFound,
            format!(
                "Datenbank „{}“ auf {on} nicht erreichbar oder kein Zugriff",
                config.database.trim()
            ),
        ),
        E::Server(t) if matches!(t.code(), 229 | 230 | 262 | 297 | 300 | 916) => AppError::new(
            ErrorCode::PermissionDenied,
            format!("Kein Zugriff: {}", super::clean(t.message())),
        ),
        E::Server(t) => AppError::new(
            ErrorCode::InvalidQuery,
            format!("SQL Server {}: {}", t.code(), super::clean(t.message())),
        ),
        E::Tls(m) => AppError::new(ErrorCode::ConnectionFailed, super::tls_text(&on, m)),
        E::Io { message, .. } => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on} nicht erreichbar: {}", super::clean(message)),
        ),
        other => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: {}", super::clean(&other.to_string())),
        ),
    }
}

pub fn connect(
    config: &DbConfig,
    secret: Option<&Secret>,
    query: Query,
    stop: Stop,
) -> AppResult<Ms> {
    super::driver::install_crypto();
    let mut c = Config::new();
    c.host(config.host.trim());
    c.port(config.port_or_default());
    if !config.database.trim().is_empty() {
        c.database(config.database.trim());
    }
    c.application_name("Log Commander");
    c.readonly(true);
    c.authentication(AuthMethod::sql_server(
        config.user.trim(),
        secret.map(Secret::expose).unwrap_or_default(),
    ));
    match config.tls {
        TlsMode::Verify => {
            c.encryption(EncryptionLevel::Required);
            if !config.ca_file.trim().is_empty() {
                c.trust_cert_ca(config.ca_file.trim());
            }
        }
        TlsMode::NoVerify => {
            c.encryption(EncryptionLevel::Required);
            c.trust_cert();
        }
        // Only the login is encrypted then (the server may still insist on more).
        TlsMode::Off => {
            c.encryption(EncryptionLevel::Off);
            c.trust_cert();
        }
    }
    let conn = block(CONNECT_TIMEOUT, stop, async {
        let tcp = TcpStream::connect(c.get_addr()).await.map_err(|e| {
            AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{} nicht erreichbar: {e}", config.where_label()),
            )
        })?;
        tcp.set_nodelay(true).ok();
        let mut client = Client::connect(c, tcp.compat_write())
            .await
            .map_err(|e| ms_error(config, &e))?;
        client
            .simple_query(format!(
                "SET LOCK_TIMEOUT {}; SET QUOTED_IDENTIFIER ON; SET IMPLICIT_TRANSACTIONS OFF; \
                 SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
                QUERY_TIMEOUT.as_millis()
            ))
            .await
            .map_err(|e| ms_error(config, &e))?
            .into_results()
            .await
            .map_err(|e| ms_error(config, &e))?;
        Ok(client)
    })?;
    Ok(Ms {
        conn: Some(conn),
        query,
        config: config.clone(),
    })
}

fn kind(t: ColumnType) -> ColKind {
    use ColumnType as T;
    match t {
        T::Int1 | T::Int2 | T::Int4 | T::Int8 | T::Intn => ColKind::Int,
        T::Float4 | T::Float8 | T::Floatn => ColKind::Float,
        T::Money | T::Money4 | T::Decimaln | T::Numericn => ColKind::Decimal,
        T::Bit | T::Bitn => ColKind::Bool,
        T::BigVarChar | T::BigChar | T::NVarchar | T::NChar | T::Text | T::NText => ColKind::Text,
        T::BigVarBin | T::BigBinary | T::Image => ColKind::Bytes,
        T::Datetime | T::Datetime4 | T::Datetimen | T::Datetime2 => ColKind::Timestamp,
        T::DatetimeOffsetn => ColKind::TimestampTz,
        T::Daten => ColKind::Date,
        T::Timen => ColKind::Time,
        T::Guid => ColKind::Uuid,
        T::Xml => ColKind::Text,
        _ => ColKind::Other,
    }
}

fn columns(cols: &[tiberius::Column]) -> Vec<Column> {
    cols.iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: format!("{:?}", c.column_type()),
            kind: kind(c.column_type()),
        })
        .collect()
}

fn value(data: &ColumnData<'static>, type_name: &str) -> Value {
    let other = || Value::Other(type_name.to_string());
    match data {
        ColumnData::U8(v) => v.map_or(Value::Null, |n| Value::I64(n.into())),
        ColumnData::I16(v) => v.map_or(Value::Null, |n| Value::I64(n.into())),
        ColumnData::I32(v) => v.map_or(Value::Null, |n| Value::I64(n.into())),
        ColumnData::I64(v) => v.map_or(Value::Null, Value::I64),
        ColumnData::F32(v) => v.map_or(Value::Null, |n| Value::F64(n.into())),
        ColumnData::F64(v) => v.map_or(Value::Null, Value::F64),
        ColumnData::Bit(v) => v.map_or(Value::Null, Value::Bool),
        ColumnData::String(v) => v.as_ref().map_or(Value::Null, |s| Value::Text(text(s))),
        ColumnData::Guid(v) => v.map_or(Value::Null, |g| Value::Text(g.to_string())),
        ColumnData::Binary(v) => v.as_ref().map_or(Value::Null, |b| Value::Bytes(b.len())),
        ColumnData::Numeric(v) => v.map_or(Value::Null, |n| Value::Decimal(n.to_string())),
        ColumnData::Xml(v) => v
            .as_ref()
            .map_or(Value::Null, |x| Value::Text(text(&x.to_string()))),
        ColumnData::DateTimeOffset(None)
        | ColumnData::DateTime(None)
        | ColumnData::SmallDateTime(None)
        | ColumnData::DateTime2(None)
        | ColumnData::Date(None)
        | ColumnData::Time(None) => Value::Null,
        ColumnData::DateTimeOffset(_) => {
            match chrono::DateTime::<chrono::FixedOffset>::from_sql(data) {
                Ok(Some(t)) => Value::TsTz(t),
                _ => other(),
            }
        }
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            match chrono::NaiveDateTime::from_sql(data) {
                Ok(Some(t)) => Value::Ts(t),
                _ => other(),
            }
        }
        ColumnData::Date(_) => match chrono::NaiveDate::from_sql(data) {
            Ok(Some(d)) => Value::Date(d),
            _ => other(),
        },
        ColumnData::Time(_) => match chrono::NaiveTime::from_sql(data) {
            Ok(Some(t)) => Value::Time(t),
            _ => other(),
        },
    }
}

impl Ms {
    async fn exec(
        conn: &mut Conn,
        sql: String,
        key: Option<Key>,
        max_rows: usize,
        config: &DbConfig,
    ) -> AppResult<Rows> {
        let fail = |e: tiberius::error::Error| ms_error(config, &e);
        conn.simple_query("BEGIN TRANSACTION")
            .await
            .map_err(fail)?
            .into_results()
            .await
            .map_err(fail)?;
        let result = async {
            let text;
            let utc;
            let params: Vec<&dyn tiberius::ToSql> = match &key {
                None => Vec::new(),
                Some(Key::I64(v)) => vec![v],
                Some(Key::U64(v)) => {
                    text = v.to_string();
                    vec![&text]
                }
                Some(Key::F64(v)) => vec![v],
                Some(Key::Text(v)) => vec![v],
                Some(Key::Ts(v)) => vec![v],
                Some(Key::TsTz(v)) => {
                    utc = *v;
                    vec![&utc]
                }
                Some(Key::Date(v)) => vec![v],
            };
            let mut stream = conn.query(sql, &params).await.map_err(fail)?;
            let mut out = Rows::default();
            if let Some(cols) = stream.columns().await.map_err(fail)? {
                out.columns = columns(cols);
            }
            let mut rows = stream.into_row_stream();
            let mut budget = Budget::default();
            let mut full = false;
            while let Some(row) = rows.next().await {
                let row = row.map_err(fail)?;
                // The rest is read and dropped: the connection must see the end of the result.
                if full {
                    continue;
                }
                let values: Vec<Value> = row
                    .cells()
                    .zip(out.columns.iter())
                    .map(|((_, data), c)| value(data, &c.type_name))
                    .collect();
                let room = budget.add(&values);
                out.rows.push(values);
                full = out.rows.len() >= max_rows || !room;
            }
            Ok(out)
        }
        .await;
        conn.simple_query("IF @@TRANCOUNT > 0 ROLLBACK")
            .await
            .map_err(fail)?
            .into_results()
            .await
            .map_err(fail)?;
        result
    }

    fn conn(&mut self) -> AppResult<&mut Conn> {
        self.conn
            .as_mut()
            .ok_or_else(|| AppError::new(ErrorCode::ConnectionFailed, "Verbindung getrennt"))
    }
}

impl Driver for Ms {
    fn dialect(&self) -> Dialect {
        Dialect::Mssql
    }

    fn set_key(&mut self, key: String) {
        self.query.key = key;
    }

    fn run(&mut self, request: &Request, stop: Stop) -> AppResult<Rows> {
        let sql = self.query.render(request, Dialect::Mssql);
        let key = param(request).cloned();
        let max = match request {
            Request::Batch { limit, .. } => *limit as usize,
            Request::Preview => PREVIEW_ROWS as usize,
            _ => 1,
        };
        let config = self.config.clone();
        let conn = self.conn()?;
        let r = block(
            QUERY_TIMEOUT,
            stop,
            Self::exec(conn, sql, key, max, &config),
        );
        if r.as_ref().is_err_and(|e| e.code != ErrorCode::InvalidQuery) {
            self.conn = None;
        }
        r
    }

    fn tables(&mut self, stop: Stop) -> AppResult<Vec<TableName>> {
        let sql = format!(
            "SELECT TOP ({MAX_TABLES}) TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES \
             ORDER BY TABLE_SCHEMA, TABLE_NAME"
        );
        let config = self.config.clone();
        let conn = self.conn()?;
        let rows = block(
            QUERY_TIMEOUT,
            stop,
            Self::exec(conn, sql, None, MAX_TABLES as usize, &config),
        )?;
        Ok(super::table_names(rows))
    }
}
