//! DTOs between backend and frontend (serde camelCase). `src/app/core/log/log.models.ts` mirrors
//! them.

use crate::encoding::Encoding;
use crate::fields::Column;
use crate::level::Level;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct LevelCounts {
    #[serde(rename = "UNKNOWN")]
    pub unknown: u64,
    #[serde(rename = "TRACE")]
    pub trace: u64,
    #[serde(rename = "DEBUG")]
    pub debug: u64,
    #[serde(rename = "INFO")]
    pub info: u64,
    #[serde(rename = "WARN")]
    pub warn: u64,
    #[serde(rename = "ERROR")]
    pub error: u64,
    #[serde(rename = "FATAL")]
    pub fatal: u64,
}

impl From<[u64; Level::COUNT]> for LevelCounts {
    fn from(c: [u64; Level::COUNT]) -> Self {
        Self {
            unknown: c[0],
            trace: c[1],
            debug: c[2],
            info: c[3],
            warn: c[4],
            error: c[5],
            fatal: c[6],
        }
    }
}

/// Where a session stands. `Truncated` and `Rotated` are sent once, then `Live` follows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Status {
    Loading { progress: f32 },
    Live,
    Truncated,
    Rotated,
    FileMissing,
    Error { message: String },
}

/// Bundled live update (at most ~10 per second). The frontend loads visible lines with `get_lines`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdate {
    pub total_lines: u64,
    pub filtered_lines: u64,
    /// A filter expression took lines out of the end of the view since the last update (prompt 010):
    /// positions from here on may hold other lines, even if the count did not change.
    pub retracted_from: Option<u64>,
    pub counts: LevelCounts,
    /// Lines per level in the view (after the filter); while `filter_pending` still the old filter's.
    pub view_counts: LevelCounts,
    pub status: Status,
    pub file_size: u64,
    /// Changes when the index starts over: line numbers from before are void.
    pub epoch: u64,
    /// Changes when the filtered list or the levels were recomputed: cached lines are void.
    pub view_generation: u64,
    /// Changes with the columns (format change); `view_generation` changes with it.
    pub columns_revision: u64,
    pub filter_pending: bool,
    pub filter_progress: f32,
    pub profile_id: String,
    pub encoding: Encoding,
    /// Reading is on hold: lines, counts and sizes stay as they are until it resumes.
    pub frozen: bool,
    /// Bytes written since the last read, while frozen.
    pub pending_bytes: u64,
    /// The file shrank while frozen: the text of the frozen lines may be gone or different.
    pub frozen_stale: bool,
    /// Per source of a merge (empty for a single file); `file_size` is their sum.
    pub sources: Vec<SourceUpdate>,
    /// The dashboard database (prompt 012), once a dashboard was opened.
    pub report: Option<ReportStatus>,
    /// A source without a file (prompt 016): its state and counters; `None` for files.
    pub source_status: Option<SourceStatus>,
}

/// Kinds of sources without a file of their own (prompt 016); 017–019 add theirs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Syslog,
}

/// What a tab of a source shows instead of the spool path.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDescriptor {
    pub kind: SourceKind,
    /// "Syslog :5514".
    pub label: String,
    /// The current spool file (the session follows it).
    pub spool_path: String,
    /// The spool stays when the tab closes.
    pub keep: bool,
    /// The configuration as it was opened (no secrets), with the port actually bound.
    pub config: serde_json::Value,
}

/// Spools kept after their tab closed (prompt 016): shown in the settings with „Löschen“.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptSpools {
    pub count: u32,
    pub bytes: u64,
}

/// Where a source stands (prompt 016).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceState {
    Connecting,
    Listening,
    Connected,
    Error { message: String },
    Stopped,
}

/// State and counters of a source, sent with every update of its session.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub state: SourceState,
    /// Messages accepted (written to the spool or dropped there).
    pub received: u64,
    /// Messages the spool could not take (queue full, disk error).
    pub dropped: u64,
    /// Messages cut at the size limit.
    pub truncated: u64,
    /// Messages or connections refused (sender filter, connection limit).
    pub rejected: u64,
    /// Open connections (TCP).
    pub connections: u32,
    /// Lines written to the spool.
    pub spooled: u64,
    /// The last error writing the spool (disk full …), if it persists.
    pub spool_error: Option<String>,
}

