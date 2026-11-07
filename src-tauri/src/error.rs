//! Structured, serialisable errors (`AppError { code, message, path }`), as in
//! files-and-folders-tauri and editlicious. `src/app/core/errors/app-error.ts` mirrors the codes.

use serde::Serialize;
use std::io;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotFound,
    PermissionDenied,
    IsADirectory,
    Io,
    UnknownSession,
    UnknownProfile,
    InvalidProfile,
    InvalidSearch,
    TooLarge,
    /// A file of a merge has no recognisable timestamp in its first lines.
    NoTimestamps,
    /// Not possible for a merge, or a merge that cannot be (count, duplicates).
    InvalidMerge,
    /// An extraction rule (prompt 011) that cannot be used; `node_id` names the rule.
    InvalidRule,
    /// A dashboard query (prompt 012) that is not allowed or fails; the message is the engine's.
    InvalidQuery,
    /// A view (filter tab, prompt 013) that is not open.
    UnknownView,
    /// More than `MAX_VIEWS` views of one file (prompt 013).
    TooManyViews,
    /// An export (prompt 015) that cannot be written: target path, the open log itself, columns.
    InvalidExport,
    /// The file started over (truncated, rotated without keeping) while an export ran.
    FileChanged,
    /// A workspace file (prompt 015) that cannot be read or written: path, size, not a workspace.
    InvalidWorkspace,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The node of a filter expression the error is about (prompt 010).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
            node_id: None,
        }
    }

    pub fn with_node(mut self, id: &str) -> Self {
        self.node_id = Some(id.into());
        self
    }

    pub fn from_io(err: &io::Error, path: &Path) -> Self {
        let code = match err.kind() {
            io::ErrorKind::NotFound => ErrorCode::NotFound,
            io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            io::ErrorKind::IsADirectory => ErrorCode::IsADirectory,
            _ => ErrorCode::Io,
        };
        Self {
            code,
            message: err.to_string(),
            path: Some(path.display().to_string()),
            node_id: None,
        }
    }

    pub fn unknown_session(id: u64) -> Self {
        Self::new(ErrorCode::UnknownSession, format!("no open session {id}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl From<regex::Error> for AppError {
    fn from(err: regex::Error) -> Self {
        Self::new(ErrorCode::InvalidSearch, err.to_string())
    }
}
