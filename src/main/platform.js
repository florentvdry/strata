// What differs between Windows and Linux in the main process: paths, wording and protected locations.
// Everything that touches the disk (scanning, Recycle Bin / Trash, restoring) is in the scanner (scanner/, Rust).
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';

// Paths are case-insensitive on Windows only.
const fold = IS_WIN ? (s) => s.toLowerCase() : (s) => s;

const SCANNER_NAME = IS_WIN ? 'strata-scan.exe' : 'strata-scan';

const LABELS = IS_WIN
  ? { show: 'Show in Explorer', trash: 'Move to Recycle Bin', bin: 'Recycle Bin' }
  : { show: 'Show in file manager', trash: 'Move to Trash', bin: 'Trash' };

// Drives in the order people expect: by letter on Windows, by mount point on Linux.
function sortDrives(drives) {
  return drives.sort((a, b) => (IS_WIN ? a.letter.localeCompare(b.letter) : a.root.localeCompare(b.root)));
}

// Places that are never deleted as a whole. `info` is the scanner's info message (drives, Trash folders).
function protectedPaths(info) {
  const env = process.env;
  if (!IS_WIN) {
    const home = os.homedir();
    const list = ['/home', '/root', '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/boot', '/var', '/var/lib', '/opt',
      '/srv', '/media', '/mnt', '/run', '/tmp', '/var/tmp', '/proc', '/sys', '/dev', '/snap', home, path.join(home, '.config'),
      path.join(home, '.local'), path.join(home, '.local', 'share'), path.join(home, '.cache')];
    if (info) list.push(...(info.trashDirs || []), ...info.drives.map((d) => d.root)); // the Trash, mount points
    return list.map((p) => path.resolve(p));
  }
  const list = [env.WINDIR, env.SystemRoot && path.join(env.SystemRoot, 'System32'), env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData,
    env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, path.join(env.SystemDrive || 'C:', 'Users'), path.join(env.LOCALAPPDATA || '', 'Temp')];
  return list.filter(Boolean).map((p) => path.resolve(p).toLowerCase());
}

function isDriveRoot(resolved) {
  return IS_WIN ? /^[a-z]:\\?$/i.test(resolved) : resolved === '/';
}

module.exports = { IS_WIN, fold, SCANNER_NAME, LABELS, sortDrives, protectedPaths, isDriveRoot };
