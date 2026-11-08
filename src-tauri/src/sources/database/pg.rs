//! PostgreSQL over `sqlx-postgres` (prompt 019). Read-only twice: the session default
//! (`default_transaction_read_only`) and an explicit `BEGIN READ ONLY` per request, which a
//! `set_config(...)` in the query cannot turn back (the spike checked that). `statement_timeout`
//! ends long queries on the server; prepared statements refuse a second statement.

use super::driver::{
    block, param, Budget, Driver, Query, Request, Rows, Stop, TableName, CONNECT_TIMEOUT,
    MAX_TABLES, QUERY_TIMEOUT,
};
use super::sql::Dialect;
use super::value::{pg_numeric, text, text_bytes, ColKind, Column, Key, Value};
use super::{db_error, DbConfig, TlsMode};
use crate::error::AppResult;
use crate::remote::secrets::Secret;
use futures_util::StreamExt;
use sqlx_core::column::Column as _;
use sqlx_core::connection::Connection;
use sqlx_core::executor::Executor;
use sqlx_core::row::Row as _;
use sqlx_core::sql_str::AssertSqlSafe;
use sqlx_core::type_info::TypeInfo;
use sqlx_core::value::ValueRef;
use sqlx_postgres::{PgConnectOptions, PgConnection, PgRow, PgSslMode, PgValueFormat, Postgres};

pub struct Pg {
    conn: Option<PgConnection>,
    query: Query,
    /// For the error texts (never holds the password).
    config: DbConfig,
}

pub fn connect(
    config: &DbConfig,
    secret: Option<&Secret>,
    query: Query,
    stop: Stop,
) -> AppResult<Pg> {
    super::driver::install_crypto();
    let mut options = PgConnectOptions::new_without_pgpass()
        .host(config.host.trim())
        .port(config.port_or_default())
        .username(config.user.trim())
        .application_name("Log Commander")
        .statement_cache_capacity(16)
        .ssl_mode(match config.tls {
            TlsMode::Verify => PgSslMode::VerifyFull,
            TlsMode::NoVerify => PgSslMode::Require,
            TlsMode::Off => PgSslMode::Disable,
        })
        .options([
            ("default_transaction_read_only", "on".to_string()),
            ("statement_timeout", QUERY_TIMEOUT.as_millis().to_string()),
            ("idle_in_transaction_session_timeout", "60000".to_string()),
            // The checker tokenizes strings the standard way.
            ("standard_conforming_strings", "on".to_string()),
        ]);
    if !config.database.trim().is_empty() {
        options = options.database(config.database.trim());
    }
    if let Some(secret) = secret {
        options = options.password(secret.expose());
    }
    if config.tls == TlsMode::Verify && !config.ca_file.trim().is_empty() {
        options = options.ssl_root_cert(config.ca_file.trim());
    }
    let conn = block(CONNECT_TIMEOUT, stop, async {
        PgConnection::connect_with(&options)
            .await
            .map_err(|e| db_error(config, &e))
    })?;
    Ok(Pg {
        conn: Some(conn),
        query,
        config: config.clone(),
    })
}

fn kind(type_name: &str) -> ColKind {
    match type_name {
        "INT2" | "INT4" | "INT8" | "OID" => ColKind::Int,
        "FLOAT4" | "FLOAT8" => ColKind::Float,
        "NUMERIC" => ColKind::Decimal,
        "BOOL" => ColKind::Bool,
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "\"CHAR\"" | "CHAR" | "CITEXT" | "citext" => {
            ColKind::Text
        }
        "BYTEA" => ColKind::Bytes,
        "TIMESTAMP" => ColKind::Timestamp,
        "TIMESTAMPTZ" => ColKind::TimestampTz,
        "DATE" => ColKind::Date,
        "TIME" => ColKind::Time,
        "JSON" | "JSONB" => ColKind::Json,
        "UUID" => ColKind::Uuid,
        _ => ColKind::Other,
    }
}

