//! What differs between Windows and Linux in the app: paths, wording and protected locations.
//! Everything that touches the disk (scanning, Recycle Bin / Trash, restoring) is in the scanner (scanner/).
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub const IS_WIN: bool = cfg!(windows);

/// Paths are case-insensitive on Windows only.
pub fn fold(s: &str) -> String {
    if IS_WIN { s.to_lowercase() } else { s.to_string() }
}

pub fn scanner_name() -> &'static str {
    if IS_WIN { "strata-scan.exe" } else { "strata-scan" }
}

pub fn bin_label() -> &'static str {
    if IS_WIN { "Recycle Bin" } else { "Trash" }
}

/// Drives in the order people expect: by letter on Windows, by mount point on Linux.
pub fn sort_drives(drives: &mut [Value]) {
    let key = |d: &Value| -> String {
        let field = if IS_WIN { "letter" } else { "root" };
        d.get(field).and_then(Value::as_str).unwrap_or("").to_string()
    };
    drives.sort_by_key(key);
}

/// Absolute path with `.` and `..` resolved by name only (no disk access), like Node's `path.resolve`.
pub fn clean(p: &str) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| PathBuf::from(p));
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                if !matches!(out.components().next_back(), Some(Component::RootDir | Component::Prefix(_)) | None) {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn resolved(p: &str) -> String {
    let s = clean(p).to_string_lossy().into_owned();
    // `C:\` keeps its separator; anything else loses a trailing one.
    if s.len() > 3 { s.trim_end_matches(['\\', '/']).to_string() } else { s }
}

pub fn is_drive_root(resolved: &str) -> bool {
    if IS_WIN {
        let b = resolved.as_bytes();
        (b.len() == 2 || (b.len() == 3 && b[2] == b'\\')) && b[0].is_ascii_alphabetic() && b[1] == b':'
    } else {
        resolved == "/"
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}

/// Places that are never deleted as a whole. `info` is the scanner's info message (drives, Trash folders).
pub fn protected_paths(info: Option<&Value>) -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    if !IS_WIN {
        let home = env("HOME").unwrap_or_else(|| "/root".into());
        list.extend(
            [
                "/home", "/root", "/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot",
                "/var", "/var/lib", "/opt", "/srv", "/media", "/mnt", "/run", "/tmp", "/var/tmp", "/proc", "/sys",
                "/dev", "/snap",
            ]
            .map(String::from),
        );
        for sub in ["", ".config", ".local", ".local/share", ".cache"] {
            list.push(Path::new(&home).join(sub).to_string_lossy().into_owned());
        }
        if let Some(info) = info {
            for t in info.get("trashDirs").and_then(Value::as_array).into_iter().flatten() {
                list.extend(t.as_str().map(String::from));
            }
            for d in info.get("drives").and_then(Value::as_array).into_iter().flatten() {
                list.extend(d.get("root").and_then(Value::as_str).map(String::from));
            }
        }
        return list.iter().map(|p| resolved(p)).collect();
    }
    let join = |a: Option<String>, b: &str| a.map(|a| Path::new(&a).join(b).to_string_lossy().into_owned());
    let sys_drive = env("SystemDrive").unwrap_or_else(|| "C:".into());
    list.extend(
        [
            env("WINDIR"),
            join(env("SystemRoot"), "System32"),
            env("ProgramFiles"),
            env("ProgramFiles(x86)"),
            env("ProgramData"),
            env("USERPROFILE"),
            env("APPDATA"),
            env("LOCALAPPDATA"),
            Some(format!("{sys_drive}\\Users")),
            Some(Path::new(&env("LOCALAPPDATA").unwrap_or_default()).join("Temp").to_string_lossy().into_owned()),
        ]
        .into_iter()
        .flatten(),
    );
    list.iter().map(|p| fold(&resolved(p))).collect()
}

pub fn is_protected(p: &str, info: Option<&Value>) -> bool {
    let r = fold(&resolved(p));
    if is_drive_root(&r) {
        return true;
    }
    protected_paths(info).iter().any(|x| fold(x) == r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn resolves_and_protects() {
        assert_eq!(resolved("/home/me/../me/./x/"), "/home/me/x");
        assert!(is_protected("/usr/", None));
        assert!(is_protected("/", None));
        assert!(!is_protected("/home/me/Downloads/x.iso", None));
        let info = serde_json::json!({"trashDirs": ["/home/me/.local/share/Trash"], "drives": [{"root": "/mnt/data"}]});
        assert!(is_protected("/mnt/data", Some(&info)));
        assert!(is_protected("/home/me/.local/share/Trash/", Some(&info)));
    }

    #[test]
    fn sorts_drives() {
        let mut d =
            vec![serde_json::json!({"letter": "D", "root": "/b"}), serde_json::json!({"letter": "C", "root": "/a"})];
        sort_drives(&mut d);
        let first = if IS_WIN { "C" } else { "/a" };
        assert_eq!(d[0].get(if IS_WIN { "letter" } else { "root" }).unwrap(), first);
    }
}
