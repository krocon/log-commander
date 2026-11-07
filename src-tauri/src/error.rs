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
    /// A source (prompt 016) that cannot be opened as configured: address, sender filter, remote
    /// listening without the explicit choice.
    InvalidSource,
    /// The port of a source is taken by another program.
    PortInUse,
    /// SSH (prompt 017): the server's host key is not known yet; `remote` has type and fingerprint.
    /// Connecting again with the confirmed fingerprint records it.
    HostKeyUnknown,
    /// The server's host key differs from the recorded one. Refused, there is no way around it.
    HostKeyChanged,
    /// The server refused the login (agent, key).
    AuthFailed,
    /// A password or the passphrase of the key file is needed, or the one given was wrong
    /// (`remote.secret`, `remote.wrong`).
    SecretRequired,
    /// The server cannot be reached, does not answer or the connection broke.
    ConnectionFailed,
    /// Not supported (e.g. ProxyJump in ~/.ssh/config).
    Unsupported,
}

/// Details of an SSH error (prompt 017) for the dialog. Never holds a secret.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_type: Option<String>,
    /// `SHA256:…`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// Where the other key is recorded (changed host key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_hosts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_hosts_line: Option<usize>,
    /// Which secret is needed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<crate::remote::secrets::SecretKind>,
    /// The secret given was not accepted.
    pub wrong: bool,
    /// Why a host key is refused: `other_key`, `revoked`, `unusable`, `cert_authority`,
    /// `unknown_marker`, `unreadable` (security review 017 M1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
    /// SSH details (prompt 017).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<Box<RemoteDetail>>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
            node_id: None,
            remote: None,
        }
    }

    pub fn with_remote(mut self, detail: RemoteDetail) -> Self {
        self.remote = Some(Box::new(detail));
        self
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
            remote: None,
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
