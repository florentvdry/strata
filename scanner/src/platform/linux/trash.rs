//! The freedesktop.org Trash (https://specifications.freedesktop.org/trash-spec/latest/), used by GNOME, KDE,
//! Xfce and the rest.

use super::mounts::{self, Mount};
use crate::platform::TrashEntry;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

fn uid() -> u32 {
    unsafe { libc::getuid() }
}

pub fn home_trash() -> PathBuf {
    let data = match std::env::var_os("XDG_DATA_HOME") {
        Some(d) if Path::new(&d).is_absolute() => PathBuf::from(d),
        _ => home_dir().join(".local").join("share"),
    };
    data.join("Trash")
}

fn home_dir() -> PathBuf {
    if let Some(h) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h);
    }
    // No $HOME: ask the password database.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_dir.is_null() {
            let dir = std::ffi::CStr::from_ptr((*pw).pw_dir);
            return PathBuf::from(std::ffi::OsStr::from_encoded_bytes_unchecked(dir.to_bytes()));
        }
    }
    PathBuf::from("/")
}

fn ensure_dirs(trash: &Path) -> io::Result<()> {
    let mut b = DirBuilder::new();
    b.recursive(true).mode(0o700);
    b.create(trash.join("files"))?;
    b.create(trash.join("info"))
}

/// $topdir/.Trash/$uid when the admin set up a shared, sticky .Trash; otherwise $topdir/.Trash-$uid.
fn topdir_trashes(topdir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let shared = topdir.join(".Trash");
    if let Ok(m) = fs::symlink_metadata(&shared)
        && m.is_dir()
        && m.mode() & 0o1000 != 0
    {
        out.push(shared.join(uid().to_string()));
    }
    out.push(topdir.join(format!(".Trash-{}", uid())));
    out
}

fn dev_of(p: &Path) -> Option<u64> {
    fs::metadata(p).ok().map(|m| m.dev())
}

/// Device of a folder that may not exist yet (a new user has no ~/.local/share): its nearest existing ancestor's.
fn dev_of_future(p: &Path) -> Option<u64> {
    let mut d = Some(p);
    while let Some(cur) = d {
        if let Some(dev) = dev_of(cur) {
            return Some(dev);
        }
        d = cur.parent();
    }
    None
}

