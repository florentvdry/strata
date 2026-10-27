//! Windows: FindFirstFileExW folder listing, drive details, the NTFS fast scan, and the Recycle Bin.

mod info;
mod list;
mod recycle;

use super::{DirLister, ScanFlags, Volume};
use crate::scan::ScanOptions;
use crate::scan::state::ScanState;
use crate::strata_file::Nodes;
use serde_json::{Value, json};
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetVolumeInformationW,
};

pub const SEP: char = '\\';

pub use recycle::{restore, trash_context, trash_entries, trash_item, trash_prepare};

/// NUL-terminated UTF-16.
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// UTF-16 up to the first NUL.
pub fn from_wide(buf: &[u16]) -> OsString {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..n])
}

/// "\\?\" form of a path, so APIs that don't do it themselves accept long paths.
pub fn long_path(p: &str) -> String {
    if p.starts_with(r"\\?\") || p.len() < 240 {
        p.to_owned()
    } else if let Some(unc) = p.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{unc}")
    } else {
        format!(r"\\?\{p}")
    }
}

/// FILETIME (100 ns since 1601) → Unix seconds.
pub fn unix_from_filetime(ft: i64) -> f64 {
    if ft <= 0 { 0.0 } else { (ft - 116_444_736_000_000_000) as f64 / 1e7 }
}

/// "C:" → "C:\", no trailing backslash otherwise, absolute.
pub fn normalize_root(arg: &str) -> PathBuf {
    let mut p = arg.trim().trim_matches('"').to_owned();
    if p.len() == 2 && p.as_bytes()[1] == b':' {
        p.push('\\');
    }
    if p.len() > 3 && p.ends_with('\\') {
        p = p.trim_end_matches('\\').to_owned();
    }
    let mut s = std::path::absolute(&p).map(|a| a.to_string_lossy().into_owned()).unwrap_or(p);
    if s.len() > 3 && s.ends_with('\\') {
        s = s.trim_end_matches('\\').to_owned();
    }
    if s.len() == 2 && s.as_bytes()[1] == b':' {
        s.push('\\');
    }
    PathBuf::from(s)
}

/// "C:\" for C:\Users\a, "\\server\share\" for a network path.
pub fn drive_root(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\") {
        let mut parts = rest.splitn(3, '\\');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        return format!(r"\\{server}\{share}\");
    }
    p.chars().take(2).collect::<String>() + "\\"
}

pub fn is_dir(p: &Path) -> bool {
    p.is_dir()
}

pub fn root_mtime(p: &Path) -> f64 {
    std::fs::metadata(p).map_or(0.0, |m| unix_from_filetime(m.last_write_time() as i64))
}

pub fn cluster_size(root: &str) -> u64 {
    let (mut spc, mut bps, mut fc, mut tc) = (0u32, 0u32, 0u32, 0u32);
    let w = wide(root);
    if unsafe { GetDiskFreeSpaceW(w.as_ptr(), &mut spc, &mut bps, &mut fc, &mut tc) } != 0 {
        (spc * bps) as u64
    } else {
        4096
    }
}

/// File system name and label of a drive root, if it is ready.
pub fn volume_names(root: &str) -> Option<(String, String)> {
    let w = wide(root);
    let mut label = [0u16; 261];
    let mut fs = [0u16; 261];
    let (mut serial, mut maxlen, mut flags) = (0u32, 0u32, 0u32);
    let ok = unsafe {
        GetVolumeInformationW(
            w.as_ptr(),
            label.as_mut_ptr(),
            261,
            &mut serial,
            &mut maxlen,
            &mut flags,
            fs.as_mut_ptr(),
            261,
        )
    };
    (ok != 0).then(|| (from_wide(&fs).to_string_lossy().into_owned(), from_wide(&label).to_string_lossy().into_owned()))
}

/// Total size and free space (all of it, not just what this user may use).
pub fn space(root: &str) -> Option<(u64, u64)> {
    let w = wide(root);
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    (unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) } != 0).then_some((total, free))
}

pub fn volume(root: &Path) -> Volume {
    let r = root.to_string_lossy();
    let dr = drive_root(&r);
    let mut v = Volume { cluster: 4096, is_drive_root: dr.eq_ignore_ascii_case(&r), ..Default::default() };
    if let (Some((fs, _)), Some((total, free))) = (volume_names(&dr), space(&dr)) {
        v.fs = fs;
        v.total = total;
        v.free = free;
        v.cluster = cluster_size(&dr);
    }
    v
}

pub fn new_lister(_root: &Path, flags: &ScanFlags) -> Box<dyn DirLister> {
    Box::new(list::WinLister::new(flags))
}

pub fn is_admin() -> bool {
    info::is_elevated()
}

pub fn info() -> Value {
    json!({ "type": "info", "admin": is_admin(), "drives": info::drives(), "trashDirs": [] })
}

/// The NTFS fast scan: reads the drive's master file table directly. Any problem → a message, and the caller walks.
pub fn fast_scan(o: &ScanOptions, vol: &Volume, st: &Arc<ScanState>) -> Result<Nodes, String> {
    if !vol.fs.eq_ignore_ascii_case("NTFS") {
        return Err("Fast scan needs an NTFS drive — using a normal scan.".into());
    }
    if !is_admin() {
        return Err("Fast scan needs administrator rights — using a normal scan.".into());
    }
    let letter: String = o.root_name.chars().take(2).collect();
    let volume = match crate::mft::open_volume(&letter) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err("Windows refused raw access to the drive — using a normal scan.".into());
        }
        Err(e) => {
            return Err(format!("Could not read the file table ({e}) — using a normal scan."));
        }
    };
    let rest: Vec<String> =
        o.root_name.get(3..).unwrap_or("").split('\\').filter(|s| !s.is_empty()).map(str::to_owned).collect();
    crate::mft::scan(volume, o, vol, &rest, st)
        .map_err(|e| format!("Could not read the file table ({e}) — using a normal scan."))
}

/// Permanent deletion: read-only files and folders can't be deleted until the attribute is cleared.
pub fn prepare_delete(p: &Path, md: &std::fs::Metadata) {
    let mut perm = md.permissions();
    if perm.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(p, perm);
    }
}

/// Removes a symbolic link or junction itself, never what it points to.
pub fn remove_link(p: &Path, md: &std::fs::Metadata) -> std::io::Result<()> {
    if md.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 { std::fs::remove_dir(p) } else { std::fs::remove_file(p) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_and_long_paths() {
        assert_eq!(drive_root(r"C:\Users\a"), r"C:\");
        assert_eq!(drive_root(r"\\srv\share\dir"), r"\\srv\share\");
        assert_eq!(long_path(r"C:\x"), r"C:\x");
        let long = format!(r"C:\{}", "a".repeat(300));
        assert!(long_path(&long).starts_with(r"\\?\C:\"));
        assert!(long_path(&format!(r"\\srv\{}", "a".repeat(300))).starts_with(r"\\?\UNC\srv\"));
        assert_eq!(normalize_root("c:"), PathBuf::from(r"c:\"));
    }
}
