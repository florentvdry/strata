//! Mounted file systems, from /proc/self/mountinfo.

/// Pseudo and virtual file systems: never shown as drives, never scanned into.
const VIRTUAL: &[&str] = &[
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "tmpfs",
    "ramfs",
    "cgroup",
    "cgroup2",
    "pstore",
    "bpf",
    "securityfs",
    "debugfs",
    "tracefs",
    "configfs",
    "fusectl",
    "mqueue",
    "hugetlbfs",
    "autofs",
    "binfmt_misc",
    "efivarfs",
    "rpc_pipefs",
    "nsfs",
    "overlay",
    "squashfs",
    "iso9660",
    "udf",
    "fuse.portal",
    "fuse.gvfsd-fuse",
    "fuse.snapfuse",
    "fuse.lxcfs",
    "fuse.xdg-document-portal",
];
const NETWORK: &[&str] =
    &["nfs", "nfs4", "cifs", "smb3", "smbfs", "fuse.sshfs", "9p", "afs", "ceph", "glusterfs", "fuse.rclone"];
/// Places where the system mounts things that aren't user drives (EFI partitions, snaps, containers).
const HIDDEN_PREFIXES: &[&str] = &[
    "/boot",
    "/efi",
    "/snap",
    "/var/snap",
    "/var/lib/docker",
    "/var/lib/containers",
    "/var/lib/snapd",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/tmp",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Mount {
    pub dev: String,
    pub root: String,
    pub mount: String,
    pub fstype: String,
    pub source: String,
}

impl Mount {
    pub fn is_virtual(&self) -> bool {
        VIRTUAL.contains(&self.fstype.as_str())
    }

    pub fn is_network(&self) -> bool {
        NETWORK.contains(&self.fstype.as_str())
    }

    /// A drive the user would recognize; udisks mounts removable drives under /run/media.
    pub fn is_user_mount(&self) -> bool {
        !self.is_virtual()
            && (self.mount.starts_with("/run/media/") || !HIDDEN_PREFIXES.iter().any(|p| is_under(&self.mount, p)))
    }
}

/// mountinfo escapes space, tab, newline and backslash as \ooo.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            out.push(((b[i + 1] - b'0') << 6) | ((b[i + 2] - b'0') << 3) | (b[i + 3] - b'0'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse(text: &str) -> Vec<Mount> {
    let mut out = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split(' ').collect();
        let Some(dash) = parts.iter().skip(6).position(|p| *p == "-").map(|k| k + 6) else {
            continue;
        };
        if parts.len() < 5 || dash + 1 >= parts.len() {
            continue;
        }
        out.push(Mount {
            dev: parts[2].to_owned(),
            root: unescape(parts[3]),
            mount: unescape(parts[4]),
            fstype: parts[dash + 1].to_owned(),
            source: unescape(parts.get(dash + 2).copied().unwrap_or("")),
        });
    }
    out
}

pub fn read() -> Vec<Mount> {
    std::fs::read_to_string("/proc/self/mountinfo").map(|t| parse(&t)).unwrap_or_default()
}

pub fn is_under(p: &str, dir: &str) -> bool {
    if dir == "/" {
        p.starts_with('/')
    } else {
        p == dir || (p.starts_with(dir) && p.as_bytes().get(dir.len()) == Some(&b'/'))
    }
}

/// The mount a path lives on: the longest mount point containing it (the last one wins when stacked).
pub fn mount_of<'a>(p: &str, mounts: &'a [Mount]) -> Option<&'a Mount> {
    let mut best: Option<&Mount> = None;
    for m in mounts {
        if is_under(p, &m.mount) && best.is_none_or(|b| m.mount.len() >= b.mount.len()) {
            best = Some(m);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
23 22 0:5 / /proc rw shared:2 - proc proc rw
24 22 8:3 / /home/me/My\\040Drive rw - ext4 /dev/sda3 rw
25 22 0:40 / /run/media/me/USB rw - vfat /dev/sdb1 rw
26 22 0:41 / /boot/efi rw - vfat /dev/sda1 rw
27 22 0:42 / /mnt/share rw shared:9 master:1 - cifs //server/share rw
";

    #[test]
    fn parses_mountinfo() {
        let m = parse(SAMPLE);
        assert_eq!(m.len(), 6);
        assert_eq!(m[2].mount, "/home/me/My Drive");
        assert_eq!(m[5].fstype, "cifs");
        assert_eq!(m[5].source, "//server/share");
        assert!(m[1].is_virtual());
        assert!(m[3].is_user_mount());
        assert!(!m[4].is_user_mount());
        assert!(m[5].is_network());
        assert_eq!(mount_of("/home/me/My Drive/x", &m).unwrap().mount, "/home/me/My Drive");
        assert_eq!(mount_of("/home/me/My Drivex", &m).unwrap().mount, "/");
    }
}
