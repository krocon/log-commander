//! The bridge between the sidecar and the app (AppIconic design 018 E1; from editlicious `ed-mcp`, design 016): newline-delimited JSON over
//! TCP on 127.0.0.1. The first line is the token; then one request per line, one answer each.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};

/// The app's identifier (`tauri.conf.json`) – its config folder holds the endpoint file.
pub const APP_IDENTIFIER: &str = "io.github.krocon.logcommander";
/// Name of the endpoint file in the config folder.
pub const ENDPOINT_FILE: &str = "mcp.json";
/// Environment variable with another endpoint file (tests, portable setups).
pub const ENDPOINT_ENV: &str = "LOG_COMMANDER_MCP_ENDPOINT";
/// Longest line on the bridge (a preview image, an asset).
pub const MAX_LINE_BYTES: usize = 16 << 20;

/// Where the running app listens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hello {
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloAnswer {
    pub ok: bool,
    /// Why a correct token was still turned away (too many connections).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeError {
    /// `FsError` code of the app (snake_case) or a sidecar code (`not_running`).
    pub code: String,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
}

/// The config folder of the app as Tauri's `app_config_dir` computes it.
pub fn config_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }?;
    Some(base.join(APP_IDENTIFIER))
}

/// The endpoint file: from the environment or in the config folder.
pub fn endpoint_path() -> Option<PathBuf> {
    match std::env::var_os(ENDPOINT_ENV) {
        Some(p) if !p.is_empty() => Some(PathBuf::from(p)),
        _ => config_dir().map(|d| d.join(ENDPOINT_FILE)),
    }
}

pub fn read_endpoint(path: &Path) -> io::Result<Endpoint> {
    let text = std::fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(io::Error::other)
}

/// Writes the endpoint file only the user can read (Unix: 0600) – written fresh, never
/// through an existing file of someone else.
pub fn write_endpoint(path: &Path, e: &Endpoint) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    use std::io::Write;
    f.write_all(
        serde_json::to_string(e)
            .map_err(io::Error::other)?
            .as_bytes(),
    )?;
    f.sync_all()
}

/// 256 random bits as hex: four 64-bit values from `RandomState`. The standard library draws its
/// keys from the operating system's random source once per thread and then only counts up, so
/// every value comes from its own short-lived thread – four independent 128-bit keys (AppIconic prompt 031).
pub fn new_token() -> String {
    (0..4u64)
        .map(|i| {
            std::thread::spawn(move || {
                let mut h = RandomState::new().build_hasher();
                h.write_u64(i);
                format!("{:016x}", h.finish())
            })
            .join()
            .expect("token thread")
        })
        .collect()
}

/// Compares in time independent of where the first difference is.
pub fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_long_and_differ() {
        let a = new_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, new_token());
        assert!(same_token(&a, &a.clone()));
        assert!(!same_token(&a, &new_token()));
        assert!(!same_token("ab", "abc"));
    }

    #[test]
    fn endpoint_file_round_trip_and_rights() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub").join(ENDPOINT_FILE);
        let e = Endpoint {
            port: 4711,
            token: new_token(),
            pid: 1,
        };
        write_endpoint(&p, &e).unwrap();
        write_endpoint(&p, &e).unwrap(); // again over the old one
        assert_eq!(read_endpoint(&p).unwrap(), e);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn messages_serialise_compactly() {
        let r = Response {
            id: 3,
            result: None,
            error: Some(BridgeError::new("revision_conflict", "x")),
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"id":3,"error":{"code":"revision_conflict","message":"x"}}"#
        );
    }
}
