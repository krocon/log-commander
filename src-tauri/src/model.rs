//! DTOs between backend and frontend (serde camelCase). `src/app/core/log/log.models.ts` mirrors
//! them.

use crate::encoding::Encoding;
use crate::fields::Column;
use crate::level::Level;
use serde::Serialize;

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
    pub counts: LevelCounts,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: u64,
    pub path: String,
    pub file_name: String,
    pub suggested_profile_id: String,
    pub update: SessionUpdate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Zero-based number of the line in the file (the index).
    pub line: u32,
    pub level: Level,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindHit {
    pub line: u32,
    /// Position in the filtered view, which is what the viewport scrolls by.
    pub position: u32,
    /// The search passed the end of the view and went on from the other side.
    pub wrapped: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRange {
    pub first: u32,
    pub last: u32,
}
