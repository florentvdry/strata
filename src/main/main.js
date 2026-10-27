// Strata — Electron main process: window, scanner process, files, settings and history.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const readline = require('readline');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const IS_WIN = process.platform === 'win32';
// Windows: StrataScan.exe (C#). Linux: scanner/linux/strata-scan.js, run by Electron's own Node.js.
const SCANNER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'scanner') : path.join(ROOT, 'scanner', 'linux');
const SCANNER = IS_WIN
  ? (app.isPackaged ? path.join(process.resourcesPath, 'StrataScan.exe') : path.join(ROOT, 'bin', 'StrataScan.exe'))
  : path.join(SCANNER_DIR, 'strata-scan.js');
const trash = IS_WIN ? null : require(path.join(SCANNER_DIR, 'trash.js'));
// Paths are case-insensitive on Windows only.
const fold = IS_WIN ? (s) => s.toLowerCase() : (s) => s;

// The portable build keeps its data next to the .exe; STRATA_DATA_DIR overrides both (used for screenshots).
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR;
if (process.env.STRATA_DATA_DIR) app.setPath('userData', process.env.STRATA_DATA_DIR);
else if (PORTABLE_DIR) app.setPath('userData', path.join(PORTABLE_DIR, 'Strata Data'));
const DATA = app.getPath('userData');
const SCANS = path.join(DATA, 'scans');
const SETTINGS = path.join(DATA, 'settings.json');
const RECENT = path.join(SCANS, 'index.json');
const HISTORY = path.join(DATA, 'history.json');
const MAX_RECENT = 8;
const HISTORY_DAYS = 7;

let win = null;

// ───────────── small JSON stores ─────────────

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
  accent: '#C6F432',
  shading: true,
  scan: { mft: true, hidden: true, links: false },
  view: 'treemap',
};
function getSettings() {
  const s = readJson(SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...s, scan: { ...DEFAULT_SETTINGS.scan, ...(s.scan || {}) } };
}

// ───────────── window ─────────────

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0E1014',
    title: 'Strata',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r' && !app.isPackaged) win.webContents.reload();
  });
  // Never navigate away from the app; open external links in the browser.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ───────────── scanner helper ─────────────

function runHelper(args, onLine, onSpawn) {
  return new Promise((resolve, reject) => {
    const proc = IS_WIN
      ? spawn(SCANNER, args, { windowsHide: true })
      : spawn(process.execPath, [SCANNER, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } });
    if (onSpawn) onSpawn(proc);
    const rl = readline.createInterface({ input: proc.stdout });
    let err = '';
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try { onLine(JSON.parse(line), proc); } catch (e) { /* ignore malformed */ }
    });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `Scanner exited with code ${code}`))));
  });
}

let driveCache = null;
async function getInfo(force) {
  if (driveCache && !force && Date.now() - driveCache.at < 8000) return driveCache.value;
  let value = { admin: false, drives: [] };
  await runHelper(['info'], (msg) => { if (msg.type === 'info') value = msg; });
  value.drives.sort((a, b) => (IS_WIN ? a.letter.localeCompare(b.letter) : a.root.localeCompare(b.root)));
  driveCache = { at: Date.now(), value };
  return value;
}

// ───────────── scans ─────────────

let current = null; // { proc, id, root, options, out, done, snapshotWaiters }

function recentList() {
  const list = readJson(RECENT, []);
  return list.filter((r) => fs.existsSync(path.join(SCANS, r.file)));
}

function addRecent(entry) {
  let list = readJson(RECENT, []);
  const same = list.filter((r) => fold(r.root) === fold(entry.root));
  list = list.filter((r) => fold(r.root) !== fold(entry.root));
  for (const r of same) removeScanFiles(r.file);
  list.unshift(entry);
  for (const r of list.slice(MAX_RECENT)) removeScanFiles(r.file);
  list = list.slice(0, MAX_RECENT);
  writeJson(RECENT, list);
}

