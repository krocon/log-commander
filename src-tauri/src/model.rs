//! DTOs between backend and frontend (serde camelCase). `src/app/core/log/log.models.ts` mirrors
//! them.

use crate::encoding::Encoding;
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
    pub filter_pending: bool,
    pub filter_progress: f32,
    pub profile_id: String,
    pub encoding: Encoding,
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
