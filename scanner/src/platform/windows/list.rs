//! Listing a folder with FindFirstFileExW (basic info, large fetch): sizes, attributes and times come with the
//! listing, without opening every file.

use super::{from_wide, long_path, unix_from_filetime, wide};
use crate::platform::{DirLister, Entry, ListError, ScanFlags};
use crate::scan::state::lock;
use crate::strata_file::{CLOUD, DIR, HIDDEN, REPARSE, SYSTEM};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_OFFLINE,
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_SYSTEM, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FIND_FIRST_EX_LARGE_FETCH, FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
    GetFinalPathNameByHandleW, OPEN_EXISTING, WIN32_FIND_DATAW,
};

/// Cloud placeholders (OneDrive "online-only" files) don't use local space.
pub const CLOUD_ATTRS: u32 =
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_OFFLINE;

pub struct WinLister {
    hidden: bool,
    links: bool,
    /// Targets of the junctions and symlinks followed so far (lowercase), each entered once.
    link_targets: Mutex<HashSet<String>>,
}

impl WinLister {
    pub fn new(flags: &ScanFlags) -> Self {
        WinLister { hidden: flags.hidden, links: flags.links, link_targets: Mutex::new(HashSet::new()) }
    }

    /// Follow a junction or symlink only when it leads somewhere we haven't been and isn't an ancestor.
    fn should_follow(&self, parent: &str, name: &str, depth: u32) -> bool {
        if depth > 64 {
            return false;
        }
        let full = join(parent, name);
        let w = wide(long_path(&full));
        let h = unsafe {
            CreateFileW(
                w.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut buf = vec![0u16; 1024];
        let len = unsafe { GetFinalPathNameByHandleW(h, buf.as_mut_ptr(), 1024, 0) };
        unsafe { CloseHandle(h) };
        if len == 0 || len >= 1024 {
            return false;
        }
        let mut target = from_wide(&buf[..len as usize]).to_string_lossy().into_owned();
        if let Some(unc) = target.strip_prefix(r"\\?\UNC\") {
            target = format!(r"\\{unc}");
        } else if let Some(local) = target.strip_prefix(r"\\?\") {
            target = local.to_owned();
        }
        let target = target.trim_end_matches('\\').to_lowercase();
        let p = format!("{}\\", parent.trim_end_matches('\\')).to_lowercase();
        if p.starts_with(&format!("{target}\\")) {
            return false;
        }
        lock(&self.link_targets).insert(target)
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('\\') { format!("{dir}{name}") } else { format!("{dir}\\{name}") }
}

impl DirLister for WinLister {
    fn list(&self, dir: &Path, depth: u32) -> Result<Vec<Entry>, ListError> {
        let dir_s = dir.to_string_lossy();
        let pattern = wide(long_path(&join(&dir_s, "*")));
        let mut fd: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
        let h = unsafe {
            FindFirstFileExW(
                pattern.as_ptr(),
                FindExInfoBasic,
                (&mut fd as *mut WIN32_FIND_DATAW).cast(),
                FindExSearchNameMatch,
                std::ptr::null(),
                FIND_FIRST_EX_LARGE_FETCH,
            )
        };
        if h == INVALID_HANDLE_VALUE {
            // ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES: nothing in it. ERROR_PATH_NOT_FOUND: deleted while scanning.
            return match unsafe { GetLastError() } {
                2 | 18 => Ok(Vec::new()),
                3 => Err(ListError::Gone),
                _ => Err(ListError::Denied),
            };
        }
        let mut out = Vec::new();
        loop {
            let os_name = from_wide(&fd.cFileName);
            let name = os_name.to_string_lossy().into_owned();
            let a = fd.dwFileAttributes;
            let hidden = a & FILE_ATTRIBUTE_HIDDEN != 0;
            let system = a & FILE_ATTRIBUTE_SYSTEM != 0;
            if name != "." && name != ".." && (self.hidden || !(hidden || system)) {
                let is_dir = a & FILE_ATTRIBUTE_DIRECTORY != 0;
                let reparse = a & FILE_ATTRIBUTE_REPARSE_POINT != 0;
                let mut flags = 0;
                if is_dir {
                    flags |= DIR;
                }
                if hidden {
                    flags |= HIDDEN;
                }
                if system {
                    flags |= SYSTEM;
                }
                if reparse {
                    flags |= REPARSE;
                }
                let ft = ((fd.ftLastWriteTime.dwHighDateTime as i64) << 32) | fd.ftLastWriteTime.dwLowDateTime as i64;
                let (size, descend) = if is_dir {
                    (0, !reparse || (self.links && self.should_follow(&dir_s, &name, depth)))
                } else if a & CLOUD_ATTRS != 0 {
                    flags |= CLOUD;
                    (0, false)
                } else {
                    (((fd.nFileSizeHigh as u64) << 32) | fd.nFileSizeLow as u64, false)
                };
                out.push(Entry { name, os_name, size, mtime: unix_from_filetime(ft), flags, descend, typed: true });
            }
            if unsafe { FindNextFileW(h, &mut fd) } == 0 {
                break;
            }
        }
        unsafe { FindClose(h) };
        Ok(out)
    }
}