function removeScanFiles(file) {
  for (const f of [file, file.replace(/\.strata$/, '.dupes.json')]) {
    try { fs.unlinkSync(path.join(SCANS, f)); } catch { /* already gone */ }
  }
}

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    const len = head.readInt32LE(8);
    const json = Buffer.alloc(len);
    fs.readSync(fd, json, 0, len, 12);
    return JSON.parse(json.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

ipcMain.handle('scan:start', async (e, { root, options }) => {
  if (current && current.proc) { try { current.proc.kill(); } catch { /* gone */ } }
  fs.mkdirSync(SCANS, { recursive: true });
  const id = Date.now().toString(36);
  const out = path.join(SCANS, `${id}.strata`);
  const args = ['scan', root, out];
  if (options.mft && !options.links) args.push('--mft');
  if (options.hidden) args.push('--hidden');
  if (options.links) args.push('--links');
  const scan = { id, root, options, out, proc: null, done: false, snapshotWaiters: [], startedAt: Date.now() };
  current = scan;
  const p = runHelper(args, (msg) => {
    if (msg.type === 'snapshot') {
      const w = scan.snapshotWaiters.shift();
      if (w) w(msg);
      return;
    }
    if (msg.type === 'progress' && current === scan && win) {
      win.setProgressBar(Math.max(0.01, msg.pct || 0), { mode: msg.phase === 'paused' ? 'paused' : 'normal' });
    }
    if (msg.type === 'done') {
      scan.done = true;
      if (win) win.setProgressBar(-1);
      try {
        const h = readHeader(out);
        addRecent({ id, root: h.root, file: path.basename(out), scannedAt: h.scannedAt, bytes: h.bytes, files: h.files, dirs: h.dirs, method: h.method, duration: h.duration, partial: h.partial });
      } catch (err) { /* reported below */ }
    }
    if (current === scan) send('scan:event', { id, ...msg });
  }, (proc) => { scan.proc = proc; });
  p.catch((err) => { if (current === scan && !scan.cancelled) send('scan:event', { id, type: 'error', message: err.message }); })
    .finally(() => {
      if (current === scan) current.proc = null;
      if (win && (current === scan || !current)) win.setProgressBar(-1);
    });
  return { id };
});

function writeCmd(cmd) {
  if (current && current.proc && !current.done) current.proc.stdin.write(cmd + '\n');
}
ipcMain.handle('scan:pause', () => writeCmd('pause'));
ipcMain.handle('scan:resume', () => writeCmd('resume'));
ipcMain.handle('scan:cancel', () => {
  if (!current) return;
  current.cancelled = true;
  if (current.proc) { try { current.proc.kill(); } catch { /* gone */ } }
  if (win) win.setProgressBar(-1);
  const out = current.out;
  setTimeout(() => { for (const f of [out, out + '.part']) fs.unlink(f, () => {}); }, 400);
  current = null;
});
ipcMain.handle('scan:snapshot', async () => {
  if (!current || !current.proc || current.done) return null;
  const file = path.join(SCANS, `${current.id}.partial.strata`);
  const scan = current;
  const result = await new Promise((resolve) => {
    scan.snapshotWaiters.push(resolve);
    scan.proc.stdin.write(`snapshot ${file}\n`);
    setTimeout(() => resolve({ error: 'timeout' }), 30000);
  });
  if (result.error) throw new Error(result.error);
  return fs.readFileSync(file);
});
ipcMain.handle('scan:load', async (e, id) => {
  const entry = recentList().find((r) => r.id === id);
  if (!entry) throw new Error('This scan is no longer available.');
  return fsp.readFile(path.join(SCANS, entry.file));
});
ipcMain.handle('scan:recent', () => recentList());
ipcMain.handle('scan:clearRecent', () => {
  for (const r of readJson(RECENT, [])) removeScanFiles(r.file);
  writeJson(RECENT, []);
});

// ───────────── duplicates ─────────────

let dupesProc = null;
ipcMain.handle('dupes:find', async (e, { id, groups }) => {
  const cache = path.join(SCANS, `${id}.dupes.json`);
  const cached = readJson(cache, null);
  if (cached) return cached;
  if (dupesProc) { try { dupesProc.kill(); } catch { /* gone */ } }
  const list = path.join(os.tmpdir(), `strata-dupes-${id}.txt`);
  const lines = [];
  for (const g of groups) for (const p of g.paths) lines.push(`${g.size}\t${p}`);
  fs.writeFileSync(list, lines.join('\n'), 'utf8');
  const found = [];
  try {
    await runHelper(['dupes', list], (msg) => {
      if (msg.type === 'group') found.push({ size: msg.size, verified: msg.verified, paths: msg.paths });
      else if (msg.type === 'progress') send('dupes:progress', { id, done: msg.done, total: msg.total });
    }, (proc) => { dupesProc = proc; });
  } finally {
    dupesProc = null;
    fs.unlink(list, () => {});
  }
  if (fs.existsSync(path.join(SCANS, `${id}.strata`))) writeJson(cache, found);
  return found;
});

// ───────────── files ─────────────

function protectedPaths() {
  const env = process.env;
  if (!IS_WIN) {
    const home = os.homedir();
    const list = ['/home', '/root', '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/boot', '/var', '/var/lib', '/opt',
      '/srv', '/media', '/mnt', '/run', '/tmp', '/var/tmp', '/proc', '/sys', '/dev', '/snap', home, path.join(home, '.config'),
      path.join(home, '.local'), path.join(home, '.local', 'share'), path.join(home, '.cache'), trash.homeTrash()];
    for (const d of (driveCache && driveCache.value.drives) || []) list.push(d.root); // mount points
    return list.map((p) => path.resolve(p));
  }
  const list = [env.WINDIR, env.SystemRoot && path.join(env.SystemRoot, 'System32'), env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData,
    env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, path.join(env.SystemDrive || 'C:', 'Users'), path.join(env.LOCALAPPDATA || '', 'Temp')];
  return list.filter(Boolean).map((p) => path.resolve(p).toLowerCase());
}

function isProtected(p) {
  const r = fold(path.resolve(p));
  if (IS_WIN ? /^[a-z]:\\?$/.test(r) : r === '/') return true; // drive roots
  return protectedPaths().includes(r);
}

// Turn delete targets into concrete paths. "contentsOnly" targets (temp folders, caches) keep the folder itself.
async function expandTargets(targets) {
  const paths = [];
  const owner = [];
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    if (target.contentsOnly) {
      let entries = [];
      try { entries = await fsp.readdir(target.path); } catch { /* missing */ }
      for (const name of entries) { paths.push(path.join(target.path, name)); owner.push(t); }
    } else {
      if (isProtected(target.path)) continue;
      paths.push(target.path);
      owner.push(t);
    }
  }
  return { paths, owner };
}

