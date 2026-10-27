//! What differs between Windows and Linux, behind one interface.
//!
//! The rest of the scanner (protocol, scan file, folder walk, duplicates, deletion loop) is shared.

use std::ffi::OsString;
use std::path::Path;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// One item of a folder, already filtered and measured the platform's way.
pub struct Entry {
    /// Name as shown and written to the scan file (UTF-8; invalid sequences replaced).
    pub name: String,
    /// Exact name, to build the path of a folder to enter.
    pub os_name: OsString,
    pub size: u64,
    pub mtime: f64,
    /// `strata_file` flags: DIR, HIDDEN, SYSTEM, REPARSE, CLOUD.
    pub flags: u8,
    /// Enter this folder (real folder on the same drive, or a link to follow).
    pub descend: bool,
    /// Give it a file type from its extension (links that aren't followed have none on Linux).
    pub typed: bool,
}

pub enum ListError {
    /// Could not be read: counted as an error and flagged on the folder.
    Denied,
    /// Vanished while scanning: ignored.
    Gone,
}

/// Lists folders during a scan. Shared by all walker threads.
pub trait DirLister: Sync {
    fn list(&self, dir: &Path, depth: u32) -> Result<Vec<Entry>, ListError>;
}

/// The drive a scanned folder lives on.
#[derive(Debug, Default, Clone)]
pub struct Volume {
    pub fs: String,
    pub cluster: u64,
    pub total: u64,
    pub free: u64,
    /// The scanned folder is the drive itself.
    pub is_drive_root: bool,
}

/// An item in the Recycle Bin or the Trash.
#[derive(Debug, Clone)]
pub struct TrashEntry {
    /// Metadata file ($I… or .trashinfo).
    pub info: String,
    /// The item itself ($R… or files/…).
    pub data: String,
    /// Where it was deleted from.
    pub original: String,
    /// Unix milliseconds.
    pub deleted_at: f64,
}

pub struct ScanFlags {
    pub hidden: bool,
    pub links: bool,
}

/// Two hex digits → a byte.
#[cfg(target_os = "linux")]
pub fn hex_byte(hi: u8, lo: u8) -> Option<u8> {
    let d = |c: u8| (c as char).to_digit(16);
    Some((d(hi)? * 16 + d(lo)?) as u8)
}

/// An I/O error, worded for the UI.
pub fn describe_io(e: &std::io::Error) -> String {
    #[cfg(windows)]
    const IN_USE: &[i32] = &[32, 33]; // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
    #[cfg(not(windows))]
    const IN_USE: &[i32] = &[libc::EBUSY, libc::ETXTBSY];
    if e.raw_os_error().is_some_and(|c| IN_USE.contains(&c)) {
        return "In use".into();
    }
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "Permission denied".into(),
        _ => e.to_string(),
    }
}

#[cfg(windows)]
const BIN: &str = "Recycle Bin";
#[cfg(not(windows))]
const BIN: &str = "Trash";

/// Moves an item out of the Recycle Bin / Trash back to where it came from, then drops its metadata file.
pub fn put_back(data: &Path, original: &Path, info: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(original).is_ok() {
        return Err("Something already exists at the original location".into());
    }
    if std::fs::symlink_metadata(data).is_err() {
        return Err(format!("The item is no longer in the {BIN}"));
    }
    if let Some(parent) = original.parent() {
        std::fs::create_dir_all(parent).map_err(|e| describe_io(&e))?;
    }
    std::fs::rename(data, original).map_err(|e| describe_io(&e))?;
    let _ = std::fs::remove_file(info);
    Ok(())
}
