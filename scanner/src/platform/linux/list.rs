//! Listing a folder: one opendir, then fstatat relative to the folder for each name (no path rebuilding).

use crate::platform::{DirLister, Entry, ListError, ScanFlags};
use crate::scan::state::lock;
use crate::strata_file::{DIR, HIDDEN, REPARSE};
use std::collections::HashSet;
use std::ffi::{CStr, CString, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use std::sync::Mutex;

pub struct LinuxLister {
    hidden: bool,
    links: bool,
    /// Other file systems mounted inside the scanned folder: listed, not entered (like du -x).
    mount_points: HashSet<Vec<u8>>,
    /// Hard-linked files count once.
    seen_inodes: Mutex<HashSet<(u64, u64)>>,
    /// With --links: folders entered so far, so a link never leads into an ancestor or twice into the same folder.
    visited_dirs: Mutex<HashSet<(u64, u64)>>,
}

enum Kind {
    File,
    Dir,
    Link,
    Other,
}

pub(super) struct Stat {
    pub dev: u64,
    pub ino: u64,
    pub mode: u32,
    pub size: u64,
    pub blocks: u64,
    pub nlink: u64,
    pub mtime: f64,
}

pub(super) fn stat_at(dirfd: libc::c_int, name: &CStr, follow: bool) -> Option<Stat> {
    let mut s: libc::stat = unsafe { std::mem::zeroed() };
    let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
    if unsafe { libc::fstatat(dirfd, name.as_ptr(), &mut s, flags) } != 0 {
        return None;
    }
    Some(Stat {
        dev: s.st_dev as u64,
        ino: s.st_ino as u64,
        mode: s.st_mode as u32,
        size: s.st_size.max(0) as u64,
        blocks: s.st_blocks.max(0) as u64,
        nlink: s.st_nlink as u64,
        mtime: s.st_mtime as f64 + s.st_mtime_nsec as f64 / 1e9,
    })
}

pub(super) fn stat_path(p: &Path, follow: bool) -> Option<Stat> {
    let c = CString::new(p.as_os_str().as_bytes()).ok()?;
    stat_at(libc::AT_FDCWD, &c, follow)
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// An open folder, closed on drop.
struct Dir(*mut libc::DIR);

impl Drop for Dir {
    fn drop(&mut self) {
        unsafe { libc::closedir(self.0) };
    }
}

impl LinuxLister {
    pub fn new(root: &Path, flags: &ScanFlags, mounts: &[super::mounts::Mount], root_mount: Option<&str>) -> Self {
        let mount_points = mounts
            .iter()
            .filter(|m| Some(m.mount.as_str()) != root_mount)
            .map(|m| m.mount.as_bytes().to_vec())
            .collect();
        let mut visited = HashSet::new();
        if let Some(s) = stat_path(root, true) {
            visited.insert((s.dev, s.ino));
        }
        LinuxLister {
            hidden: flags.hidden,
            links: flags.links,
            mount_points,
            seen_inodes: Mutex::new(HashSet::new()),
            visited_dirs: Mutex::new(visited),
        }
    }
}

impl DirLister for LinuxLister {
    fn list(&self, dir: &Path, depth: u32) -> Result<Vec<Entry>, ListError> {
        let c = CString::new(dir.as_os_str().as_bytes()).map_err(|_| ListError::Gone)?;
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(match errno() {
                libc::ENOENT | libc::ENOTDIR => ListError::Gone,
                _ => ListError::Denied,
            });
        }
        let d = unsafe { libc::fdopendir(fd) };
        if d.is_null() {
            unsafe { libc::close(fd) };
            return Err(ListError::Denied);
        }
        let d = Dir(d);
        let dirfd = unsafe { libc::dirfd(d.0) };

        let mut raw: Vec<(CString, Kind, Stat)> = Vec::new();
        loop {
            let ent = unsafe { libc::readdir(d.0) };
            if ent.is_null() {
                break;
            }
            let name = unsafe { CStr::from_ptr((*ent).d_name.as_ptr()) };
            let bytes = name.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            // Vanished while scanning: left out.
            let Some(s) = stat_at(dirfd, name, false) else {
                continue;
            };
            let kind = match s.mode & libc::S_IFMT {
                libc::S_IFREG => Kind::File,
                libc::S_IFDIR => Kind::Dir,
                libc::S_IFLNK => Kind::Link,
                _ => Kind::Other,
            };
            raw.push((name.to_owned(), kind, s));
        }

        // Real folders first, so a link next to the folder it points to isn't followed as well.
        if self.links {
            let mut visited = lock(&self.visited_dirs);
            for (_, kind, s) in &raw {
                if matches!(kind, Kind::Dir) {
                    visited.insert((s.dev, s.ino));
                }
            }
        }

        let base = dir.as_os_str().as_bytes();
        let mut out = Vec::with_capacity(raw.len());
        for (cname, kind, s) in raw {
            let bytes = cname.as_bytes();
            let hidden = bytes.first() == Some(&b'.');
            if hidden && !self.hidden {
                continue;
            }
            let name = String::from_utf8_lossy(bytes).into_owned();
            let os_name = OsString::from_vec(bytes.to_vec());
            let mut flags = if hidden { HIDDEN } else { 0 };
            let (size, descend) = match kind {
                Kind::Dir => {
                    flags |= DIR;
                    let mut full = Vec::with_capacity(base.len() + 1 + bytes.len());
                    full.extend_from_slice(base);
                    if base != b"/" {
                        full.push(b'/');
                    }
                    full.extend_from_slice(bytes);
                    let other = self.mount_points.contains(&full);
                    if other {
                        flags |= REPARSE;
                    }
                    (0, !other)
                }
                Kind::Link => {
                    flags |= REPARSE;
                    let mut follow = false;
                    // Follow a link only into a folder we haven't been in: never an ancestor, never twice.
                    if self.links
                        && depth < 64
                        && let Some(t) = stat_at(dirfd, &cname, true)
                        && t.mode & libc::S_IFMT == libc::S_IFDIR
                    {
                        follow = lock(&self.visited_dirs).insert((t.dev, t.ino));
                    }
                    if follow {
                        flags |= DIR;
                    }
                    (0, follow)
                }
                Kind::File | Kind::Other => {
                    // Allocated size when smaller (sparse files such as VM disks and container images), else the length.
                    let mut size = if s.blocks > 0 { s.size.min(s.blocks * 512) } else { s.size };
                    if matches!(kind, Kind::File) && s.nlink > 1 && !lock(&self.seen_inodes).insert((s.dev, s.ino)) {
                        size = 0;
                    }
                    (size, false)
                }
            };
            let typed = !matches!(kind, Kind::Link);
            out.push(Entry { name, os_name, size, mtime: s.mtime, flags, descend, typed });
        }
        Ok(out)
    }
}
