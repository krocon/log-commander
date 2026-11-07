//! OS-specific parts of following a file: opening without blocking the writer, and telling
//! whether the path still names the file we have open.

use std::fs::File;
use std::io;
use std::path::Path;

/// Identity of a file independent of its name: device + inode on Unix, volume + file index on
/// Windows. Creation time and size would not do there: file tunnelling gives a file re-created
/// under a rotated name the old creation time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId(u64, u64);

#[cfg(unix)]
pub fn open_shared(path: &Path) -> io::Result<File> {
    File::open(path)
}

/// FILE_SHARE_* for all three: the writer is not blocked and may rename or delete the file
/// (log rotation) while it is open here.
#[cfg(windows)]
pub fn open_shared(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
}

#[cfg(unix)]
pub fn file_id(path: &Path) -> io::Result<FileId> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path)?;
    Ok(FileId(meta.dev(), meta.ino()))
}

#[cfg(unix)]
pub fn open_file_id(file: &File) -> io::Result<FileId> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(FileId(meta.dev(), meta.ino()))
}

/// `std` only exposes the file index on nightly, so the handle is asked directly.
#[cfg(windows)]
pub fn open_file_id(file: &File) -> io::Result<FileId> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is valid for the lifetime of `file`, `info` is a writable struct.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok(FileId(u64::from(info.dwVolumeSerialNumber), index))
}

#[cfg(windows)]
pub fn file_id(path: &Path) -> io::Result<FileId> {
    open_file_id(&open_shared(path)?)
}

/// Bytes free for this user on the volume of `path` (the dashboard database of prompt 012 checks
/// before it grows). `None` if the OS does not say.
#[cfg(unix)]
pub fn free_space(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `name` is a valid C string and `stat` is written by statvfs before it is read.
    let ok = unsafe { libc::statvfs(name.as_ptr(), stat.as_mut_ptr()) } == 0;
    if !ok {
        return None;
    }
    // SAFETY: statvfs succeeded, so the struct is initialised.
    let stat = unsafe { stat.assume_init() };
    #[allow(clippy::unnecessary_cast)]
    Some(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(windows)]
pub fn free_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut available = 0u64;
    // SAFETY: `wide` is NUL-terminated; the other out-pointers may be null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } != 0;
    ok.then_some(available)
}