ipcMain.handle('fs:delete', async (e, { targets, permanent }) => {
  const { paths, owner } = await expandTargets(targets);
  const results = targets.map((t) => ({ path: t.path, ok: true, remaining: 0, errors: 0, error: null, protected: !t.contentsOnly && isProtected(t.path) }));
  for (const r of results) if (r.protected) { r.ok = false; r.error = 'Protected system location'; r.remaining = -1; }
  if (paths.length) {
    const list = path.join(os.tmpdir(), `strata-delete-${Date.now()}.txt`);
    fs.writeFileSync(list, paths.join('\n'), 'utf8');
    const index = new Map(paths.map((p, i) => [p, i]));
    try {
      await runHelper(['delete', list, permanent ? 'permanent' : 'recycle'], (msg) => {
        if (msg.type === 'progress') send('fs:progress', { done: msg.done, total: msg.total, current: msg.current });
        if (msg.type === 'result') {
          const i = index.get(msg.path);
          if (i === undefined) return;
          const r = results[owner[i]];
          if (!msg.ok) { r.ok = false; r.errors++; r.remaining += msg.remaining; r.error = r.error || msg.error; }
        }
      });
    } finally { fs.unlink(list, () => {}); }
  }
  // History: what went where, for the 7-day list in Settings › History.
  const now = Date.now();
  const hist = pruneHistory(readJson(HISTORY, []));
  targets.forEach((t, i) => {
    const r = results[i];
    if (r.protected) return;
    hist.unshift({ id: `${now.toString(36)}-${i}`, path: t.path, name: t.name || path.basename(t.path), size: Math.max(0, (t.size || 0) - Math.max(0, r.remaining)), contentsOnly: !!t.contentsOnly, permanent: !!permanent, at: now, ok: r.ok });
  });
  writeJson(HISTORY, hist.slice(0, 500));
  return results;
});

ipcMain.handle('fs:stat', async (e, p) => {
  try { const s = await fsp.stat(p); return { isDir: s.isDirectory(), size: s.size }; } catch { return null; }
});
ipcMain.handle('fs:exists', async (e, p) => fs.existsSync(p));
ipcMain.handle('shell:show', (e, p) => {
  if (fs.existsSync(p)) shell.showItemInFolder(p);
  else shell.openPath(path.dirname(p));
});
ipcMain.handle('shell:open', (e, p) => shell.openPath(p));
ipcMain.handle('clipboard:write', (e, text) => clipboard.writeText(text));
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to map', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// Native right-click menu for a node in the map or tree. Resolves with the chosen action id.
ipcMain.handle('menu:node', (e, spec) => new Promise((resolve) => {
  let chosen = null;
  const item = (id, label, extra = {}) => ({ label, click: () => { chosen = id; }, ...extra });
  const template = [
    ...(spec.isDir ? [item('zoom', 'Zoom in', { enabled: !!spec.canZoom })] : [item('open', 'Open')]),
    item('show', IS_WIN ? 'Show in Explorer' : 'Show in file manager'),
    item('copy', 'Copy path'),
    { type: 'separator' },
    item('cleanup', spec.inCleanup ? 'Remove from cleanup' : 'Add to cleanup', { enabled: !spec.isRoot }),
    item('trash', IS_WIN ? 'Move to Recycle Bin' : 'Move to Trash', { enabled: !spec.isRoot }),
  ];
  Menu.buildFromTemplate(template).popup({ window: win, callback: () => resolve(chosen) });
}));

// ───────────── history & restore ─────────────

