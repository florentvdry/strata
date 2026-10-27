//! Linux: mounted file systems, folder listing with fstatat, and the freedesktop.org Trash.

mod info;
mod list;
pub mod mounts;
mod trash;

use super::{DirLister, ScanFlags, TrashEntry, Volume};
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

pub const SEP: char = '/';

/// Absolute, with "." and ".." resolved (like Node's path.resolve), without a trailing slash.
pub fn resolve(p: &str) -> PathBuf {
    let p = Path::new(p);
    let abs =
        if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_else(|_| "/".into()).join(p) };
    let mut out = PathBuf::from("/");
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(n) => out.push(n),
            _ => {}
        }
    }
    out
}

pub fn normalize_root(arg: &str) -> PathBuf {
    let t = arg.trim();
    let t = t.strip_prefix('"').unwrap_or(t);
    let t = t.strip_suffix('"').unwrap_or(t);
    resolve(t)
}

pub fn is_dir(p: &Path) -> bool {
    p.is_dir()
}

pub fn root_mtime(p: &Path) -> f64 {
    list::stat_path(p, true).map_or(0.0, |s| s.mtime)
}

pub fn volume(root: &Path) -> Volume {
    let mounts = mounts::read();
    let r = root.to_string_lossy();
    let m = mounts::mount_of(&r, &mounts);
    let s = info::statfs(&r);
    Volume {
        fs: m.map(|m| m.fstype.clone()).unwrap_or_default(),
        cluster: s.as_ref().map_or(4096, |s| s.cluster),
        total: s.as_ref().map_or(0, |s| s.total),
        free: s.as_ref().map_or(0, |s| s.free),
        is_drive_root: m.is_some_and(|m| m.mount == r),
    }
}

pub fn new_lister(root: &Path, flags: &ScanFlags) -> Box<dyn DirLister> {
    let mounts = mounts::read();
    let r = root.to_string_lossy();
    let root_mount = mounts::mount_of(&r, &mounts).map(|m| m.mount.clone());
    Box::new(list::LinuxLister::new(root, flags, &mounts, root_mount.as_deref()))
}

pub fn is_admin() -> bool {
    unsafe { libc::geteuid() == 0 }
}

pub fn info() -> Value {
    json!({
        "type": "info",
        "admin": is_admin(),
        "drives": info::drives(),
        "trashDirs": [trash::home_trash().to_string_lossy()],
    })
}

// ── Trash ──

/// Nothing to prepare: items are moved one by one.
pub fn trash_prepare(_paths: &[String], _progress: &mut dyn FnMut(usize)) {}

pub struct TrashContext {
    mounts: Vec<mounts::Mount>,
}

pub fn trash_context() -> TrashContext {
    TrashContext { mounts: mounts::read() }
}

pub fn trash_item(ctx: &TrashContext, p: &str) -> Result<(), String> {
    trash::trash_item(p, &ctx.mounts)
}

pub fn trash_entries(for_path: &str) -> Vec<TrashEntry> {
    trash::entries(for_path)
}

pub fn restore(info: &str) -> Result<String, String> {
    trash::restore(info)
}

/// Permanent deletion: nothing special about read-only files on Linux.
pub fn prepare_delete(_p: &Path, _md: &std::fs::Metadata) {}

/// Removes a symbolic link itself, never what it points to.
pub fn remove_link(p: &Path, _md: &std::fs::Metadata) -> std::io::Result<()> {
    std::fs::remove_file(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_node() {
        assert_eq!(resolve("/a/b/../c/./d/"), PathBuf::from("/a/c/d"));
        assert_eq!(resolve("/.."), PathBuf::from("/"));
        assert_eq!(normalize_root(" \"/usr/\" "), PathBuf::from("/usr"));
    }
}