/// Like encodeURIComponent, per path segment.
pub fn encode_path(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    for &b in p.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn decode_path(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = crate::platform::hex_byte(b[i + 1], b[i + 2])
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn local_tm(secs: u64) -> libc::tm {
    // time_t without naming it (its width differs between libcs).
    let t = secs as _;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    tm
}

/// Local time, as the spec asks: 2026-10-27T10:04:05.
fn local_date() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let tm = local_tm(now);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

/// "YYYY-MM-DDThh:mm:ss" in local time → Unix milliseconds.
pub fn parse_local_date(s: &str) -> Option<f64> {
    let s = s.trim();
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i32>().ok();
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = num(0, 4)? - 1900;
    tm.tm_mon = num(5, 7)? - 1;
    tm.tm_mday = num(8, 10)?;
    tm.tm_hour = num(11, 13)?;
    tm.tm_min = num(14, 16)?;
    tm.tm_sec = num(17, 19).unwrap_or(0);
    tm.tm_isdst = -1;
    let t = unsafe { libc::mktime(&mut tm) };
    (t != -1).then_some(t as f64 * 1000.0)
}

fn raw_code(e: &io::Error) -> i32 {
    e.raw_os_error().unwrap_or(0)
}

/// Reserve a unique name in info/ (O_EXCL, as the spec asks), then move the item into files/.
fn move_into(trash: &Path, p: &Path, stored: &str) -> io::Result<()> {
    ensure_dirs(trash)?;
    let base = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (stem, ext) = match base.rfind('.') {
        Some(k) if k > 0 => (&base[..k], &base[k..]),
        _ => (base.as_str(), ""),
    };
    for k in 1..10000 {
        let name = if k == 1 { base.clone() } else { format!("{stem}.{k}{ext}") };
        let info = trash.join("info").join(format!("{name}.trashinfo"));
        let mut f = match OpenOptions::new().write(true).create_new(true).mode(0o600).open(&info) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let written = f.write_all(
            format!("[Trash Info]\nPath={}\nDeletionDate={}\n", encode_path(stored), local_date()).as_bytes(),
        );
        drop(f);
        if let Err(e) = written.and_then(|_| fs::rename(p, trash.join("files").join(&name))) {
            let _ = fs::remove_file(&info);
            return Err(e);
        }
        return Ok(());
    }
    Err(io::Error::other("Too many items with this name in the Trash"))
}

/// Moves `p` to the Trash of its drive. Errors are worded for the UI.
pub fn trash_item(p: &str, mounts: &[Mount]) -> Result<(), String> {
    let p = super::resolve(p);
    let home = home_trash();
    let parent_dev = p.parent().and_then(dev_of);
    // Home trash when it lives on the same file system (rename can't cross devices).
    if parent_dev.is_some() && parent_dev == dev_of_future(&home) {
        match move_into(&home, &p, &p.to_string_lossy()) {
            Ok(()) => return Ok(()),
            Err(e) if raw_code(&e) == libc::EXDEV => {}
            Err(e) => return Err(crate::platform::describe_io(&e)),
        }
    }
    let ps = p.to_string_lossy();
    let topdir = mounts::mount_of(&ps, mounts).map_or("/".to_owned(), |m| m.mount.clone());
    let rel = Path::new(ps.as_ref())
        .strip_prefix(&topdir)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ps.to_string());
    let mut last: Option<io::Error> = None;
    for t in topdir_trashes(Path::new(&topdir)) {
        match move_into(&t, &p, &rel) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
    }
    Err(match last {
        Some(e) if matches!(raw_code(&e), libc::EACCES | libc::EROFS | libc::EPERM) => {
            "This drive has no Trash you can write to".into()
        }
        Some(e) => crate::platform::describe_io(&e),
        None => "No Trash on this drive".into(),
    })
}

/// Every item in the Trash folders that could hold `for_path`.
pub fn entries(for_path: &str) -> Vec<TrashEntry> {
    let mounts = mounts::read();
    let mut dirs: Vec<(PathBuf, Option<String>)> = vec![(home_trash(), None)];
    if !for_path.is_empty() {
        let p = super::resolve(for_path);
        if let Some(m) = mounts::mount_of(&p.to_string_lossy(), &mounts) {
            for t in topdir_trashes(Path::new(&m.mount)) {
                dirs.push((t, Some(m.mount.clone())));
            }
        }
    }
    let mut out = Vec::new();
    for (trash, topdir) in dirs {
        let Ok(rd) = fs::read_dir(trash.join("info")) else {
            continue;
        };
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for n in names {
            let Some(stem) = n.strip_suffix(".trashinfo") else {
                continue;
            };
            let info = trash.join("info").join(&n);
            let Ok(text) = fs::read_to_string(&info) else {
                continue;
            };
            let Some(path_line) = text.lines().find_map(|l| l.strip_prefix("Path=")) else {
                continue;
            };
            let mut original = decode_path(path_line.trim());
            if !original.starts_with('/') {
                original = Path::new(topdir.as_deref().unwrap_or("/")).join(original).to_string_lossy().into_owned();
            }
            let deleted_at =
                text.lines().find_map(|l| l.strip_prefix("DeletionDate=")).and_then(parse_local_date).unwrap_or(0.0);
            out.push(TrashEntry {
                info: info.to_string_lossy().into_owned(),
                data: trash.join("files").join(stem).to_string_lossy().into_owned(),
                original,
                deleted_at,
            });
        }
    }
    out
}

/// Puts an item back where it came from, given its .trashinfo file.
pub fn restore(info: &str) -> Result<String, String> {
    let info_path = Path::new(info);
    let text = fs::read_to_string(info_path).map_err(|e| crate::platform::describe_io(&e))?;
    let trash = info_path.parent().and_then(Path::parent).ok_or("Not a Trash entry")?;
    let stem = info_path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_suffix(".trashinfo"))
        .ok_or("Not a Trash entry")?;
    let path_line = text.lines().find_map(|l| l.strip_prefix("Path=")).ok_or("Not a Trash entry")?;
    let mut original = decode_path(path_line.trim());
    if !original.starts_with('/') {
        // A $topdir trash: $topdir/.Trash-$uid or $topdir/.Trash/$uid.
        let mut top = trash.parent().unwrap_or(Path::new("/"));
        if top.file_name().is_some_and(|n| n == ".Trash") {
            top = top.parent().unwrap_or(Path::new("/"));
        }
        original = top.join(original).to_string_lossy().into_owned();
    }
    let data = trash.join("files").join(stem);
    crate::platform::put_back(&data, Path::new(&original), info_path)?;
    Ok(original)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_encode_uri_component_per_segment() {
        assert_eq!(encode_path("/home/a b/caf\u{e9}%.txt"), "/home/a%20b/caf%C3%A9%25.txt");
        assert_eq!(decode_path("/home/a%20b/caf%C3%A9%25.txt"), "/home/a b/caf\u{e9}%.txt");
        assert_eq!(decode_path("100%"), "100%");
    }

    #[test]
    fn local_dates_round_trip() {
        let d = local_date();
        let t = parse_local_date(&d).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;
        assert!((t - now).abs() < 5000.0, "{d}");
    }
}