function pruneHistory(list) {
  const cutoff = Date.now() - HISTORY_DAYS * 864e5;
  return list.filter((h) => h.at >= cutoff);
}

// Recycle Bin entries: $I files hold the original path, $R files the content.
async function recycleEntries(drive) {
  const bin = `${drive}\\$Recycle.Bin`;
  const out = [];
  let sids = [];
  try { sids = await fsp.readdir(bin); } catch { return out; }
  for (const sid of sids) {
    const dir = path.join(bin, sid);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('$I')) continue;
      try {
        const b = await fsp.readFile(path.join(dir, n));
        const version = b.readBigInt64LE(0);
        let original;
        if (version === 2n) { const len = b.readInt32LE(24); original = b.toString('utf16le', 28, 28 + (len - 1) * 2); }
        else original = b.toString('utf16le', 24, 24 + 520).replace(/\0.*$/s, '');
        const deletedAt = Number((b.readBigInt64LE(16) - 116444736000000000n) / 10000n);
        out.push({ info: path.join(dir, n), data: path.join(dir, '$R' + n.slice(2)), original, deletedAt });
      } catch { /* unreadable entry */ }
    }
  }
  return out;
}

async function inBin(h) {
  // Linux: the freedesktop.org Trash (.trashinfo files say where each item came from).
  const entries = IS_WIN ? await recycleEntries(h.path.slice(0, 2)) : trash.trashEntries(h.path);
  const want = fold(h.path);
  return entries.filter((en) => {
    const o = fold(en.original);
    return h.contentsOnly ? path.dirname(o) === want : o === want;
  }).filter((en) => Math.abs(en.deletedAt - h.at) < 10 * 60 * 1000);
}

ipcMain.handle('history:list', async () => {
  const hist = pruneHistory(readJson(HISTORY, []));
  writeJson(HISTORY, hist);
  for (const h of hist) {
    h.restorable = false;
    if (!h.permanent && !h.restored) {
      try { h.restorable = (await inBin(h)).length > 0; } catch { /* no access */ }
    }
  }
  return hist;
});

ipcMain.handle('history:restore', async (e, id) => {
  const hist = readJson(HISTORY, []);
  const h = hist.find((x) => x.id === id);
  if (!h) throw new Error('Not found in history');
  const entries = await inBin(h);
  if (!entries.length) throw new Error('The item is no longer in the Recycle Bin.');
  let restored = 0;
  for (const en of entries) {
    if (fs.existsSync(en.original)) continue;
    await fsp.mkdir(path.dirname(en.original), { recursive: true });
    await fsp.rename(en.data, en.original);
    await fsp.unlink(en.info).catch(() => {});
    restored++;
  }
  h.restored = true;
  writeJson(HISTORY, hist);
  return restored;
});

ipcMain.handle('history:clear', () => writeJson(HISTORY, []));

// ───────────── app ─────────────

ipcMain.handle('app:info', async () => {
  let admin = false;
  try { admin = (await getInfo()).admin; } catch { /* scanner missing */ }
  return { admin, version: app.getVersion(), user: os.userInfo().username, home: os.homedir(), temp: os.tmpdir(), platform: process.platform };
});
ipcMain.handle('drives:list', async (e, force) => (await getInfo(force)).drives);
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (e, patch) => {
  const s = { ...getSettings(), ...patch };
  writeJson(SETTINGS, s);
  return s;
});

// Relaunch elevated (for the MFT fast scan). The current instance quits once UAC is accepted.
ipcMain.handle('app:relaunchAdmin', async (e, pending) => {
  if (!IS_WIN) return false; // no file-table fast scan on Linux, and GUI apps shouldn't run as root
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const args = process.argv.slice(1).filter((a) => !a.startsWith('--strata-'));
  if (pending) args.push(`--strata-scan=${Buffer.from(JSON.stringify(pending)).toString('base64')}`);
  const argList = args.length ? ` -ArgumentList ${args.map((a) => quote(`"${a}"`)).join(',')}` : '';
  // The portable build runs from a temp folder that disappears when it quits, so relaunch the portable .exe itself.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const cmd = `Start-Process -FilePath ${quote(exe)}${argList} -WorkingDirectory ${quote(process.cwd())} -Verb RunAs`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }, (err) => {
      if (err) return resolve(false);
      resolve(true);
      setTimeout(() => app.quit(), 150);
    });
  });
});

// A scan requested before relaunching as admin.
ipcMain.handle('app:pendingScan', () => {
  const arg = process.argv.find((a) => a.startsWith('--strata-scan='));
  if (!arg) return null;
  try { return JSON.parse(Buffer.from(arg.slice(14), 'base64').toString('utf8')); } catch { return null; }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (current && current.proc) { try { current.proc.kill(); } catch { /* gone */ } }
  app.quit();
});
