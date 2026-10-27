//! Drives: mounted file systems, with sizes from statfs and hardware details from /sys/class/block.

use super::mounts::{self, Mount};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub struct FsStat {
    pub total: u64,
    pub free: u64,
    pub cluster: u64,
}

pub fn statfs(p: &str) -> Option<FsStat> {
    let c = std::ffi::CString::new(p).ok()?;
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let bsize = s.f_bsize as u64;
    Some(FsStat { total: s.f_blocks as u64 * bsize, free: s.f_bavail as u64 * bsize, cluster: bsize })
}

fn real(p: &str) -> Option<String> {
    fs::canonicalize(p).ok().map(|p| p.to_string_lossy().into_owned())
}

fn read_sys(p: &str) -> Option<String> {
    fs::read_to_string(p).ok().map(|s| s.trim().to_owned())
}

/// /sys/class/block/<dev> → the whole disk behind a partition, LVM volume or LUKS container.
fn disk_of(name: &str, depth: u32) -> Option<String> {
    if depth > 6 {
        return None;
    }
    let sys = format!("/sys/class/block/{name}");
    if let Ok(rd) = fs::read_dir(format!("{sys}/slaves")) {
        let mut slaves: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        slaves.sort();
        if let Some(first) = slaves.first() {
            return disk_of(first, depth + 1);
        }
    }
    if Path::new(&format!("{sys}/partition")).exists() {
        let r = fs::canonicalize(&sys).ok()?;
        return r.parent()?.file_name().map(|n| n.to_string_lossy().into_owned());
    }
    Path::new(&sys).exists().then(|| name.to_owned())
}

/// udev escapes characters in labels as \xHH.
fn unescape_label(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\'
            && i + 3 < b.len()
            && (b[i + 1] == b'x' || b[i + 1] == b'X')
            && let Some(v) = crate::platform::hex_byte(b[i + 2], b[i + 3])
        {
            out.push(v);
            i += 4;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn labels() -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(rd) = fs::read_dir("/dev/disk/by-label") {
        for e in rd.flatten() {
            let l = e.file_name().to_string_lossy().into_owned();
            if let Some(dev) = real(&format!("/dev/disk/by-label/{l}")) {
                map.insert(dev, unescape_label(&l));
            }
        }
    }
    map
}

struct Hardware {
    bus: Option<&'static str>,
    media: Option<&'static str>,
    removable: bool,
}

fn hardware(source: &str) -> Hardware {
    let mut res = Hardware { bus: None, media: None, removable: false };
    if !source.starts_with("/dev/") {
        return res;
    }
    let Some(dev) = real(source).and_then(|r| Path::new(&r).file_name().map(|n| n.to_string_lossy().into_owned()))
    else {
        return res;
    };
    let Some(disk) = disk_of(&dev, 0) else {
        return res;
    };
    let sys = format!("/sys/class/block/{disk}");
    let realp = real(&sys).unwrap_or_default();
    let has_segment = |prefix: &str| {
        realp
            .split('/')
            .any(|seg| seg.strip_prefix(prefix).is_some_and(|rest| rest.bytes().all(|b| b.is_ascii_digit())))
    };
    res.bus = if has_segment("usb") {
        Some("USB")
    } else if disk.starts_with("nvme") {
        Some("NVMe")
    } else if disk.starts_with("mmcblk") {
        Some("SD")
    } else if disk.starts_with("vd") || disk.starts_with("xvd") || realp.contains("/virtio") {
        Some("Virtual")
    } else if realp
        .split('/')
        .any(|seg| seg.strip_prefix("ata").is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit())))
    {
        Some("SATA")
    } else if disk.starts_with("sd") {
        Some("SCSI")
    } else {
        None
    };
    let rot = read_sys(&format!("{sys}/queue/rotational"));
    if rot.as_deref() == Some("0") && !matches!(res.bus, Some("Virtual" | "USB" | "SD")) {
        res.media = Some("SSD");
    } else if rot.as_deref() == Some("1") && res.bus != Some("Virtual") {
        res.media = Some("HDD");
    }
    res.removable =
        read_sys(&format!("{sys}/removable")).as_deref() == Some("1") || matches!(res.bus, Some("USB" | "SD"));
    res
}

fn fs_name(m: &Mount) -> String {
    let t = m.fstype.as_str();
    let stripped = t.strip_prefix("fuseblk").or_else(|| t.strip_prefix("fuse")).unwrap_or(t);
    let stripped = stripped.strip_prefix('.').unwrap_or(stripped);
    if stripped.is_empty() { t.to_owned() } else { stripped.to_owned() }
}

pub fn drives() -> Vec<Value> {
    let mounts = mounts::read();
    let by_label = labels();
    let mut seen = std::collections::HashSet::new();
    let mut drives: Vec<(String, Value)> = Vec::new();
    for m in &mounts {
        if !m.is_user_mount() || seen.contains(&format!("{}:{}", m.dev, m.root)) || seen.contains(&m.mount) {
            continue;
        }
        let Some(s) = statfs(&m.mount) else { continue };
        if s.total == 0 {
            continue;
        }
        seen.insert(format!("{}:{}", m.dev, m.root));
        seen.insert(m.mount.clone());
        let hw = if m.is_network() {
            Hardware { bus: Some("Network"), media: None, removable: false }
        } else {
            hardware(&m.source)
        };
        let label = real(&m.source).and_then(|r| by_label.get(&r).cloned());
        let kind = if m.is_network() {
            "Network"
        } else if hw.removable {
            "Removable"
        } else {
            "Fixed"
        };
        let d = json!({
            "letter": null,
            "root": m.mount,
            "label": label,
            "fs": fs_name(m),
            "total": s.total,
            "free": s.free,
            "kind": kind,
            "bus": hw.bus,
            "media": hw.media,
            "cluster": s.cluster,
            "system": m.mount == "/",
        });
        // Stacked mounts on the same point: the last one is what you see.
        match drives.iter_mut().find(|(root, _)| *root == m.mount) {
            Some(slot) => slot.1 = d,
            None => drives.push((m.mount.clone(), d)),
        }
    }
    drives.into_iter().map(|(_, d)| d).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_fs_names() {
        assert_eq!(unescape_label("My\\x20Disk"), "My Disk");
        let m = |t: &str| Mount {
            dev: String::new(),
            root: String::new(),
            mount: String::new(),
            fstype: t.into(),
            source: String::new(),
        };
        assert_eq!(fs_name(&m("ext4")), "ext4");
        assert_eq!(fs_name(&m("fuseblk")), "fuseblk");
        assert_eq!(fs_name(&m("fuse.sshfs")), "sshfs");
    }

    #[test]
    fn lists_at_least_the_root_file_system() {
        let d = drives();
        assert!(d.iter().all(|d| d["total"].as_u64().unwrap() > 0));
    }
}
