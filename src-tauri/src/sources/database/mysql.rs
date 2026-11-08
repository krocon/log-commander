//! MySQL and MariaDB over `sqlx-mysql` (prompt 019). Read-only twice: the session
//! (`SET SESSION TRANSACTION READ ONLY`) and `START TRANSACTION READ ONLY` per request.
//! `time_zone` is UTC (TIMESTAMP values are instants), `max_execution_time` (MySQL, ms) or `max_statement_time` (MariaDB, s) end long queries on the
//! server. `ANSI_QUOTES` and `NO_BACKSLASH_ESCAPES` are taken out of the session's `sql_mode`, so
//! strings end where the checker (`sql.rs`) ends them.

use super::driver::{
    block, param, Budget, Driver, Query, Request, Rows, Stop, TableName, CONNECT_TIMEOUT,
    MAX_TABLES, PREVIEW_ROWS, QUERY_TIMEOUT,
};
use super::sql::Dialect;
use super::value::{text, text_bytes, ColKind, Column, Key, Value};
use super::{db_error, DbConfig, TlsMode};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::remote::secrets::Secret;
use futures_util::StreamExt;
use sqlx_core::column::Column as _;
use sqlx_core::connection::Connection;
use sqlx_core::executor::Executor;
use sqlx_core::row::Row as _;
use sqlx_core::sql_str::AssertSqlSafe;
use sqlx_core::type_info::TypeInfo;
use sqlx_core::value::ValueRef;
use sqlx_mysql::{MySql, MySqlConnectOptions, MySqlConnection, MySqlRow, MySqlSslMode};

pub struct My {
    conn: Option<MySqlConnection>,
    query: Query,
    config: DbConfig,
}

pub fn connect(
    config: &DbConfig,
    secret: Option<&Secret>,
    query: Query,
    stop: Stop,
) -> AppResult<My> {
    super::driver::install_crypto();
    let mut options = MySqlConnectOptions::new()
        .host(config.host.trim())
        .port(config.port_or_default())
        .username(config.user.trim())
        .statement_cache_capacity(16)
        .charset("utf8mb4")
        .ssl_mode(match config.tls {
            TlsMode::Verify => MySqlSslMode::VerifyIdentity,
            TlsMode::NoVerify => MySqlSslMode::Required,
            TlsMode::Off => MySqlSslMode::Disabled,
        });
    if !config.database.trim().is_empty() {
        options = options.database(config.database.trim());
    }
    if let Some(secret) = secret {
        options = options.password(secret.expose());
    }
    if config.tls == TlsMode::Verify && !config.ca_file.trim().is_empty() {
        options = options.ssl_ca(config.ca_file.trim());
    }
    let conn = block(CONNECT_TIMEOUT, stop, async {
        let fail = |e: sqlx_core::error::Error| db_error(config, &e);
        let mut conn = MySqlConnection::connect_with(&options)
            .await
            .map_err(fail)?;
        let version: (String,) = sqlx_core::query_as::query_as("SELECT VERSION()")
            .fetch_one(&mut conn)
            .await
            .map_err(fail)?;
        let timeout = if version.0.contains("MariaDB") {
            format!(
                "SET SESSION max_statement_time = {}",
                QUERY_TIMEOUT.as_secs()
            )
        } else {
            format!(
                "SET SESSION max_execution_time = {}",
                QUERY_TIMEOUT.as_millis()
            )
        };
        for sql in [
            "SET SESSION TRANSACTION READ ONLY".to_string(),
            // TIMESTAMP values come in the session's zone: UTC, so they are read as instants.
            "SET SESSION time_zone = '+00:00'".to_string(),
            "SET SESSION sql_mode = REPLACE(REPLACE(@@SESSION.sql_mode, 'ANSI_QUOTES', ''), \
             'NO_BACKSLASH_ESCAPES', '')"
                .to_string(),
            timeout,
        ] {
            conn.execute(AssertSqlSafe(sql)).await.map_err(fail)?;
        }
        Ok(conn)
    })?;
    Ok(My {
        conn: Some(conn),
        query,
        config: config.clone(),
    })
}

fn kind(type_name: &str) -> ColKind {
    match type_name {
        "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" | "TINYINT UNSIGNED"
        | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED" | "BIGINT UNSIGNED"
        | "YEAR" => ColKind::Int,
        "FLOAT" | "DOUBLE" => ColKind::Float,
        "DECIMAL" => ColKind::Decimal,
        "BOOLEAN" => ColKind::Bool,
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            ColKind::Text
        }
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BIT"
        | "GEOMETRY" => ColKind::Bytes,
        "DATETIME" => ColKind::Timestamp,
        "TIMESTAMP" => ColKind::TimestampTz,
        "DATE" => ColKind::Date,
        "TIME" => ColKind::Time,
        "JSON" => ColKind::Json,
        _ => ColKind::Other,
    }
}

