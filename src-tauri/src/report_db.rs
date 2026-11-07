//! Dashboard data (prompt 012): a SQLite file per session with one row per entry head, built in the
//! background from the line index, and read-only SQL over it.
//!
//! - Table `log(line, ts, level, source, <fields>)`: `line` is the line number as shown (1-based) of
//!   the head, `ts` milliseconds since the epoch (UTC) or NULL, `level` the word (`ERROR`), `source`
//!   the index of the file (0 for a single file; names in `sources(source, name)`). Fields are the
//!   columns of the format and the extracted ones (prompt 011); numbers in their base unit
//!   (`parse_value`), text cut at 1 KB. Never the message: that would copy the log.
//! - The file lives in the app's own cache folder, one per session, deleted with the session.
//! - The builder runs on its own thread with its own connection. It takes the session's read lock
//!   only to copy a batch of index entries, never while SQLite works, so the tail never waits.
//! - Queries open their own read-only connection each: `PRAGMA query_only`, an authorizer that allows
//!   reading only, `Statement::readonly`, limits on length and attachments, a time limit through the
//!   progress handler, at most `MAX_ROWS` rows and `MAX_RESULT_BYTES`. Extension loading is not even
//!   compiled in (`.cargo/config.toml`).
//!
//! Free of Tauri like everything but `commands.rs` and `lib.rs`.

use crate::encoding::display_text;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::extract::{parse_value, ValueKind};
use crate::fields::{self, Column, ColumnKind, FormatGuess};
use crate::indexer::{LineEntry, LineReader, Segment};
use crate::level::Level;
use crate::merge::time_of;
use crate::model::{ReportResult, ReportSchema, ReportState, ReportStatus, SchemaColumn};
use crate::platform::free_space;
use crate::session::Shared;
use crate::timestamp::TimestampParser;
use chrono::{Local, NaiveDate, TimeZone};
use parking_lot::{Condvar, Mutex};
use rusqlite::functions::FunctionFlags;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

/// Rows a query returns at most; the rest is cut (`truncated`).
pub const MAX_ROWS: usize = 10_000;
/// Bytes of values a query returns at most (a row limit alone allows 10 000 × 1 MB).
pub const MAX_RESULT_BYTES: usize = 32 * 1024 * 1024;
/// Time a query may take.
pub const QUERY_TIME: Duration = Duration::from_secs(10);
/// Longest SQL text accepted.
pub const MAX_SQL_BYTES: usize = 64 * 1024;
/// Longest string or blob a query may build (`SQLITE_LIMIT_LENGTH`): stored text is cut at 1 KB anyway.
/// Kept small because one function call (`LIKE`, `instr`, `replace`) is one VM step: the progress handler
/// cannot stop it, so its input has to be small.
pub const MAX_VALUE_BYTES: i32 = 64 * 1024;
/// Longest `LIKE`/`GLOB` pattern (`SQLITE_LIMIT_LIKE_PATTERN_LENGTH`): pattern × text bounds one call.
pub const MAX_LIKE_PATTERN: i32 = 256;
/// Result columns of a query (`SQLITE_LIMIT_COLUMN`).
pub const MAX_COLUMNS: i32 = 50;
/// Queries running at once over all sessions; more wait (up to their time limit) for a free slot.
pub const MAX_QUERIES: usize = 6;
/// Heap of SQLite in this process (`sqlite3_hard_heap_limit64`, process-wide: builders and queries). Sorts
/// stay in memory (`temp_store = MEMORY`, nothing spills to `$TMPDIR`) and fail with "out of memory" above
/// it; a builder that hits it retries its batch a second later.
pub const HEAP_LIMIT: i64 = 768 * 1024 * 1024;
const OUT_OF_MEMORY: &str = "out of memory";
/// New lines of the tail go into the database at most this often, and only while the dashboard is open.
pub const CATCH_UP: Duration = Duration::from_secs(5);
/// Lines per batch (one transaction), between which the builder looks for a stop.
const BATCH: usize = 16 * 1024;
/// Text fields are cut here.
const MAX_TEXT_FIELD: usize = 1024;
/// Bytes per row in the file as estimated for the space check: key, ts, level and source with the
/// record header, plus the ts index; numbers and text per field.
const ROW_BYTES: u64 = 40;
const NUMBER_BYTES: u64 = 10;
const TEXT_BYTES: u64 = 48;
/// Below this much free space the builder does not start or stops.
const MIN_FREE: u64 = 256 * 1024 * 1024;
/// Free space is checked again every this many batches.
const SPACE_CHECK_BATCHES: usize = 64;
/// VM steps between two looks at the clock while a query runs: few, so that a row of 50 expensive columns
/// is checked between its columns too (the look costs an atomic load and a clock read).
const PROGRESS_STEPS: i32 = 32;
/// At most this many status updates per second reach the frontend.
const STATUS_INTERVAL: Duration = Duration::from_millis(200);
/// Names the table has itself; a field with one of them gets a prefix.
const FIXED: [&str; 4] = ["line", "ts", "level", "source"];
const LEVEL_NAMES: [&str; Level::COUNT] = [
    "UNKNOWN", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL",
];
/// Functions no query may call, even if a build had them: native code, files, pointers.
const DENIED_FUNCTIONS: [&str; 5] = [
    "load_extension",
    "fts3_tokenizer",
    "readfile",
    "writefile",
    "edit",
];

/// Limits of the queries and the catch-up interval; tests use smaller ones.
#[derive(Debug, Clone, Copy)]
pub struct ReportLimits {
    pub max_rows: usize,
    pub max_bytes: usize,
    pub max_time: Duration,
    pub catch_up: Duration,
}

impl Default for ReportLimits {
    fn default() -> Self {
        Self {
            max_rows: MAX_ROWS,
            max_bytes: MAX_RESULT_BYTES,
            max_time: QUERY_TIME,
            catch_up: CATCH_UP,
        }
    }
}

// ------------------------------------------------------------------------------------------------
// bucket()
// ------------------------------------------------------------------------------------------------

/// An interval for `bucket(ts, '5m')`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interval {
    /// Fixed length in milliseconds (seconds, minutes, hours): buckets in UTC, so a change of daylight
    /// saving time neither leaves a gap nor counts an hour twice.
    Fixed(i64),
    /// Calendar days in the local zone, from local midnight (23 or 25 hours on a DST change).
    Days(i64),
}

/// `'1m'`, `'15 s'`, `'2h'`, `'1d'`, also `ms`; 1 to 100 000 of the unit.
pub fn parse_interval(spec: &str) -> Option<Interval> {
    let spec = spec.trim();
    let digits = spec.bytes().take_while(u8::is_ascii_digit).count();
    let count: i64 = spec[..digits].parse().ok()?;
    if !(1..=100_000).contains(&count) {
        return None;
    }
    let unit = spec[digits..].trim();
    let ms = match unit {
        "ms" => 1,
        "s" | "sec" => 1000,
        "m" | "min" => 60_000,
        "h" => 3_600_000,
        "d" => return Some(Interval::Days(count)),
        _ => return None,
    };
    Some(Interval::Fixed(count * ms))
}

/// Start of the bucket of `ts` (milliseconds, UTC).
pub fn bucket(ts: i64, interval: Interval) -> i64 {
    match interval {
        Interval::Fixed(len) => ts.div_euclid(len) * len,
        Interval::Days(count) => {
            let Some(local) = Local.timestamp_millis_opt(ts).single() else {
                return ts;
            };
            let day = local.date_naive();
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap_or_default();
            let days = (day - epoch).num_days();
            let start = epoch + chrono::Duration::days(days.div_euclid(count) * count);
            start
                .and_hms_opt(0, 0, 0)
                .and_then(|midnight| Local.from_local_datetime(&midnight).earliest())
                .map_or(ts, |t| t.timestamp_millis())
        }
    }
}

fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8
        | FunctionFlags::SQLITE_DETERMINISTIC
        | FunctionFlags::SQLITE_INNOCUOUS;
    let call = |ctx: &rusqlite::functions::Context<'_>| -> rusqlite::Result<Option<i64>> {
        let ts: Option<i64> = match ctx.get_raw(0) {
            ValueRef::Integer(v) => Some(v),
            ValueRef::Real(v) if v.is_finite() => Some(v as i64),
            _ => None,
        };
        let interval = if ctx.len() > 1 {
            // The interval is constant in a query: parsed once per statement, not per row.
            *ctx.get_or_create_aux(1, |value| -> Result<Interval, String> {
                let spec = match value {
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                    _ => String::new(),
                };
                parse_interval(&spec).ok_or_else(|| {
                    format!("bucket: unknown interval '{spec}', use e.g. '30s', '1m', '1h', '1d'")
                })
            })?
        } else {
            Interval::Fixed(60_000)
        };
        Ok(ts.map(|ts| bucket(ts, interval)))
    };
    conn.create_scalar_function("bucket", 2, flags, call)?;
    conn.create_scalar_function("bucket", 1, flags, call)
}

// ------------------------------------------------------------------------------------------------
// Fields
// ------------------------------------------------------------------------------------------------

/// A column of the format that can go into the table.
#[derive(Debug, Clone, PartialEq)]
pub struct DbField {
    /// Name in SQL: lower case letters, digits and `_`.
    pub name: String,
    /// Index of the column in the parser.
    pub column: usize,
    pub column_id: String,
    pub label: String,
    pub kind: ColumnKind,
    pub unit: Option<String>,
}

impl DbField {
    fn numeric(&self) -> Option<ValueKind> {
        ValueKind::of_column(self.kind)
    }

    fn sql_type(&self) -> &'static str {
        if self.numeric().is_some() {
            "REAL"
        } else {
            "TEXT"
        }
    }
}

/// The columns of a format that can go into the table: all but the message, the level and times
/// (`ts` has them). Names are made safe and unique.
pub fn available_fields(columns: &[Column]) -> Vec<DbField> {
    let mut taken: Vec<String> = FIXED.iter().map(|s| s.to_string()).collect();
    let mut out = Vec::new();
    for (index, column) in columns.iter().enumerate() {
        if column.id == "message"
            || matches!(column.kind, ColumnKind::Level | ColumnKind::Timestamp)
        {
            continue;
        }
        let mut name: String = column
            .id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect();
        if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) {
            name.insert_str(0, "f_");
        }
        let base = name.clone();
        let mut n = 1;
        while taken.contains(&name) {
            n += 1;
            name = format!("{base}_{n}");
        }
        taken.push(name.clone());
        out.push(DbField {
            name,
            column: index,
            column_id: column.id.clone(),
            label: column.label.clone(),
            kind: column.kind,
            unit: column.unit.clone(),
        });
    }
    out
}

/// What goes into the table: the chosen column ids, or by default every number (extracted values,
/// numeric columns). Text costs space per row and is added by ticking it.
fn chosen_fields(columns: &[Column], chosen: Option<&[String]>) -> Vec<DbField> {
    available_fields(columns)
        .into_iter()
        .filter(|f| match chosen {
            Some(ids) => ids.contains(&f.column_id),
            None => f.numeric().is_some() && !is_id_name(&f.column_id),
        })
        .collect()
}

/// Numbers that only name something (process, thread, port, ids) are no measurements: not by default.
pub fn is_id_name(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "pid" | "tid" | "ppid" | "port" | "id" | "uid" | "gid"
    ) || lower.ends_with("_id")
        || lower.ends_with(".id")
        || (id.ends_with("Id") && id.len() > 2)
}

// ------------------------------------------------------------------------------------------------
// The database of a session
// ------------------------------------------------------------------------------------------------

/// Free slots for queries, shared by all sessions.
struct Permits {
    used: Mutex<usize>,
    freed: Condvar,
}

static PERMITS: Permits = Permits {
    used: Mutex::new(0),
    freed: Condvar::new(),
};

/// A query slot; given back when dropped.
struct Permit;

impl Drop for Permit {
    fn drop(&mut self) {
        *PERMITS.used.lock() -= 1;
        PERMITS.freed.notify_one();
    }
}

/// Waits up to `timeout` for one of `MAX_QUERIES` slots.
fn acquire(timeout: Duration) -> Option<Permit> {
    let deadline = Instant::now() + timeout;
    let mut used = PERMITS.used.lock();
    while *used >= MAX_QUERIES {
        if PERMITS.freed.wait_until(&mut used, deadline).timed_out() && *used >= MAX_QUERIES {
            return None;
        }
    }
    *used += 1;
    Some(Permit)
}

/// Queries running right now, over all sessions.
pub fn running_queries() -> usize {
    *PERMITS.used.lock()
}

/// Sets the process-wide heap limit of SQLite once.
fn limit_heap() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    // SAFETY: a plain setter of SQLite, safe to call at any time from any thread.
    ONCE.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_hard_heap_limit64(HEAP_LIMIT);
    });
}

/// An error message without the cache folder in it: the UI shows messages, not where files live.
fn scrub(mut err: AppError, dir: &Path) -> AppError {
    let shown = dir.display().to_string();
    if !shown.is_empty() {
        err.message = err.message.replace(&shown, "…");
    }
    err.path = None;
    err
}

/// The report database of one session. Created when a dashboard opens the first time.
pub struct ReportDb {
    path: PathBuf,
    /// File name per source index.
    source_names: Vec<String>,
    /// Chosen column ids (`None`: the numbers), and a revision that makes the builder start over.
    fields: Mutex<(Option<Vec<String>>, u64)>,
    /// The builder stops at its next look (dashboard closed, session closing).
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
    /// Wakes the builder while it waits for the next catch-up.
    signal: Arc<(Mutex<bool>, Condvar)>,
    /// Newest query per slot (panel): an older one sees the difference and stops.
    slots: Mutex<HashMap<String, Arc<AtomicU64>>>,
    /// The columns the table has now, for the schema help.
    current: Arc<Mutex<Vec<DbField>>>,
    /// Where the builder stood when the dashboard closed.
    resume: Mutex<Option<Resume>>,
    /// Running queries with their slot: closing interrupts them even inside one long VM step.
    readers: Mutex<HashMap<u64, (String, rusqlite::InterruptHandle)>>,
    next_reader: AtomicU64,
    /// The session is closing: no new queries.
    closed: Arc<AtomicBool>,
    /// Goes up when the dashboard closes or the session ends: queries started before stop, also those still
    /// waiting for a slot when it happened.
    stops: Arc<AtomicU64>,
    limits: ReportLimits,
}