fn columns(row: &PgRow) -> Vec<Column> {
    row.columns()
        .iter()
        .map(|c| {
            let type_name = c.type_info().name().to_string();
            Column {
                name: c.name().to_string(),
                kind: kind(&type_name),
                type_name,
            }
        })
        .collect()
}

fn decode<'r, T: sqlx_core::decode::Decode<'r, Postgres>>(
    v: sqlx_postgres::PgValueRef<'r>,
) -> Option<T> {
    T::decode(v).ok()
}

fn value(row: &PgRow, i: usize, kind: ColKind, type_name: &str) -> Value {
    let Ok(v) = row.try_get_raw(i) else {
        return Value::Null;
    };
    if v.is_null() {
        return Value::Null;
    }
    let other = || Value::Other(type_name.to_string());
    let text_or_other = |v: sqlx_postgres::PgValueRef| -> Value {
        // Enums, domains over text and the text format arrive as UTF-8.
        match v.as_bytes().ok().map(std::str::from_utf8) {
            Some(Ok(s)) => Value::Text(text(s)),
            _ => other(),
        }
    };
    let decoded = match kind {
        ColKind::Int => match type_name {
            "INT2" => decode::<i16>(v).map(|n| Value::I64(n.into())),
            "INT4" => decode::<i32>(v).map(|n| Value::I64(n.into())),
            "OID" => decode::<sqlx_postgres::types::Oid>(v).map(|n| Value::I64(n.0.into())),
            _ => decode::<i64>(v).map(Value::I64),
        },
        ColKind::Float => match type_name {
            "FLOAT4" => decode::<f32>(v).map(|n| Value::F64(n.into())),
            _ => decode::<f64>(v).map(Value::F64),
        },
        ColKind::Decimal => match v.format() {
            PgValueFormat::Binary => v.as_bytes().ok().and_then(pg_numeric).map(Value::Decimal),
            PgValueFormat::Text => v.as_str().ok().map(|s| Value::Decimal(s.to_string())),
        },
        ColKind::Bool => decode::<bool>(v).map(Value::Bool),
        ColKind::Text => v.as_bytes().ok().map(|b| Value::Text(text_bytes(b))),
        ColKind::Bytes => v.as_bytes().ok().map(|b| Value::Bytes(b.len())),
        ColKind::Timestamp => decode::<chrono::NaiveDateTime>(v).map(Value::Ts),
        ColKind::TimestampTz => {
            decode::<chrono::DateTime<chrono::Utc>>(v).map(|t| Value::TsTz(t.fixed_offset()))
        }
        ColKind::Date => decode::<chrono::NaiveDate>(v).map(Value::Date),
        ColKind::Time => decode::<chrono::NaiveTime>(v).map(Value::Time),
        ColKind::Json => v.as_bytes().ok().map(|b| {
            // JSONB in binary: a version byte (1) before the text.
            let b = if type_name == "JSONB" && v.format() == PgValueFormat::Binary {
                b.get(1..).unwrap_or_default()
            } else {
                b
            };
            Value::Json(text_bytes(b))
        }),
        ColKind::Uuid => v.as_bytes().ok().and_then(|b| {
            let b: [u8; 16] = b.try_into().ok()?;
            let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
            Some(Value::Text(format!(
                "{}-{}-{}-{}-{}",
                &h[..8],
                &h[8..12],
                &h[12..16],
                &h[16..20],
                &h[20..]
            )))
        }),
        ColKind::Other => Some(text_or_other(v)),
    };
    decoded.unwrap_or_else(other)
}

