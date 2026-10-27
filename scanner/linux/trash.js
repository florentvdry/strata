// The freedesktop.org Trash (https://specifications.freedesktop.org/trash-spec/latest/), used by GNOME, KDE,
// Xfce and the rest. Shared by the Linux scanner (moving to Trash) and the main process (History › Restore).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readMounts, mountOf } = require('./mounts');

const uid = () => (process.getuid ? process.getuid() : 0);

function homeTrash() {
  const data = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'Trash');
}

function ensureDirs(trash) {
  fs.mkdirSync(path.join(trash, 'files'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(trash, 'info'), { recursive: true, mode: 0o700 });
}

// $topdir/.Trash/$uid when the admin set up a shared, sticky .Trash; otherwise $topdir/.Trash-$uid.
function topdirTrashes(topdir) {
  const out = [];
  const shared = path.join(topdir, '.Trash');
  try {
    const s = fs.lstatSync(shared);
    if (s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o1000)) out.push(path.join(shared, String(uid())));
  } catch { /* none */ }
  out.push(path.join(topdir, `.Trash-${uid()}`));
  return out;
}

function devOf(p) {
  try { return fs.statSync(p).dev; } catch { return -1; }
}

// Device of a folder that may not exist yet (a new user has no ~/.local/share): its nearest existing ancestor's.
function devOfFuture(p) {
  for (let d = p; ; d = path.dirname(d)) {
    const dev = devOf(d);
    if (dev >= 0 || d === path.dirname(d)) return dev;
  }
}

// Paths in .trashinfo files are URL-encoded; the home trash stores absolute paths, a topdir trash relative ones.
function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

function localDate(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

// Reserve a unique name in info/ (O_EXCL, as the spec asks), then move the item into files/.
function moveInto(trash, p, stored) {
  ensureDirs(trash);
  const base = path.basename(p);
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  for (let k = 1; k < 10000; k++) {
    const name = k === 1 ? base : `${stem}.${k}${ext}`;
    const info = path.join(trash, 'info', name + '.trashinfo');
    let fd;
    try { fd = fs.openSync(info, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try { fs.writeSync(fd, `[Trash Info]\nPath=${encodePath(stored)}\nDeletionDate=${localDate()}\n`); } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(p, path.join(trash, 'files', name));
      return;
    } catch (e) {
      fs.rmSync(info, { force: true });
      throw e;
    }
  }
  throw new Error('Too many items with this name in the Trash');
}

function trashItem(p, mounts = readMounts()) {
  p = path.resolve(p);
  const home = homeTrash();
  const parentDev = devOf(path.dirname(p));
  // Home trash when it lives on the same file system (rename can't cross devices).
  if (parentDev >= 0 && parentDev === devOfFuture(home)) {
    try { return moveInto(home, p, p); } catch (e) { if (e.code !== 'EXDEV') throw e; }
  }
  const m = mountOf(p, mounts);
  const topdir = m ? m.mount : '/';
  let last = null;
  for (const t of topdirTrashes(topdir)) {
    try { return moveInto(t, p, path.relative(topdir, p)); } catch (e) { last = e; }
  }
  const err = new Error(last && (last.code === 'EACCES' || last.code === 'EROFS') ? 'This drive has no Trash you can write to' : (last ? last.message : 'No Trash on this drive'));
  err.code = last && last.code;
  throw err;
}

// Every item in the Trash folders that could hold `forPath`: { info, data, original, deletedAt }.
function trashEntries(forPath) {
  const mounts = readMounts();
  const dirs = [{ trash: homeTrash(), topdir: null }];
  const m = forPath ? mountOf(path.resolve(forPath), mounts) : null;
  if (m) for (const t of topdirTrashes(m.mount)) dirs.push({ trash: t, topdir: m.mount });
  const out = [];
  for (const { trash, topdir } of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(trash, 'info')); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.trashinfo')) continue;
      try {
        const text = fs.readFileSync(path.join(trash, 'info', n), 'utf8');
        const pm = /^Path=(.*)$/m.exec(text), dm = /^DeletionDate=(.*)$/m.exec(text);
        if (!pm) continue;
        let original = decodeURIComponent(pm[1].trim());
        if (!path.isAbsolute(original)) original = path.join(topdir || '/', original);
        const deletedAt = dm ? new Date(dm[1].trim()).getTime() : 0;
        out.push({ info: path.join(trash, 'info', n), data: path.join(trash, 'files', n.slice(0, -10)), original, deletedAt });
      } catch { /* unreadable entry */ }
    }
  }
  return out;
}

module.exports = { trashItem, trashEntries, homeTrash };