impl ReportDb {
    /// Creates the file (replacing a leftover one) with an empty table, so queries work at once.
    pub fn create(
        dir: &Path,
        session_id: u64,
        source_names: Vec<String>,
        limits: ReportLimits,
    ) -> AppResult<Self> {
        limit_heap();
        std::fs::create_dir_all(dir).map_err(|e| {
            scrub(
                AppError::new(ErrorCode::Io, format!("no folder for the dashboard: {e}")),
                dir,
            )
        })?;
        let path = dir.join(format!("session-{session_id}.sqlite"));
        remove_files(&path);
        let conn = open_writer(&path).map_err(|e| scrub(e, dir))?;
        create_tables(&conn, &[], &source_names).map_err(|e| scrub(sql_error(e), dir))?;
        drop(conn);
        Ok(Self {
            path,
            source_names,
            fields: Mutex::new((None, 0)),
            stop: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
            signal: Arc::new((Mutex::new(false), Condvar::new())),
            slots: Mutex::new(HashMap::new()),
            current: Arc::new(Mutex::new(Vec::new())),
            resume: Mutex::new(None),
            readers: Mutex::new(HashMap::new()),
            next_reader: AtomicU64::new(0),
            closed: Arc::new(AtomicBool::new(false)),
            stops: Arc::new(AtomicU64::new(0)),
            limits,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Chooses the text and number columns to store; a change builds the table anew.
    pub fn set_fields(&self, chosen: Option<Vec<String>>) {
        let mut fields = self.fields.lock();
        if fields.0 != chosen {
            fields.0 = chosen;
            fields.1 += 1;
            drop(fields);
            self.kick();
        }
    }

    fn fields(&self) -> (Option<Vec<String>>, u64) {
        self.fields.lock().clone()
    }

    /// Starts the builder if it does not run (the dashboard is open).
    pub fn start(self: &Arc<Self>, shared: Arc<Shared>, session_id: u64) -> AppResult<()> {
        let mut worker = self.worker.lock();
        if worker.as_ref().is_some_and(|w| !w.is_finished()) {
            return Ok(());
        }
        self.stop.store(false, Ordering::SeqCst);
        let db = Arc::clone(self);
        let handle = thread::Builder::new()
            .name(format!("report-{session_id}"))
            .spawn(move || run_builder(&shared, &db))
            .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
        *worker = Some(handle);
        Ok(())
    }

    /// Stops the builder (dashboard closed) and running queries; the file stays for the next time.
    pub fn pause(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.interrupt_readers(None);
        self.stop.store(true, Ordering::SeqCst);
        self.kick();
        if let Some(worker) = self.worker.lock().take() {
            let _ = worker.join();
        }
    }

    /// Whether the builder thread is running.
    pub fn is_running(&self) -> bool {
        self.worker
            .lock()
            .as_ref()
            .is_some_and(|w| !w.is_finished())
    }

    /// Stops everything and deletes the file (session closed).
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.pause();
        remove_files(&self.path);
    }

    /// `sqlite3_interrupt` for the running queries (of one slot, or all): stops them inside a long step too.
    fn interrupt_readers(&self, slot: Option<&str>) {
        for (s, handle) in self.readers.lock().values() {
            if slot.is_none_or(|slot| slot == s) {
                handle.interrupt();
            }
        }
    }

    fn kick(&self) {
        let (lock, condvar) = &*self.signal;
        *lock.lock() = true;
        condvar.notify_all();
    }

    /// Waits up to `timeout`, or until kicked or stopped.
    fn wait(&self, timeout: Duration) {
        let (lock, condvar) = &*self.signal;
        let mut kicked = lock.lock();
        if !*kicked && !self.stop.load(Ordering::SeqCst) {
            condvar.wait_for(&mut kicked, timeout);
        }
        *kicked = false;
    }

    /// The columns of the table now, and those that could be added.
    pub fn schema(&self, format: &FormatGuess, status: Option<ReportStatus>) -> ReportSchema {
        let current = self.current.lock().clone();
        let mut columns = vec![
            fixed_column(
                "line",
                "INTEGER",
                "Zeilennummer des Eintrags (wie in der Ansicht)",
            ),
            fixed_column(
                "ts",
                "INTEGER",
                "Zeit in ms seit 1970 (UTC), NULL ohne Zeit",
            ),
            fixed_column("level", "TEXT", "Level, z. B. 'ERROR'"),
            fixed_column(
                "source",
                "INTEGER",
                "Quelle (0 bei einer Datei), Namen in sources",
            ),
        ];
        for field in available_fields(format.parser.columns()) {
            let included = current.iter().any(|c| c.column_id == field.column_id);
            let name = current
                .iter()
                .find(|c| c.column_id == field.column_id)
                .map_or(field.name.clone(), |c| c.name.clone());
            columns.push(SchemaColumn {
                name,
                sql_type: field.sql_type().into(),
                description: field.label.clone(),
                column: Some(field.column_id.clone()),
                kind: Some(field.kind),
                unit: field.unit.clone(),
                included,
            });
        }
        ReportSchema {
            table: "log".into(),
            columns,
            sources: self.source_names.clone(),
            status,
        }
    }

    /// Runs one read-only query. A newer query of the same slot stops this one.
    pub fn query(&self, sql: &str, slot: &str) -> AppResult<ReportResult> {
        let counter = Arc::clone(
            self.slots
                .lock()
                .entry(slot.to_string())
                .or_insert_with(|| Arc::new(AtomicU64::new(0))),
        );
        let generation = counter.fetch_add(1, Ordering::SeqCst) + 1;
        if self.closed.load(Ordering::SeqCst) {
            return Err(invalid("the dashboard of this tab is not open"));
        }
        // An older query of this panel stops now, not only at its next VM step.
        self.interrupt_readers(Some(slot));
        let cancel = Cancel {
            counter,
            generation,
            stop: Some((Arc::clone(&self.stops), self.stops.load(Ordering::SeqCst))),
        };
        let id = self.next_reader.fetch_add(1, Ordering::SeqCst);
        let result = query(&self.path, sql, &self.limits, cancel, |handle| {
            self.readers.lock().insert(id, (slot.to_string(), handle));
        });
        self.readers.lock().remove(&id);
        result
    }
}

fn fixed_column(name: &str, sql_type: &str, description: &str) -> SchemaColumn {
    SchemaColumn {
        name: name.into(),
        sql_type: sql_type.into(),
        description: description.into(),
        column: None,
        kind: None,
        unit: None,
        included: true,
    }
}

fn remove_files(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

fn sql_error(err: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("dashboard database: {err}"))
}

fn open_writer(path: &Path) -> AppResult<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags).map_err(sql_error)?;
    // Temporary data: a crash only means building again, so no syncing.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA cache_size = -16384; \
         PRAGMA journal_size_limit = 67108864;",
    )
    .map_err(sql_error)?;
    Ok(conn)
}

fn create_tables(
    conn: &Connection,
    fields: &[DbField],
    sources: &[String],
) -> rusqlite::Result<()> {
    let mut sql = String::from(
        "DROP INDEX IF EXISTS log_ts; DROP TABLE IF EXISTS log; DROP TABLE IF EXISTS sources;\n\
         CREATE TABLE log (line INTEGER PRIMARY KEY, ts INTEGER, level TEXT NOT NULL, source INTEGER NOT NULL",
    );
    for field in fields {
        // Quoted: a field may be called `order` or `group`.
        sql.push_str(&format!(", \"{}\" {}", field.name, field.sql_type()));
    }
    sql.push_str(");\nCREATE TABLE sources (source INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(&sql)?;
    {
        let mut insert = tx.prepare("INSERT INTO sources VALUES (?1, ?2)")?;
        for (i, name) in sources.iter().enumerate() {
            insert.execute(rusqlite::params![i as i64, name])?;
        }
    }
    tx.commit()
}

// ------------------------------------------------------------------------------------------------
// Builder
// ------------------------------------------------------------------------------------------------

/// What makes the table start over: a new epoch (truncation, rotation without keeping, re-sort), other
/// columns (profile, rules), other chosen fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Key {
    epoch: u64,
    columns: u64,
    fields: u64,
}

struct Builder {
    conn: Connection,
    key: Option<Key>,
    position: usize,
    rows: u64,
    generation: u64,
    reason: Option<String>,
    fields: Vec<DbField>,
    insert: String,
    clocks: Vec<TimestampParser>,
    reference: SystemTime,
    sample: Arc<Vec<String>>,
    indexed: bool,
    low_space: bool,
    batches: usize,
    last_status: Option<Instant>,
}

fn run_builder(shared: &Arc<Shared>, db: &Arc<ReportDb>) {
    if let Err(message) = build(shared, db) {
        let mut data = shared.data.write();
        let mut status = data.report.clone().unwrap_or_default();
        status.state = ReportState::Error;
        status.message = Some(message);
        data.report = Some(status);
        data.dirty = true;
        drop(data);
        shared.wake();
    }
}

fn stopped(shared: &Shared, db: &ReportDb) -> bool {
    db.stop.load(Ordering::SeqCst) || shared.shutdown.load(Ordering::SeqCst)
}

/// The builder loop: start over when the key changes, read batches of heads into the table, then
/// catch up every `CATCH_UP` until stopped. Errors (disk full) end it with a message.
fn build(shared: &Arc<Shared>, db: &Arc<ReportDb>) -> Result<(), String> {
    let conn = open_writer(&db.path).map_err(|e| e.message)?;
    let mut builder = Builder {
        conn,
        key: None,
        position: 0,
        rows: 0,
        generation: 0,
        reason: None,
        fields: Vec::new(),
        insert: String::new(),
        clocks: Vec::new(),
        reference: SystemTime::now(),
        sample: Arc::new(Vec::new()),
        indexed: false,
        low_space: false,
        batches: 0,
        last_status: None,
    };
    // Continue a table built before the dashboard was closed, if nothing changed meanwhile.
    if let Some(resume) = db.resume.lock().take() {
        builder.resume(resume);
    }
    let result = builder.run(shared, db);
    *db.resume.lock() = Some(builder.suspend());
    result
}

/// Where a paused builder stood, to continue without building anew.
pub struct Resume {
    key: Option<Key>,
    position: usize,
    rows: u64,
    generation: u64,
    fields: Vec<DbField>,
    clocks: Vec<TimestampParser>,
    reference: SystemTime,
    sample: Arc<Vec<String>>,
    indexed: bool,
}

