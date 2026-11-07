//! Workspace files (prompt 015): a `.lcw` is JSON the frontend builds and checks; the backend only
//! reads and writes it, and only files of that kind, so the commands cannot be used to read or write
//! anything else. The content is untrusted when it is read back (it may come from someone else): the
//! frontend validates every field (`workspace-model.ts`), nothing in it is executed.

use crate::error::{AppError, AppResult, ErrorCode};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const WORKSPACE_EXTENSION: &str = "lcw";
/// A workspace is a few KB; this leaves room for thousands of bookmarks and notes.
pub const MAX_WORKSPACE_BYTES: u64 = 8 * 1024 * 1024;
/// Paths per `probe_paths` call.
pub const MAX_PROBE_PATHS: usize = 256;

fn invalid(message: &str, path: &Path) -> AppError {
    let mut err = AppError::new(ErrorCode::InvalidWorkspace, message);
    err.path = Some(path.display().to_string());
    err
}

/// An absolute path without `.`/`..`, ending in `.lcw`.
pub fn check_path(path: &Path) -> AppResult<()> {
    if !path.is_absolute() {
        return Err(invalid("the path must be absolute", path));
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid("the path must not contain . or ..", path));
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if extension.as_deref() != Some(WORKSPACE_EXTENSION) {
        return Err(invalid("a workspace file ends in .lcw", path));
    }
    Ok(())
}

/// The text of a workspace file, at most `MAX_WORKSPACE_BYTES`, UTF-8.
pub fn read(path: &Path) -> AppResult<String> {
    check_path(path)?;
    if is_network_path(path) {
        return Err(invalid("workspaces on network paths are not opened", path));
    }
    // A FIFO or device named `.lcw` would block `open`: only regular files (links followed).
    let meta = std::fs::metadata(path).map_err(|e| AppError::from_io(&e, path))?;
    if !meta.is_file() {
        return Err(invalid("not a file", path));
    }
    let file = open_nonblocking(path).map_err(|e| AppError::from_io(&e, path))?;
    let meta = file.metadata().map_err(|e| AppError::from_io(&e, path))?;
    if !meta.is_file() {
        return Err(invalid("not a file", path));
    }
    if meta.len() > MAX_WORKSPACE_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "the workspace file is too large",
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // The size may have changed since: never read more than the limit.
    file.take(MAX_WORKSPACE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::from_io(&e, path))?;
    if bytes.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "the workspace file is too large",
        ));
    }
    String::from_utf8(bytes).map_err(|_| invalid("the workspace file is not UTF-8 text", path))
}

/// Writes a workspace file through a temporary file next to it, so a failure leaves the old one.
pub fn write(path: &Path, content: &str) -> AppResult<()> {
    check_path(path)?;
    if content.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "the workspace is too large",
        ));
    }
    if path.is_dir() {
        return Err(invalid("the target is a folder", path));
    }
    let name = path
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let temp = path.with_file_name(format!(".{name}.{}.part", std::process::id()));
    let result = (|| {
        // A leftover of a crashed run goes first; `create_new` never follows a planted link.
        let _ = std::fs::remove_file(&temp);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(AppError::from_io(&e, path));
    }
    Ok(())
}

/// Opens for reading without blocking on a FIFO swapped in after the check (Unix).
fn open_nonblocking(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options.open(path)
}

/// Paths that would reach out to another machine when touched: UNC and `\\?\UNC` on Windows,
/// `//host`, macOS automounts (`/net/`, `/Network/`). A workspace from someone else must not make
/// the app connect there (SMB hash leak, automount hangs).
pub fn is_network_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let lower = text.to_ascii_lowercase();
    lower.starts_with("\\\\")
        || lower.starts_with("//")
        || lower.starts_with("\\\\?\\unc\\")
        || lower.starts_with("/net/")
        || lower.starts_with("/network/")
}

/// Whether paths name existing files, for the list of missing files when a workspace opens.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathProbe {
    pub path: String,
    pub exists: bool,
}

pub fn probe(paths: &[String]) -> AppResult<Vec<PathProbe>> {
    if paths.len() > MAX_PROBE_PATHS {
        return Err(AppError::new(ErrorCode::TooLarge, "too many paths"));
    }
    Ok(paths
        .iter()
        .map(|p| {
            let path = PathBuf::from(p);
            PathProbe {
                path: p.clone(),
                exists: path.is_absolute() && !is_network_path(&path) && path.is_file(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_lcw_files_are_read_and_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.lcw");
        write(&path, "{\"version\":2}").unwrap();
        assert_eq!(read(&path).unwrap(), "{\"version\":2}");
        // Overwriting keeps no temporary file behind.
        write(&path, "{}").unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let other = dir.path().join("a.txt");
        std::fs::write(&other, "secret").unwrap();
        assert_eq!(read(&other).unwrap_err().code, ErrorCode::InvalidWorkspace);
        assert_eq!(
            write(&other, "x").unwrap_err().code,
            ErrorCode::InvalidWorkspace
        );
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "secret");
        assert_eq!(
            read(Path::new("a.lcw")).unwrap_err().code,
            ErrorCode::InvalidWorkspace
        );
        let traversal = dir.path().join("x").join("..").join("a.lcw");
        assert_eq!(
            read(&traversal).unwrap_err().code,
            ErrorCode::InvalidWorkspace
        );
    }

    #[test]
    fn large_or_binary_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.lcw");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_WORKSPACE_BYTES + 1).unwrap();
        assert_eq!(read(&big).unwrap_err().code, ErrorCode::TooLarge);
        let binary = dir.path().join("bin.lcw");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read(&binary).unwrap_err().code, ErrorCode::InvalidWorkspace);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_named_lcw_does_not_block() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe.lcw");
        let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a valid C string; mkfifo only creates the node.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let start = std::time::Instant::now();
        assert_eq!(read(&fifo).unwrap_err().code, ErrorCode::InvalidWorkspace);
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn network_paths_are_never_touched() {
        for p in [
            r"\\attacker\share\a.log",
            r"\\?\UNC\host\s\a.log",
            "//host/share/a.log",
            "/net/host/a.log",
            "/Network/Servers/x/a.log",
        ] {
            assert!(is_network_path(Path::new(p)), "{p}");
        }
        assert!(!is_network_path(Path::new("/var/log/a.log")));
        assert!(!is_network_path(Path::new(r"C:\logs\a.log")));
        let found = probe(&["//host/share/a.log".into(), "/net/host/a.log".into()]).unwrap();
        assert!(found.iter().all(|p| !p.exists));
        assert_eq!(
            read(Path::new("/net/host/x.lcw")).unwrap_err().code,
            ErrorCode::InvalidWorkspace
        );
    }

    #[test]
    fn probes_say_which_files_exist() {
        let dir = tempfile::tempdir().unwrap();
        let there = dir.path().join("x.log");
        std::fs::write(&there, "x").unwrap();
        let found = probe(&[
            there.display().to_string(),
            dir.path().join("y.log").display().to_string(),
            "relative.log".into(),
            dir.path().display().to_string(),
        ])
        .unwrap();
        let exists: Vec<bool> = found.iter().map(|p| p.exists).collect();
        assert_eq!(exists, vec![true, false, false, false]);
    }
}