/// Live state of one source of a merge.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUpdate {
    pub status: Status,
    pub file_size: u64,
    /// Lines in the merge from this source.
    pub lines: u64,
    /// Entries that came after a later one was already shown, appended at the end.
    pub late_lines: u64,
}

/// One file of a merge, fixed for the session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub index: u8,
    pub path: String,
    pub file_name: String,
    pub profile_id: String,
    pub encoding: Encoding,
}

/// What the merge dialog shows about a file before merging it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCandidate {
    pub path: String,
    pub file_name: String,
    pub suggested_profile_id: String,
    pub encoding: Encoding,
    /// Microseconds since the epoch (UTC) of the first and last timestamp found, if any.
    pub first_time: Option<i64>,
    pub last_time: Option<i64>,
    pub file_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: u64,
    pub path: String,
    pub file_name: String,
    pub suggested_profile_id: String,
    pub update: SessionUpdate,
    /// The files of a merge in source order; empty for a single file.
    pub sources: Vec<SourceInfo>,
    /// A source without a file (prompt 016); `path` is then its spool.
    pub source: Option<SourceDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Zero-based number of the line in the file (the index).
    pub line: u32,
    pub level: Level,
    /// Index into `SessionInfo.sources` (0 for a single file).
    pub source: u8,
    pub text: String,
    pub is_continuation: bool,
    /// The line is longer than what was sent.
    pub truncated: bool,
    /// Search matches `[start, end)` in UTF-16 code units.
    pub matches: Vec<[u32; 2]>,
    /// One span `[start, end)` in UTF-16 code units per column of `get_columns`, `[0, 0]` if empty.
    pub fields: Vec<[u32; 2]>,
}

/// The columns lines split into, fixed per session until the format changes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSet {
    pub revision: u64,
    /// Share of the entry heads of the sample that fit the format, 0 to 1.
    pub confidence: f32,
    /// The profile whose layout splits the lines (`generic` for an inferred layout).
    pub profile_id: String,
    /// The regex the inference built, to take over into a custom profile.
    pub inferred_layout: Option<String>,
    pub columns: Vec<Column>,
}

/// A layout tried on one line (settings dialog).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldPreview {
    pub columns: Vec<Column>,
    pub fields: Vec<[u32; 2]>,
    /// The line fits the layout; otherwise everything is in the message.
    pub matched: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterInfo {
    pub view_generation: u64,
    /// The result arrives later through the channel.
    pub pending: bool,
    pub filtered_lines: u64,
}

pub type Stats = SessionUpdate;

/// A view opened as a tab of its own (prompt 013); its updates come through its own channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewInfo {
    pub view_id: u32,
    pub parent_view_id: Option<u32>,
    pub update: SessionUpdate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindHit {
    pub line: u32,
    /// Position in the filtered view, which is what the viewport scrolls by.
    pub position: u32,
    /// The search passed the end of the view and went on from the other side.
    pub wrapped: bool,
}

/// What the overview ruler draws (prompt 007), for the view of `view_generation` in `epoch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub view_generation: u64,
    pub epoch: u64,
    /// Positions in the view; buckets and marks belong to this count.
    pub count: u64,
    /// Level bits (`1 << level`) per pixel bucket, top to bottom.
    pub buckets: Vec<u8>,
    /// Per bucket three densities 0–255 (FATAL, ERROR, WARN): how much of the bucket's positions lie in
    /// summary chunks with the level (`overview::LevelSummary::buckets`).
    pub density: Vec<u8>,
    pub marks: Vec<OverviewMark>,
}