/// A batch of entries copied under the read lock.
struct Batch {
    entries: Vec<LineEntry>,
    first: usize,
    segments: Vec<Arc<Segment>>,
    format: Arc<FormatGuess>,
    /// Lines the table can have now (without the provisional last line).
    limit: usize,
}

enum Step {
    Wait(Duration),
    Rebuild {
        key: Key,
        format: Arc<FormatGuess>,
        sample: Arc<Vec<String>>,
        reference: SystemTime,
        total: usize,
        reason: Option<String>,
    },
    Batch(Batch),
    CaughtUp(usize),
}

impl Builder {
    fn resume(&mut self, r: Resume) {
        self.key = r.key;
        self.position = r.position;
        self.rows = r.rows;
        self.generation = r.generation;
        self.insert = insert_sql(&r.fields);
        self.fields = r.fields;
        self.clocks = r.clocks;
        self.reference = r.reference;
        self.sample = r.sample;
        self.indexed = r.indexed;
    }

    fn suspend(self) -> Resume {
        Resume {
            key: self.key,
            position: self.position,
            rows: self.rows,
            generation: self.generation,
            fields: self.fields,
            clocks: self.clocks,
            reference: self.reference,
            sample: self.sample,
            indexed: self.indexed,
        }
    }

    fn run(&mut self, shared: &Arc<Shared>, db: &Arc<ReportDb>) -> Result<(), String> {
        loop {
            if stopped(shared, db) {
                return Ok(());
            }
            match self.next_step(shared, db) {
                Step::Wait(time) => db.wait(time),
                Step::Rebuild {
                    key,
                    format,
                    sample,
                    reference,
                    total,
                    reason,
                } => {
                    self.rebuild(shared, db, key, &format, sample, reference, total, reason)?;
                }
                Step::Batch(batch) => match self.insert_batch(shared, db, batch) {
                    // The shared heap limit is reached (a big query): try the batch again shortly.
                    Err(message) if message.starts_with(OUT_OF_MEMORY) => {
                        db.wait(Duration::from_secs(1))
                    }
                    other => other?,
                },
                Step::CaughtUp(limit) => {
                    if !self.indexed {
                        self.publish(shared, ReportState::Indexing, limit, true);
                        // The index makes `WHERE ts BETWEEN` (a click on a point) fast; built once at
                        // the end, it costs a fraction of keeping it up while inserting.
                        self.conn
                            .execute_batch(
                                "CREATE INDEX IF NOT EXISTS log_ts ON log(ts); \
                                 PRAGMA wal_checkpoint(TRUNCATE);",
                            )
                            .map_err(|e| space_message(&e))?;
                        self.indexed = true;
                    }
                    self.publish(shared, ReportState::Ready, limit, true);
                    db.wait(db.limits.catch_up);
                }
            }
        }
    }

    fn next_step(&self, shared: &Shared, db: &ReportDb) -> Step {
        let chosen_revision = db.fields().1;
        let data = shared.data.read();
        if data.relevel_needed {
            // Levels change in place: wait for the job, then start over with the new ones.
            return Step::Wait(Duration::from_millis(200));
        }
        let key = Key {
            epoch: data.epoch,
            columns: data.columns_revision,
            fields: chosen_revision,
        };
        if self.key != Some(key) {
            let reason = self.key.map(|old| {
                if old.epoch != key.epoch {
                    "epoch".to_string()
                } else if old.columns != key.columns {
                    "columns".to_string()
                } else {
                    "fields".to_string()
                }
            });
            let reference = data
                .segments
                .first()
                .and_then(|s| s.file.metadata().ok()?.modified().ok())
                .unwrap_or_else(SystemTime::now);
            return Step::Rebuild {
                key,
                format: Arc::clone(&data.format),
                sample: Arc::clone(&data.sample),
                reference,
                total: data.index.len(),
                reason,
            };
        }
        let limit = data.index.len() - usize::from(data.provisional.is_some());
        if self.position >= limit {
            return Step::CaughtUp(limit);
        }
        let end = (self.position + BATCH).min(limit);
        Step::Batch(Batch {
            entries: data.index.entries[self.position..end].to_vec(),
            first: self.position,
            segments: data.segments.clone(),
            format: Arc::clone(&data.format),
            limit,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn rebuild(
        &mut self,
        shared: &Shared,
        db: &ReportDb,
        key: Key,
        format: &FormatGuess,
        sample: Arc<Vec<String>>,
        reference: SystemTime,
        total: usize,
        reason: Option<String>,
    ) -> Result<(), String> {
        let (chosen, _) = db.fields();
        self.fields = chosen_fields(format.parser.columns(), chosen.as_deref());
        // Space: refuse when it clearly does not fit, warn when it gets tight.
        let estimate = estimate_bytes(total, &self.fields);
        self.low_space = false;
        if let Some(free) = db.path.parent().and_then(free_space) {
            if free < estimate + MIN_FREE {
                return Err(format!(
                    "not enough disk space: about {} MB needed, {} MB free",
                    estimate / 1_048_576,
                    free / 1_048_576
                ));
            }
            self.low_space = free < 2 * estimate + 4 * MIN_FREE;
        }
        create_tables(&self.conn, &self.fields, &db.source_names).map_err(|e| space_message(&e))?;
        *db.current.lock() = self.fields.clone();
        self.insert = insert_sql(&self.fields);
        self.key = Some(key);
        self.position = 0;
        self.rows = 0;
        self.generation += 1;
        self.reason = reason;
        self.indexed = false;
        self.reference = reference;
        self.sample = sample;
        self.clocks.clear();
        self.publish(shared, ReportState::Building, total, true);
        Ok(())
    }

    fn insert_batch(&mut self, shared: &Shared, db: &ReportDb, batch: Batch) -> Result<(), String> {
        let mut reader = LineReader::new(batch.segments, 1024 * 1024);
        let parser = &batch.format.parser;
        let wanted: Vec<usize> = self.fields.iter().map(|f| f.column).collect();
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| space_message(&e))?;
        let mut inserted = 0u64;
        {
            let mut stmt = tx
                .prepare_cached(&self.insert)
                .map_err(|e| space_message(&e))?;
            for (i, entry) in batch.entries.iter().enumerate() {
                if entry.is_continuation() {
                    continue;
                }
                let line = batch.first + i;
                let text = match reader.raw(entry, fields::MAX_PARSE_BYTES + 16) {
                    Ok((raw, encoding)) => display_text(raw, encoding).into_owned(),
                    // The file shrank meanwhile: the next epoch builds anew.
                    Err(_) => String::new(),
                };
                let clock = clock_of(
                    &mut self.clocks,
                    &self.sample,
                    self.reference,
                    entry.source(),
                );
                let ts = time_of(clock, text.as_bytes()).map(|micros| micros.div_euclid(1000));
                let values = parser.fields(&text, &wanted);
                let bind = |stmt: &mut rusqlite::CachedStatement<'_>| -> rusqlite::Result<()> {
                    stmt.raw_bind_parameter(1, (line + 1) as i64)?;
                    stmt.raw_bind_parameter(2, ts)?;
                    stmt.raw_bind_parameter(3, LEVEL_NAMES[entry.level() as usize])?;
                    stmt.raw_bind_parameter(4, entry.source() as i64)?;
                    for (k, (field, value)) in self.fields.iter().zip(&values).enumerate() {
                        let at = 5 + k;
                        match (field.numeric(), value) {
                            (_, None) => stmt.raw_bind_parameter(at, rusqlite::types::Null)?,
                            (Some(kind), Some(value)) => stmt.raw_bind_parameter(
                                at,
                                parse_value(value, kind, field.unit.as_deref()),
                            )?,
                            (None, Some(value)) => {
                                let cut = floor_boundary(value, MAX_TEXT_FIELD);
                                stmt.raw_bind_parameter(at, &value[..cut])?
                            }
                        }
                    }
                    stmt.raw_execute().map(|_| ())
                };
                bind(&mut stmt).map_err(|e| space_message(&e))?;
                inserted += 1;
            }
        }
        tx.commit().map_err(|e| space_message(&e))?;
        self.position = batch.first + batch.entries.len();
        self.rows += inserted;
        self.batches += 1;
        if self.batches.is_multiple_of(SPACE_CHECK_BATCHES) {
            if let Some(free) = db.path.parent().and_then(free_space) {
                if free < MIN_FREE {
                    return Err("disk almost full: the dashboard stopped building".into());
                }
            }
        }
        let state = if self.indexed {
            ReportState::Ready
        } else {
            ReportState::Building
        };
        self.publish(shared, state, batch.limit, false);
        Ok(())
    }

    /// Puts the status into the session data (it goes out with the next update).
    fn publish(&mut self, shared: &Shared, state: ReportState, limit: usize, force: bool) {
        let now = Instant::now();
        if !force
            && self
                .last_status
                .is_some_and(|t| now.duration_since(t) < STATUS_INTERVAL)
        {
            return;
        }
        self.last_status = Some(now);
        let size = std::fs::metadata(self.conn_path()).map_or(0, |m| m.len());
        let status = ReportStatus {
            state,
            progress: if limit == 0 {
                1.0
            } else {
                (self.position as f32 / limit as f32).min(1.0)
            },
            rows: self.rows,
            lines: self.position as u64,
            generation: self.generation,
            reason: self.reason.clone(),
            message: None,
            low_space: self.low_space,
            size,
        };
        {
            let mut data = shared.data.write();
            data.report = Some(status);
            data.dirty = true;
        }
        shared.wake();
    }

    fn conn_path(&self) -> PathBuf {
        self.conn.path().map(PathBuf::from).unwrap_or_default()
    }
}

fn insert_sql(fields: &[DbField]) -> String {
    let marks: Vec<String> = (1..=4 + fields.len()).map(|i| format!("?{i}")).collect();
    format!("INSERT INTO log VALUES ({})", marks.join(", "))
}

fn estimate_bytes(lines: usize, fields: &[DbField]) -> u64 {
    let per_row = ROW_BYTES
        + fields
            .iter()
            .map(|f| {
                if f.numeric().is_some() {
                    NUMBER_BYTES
                } else {
                    TEXT_BYTES
                }
            })
            .sum::<u64>();
    lines as u64 * per_row
}

/// A write error as the dashboard shows it; a full disk says so.
fn space_message(err: &rusqlite::Error) -> String {
    if let rusqlite::Error::SqliteFailure(e, _) = err {
        if e.code == rusqlite::ErrorCode::DiskFull {
            return "disk full: the dashboard stopped building".into();
        }
        if e.code == rusqlite::ErrorCode::OutOfMemory {
            return format!("{OUT_OF_MEMORY}: {err}");
        }
    }
    format!("dashboard database: {err}")
}

fn floor_boundary(text: &str, at: usize) -> usize {
    if at >= text.len() {
        return text.len();
    }
    (0..=at)
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0)
}