fn column_list<'a>(columns: impl Iterator<Item = &'a sqlx_mysql::MySqlColumn>) -> Vec<Column> {
    columns
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

fn decode<'r, T: sqlx_core::decode::Decode<'r, MySql>>(
    v: sqlx_mysql::MySqlValueRef<'r>,
) -> Option<T> {
    T::decode(v).ok()
}

fn value(row: &MySqlRow, i: usize, kind: ColKind, type_name: &str) -> Value {
    let Ok(v) = row.try_get_raw(i) else {
        return Value::Null;
    };
    if v.is_null() {
        return Value::Null;
    }
    let decoded = match kind {
        ColKind::Int if type_name.ends_with("UNSIGNED") => decode::<u64>(v).map(Value::U64),
        ColKind::Int if type_name == "YEAR" => decode::<u16>(v).map(|n| Value::I64(n.into())),
        ColKind::Int => decode::<i64>(v).map(Value::I64),
        ColKind::Float if type_name == "FLOAT" => decode::<f32>(v).map(|n| Value::F64(n.into())),
        ColKind::Float => decode::<f64>(v).map(Value::F64),
        ColKind::Decimal => decode::<&str>(v).map(|s| Value::Decimal(text(s))),
        ColKind::Bool => decode::<bool>(v).map(Value::Bool),
        ColKind::Text => decode::<&str>(v).map(|s| Value::Text(text(s))),
        ColKind::Bytes => decode::<&[u8]>(v).map(|b| Value::Bytes(b.len())),
        ColKind::Timestamp => decode::<chrono::NaiveDateTime>(v).map(Value::Ts),
        ColKind::TimestampTz => {
            decode::<chrono::DateTime<chrono::Utc>>(v).map(|t| Value::TsTz(t.fixed_offset()))
        }
        ColKind::Date => decode::<chrono::NaiveDate>(v).map(Value::Date),
        ColKind::Time => decode::<chrono::NaiveTime>(v).map(Value::Time),
        ColKind::Json => decode::<&[u8]>(v).map(|b| Value::Json(text_bytes(b))),
        ColKind::Uuid | ColKind::Other => decode::<&str>(v).map(|s| Value::Text(text(s))),
    };
    decoded.unwrap_or_else(|| Value::Other(type_name.to_string()))
}

impl My {
    async fn exec(
        conn: &mut MySqlConnection,
        sql: String,
        key: Option<Key>,
        max_rows: usize,
        config: &DbConfig,
    ) -> AppResult<Rows> {
        let fail = |e: sqlx_core::error::Error| db_error(config, &e);
        conn.execute("START TRANSACTION READ ONLY")
            .await
            .map_err(fail)?;
        let result = async {
            let mut q = sqlx_core::query::query::<MySql>(AssertSqlSafe(sql));
            q = match key {
                None => q,
                Some(Key::I64(v)) => q.bind(v),
                Some(Key::U64(v)) => q.bind(v),
                Some(Key::F64(v)) => q.bind(v),
                Some(Key::Text(v)) => q.bind(v),
                Some(Key::Ts(v)) => q.bind(v),
                Some(Key::TsTz(v)) => q.bind(v.to_utc()),
                Some(Key::Date(v)) => q.bind(v),
            };
            let mut out = Rows::default();
            let mut budget = Budget::default();
            let mut stream = q.fetch(&mut *conn);
            while let Some(row) = stream.next().await {
                let row = row.map_err(fail)?;
                if out.columns.is_empty() {
                    out.columns = column_list(row.columns().iter());
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

    async fn describe(
        conn: &mut MySqlConnection,
        sql: String,
        config: &DbConfig,
    ) -> AppResult<Rows> {
        use sqlx_core::statement::Statement;
        let statement = conn
            .prepare(sqlx_core::sql_str::SqlSafeStr::into_sql_str(AssertSqlSafe(
                sql,
            )))
            .await
            .map_err(|e| db_error(config, &e))?;
        Ok(Rows {
            columns: column_list(statement.columns().iter()),
            rows: Vec::new(),
        })
    }

    fn conn(&mut self) -> AppResult<&mut MySqlConnection> {
        self.conn
            .as_mut()
            .ok_or_else(|| AppError::new(ErrorCode::ConnectionFailed, "Verbindung getrennt"))
    }
}

impl Driver for My {
    fn dialect(&self) -> Dialect {
        Dialect::Mysql
    }

    fn set_key(&mut self, key: String) {
        self.query.key = key;
    }

    fn run(&mut self, request: &Request, stop: Stop) -> AppResult<Rows> {
        let sql = self.query.render(request, Dialect::Mysql);
        let key = param(request).cloned();
        let max = match request {
            Request::Batch { limit, .. } => *limit as usize,
            Request::Preview => PREVIEW_ROWS as usize,
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
                Self::exec(conn, sql, key, max, &config),
            )
        };
        if r.as_ref().is_err_and(|e| e.code != ErrorCode::InvalidQuery) {
            self.conn = None;
        }
        r
    }

    fn tables(&mut self, stop: Stop) -> AppResult<Vec<TableName>> {
        let sql = format!(
            "SELECT CAST(table_schema AS CHAR), CAST(table_name AS CHAR) FROM information_schema.tables \
             WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') \
             AND (DATABASE() IS NULL OR table_schema = DATABASE()) ORDER BY 1, 2 LIMIT {MAX_TABLES}"
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