/// What the timeline draws (prompt 014): entries of the whole file over time. Times in
/// microseconds since the epoch, UTC.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub epoch: u64,
    /// Lines of the index; anchors belong to this count.
    pub total_lines: u64,
    /// Entries (heads) of the file.
    pub entries: u64,
    /// Whether any head had a time; without, there is nothing to draw.
    pub has_times: bool,
    /// The axis: the requested range, or for the whole file the 1st–99th percentile widened.
    pub from: i64,
    pub to: i64,
    /// Entries per bucket from `from` to `to`, approximate where a chunk spreads over buckets.
    pub buckets: Vec<TimelineBucket>,
    /// Stretches without entries between chunks, at least a bucket long.
    pub gaps: Vec<TimeRange>,
    /// Earliest and latest time in the file, outliers included.
    pub min: Option<i64>,
    pub max: Option<i64>,
    /// Entries before / after the axis.
    pub before: u64,
    pub after: u64,
    /// Entries in chunks without any time, placed by their neighbours.
    pub untimed: u64,
    /// Line → time at chunk boundaries (at most 1024), for the band of the visible lines.
    pub anchors: Vec<TimeAnchor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBucket {
    pub all: f32,
    pub warn: f32,
    pub error: f32,
    pub fatal: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeAnchor {
    pub line: u32,
    pub ts: i64,
}

/// Where a time is in a view: the first entry head at or after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeHit {
    pub line: u32,
    pub position: u32,
    /// A head with this time or later was found; otherwise the start of the nearest chunk.
    pub exact: bool,
}

/// Where a line (selection, bookmark) is in the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewMark {
    pub line: u32,
    /// Its position, or that of the next visible line when the filter hides it.
    pub position: u32,
    /// The line itself is in the view.
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRange {
    pub first: u32,
    pub last: u32,
}

/// The whole entry of a line for the detail panel: head and continuations, unfiltered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetail {
    pub first: u32,
    pub last: u32,
    pub level: Level,
    pub line_count: u32,
    /// Bytes of the lines in the file, without line ends.
    pub total_bytes: u64,
    /// The lines joined by `\n`, decoded and without ANSI, at most `MAX_DETAIL_BYTES`.
    pub text: String,
    /// The text stops early; copying (`copy_lines`) still returns everything.
    pub truncated: bool,
    /// Source of the entry (merge) and the byte offset of its head in that file.
    pub source: u8,
    pub byte_offset: u64,
}

/// Where the dashboard database of a session stands (prompt 012); in `SessionUpdate` once it exists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportState {
    #[default]
    Building,
    /// The time index is built after the first pass.
    Indexing,
    Ready,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportStatus {
    pub state: ReportState,
    /// Share of the lines in the table (of those there are now).
    pub progress: f32,
    /// Rows (entry heads) in the table.
    pub rows: u64,
    /// Lines of the log the table covers.
    pub lines: u64,
    /// Changes when the table starts over.
    pub generation: u64,
    /// Why it started over: `epoch` (file truncated, rotated, re-sorted), `columns` (profile, rules),
    /// `fields` (other fields chosen).
    pub reason: Option<String>,
    /// What went wrong (state `error`), e.g. a full disk.
    pub message: Option<String>,
    /// Free space is tight for the estimated size.
    pub low_space: bool,
    /// Size of the database file in bytes.
    pub size: u64,
}

/// Rows of a dashboard query: values as JSON (numbers, text, null).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// More rows than the limit (10 000) or too many bytes: the rest is missing.
    pub truncated: bool,
    pub elapsed_ms: f64,
}

/// A column of the table `log` for the help of the SQL editor.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaColumn {
    pub name: String,
    pub sql_type: String,
    pub description: String,
    /// The column of the log view it comes from (fields only).
    pub column: Option<String>,
    pub kind: Option<crate::fields::ColumnKind>,
    pub unit: Option<String>,
    /// In the table now; others can be chosen.
    pub included: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSchema {
    pub table: String,
    pub columns: Vec<SchemaColumn>,
    /// File names by `source`.
    pub sources: Vec<String>,
    pub status: Option<ReportStatus>,
}

/// A line found again after a restart or a change of the file (prompt 015): its number, the source of a
/// merge, its byte offset in that file, its length and a hash of its first bytes (`anchor::hash_line`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub line: u32,
    #[serde(default)]
    pub source: u8,
    pub offset: u64,
    pub len: u32,
    /// FNV-1a (64 bit) of the first `ANCHOR_HASH_BYTES` raw bytes, 16 hex digits.
    pub hash: String,
}

/// Where an export (prompt 015) stands; sent at most every 100 ms and once at the end.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub job_id: u64,
    pub state: ExportState,
    /// Lines written so far.
    pub lines: u64,
    /// Lines the export will write at most (fixed at the start; a filter may change it on the way).
    pub total: u64,
    pub bytes: u64,
    /// The target, for the message at the end.
    pub path: String,
    pub error: Option<crate::error::AppError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportState {
    Running,
    Done,
    Cancelled,
    Failed,
}