/// The timestamp parser of a source, made on first use.
fn clock_of<'a>(
    clocks: &'a mut Vec<TimestampParser>,
    sample: &[String],
    reference: SystemTime,
    source: usize,
) -> &'a mut TimestampParser {
    while clocks.len() <= source {
        let clock = if clocks.is_empty() {
            TimestampParser::detect(sample.iter().map(String::as_str), reference)
        } else {
            // Other files of a merge: any format, found per line.
            TimestampParser::new(reference)
        };
        clocks.push(clock);
    }
    &mut clocks[source]
}

// ------------------------------------------------------------------------------------------------
// Queries
// ------------------------------------------------------------------------------------------------

/// Stops a query when a newer one of its slot started, or when its owner stops.
#[derive(Clone)]
pub struct Cancel {
    counter: Arc<AtomicU64>,
    generation: u64,
    /// A counter of its owner and its value when the query started.
    stop: Option<(Arc<AtomicU64>, u64)>,
}

impl Cancel {
    pub fn never() -> Self {
        Self {
            counter: Arc::new(AtomicU64::new(0)),
            generation: 0,
            stop: None,
        }
    }

    fn is_cancelled(&self) -> bool {
        self.counter.load(Ordering::SeqCst) != self.generation
            || self
                .stop
                .as_ref()
                .is_some_and(|(stops, at)| stops.load(Ordering::SeqCst) != *at)
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, message)
}

/// The authorizer of query connections: reading and calling functions, nothing else.
fn authorize(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Select | AuthAction::Read { .. } | AuthAction::Recursive => {
            Authorization::Allow
        }
        AuthAction::Function { function_name } => {
            if DENIED_FUNCTIONS
                .iter()
                .any(|f| f.eq_ignore_ascii_case(function_name))
            {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }
        _ => Authorization::Deny,
    }
}

/// A read-only connection with every guard in place.
fn open_reader(path: &Path, limits: &ReportLimits, cancel: Cancel) -> AppResult<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut conn = Connection::open_with_flags(path, flags).map_err(sql_error)?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(sql_error)?;
    // Before the authorizer, which refuses every PRAGMA: sorts in memory (bounded by the heap limit)
    // instead of temporary files, a small cache, then read only.
    conn.execute_batch(
        "PRAGMA temp_store = MEMORY; PRAGMA cache_size = -8192; PRAGMA query_only = 1;",
    )
    .map_err(sql_error)?;
    let set = |limit, value| conn.set_limit(limit, value).map(|_| ());
    set(Limit::SQLITE_LIMIT_ATTACHED, 0).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_LENGTH, MAX_VALUE_BYTES).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES as i32).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_COLUMN, MAX_COLUMNS).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_LIKE_PATTERN_LENGTH, MAX_LIKE_PATTERN).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_EXPR_DEPTH, 200).map_err(sql_error)?;
    set(Limit::SQLITE_LIMIT_COMPOUND_SELECT, 50).map_err(sql_error)?;
    register_functions(&conn).map_err(sql_error)?;
    conn.authorizer(Some(authorize)).map_err(sql_error)?;
    let started = Instant::now();
    let max_time = limits.max_time;
    conn.progress_handler(
        PROGRESS_STEPS,
        Some(move || cancel.is_cancelled() || started.elapsed() > max_time),
    )
    .map_err(sql_error)?;
    Ok(conn)
}