impl Pg {
    async fn exec(
        conn: &mut PgConnection,
        sql: String,
        key: Option<&Key>,
        max_rows: usize,
        config_label: &DbConfig,
    ) -> AppResult<Rows> {
        let fail = |e: sqlx_core::error::Error| db_error(config_label, &e);
        conn.execute("BEGIN READ ONLY").await.map_err(fail)?;
        let result = async {
            let mut q = sqlx_core::query::query::<Postgres>(AssertSqlSafe(sql));
            q = match key {
                None => q,
                Some(Key::I64(v)) => q.bind(*v),
                Some(Key::U64(v)) => q.bind(i64::try_from(*v).unwrap_or(i64::MAX)),
                Some(Key::F64(v)) => q.bind(*v),
                Some(Key::Text(v)) => q.bind(v.clone()),
                Some(Key::Ts(v)) => q.bind(*v),
                Some(Key::TsTz(v)) => q.bind(v.to_utc()),
                Some(Key::Date(v)) => q.bind(*v),
            };
            let mut out = Rows::default();
            let mut budget = Budget::default();
            let mut stream = q.fetch(&mut *conn);
            while let Some(row) = stream.next().await {
                let row = row.map_err(fail)?;
                if out.columns.is_empty() {
                    out.columns = columns(&row);
                }
                let values: Vec<Value> = out
                    .columns
                    .iter()
                    .enumerate()
                    .map(|(i, c)| value(&row, i, c.kind, &c.type_name))
                    .collect();
                let room = budget.add(&values);
                out.rows.push(values);
                if out.rows.len() >= max_rows || !room {
                    break;
                }
            }
            Ok(out)
        }
        .await;
        conn.execute("ROLLBACK").await.map_err(fail)?;
        result
    }

    /// The columns without rows: a prepared statement describes them.
    async fn describe(conn: &mut PgConnection, sql: String, config: &DbConfig) -> AppResult<Rows> {
        use sqlx_core::statement::Statement;
        let statement = conn
            .prepare(sqlx_core::sql_str::SqlSafeStr::into_sql_str(AssertSqlSafe(
                sql,
            )))
            .await
            .map_err(|e| db_error(config, &e))?;
        let columns = statement
            .columns()
            .iter()
            .map(|c| {
                let type_name = c.type_info().name().to_string();
                Column {
                    name: c.name().to_string(),
                    kind: kind(&type_name),
                    type_name,
                }
            })
            .collect();
        Ok(Rows {
            columns,
            rows: Vec::new(),
        })
    }
}

impl Pg {
    fn conn(&mut self) -> AppResult<&mut PgConnection> {
        self.conn.as_mut().ok_or_else(|| {
            crate::error::AppError::new(
                crate::error::ErrorCode::ConnectionFailed,
                "Verbindung getrennt",
            )
        })
    }
}

impl Driver for Pg {
    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    fn set_key(&mut self, key: String) {
        self.query.key = key;
    }

    fn run(&mut self, request: &Request, stop: Stop) -> AppResult<Rows> {
        let sql = self.query.render(request, Dialect::Postgres);
        let key = param(request).cloned();
        let max = match request {
            Request::Batch { limit, .. } => *limit as usize,
            Request::Preview => super::driver::PREVIEW_ROWS as usize,
            _ => 1,
        };
        let config = self.config.clone();
        let conn = self.conn()?;
        let r = if matches!(request, Request::Probe) {
            block(QUERY_TIMEOUT, stop, Self::describe(conn, sql, &config))
        } else {
            block(
                QUERY_TIMEOUT,
                stop,
                Self::exec(conn, sql, key.as_ref(), max, &config),
            )
        };
        if r.as_ref()
            .is_err_and(|e| e.code != crate::error::ErrorCode::InvalidQuery)
        {
            // A broken or cancelled request leaves the connection in an unknown state.
            self.conn = None;
        }
        r
    }

    fn tables(&mut self, stop: Stop) -> AppResult<Vec<TableName>> {
        let sql = format!(
            "SELECT table_schema::text, table_name::text FROM information_schema.tables \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY 1, 2 LIMIT {MAX_TABLES}"
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
