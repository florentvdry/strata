// Mounted file systems, from /proc/self/mountinfo. Shared by the Linux scanner and the main process.
'use strict';
const fs = require('fs');

// Pseudo and virtual file systems: never shown as drives, never scanned into.
const VIRTUAL = new Set(['proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'ramfs', 'cgroup', 'cgroup2', 'pstore', 'bpf', 'securityfs',
  'debugfs', 'tracefs', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs', 'autofs', 'binfmt_misc', 'efivarfs', 'rpc_pipefs', 'nsfs',
  'overlay', 'squashfs', 'iso9660', 'udf', 'fuse.portal', 'fuse.gvfsd-fuse', 'fuse.snapfuse', 'fuse.lxcfs', 'fuse.xdg-document-portal']);
const NETWORK = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'fuse.sshfs', '9p', 'afs', 'ceph', 'glusterfs', 'fuse.rclone']);
// Places where the system mounts things that aren't user drives (EFI partitions, snaps, containers).
const HIDDEN_PREFIXES = ['/boot', '/efi', '/snap', '/var/snap', '/var/lib/docker', '/var/lib/containers', '/var/lib/snapd', '/proc', '/sys', '/dev', '/run', '/tmp'];
const USER_RUN = /^\/run\/media\//; // udisks mounts removable drives here on Fedora, Arch, openSUSE…

// mountinfo escapes space, tab, newline and backslash as octal.
function unescape(s) {
  return s.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
}

function readMounts() {
  let text = '';
  try { text = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    const dash = parts.indexOf('-', 6);
    if (dash < 0) continue;
    out.push({
      dev: parts[2],
      root: unescape(parts[3]),
      mount: unescape(parts[4]),
      fstype: parts[dash + 1],
      source: unescape(parts[dash + 2] || ''),
    });
  }
  return out;
}

function isUnder(p, dir) {
  return dir === '/' ? p.startsWith('/') : p === dir || p.startsWith(dir + '/');
}

// The mount a path lives on: the longest mount point containing it (the last one wins when stacked).
function mountOf(p, mounts = readMounts()) {
  let best = null;
  for (const m of mounts) if (isUnder(p, m.mount) && (!best || m.mount.length >= best.mount.length)) best = m;
  return best;
}

const isVirtual = (m) => VIRTUAL.has(m.fstype);
const isNetwork = (m) => NETWORK.has(m.fstype);
const isUserMount = (m) => !isVirtual(m) && (USER_RUN.test(m.mount) || !HIDDEN_PREFIXES.some((p) => isUnder(m.mount, p)));

module.exports = { readMounts, mountOf, isUnder, isVirtual, isNetwork, isUserMount };