/// Runs `sql` on the file at `path` with all guards: one statement, reading only, within the limits.
pub fn query(
    path: &Path,
    sql: &str,
    limits: &ReportLimits,
    cancel: Cancel,
    on_open: impl FnOnce(rusqlite::InterruptHandle),
) -> AppResult<ReportResult> {
    if sql.len() > MAX_SQL_BYTES {
        return Err(invalid(format!(
            "query longer than {} KB",
            MAX_SQL_BYTES / 1024
        )));
    }
    if sql.trim().is_empty() {
        return Err(invalid("empty query"));
    }
    limit_heap();
    let started = Instant::now();
    // Waiting for a slot does not count against the query's own time limit.
    let Some(_permit) = acquire(QUERY_TIME) else {
        return Err(invalid(format!(
            "too many queries at once (at most {MAX_QUERIES})"
        )));
    };
    let dir = path.parent().unwrap_or(path);
    let cancelled = || invalid("cancelled by a newer query or by closing the dashboard");
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    // Closing deletes the file: a query that was just about to open it was cancelled, not broken.
    let conn = open_reader(path, limits, cancel.clone()).map_err(|e| {
        if cancel.is_cancelled() {
            cancelled()
        } else {
            scrub(e, dir)
        }
    })?;
    let handle = conn.get_interrupt_handle();
    on_open(conn.get_interrupt_handle());
    // Stopped while waiting for a slot or opening: the interrupt above may have come before the handle.
    if cancel.is_cancelled() {
        handle.interrupt();
    }
    let describe = |err: rusqlite::Error| -> AppError {
        if let rusqlite::Error::SqliteFailure(e, _) = &err {
            if e.code == rusqlite::ErrorCode::OperationInterrupted {
                return if cancel.is_cancelled() || started.elapsed() < limits.max_time {
                    cancelled()
                } else {
                    invalid(format!(
                        "time limit of {} s exceeded",
                        limits.max_time.as_secs_f32()
                    ))
                };
            }
        }
        match err {
            rusqlite::Error::MultipleStatement => invalid("only one statement per query"),
            rusqlite::Error::SqlInputError { msg, offset, .. } => {
                invalid(format!("{msg} (at character {})", offset + 1))
            }
            rusqlite::Error::SqliteFailure(_, Some(msg)) => invalid(msg),
            other => invalid(other.to_string()),
        }
    };
    let mut stmt = conn.prepare(sql).map_err(describe)?;
    if !stmt.readonly() {
        return Err(invalid("only reading queries (SELECT, WITH) are allowed"));
    }
    if stmt.column_count() == 0 {
        return Err(invalid("the query returns no columns"));
    }
    let columns: Vec<String> = stmt.column_names().map(str::to_string).collect();
    let width = columns.len();
    let mut rows = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    let mut cursor = stmt.query([]).map_err(describe)?;
    'rows: while let Some(row) = cursor.next().map_err(describe)? {
        if rows.len() >= limits.max_rows || bytes > limits.max_bytes {
            truncated = true;
            break;
        }
        let mut out = Vec::with_capacity(width);
        for i in 0..width {
            let value = row.get_ref(i).map_err(describe)?;
            bytes += 16;
            out.push(match value {
                ValueRef::Null => serde_json::Value::Null,
                ValueRef::Integer(v) => serde_json::Value::from(v),
                ValueRef::Real(v) => {
                    serde_json::Number::from_f64(v).map_or(serde_json::Value::Null, Into::into)
                }
                ValueRef::Text(t) => {
                    bytes += t.len();
                    serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
                }
                ValueRef::Blob(b) => {
                    bytes += 24;
                    serde_json::Value::String(format!("<{} Bytes>", b.len()))
                }
            });
            // After each value, not only per row: one wide row must not pass the limit either.
            if bytes > limits.max_bytes {
                truncated = true;
                break 'rows;
            }
        }
        rows.push(out);
    }
    Ok(ReportResult {
        columns,
        rows,
        truncated,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

// ------------------------------------------------------------------------------------------------
// The cache folder
// ------------------------------------------------------------------------------------------------

/// This process's folder for report files: `<cache>/reports/<pid>/`, held by a locked `lock` file.
/// Folders of processes that are gone (the lock can be taken) are removed: what a crash left.
pub struct ReportDir {
    pub path: PathBuf,
    _lock: File,
}

impl ReportDir {
    pub fn prepare(cache: &Path) -> io::Result<Self> {
        let root = cache.join("reports");
        std::fs::create_dir_all(&root)?;
        let own = root.join(std::process::id().to_string());
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path == own || !path.is_dir() {
                    continue;
                }
                let lock = path.join("lock");
                let free = match File::options().write(true).open(&lock) {
                    Ok(file) => file.try_lock().is_ok(),
                    // No lock file: never finished preparing, or not ours to judge – only empty or
                    // report files are removed.
                    Err(_) => true,
                };
                if free && only_report_files(&path) {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
        std::fs::create_dir_all(&own)?;
        // A folder left by an earlier process with the same id is stale, too.
        if let Ok(entries) = std::fs::read_dir(&own) {
            for entry in entries.flatten() {
                if entry.file_name() != "lock" {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let lock = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(own.join("lock"))?;
        // Never wait: a second preparation in the same process is a mistake, not something to block on.
        lock.try_lock()
            .map_err(|e| io::Error::other(e.to_string()))?;
        Ok(Self {
            path: own,
            _lock: lock,
        })
    }
}

/// Only files this module writes, so a wrong path never removes anything else.
fn only_report_files(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().all(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name == "lock" || (name.starts_with("session-") && name.contains(".sqlite"))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(text: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(text)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn intervals() {
        assert_eq!(parse_interval("1m"), Some(Interval::Fixed(60_000)));
        assert_eq!(parse_interval(" 15 s "), Some(Interval::Fixed(15_000)));
        assert_eq!(parse_interval("2h"), Some(Interval::Fixed(7_200_000)));
        assert_eq!(parse_interval("500ms"), Some(Interval::Fixed(500)));
        assert_eq!(parse_interval("1d"), Some(Interval::Days(1)));
        for bad in ["", "m", "0m", "1y", "-1m", "1.5m", "100001s", "1 m x"] {
            assert_eq!(parse_interval(bad), None, "{bad}");
        }
    }

    #[test]
    fn fixed_buckets_floor_in_utc() {
        let t = ms("2024-03-31T00:59:59.999Z");
        assert_eq!(
            bucket(t, Interval::Fixed(60_000)),
            ms("2024-03-31T00:59:00Z")
        );
        assert_eq!(
            bucket(t, Interval::Fixed(3_600_000)),
            ms("2024-03-31T00:00:00Z")
        );
        assert_eq!(
            bucket(t, Interval::Fixed(300_000)),
            ms("2024-03-31T00:55:00Z")
        );
        // Before 1970 still floors down.
        assert_eq!(bucket(-1, Interval::Fixed(1000)), -1000);
    }

    #[test]
    fn hours_across_daylight_saving_have_no_gap_and_no_double() {
        // Whatever the local zone: buckets are UTC, consecutive and exactly an hour apart, also over the
        // European (last Sunday of March/October) and US changes.
        for start in [
            "2024-03-30T20:00:00Z",
            "2024-10-26T20:00:00Z",
            "2024-03-09T20:00:00Z",
        ] {
            let from = ms(start);
            let mut last: Option<i64> = None;
            for minute in 0..(12 * 60) {
                let b = bucket(from + minute * 60_000, Interval::Fixed(3_600_000));
                if let Some(prev) = last {
                    assert!(b == prev || b == prev + 3_600_000, "gap or double at {b}");
                }
                last = Some(b);
            }
            assert_eq!(last, Some(from + 11 * 3_600_000));
        }
    }

    #[test]
    fn days_start_at_local_midnight() {
        let t = ms("2024-06-15T12:00:00Z");
        let start = bucket(t, Interval::Days(1));
        let local = Local.timestamp_millis_opt(start).unwrap();
        assert_eq!(local.format("%H:%M:%S").to_string(), "00:00:00");
        assert!(start <= t && t - start < 25 * 3_600_000);
        // Every day of a year is one bucket, none twice, also over DST.
        let mut seen = std::collections::HashSet::new();
        for day in 0..366 {
            seen.insert(bucket(
                ms("2024-01-01T12:00:00Z") + day * 86_400_000,
                Interval::Days(1),
            ));
        }
        assert_eq!(seen.len(), 366);
    }

    /// A database with 1000 rows, one per second from 2024-01-01 00:00 UTC, every tenth an ERROR.
    fn sample_db(dir: &Path, limits: ReportLimits) -> ReportDb {
        let db = ReportDb::create(dir, 1, vec!["app.log".into()], limits).unwrap();
        let conn = open_writer(db.path()).unwrap();
        let fields = vec![DbField {
            name: "took".into(),
            column: 0,
            column_id: "took".into(),
            label: "took".into(),
            kind: ColumnKind::Duration,
            unit: None,
        }];
        create_tables(&conn, &fields, &["app.log".into()]).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let start = ms("2024-01-01T00:00:00Z");
        for i in 0..1000i64 {
            let level = if i % 10 == 0 { "ERROR" } else { "INFO" };
            let ts = (i != 999).then_some(start + i * 1000);
            tx.execute(
                "INSERT INTO log VALUES (?1, ?2, ?3, 0, ?4)",
                rusqlite::params![i + 1, ts, level, (i % 7) as f64 * 0.1],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        db
    }

    fn quick() -> ReportLimits {
        ReportLimits {
            max_time: Duration::from_millis(300),
            ..ReportLimits::default()
        }
    }

    fn count(db: &ReportDb) -> i64 {
        let r = db.query("SELECT count(*) FROM log", "count").unwrap();
        r.rows[0][0].as_i64().unwrap()
    }

    fn refused(db: &ReportDb, sql: &str) -> String {
        match db.query(sql, "test") {
            Ok(r) => panic!("{sql} ran: {r:?}"),
            Err(e) => {
                assert_eq!(e.code, ErrorCode::InvalidQuery, "{sql}: {e:?}");
                e.message
            }
        }
    }

    #[test]
    fn reading_and_bucket_work() {
        let dir = tempfile::tempdir().unwrap();
        let db = sample_db(dir.path(), quick());
        let r = db
            .query(
                "SELECT bucket(ts, '1m') AS t, count(*) AS n, sum(level = 'ERROR') AS errors \
                 FROM log WHERE ts IS NOT NULL GROUP BY t ORDER BY t",
                "a",
            )
            .unwrap();
        assert_eq!(r.columns, ["t", "n", "errors"]);
        assert_eq!(r.rows.len(), 17);
        assert_eq!(r.rows[0][0].as_i64(), Some(ms("2024-01-01T00:00:00Z")));
        assert_eq!(r.rows[0][1].as_i64(), Some(60));
        assert_eq!(r.rows[0][2].as_i64(), Some(6));
        assert!(!r.truncated);
        // Default interval, NULL stays NULL, a bad interval is an error with the engine's text.
        let r = db
            .query(
                "SELECT bucket(ts), bucket(NULL, '1h') FROM log WHERE line = 61",
                "a",
            )
            .unwrap();
        assert_eq!(r.rows[0][0].as_i64(), Some(ms("2024-01-01T00:01:00Z")));
        assert!(r.rows[0][1].is_null());
        assert!(refused(&db, "SELECT bucket(ts, '1y') FROM log").contains("bucket"));
        // Schema tables can be read.
        let r = db
            .query("SELECT name FROM sqlite_master WHERE type = 'table'", "a")
            .unwrap();
        assert!(r.rows.iter().any(|row| row[0] == "log"));
        assert_eq!(count(&db), 1000);
    }

    #[test]
    fn writes_and_escapes_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let db = sample_db(dir.path(), quick());
        let outside = dir.path().join("outside.sqlite");
        let attach = format!("ATTACH DATABASE '{}' AS x", outside.display());
        let vacuum = format!("VACUUM INTO '{}'", outside.display());
        let statements = [
            "DELETE FROM log",
            "DELETE FROM log WHERE line = 1 RETURNING line",
            "WITH x AS (SELECT 1) DELETE FROM log",
            "UPDATE log SET level = 'INFO'",
            "INSERT INTO log (line, level, source) VALUES (5000, 'INFO', 0)",
            "REPLACE INTO log (line, level, source) VALUES (1, 'INFO', 0)",
            "DROP TABLE log",
            "DROP TABLE IF EXISTS sources",
            "CREATE TABLE t (x)",
            "CREATE TEMP TABLE t (x)",
            "CREATE TEMP VIEW v AS SELECT 1",
            "CREATE INDEX i ON log(level)",
            "CREATE TRIGGER t AFTER INSERT ON log BEGIN SELECT 1; END",
            "CREATE VIRTUAL TABLE v USING fts5(x)",
            "ALTER TABLE log ADD COLUMN x",
            "ALTER TABLE log RENAME TO old",
            attach.as_str(),
            "DETACH DATABASE main",
            vacuum.as_str(),
            "VACUUM",
            "REINDEX",
            "ANALYZE",
            "PRAGMA query_only = 0",
            "PRAGMA writable_schema = 1",
            "PRAGMA journal_mode = DELETE",
            "PRAGMA table_info(log)",
            "SELECT * FROM pragma_table_info('log')",
            "BEGIN",
            "COMMIT",
            "SAVEPOINT s",
            "SELECT load_extension('/tmp/evil')",
            "SELECT load_extension('/tmp/evil', 'entry')",
            "SELECT fts3_tokenizer('simple')",
            "SELECT writefile('/tmp/x', 'y')",
            "SELECT 1; DELETE FROM log",
            "SELECT 1; SELECT 2",
            "SELECT 1;; DROP TABLE log",
            "",
            "   ",
            "SELECT",
        ];
        for sql in statements {
            refused(&db, sql);
        }
        // Comments after the statement are fine, statements are not.
        assert!(db.query("SELECT 1; -- done", "a").is_ok());
        // Nothing changed, and nothing new appeared next to the file.
        assert_eq!(count(&db), 1000);
        assert!(!outside.exists());
        let r = db.query("SELECT count(*) FROM sqlite_master", "a").unwrap();
        assert_eq!(r.rows[0][0].as_i64(), Some(2));
    }

    #[test]
    fn load_extension_is_not_even_compiled_in() {
        let dir = tempfile::tempdir().unwrap();
        let db = sample_db(dir.path(), quick());
        // `.cargo/config.toml` builds SQLite with SQLITE_OMIT_LOAD_EXTENSION: the function does not
        // exist, the authorizer is a second wall.
        let conn = Connection::open_in_memory().unwrap();
        let err = conn
            .query_row("SELECT load_extension('x')", [], |r| r.get::<_, i64>(0))
            .unwrap_err();
        assert!(err.to_string().contains("no such function"), "{err}");
        refused(&db, "SELECT load_extension('x')");
    }

    #[test]
    fn endless_recursion_runs_into_the_time_limit() {
        let dir = tempfile::tempdir().unwrap();
        let db = sample_db(dir.path(), quick());
        let started = Instant::now();
        let message = refused(
            &db,
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
        );
        assert!(message.contains("time limit"), "{message}");
        assert!(started.elapsed() < Duration::from_secs(3));
        // A cross join bomb too.
        let message = refused(&db, "SELECT count(*) FROM log a, log b, log c, log d");
        assert!(message.contains("time limit"), "{message}");
    }

    #[test]
    fn rows_and_bytes_are_limited() {
        let dir = tempfile::tempdir().unwrap();
        let db = sample_db(dir.path(), quick());
        let r = db
            .query(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c",
                "a",
            )
            .unwrap();
        assert_eq!(r.rows.len(), MAX_ROWS);
        assert!(r.truncated);
        // Large values: one is capped by the length limit, many by the byte limit.
        let message = refused(&db, "SELECT randomblob(2000000000)");
        assert!(message.contains("too big"), "{message}");
        let message = refused(
            &db,
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) \
             SELECT group_concat(printf('%.*c', 1000, 'x')) FROM c",
        );
        assert!(
            message.contains("too big") || message.contains("time limit"),
            "{message}"
        );
        let r = db
            .query("SELECT printf('%.*c', 60000, 'x') FROM log", "a")
            .unwrap();
        assert!(r.truncated);
        assert!(r.rows.len() < 600, "{}", r.rows.len());
    }

    #[test]
    fn a_newer_query_of_the_same_slot_stops_the_older_one() {
        let dir = tempfile::tempdir().unwrap();
        let limits = ReportLimits {
            max_time: Duration::from_secs(20),
            ..ReportLimits::default()
        };
        let db = Arc::new(sample_db(dir.path(), limits));
        let slow = "SELECT count(*) FROM log a, log b, log c";
        let first = {
            let db = Arc::clone(&db);
            thread::spawn(move || db.query(slow, "panel"))
        };
        thread::sleep(Duration::from_millis(200));
        // Another slot does not stop it, the same one does.
        assert!(db.query("SELECT 1", "other").is_ok());
        let started = Instant::now();
        assert!(db.query("SELECT 2", "panel").is_ok());
        let err = first.join().unwrap().unwrap_err();
        assert!(err.message.contains("cancelled"), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn values_come_back_as_json() {
        let dir = tempfile::tempdir().unwrap();
        let db = sample_db(dir.path(), quick());
        let r = db
            .query(
                "SELECT 1, 2.5, 'ä😀', NULL, x'0102', 1e999, ts FROM log WHERE line = 1000",
                "a",
            )
            .unwrap();
        let row = &r.rows[0];
        assert_eq!(row[0], 1);
        assert_eq!(row[1], 2.5);
        assert_eq!(row[2], "ä😀");
        assert!(row[3].is_null());
        assert_eq!(row[4], "<2 Bytes>");
        assert!(row[5].is_null(), "infinity is no JSON number");
        assert!(row[6].is_null(), "no time: NULL");
    }

    #[test]
    fn crashed_folders_are_removed_running_ones_kept() {
        let cache = tempfile::tempdir().unwrap();
        let reports = cache.path().join("reports");
        let dead = reports.join("999999991");
        std::fs::create_dir_all(&dead).unwrap();
        std::fs::write(dead.join("lock"), "").unwrap();
        std::fs::write(dead.join("session-3.sqlite"), "x").unwrap();
        // A folder with something else in it is not ours to delete.
        let foreign = reports.join("999999992");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("notes.txt"), "keep").unwrap();
        let dir = ReportDir::prepare(cache.path()).unwrap();
        assert!(!dead.exists());
        assert!(foreign.exists());
        assert!(dir.path.join("lock").exists());
        // A second process sees this one alive (the lock is held) and keeps its folder.
        let alive = reports.join("999999993");
        std::fs::create_dir_all(&alive).unwrap();
        let held = File::create(alive.join("lock")).unwrap();
        held.lock().unwrap();
        std::fs::write(alive.join("session-1.sqlite"), "x").unwrap();
        // The own folder is locked: preparing it twice fails instead of waiting.
        assert!(ReportDir::prepare(cache.path()).is_err());
        drop(dir);
        let again = ReportDir::prepare(cache.path()).unwrap();
        assert!(
            alive.join("session-1.sqlite").exists(),
            "a running process keeps its files"
        );
        drop(held);
        drop(again);
    }

    // ---- Review findings (security review of prompt 012) ----

    #[test]
    fn one_long_function_call_cannot_outlast_the_limits() {
        let dir = tempfile::tempdir().unwrap();
        let db = sample_db(dir.path(), quick());
        // Measured before the fix: 41 s of CPU in one VM step, beyond the progress handler.
        let started = Instant::now();
        let message = refused(
            &db,
            "SELECT printf('%.*c', 1000000, 'a') LIKE '%' || printf('%.*c', 20000, 'a') || 'b'",
        );
        assert!(message.contains("too big"), "{message}");
        assert!(started.elapsed() < Duration::from_secs(1));
        // Patterns are short, values at most 64 KB: the worst LIKE within the limits is quick.
        let message = refused(
            &db,
            "SELECT printf('%.*c', 1000, 'a') LIKE printf('%.*c', 300, '%')",
        );
        assert!(message.contains("pattern too complex"), "{message}");
        let worst = "printf('%.*c', 65000, 'a') LIKE '%' || printf('%.*c', 250, 'a') || 'b'";
        let started = Instant::now();
        let r = db.query(&format!("SELECT {worst}"), "a").unwrap();
        assert_eq!(r.rows[0][0], 0);
        let single = started.elapsed();
        // 50 of them in one row: done, or stopped by the time limit between columns; never minutes.
        let many = vec![worst; MAX_COLUMNS as usize].join(", ");
        let started = Instant::now();
        let _ = db.query(&format!("SELECT {many}"), "a");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?} (one: {single:?})",
            started.elapsed()
        );
        // More columns than that are refused.
        let wide = vec!["1"; MAX_COLUMNS as usize + 1].join(", ");
        assert!(refused(&db, &format!("SELECT {wide}")).contains("too many columns"));
    }

    #[test]
    fn the_byte_limit_holds_within_one_row() {
        let dir = tempfile::tempdir().unwrap();
        let limits = ReportLimits {
            max_bytes: 1024 * 1024,
            ..quick()
        };
        let db = sample_db(dir.path(), limits);
        let wide = vec!["printf('%.*c', 60000, 'x')"; 40].join(", ");
        let r = db.query(&format!("SELECT {wide}"), "a").unwrap();
        assert!(r.truncated);
        assert!(r.rows.is_empty(), "the partial row is dropped");
    }

    #[test]
    fn closing_stops_running_queries_and_refuses_new_ones() {
        let dir = tempfile::tempdir().unwrap();
        let limits = ReportLimits {
            max_time: Duration::from_secs(30),
            ..ReportLimits::default()
        };
        let db = Arc::new(sample_db(dir.path(), limits));
        let slow = "SELECT count(*) FROM log a, log b, log c";
        let run = |db: &Arc<ReportDb>, slot: &'static str| {
            let db = Arc::clone(db);
            thread::spawn(move || db.query(slow, slot))
        };
        // Closing the dashboard (pause) interrupts.
        let first = run(&db, "p1");
        thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        db.pause();
        let err = first.join().unwrap().unwrap_err();
        assert!(err.message.contains("cancelled"), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
        // Closing the session too, and nothing new runs after it.
        let second = run(&db, "p2");
        thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        db.shutdown();
        let err = second.join().unwrap().unwrap_err();
        assert!(err.message.contains("cancelled"), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(db.query("SELECT 1", "p3").is_err());
    }

    #[test]
    fn at_most_a_few_queries_run_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let limits = ReportLimits {
            max_time: Duration::from_millis(400),
            ..ReportLimits::default()
        };
        let db = Arc::new(sample_db(dir.path(), limits));
        let threads: Vec<_> = (0..MAX_QUERIES * 2 + 2)
            .map(|i| {
                let db = Arc::clone(&db);
                thread::spawn(move || {
                    db.query("SELECT count(*) FROM log a, log b, log c", &format!("s{i}"))
                })
            })
            .collect();
        let mut most = 0;
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(600) {
            most = most.max(running_queries());
            thread::sleep(Duration::from_millis(5));
        }
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(most <= MAX_QUERIES, "{most}");
        assert!(most >= 2, "queries ran in parallel: {most}");
        // Every one ended (time limit, or no free slot within it), none hung.
        assert!(results.iter().all(|r| r.is_err()));
    }

    #[test]
    fn sorts_stay_in_memory_under_a_heap_limit() {
        let dir = tempfile::tempdir().unwrap();
        let db = sample_db(dir.path(), quick());
        let mut conn = open_reader(db.path(), &quick(), Cancel::never()).unwrap();
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .unwrap();
        let store: i64 = conn
            .query_row("PRAGMA temp_store", [], |r| r.get(0))
            .unwrap();
        assert_eq!(store, 2, "MEMORY");
        // SAFETY: a negative argument only reads the limit.
        let limit = unsafe { rusqlite::ffi::sqlite3_hard_heap_limit64(-1) };
        assert_eq!(limit, HEAP_LIMIT);
    }

    #[test]
    fn fields_named_like_keywords_work() {
        let dir = tempfile::tempdir().unwrap();
        let db = ReportDb::create(dir.path(), 9, vec!["a.log".into()], quick()).unwrap();
        let columns: Vec<Column> = ["order", "group", "from", "default"]
            .iter()
            .map(|id| Column {
                kind: ColumnKind::Number,
                ..Column::named(id)
            })
            .collect();
        let fields = available_fields(&columns);
        assert_eq!(fields[0].name, "order");
        let conn = open_writer(db.path()).unwrap();
        create_tables(&conn, &fields, &["a.log".into()]).unwrap();
        conn.execute(
            &insert_sql(&fields),
            rusqlite::params![1, 0, "INFO", 0, 1.5, 2, 3, 4],
        )
        .unwrap();
        let r = db
            .query(
                "SELECT \"order\", \"group\", \"from\", \"default\" FROM log",
                "a",
            )
            .unwrap();
        assert_eq!(r.rows[0][0], 1.5);
        assert_eq!(r.rows[0][3], 4.0);
    }

    #[test]
    fn errors_do_not_show_the_cache_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("not-a-folder");
        std::fs::write(&file, "x").unwrap();
        let below = file.join("reports");
        let err = match ReportDb::create(&below, 1, vec![], quick()) {
            Ok(_) => panic!("created below a file"),
            Err(e) => e,
        };
        assert!(err.path.is_none());
        assert!(
            !err.message.contains(&dir.path().display().to_string()),
            "{}",
            err.message
        );
    }

    #[test]
    fn field_names_are_safe_and_unique() {
        let mut columns = vec![
            Column::named("timestamp"),
            Column::named("level"),
            Column::named("logger"),
            Column::named("message"),
            Column::named("user.name"),
            Column::named("line"),
            Column::named("2xx"),
            Column::named("Logger"),
        ];
        columns.push(Column {
            kind: ColumnKind::Duration,
            ..Column::named("took")
        });
        let names: Vec<String> = available_fields(&columns)
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(
            names,
            ["logger", "user_name", "line_2", "f_2xx", "logger_2", "took"]
        );
        let numbers = chosen_fields(&columns, None);
        assert_eq!(numbers.len(), 1);
        assert_eq!(numbers[0].name, "took");
        // Numbers that are ids are not chosen by default, only when ticked.
        let ids = vec![
            Column {
                kind: ColumnKind::Number,
                ..Column::named("pid")
            },
            Column {
                kind: ColumnKind::Number,
                ..Column::named("requestId")
            },
            Column {
                kind: ColumnKind::Number,
                ..Column::named("status")
            },
        ];
        let chosen: Vec<String> = chosen_fields(&ids, None)
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(chosen, ["status"]);
        assert_eq!(
            chosen_fields(&ids, Some(&["pid".to_string()]))[0].name,
            "pid"
        );
        let chosen = chosen_fields(&columns, Some(&["logger".to_string()]));
        assert_eq!(chosen[0].name, "logger");
    }
}
