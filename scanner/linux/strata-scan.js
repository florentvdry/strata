// Strata's scanner for Linux. Same commands, JSON-lines messages and .strata file as scanner/StrataScan.cs,
// so the main process and the UI don't need to know which one they talk to.
// Runs on the Node.js built into Electron (ELECTRON_RUN_AS_NODE=1), so nothing needs compiling per distribution.
//
//   info                                       drives (mounted file systems) and whether we run as root
//   scan <path> <out> [--hidden] [--links]     scans a folder and writes a .strata file (--mft is ignored)
//   dupes <list>                               byte-identical groups among same-size candidates
//   delete <list> [recycle|permanent]          moves to the Trash or deletes, reports what is left
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { readMounts, mountOf, isNetwork, isUserMount, isVirtual } = require('./mounts');
const { trashItem } = require('./trash');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// ───────────────────────── file types ─────────────────────────

// Indices shared with the UI (src/renderer/lib/types.js). Same lists as FileTypes in StrataScan.cs, plus Linux packages.
const T_OTHER = 0, T_VIDEO = 1, T_APP = 2, T_SYSTEM = 3, T_IMAGE = 4, T_ARCHIVE = 5, T_CODE = 6, T_AUDIO = 7, T_DOC = 8;
const TYPE_COUNT = 9;
const EXT = new Map();
function addTypes(t, list) { for (const e of list.split(' ')) if (e) EXT.set(e.toLowerCase(), t); }
addTypes(T_VIDEO, 'mp4 mkv avi mov wmv webm m4v flv mpg mpeg ts m2ts mts vob 3gp ogv rm rmvb divx f4v braw r3d prproj');
addTypes(T_APP, 'exe dll pak vpk uasset uexp ubulk utoc ucas bundle assets resource resS forge rpf big ba2 bsa esm esp wad gcf vdf acf sav sys32 ocx appx msix appxbundle msixbundle apk xapk ipa so dylib bik bnk wem pck arc dat001 cache0 xnb pdx ff ipak xpak sabs sabl tre pck2 unity3d obb blob appimage flatpak');
addTypes(T_SYSTEM, 'sys log etl evtx tmp temp mui cat manifest ini reg dmp mdmp hdmp edb jfm chk blf regtrans-ms evt cpl drv efi mum inf pnf dat db db-wal db-shm sqlite ldb lock lck trace etw pf journal journal~ core');
addTypes(T_IMAGE, 'jpg jpeg png gif bmp tif tiff webp heic heif avif raw cr2 cr3 nef arw dng orf rw2 raf psd psb xcf kra svg ico icns tga exr hdr lrcat lrdata dds jxl afphoto');
addTypes(T_ARCHIVE, 'zip rar 7z tar gz tgz bz2 xz zst lz lzma cab iso img vhd vhdx vmdk vdi qcow2 dmg wim esd msi msp msu nupkg crx xpi bak backup tib deb rpm snap pkg.tar.zst');
addTypes(T_CODE, 'js mjs cjs ts tsx jsx py pyc pyd java class jar war c cc cpp cxx h hpp cs vb fs go rs rb php swift kt kts scala lua pl r m mm sh ps1 psm1 bat cmd json yaml yml toml xml map wasm o obj lib a pdb ilk idb ipch pch whl gem crate node gradle sln csproj vcxproj nuspec css scss less html htm vue svelte sql ipynb');
addTypes(T_AUDIO, 'mp3 wav flac aac ogg oga m4a wma opus aiff aif mid midi ape alac wv dsf amr caf');
addTypes(T_DOC, 'pdf doc docx xls xlsx xlsm ppt pptx txt md rtf odt ods odp csv tsv epub mobi azw3 pages numbers key one pst ost msg eml vsdx pub tex djvu xps oxps chm');

function classify(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return T_OTHER;
  const t = EXT.get(name.slice(dot + 1).toLowerCase());
  if (t !== undefined) return t;
  return /\.so(\.\d+)+$/.test(name) ? T_APP : T_OTHER; // versioned shared libraries: libfoo.so.1.2

}

const F_DIR = 1, F_HIDDEN = 2, F_REPARSE = 8, F_DENIED = 16;

// ───────────────────────── folder listing (worker threads) ─────────────────────────

// Per entry: kind, size, blocks, mtime, nlink, dev, ino, and for a link: points to a folder?, its dev, its ino.
const FIELDS = 10;
const K_FILE = 0, K_DIR = 1, K_LINK = 2, K_OTHER = 3;

function listDir(dir, links) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { error: e.code || 'EIO' }; }
  const base = dir === '/' ? '/' : dir + '/';
  const data = new Float64Array(names.length * FIELDS);
  for (let k = 0; k < names.length; k++) {
    const d = k * FIELDS;
    let s;
    try { s = fs.lstatSync(base + names[k], { throwIfNoEntry: false }); } catch { s = null; }
    if (!s) { data[d] = -1; continue; }
    const kind = s.isFile() ? K_FILE : s.isDirectory() ? K_DIR : s.isSymbolicLink() ? K_LINK : K_OTHER;
    data[d] = kind; data[d + 1] = s.size; data[d + 2] = s.blocks; data[d + 3] = s.mtimeMs / 1000;
    data[d + 4] = s.nlink; data[d + 5] = s.dev; data[d + 6] = s.ino;
    if (kind === K_LINK && links) {
      try {
        const t = fs.statSync(base + names[k]);
        if (t.isDirectory()) { data[d + 7] = 1; data[d + 8] = t.dev; data[d + 9] = t.ino; }
      } catch { /* broken link */ }
    }
  }
  return { names, data };
}

if (!isMainThread) {
  parentPort.on('message', ({ id, dir }) => {
    const res = listDir(dir, workerData.links);
    parentPort.postMessage({ id, res }, res.data ? [res.data.buffer] : []);
  });
}

// ───────────────────────── info ─────────────────────────

// /sys/class/block/<dev> → the whole disk behind a partition, LVM volume or LUKS container.
function diskOf(name, depth = 0) {
  if (depth > 6) return null;
  const sys = `/sys/class/block/${name}`;
  try {
    const slaves = fs.readdirSync(`${sys}/slaves`);
    if (slaves.length) return diskOf(slaves[0], depth + 1);
  } catch { /* not a device-mapper device */ }
  if (fs.existsSync(`${sys}/partition`)) {
    try { return path.basename(path.dirname(fs.realpathSync(sys))); } catch { return null; }
  }
  return fs.existsSync(sys) ? name : null;
}

function readSys(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } }

function labels() {
  const map = new Map();
  try {
    for (const l of fs.readdirSync('/dev/disk/by-label')) {
      try { map.set(fs.realpathSync(`/dev/disk/by-label/${l}`), l.replace(/\\x([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))); } catch { /* broken link */ }
    }
  } catch { /* no udev */ }
  return map;
}

function hardware(source) {
  const res = { bus: null, media: null, removable: false };
  if (!source.startsWith('/dev/')) return res;
  let dev;
  try { dev = path.basename(fs.realpathSync(source)); } catch { return res; }
  const disk = diskOf(dev);
  if (!disk) return res;
  const sys = `/sys/class/block/${disk}`;
  let real = '';
  try { real = fs.realpathSync(sys); } catch { /* keep empty */ }
  if (/\/usb\d*\//.test(real)) res.bus = 'USB';
  else if (/^nvme/.test(disk)) res.bus = 'NVMe';
  else if (/^mmcblk/.test(disk)) res.bus = 'SD';
  else if (/^(vd|xvd)/.test(disk) || /\/virtio/.test(real)) res.bus = 'Virtual';
  else if (/\/ata\d+\//.test(real)) res.bus = 'SATA';
  else if (/^sd/.test(disk)) res.bus = 'SCSI';
  const rot = readSys(`${sys}/queue/rotational`);
  if (rot === '0' && res.bus !== 'Virtual' && res.bus !== 'USB' && res.bus !== 'SD') res.media = 'SSD';
  else if (rot === '1' && res.bus !== 'Virtual') res.media = 'HDD';
  res.removable = readSys(`${sys}/removable`) === '1' || res.bus === 'USB' || res.bus === 'SD';
  return res;
}

function statfs(p) {
  try {
    const s = fs.statfsSync(p);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize, cluster: s.bsize };
  } catch { return null; }
}

function info() {
  const mounts = readMounts();
  const byLabel = labels();
  const seen = new Set();
  const drives = [];
  for (const m of mounts) {
    if (!isUserMount(m) || seen.has(`${m.dev}:${m.root}`) || seen.has(m.mount)) continue;
    const s = statfs(m.mount);
    if (!s || !s.total) continue;
    seen.add(`${m.dev}:${m.root}`);
    seen.add(m.mount);
    const hw = isNetwork(m) ? { bus: 'Network', media: null, removable: false } : hardware(m.source);
    let label = null;
    try { label = byLabel.get(fs.realpathSync(m.source)) || null; } catch { /* not a device */ }
    drives.push({
      letter: null,
      root: m.mount,
      label,
      fs: m.fstype.replace(/^fuse(blk)?\.?/, '') || m.fstype,
      total: s.total,
      free: s.free,
      kind: isNetwork(m) ? 'Network' : hw.removable ? 'Removable' : 'Fixed',
      bus: hw.bus,
      media: hw.media,
      cluster: s.cluster,
      system: m.mount === '/',
    });
  }
  // Stacked mounts on the same point: the last one is what you see.
  const last = new Map();
  for (const d of drives) last.set(d.root, d);
  out({ type: 'info', admin: process.getuid ? process.getuid() === 0 : false, drives: [...last.values()] });
}

// ───────────────────────── scan ─────────────────────────

// Columnar node storage: parents always come before their children.
class Nodes {
  constructor() {
    this.n = 0;
    this.cap = 1 << 16;
    this.size = new Float64Array(this.cap);
    this.mtime = new Float64Array(this.cap);
    this.parent = new Int32Array(this.cap);
    this.flags = new Uint8Array(this.cap);
    this.type = new Uint8Array(this.cap);
    this.names = [];
  }
  grow(need) {
    if (need <= this.cap) return;
    let cap = this.cap;
    while (cap < need) cap *= 2;
    for (const k of ['size', 'mtime', 'parent', 'flags', 'type']) {
      const a = new this[k].constructor(cap);
      a.set(this[k]);
      this[k] = a;
    }
    this.cap = cap;
  }
  add(parent, name, size, mtime, flags, type) {
    this.grow(this.n + 1);
    const i = this.n++;
    this.parent[i] = parent; this.size[i] = size; this.mtime[i] = mtime; this.flags[i] = flags; this.type[i] = type;
    this.names.push(name);
    return i;
  }
}

// Layout (little-endian), as in ScanCommand.WriteResult:
//   "STRATA01" | int32 headerLen | header JSON (UTF-8) | zero pad to 8
//   int32 N | int32 0
//   float64[N] size | float64[N] mtime (unix s) | int32[N] parent | uint8[N] flags | uint8[N] type
//   int32 namesLen | names, UTF-8, NUL-separated
function writeResult(file, nodes, n, header) {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  let pre = 8 + 4 + h.length;
  const pad = (8 - (pre % 8)) % 8;
  const names = Buffer.from(nodes.names.slice(0, n).join('\0'), 'utf8');
  const head = Buffer.alloc(pre + pad + 8);
  head.write('STRATA01', 0, 'ascii');
  head.writeInt32LE(h.length, 8);
  h.copy(head, 12);
  head.writeInt32LE(n, pre + pad);
  head.writeInt32LE(0, pre + pad + 4);
  const nl = Buffer.alloc(4);
  nl.writeInt32LE(names.length, 0);
  const view = (a, bytes) => Buffer.from(a.buffer, a.byteOffset, n * bytes);
  const tmp = file + '.part';
  const fd = fs.openSync(tmp, 'w');
  try {
    for (const b of [head, view(nodes.size, 8), view(nodes.mtime, 8), view(nodes.parent, 4), view(nodes.flags, 1), view(nodes.type, 1), nl, names]) {
      let off = 0;
      while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off);
    }
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function normalizeRoot(p) {
  p = path.resolve(p.trim().replace(/^"|"$/g, ''));
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

async function scan(args) {
  const o = { root: normalizeRoot(args[1]), out: args[2], hidden: args.includes('--hidden'), links: args.includes('--links'), mft: args.includes('--mft') };
  let rootStat;
  try { rootStat = fs.statSync(o.root); } catch { rootStat = null; }
  if (!rootStat || !rootStat.isDirectory()) {
    out({ type: 'error', message: `Folder not found: ${o.root}` });
    return 1;
  }

  const mounts = readMounts();
  const mount = mountOf(o.root, mounts);
  const disk = statfs(o.root) || { total: 0, free: 0, cluster: 4096 };
  // Other file systems mounted inside the scanned folder are listed but not entered (like du -x):
  // they're drives of their own, and /proc, /sys, /dev and /run aren't files on disk.
  const mountPoints = new Set(mounts.filter((m) => m.mount !== (mount && mount.mount)).map((m) => m.mount));
  const virtualPoints = new Set(mounts.filter(isVirtual).map((m) => m.mount));

  const st = {
    paused: false, stop: false, finished: false, phase: 'walk', current: '',
    files: 0, dirs: 1, bytes: 0, errors: 0, pct: 0,
    isDriveRoot: !!mount && mount.mount === o.root, driveUsed: disk.total - disk.free,
    started: Date.now(), tops: [], topCount: 0, topDone: 0, biggest: [],
  };
  const nodes = new Nodes();
  nodes.add(-1, o.root, 0, rootStat.mtimeMs / 1000, F_DIR, 0);
  const seenInodes = new Set(); // hard links count once; with --links, folders are entered once
  const visitedDirs = new Set([`${rootStat.dev}:${rootStat.ino}`]);

  const header = (partial, n) => {
    let files = 0, dirs = 0, bytes = 0;
    for (let i = 0; i < n; i++) { if (nodes.flags[i] & F_DIR) dirs++; else { files++; bytes += nodes.size[i]; } }
    return {
      version: 1, root: o.root, fs: mount ? mount.fstype : '', cluster: disk.cluster, total: disk.total, free: disk.free,
      method: 'Walk', scannedAt: Date.now(), duration: Math.round((Date.now() - st.started) / 100) / 10, partial,
      files, dirs: dirs - 1, errors: st.errors, bytes, options: { mft: o.mft, hidden: o.hidden, links: o.links },
    };
  };

  function offerBig(size, rel) {
    const b = st.biggest;
    if (b.length === 5 && size <= b[4].size) return;
    b.push({ path: rel, size, type: classify(rel) });
    b.sort((x, y) => y.size - x.size);
    if (b.length > 5) b.pop();
  }

  // ── stdin commands ──
  let resumeWaiters = [];
  const resume = () => { const w = resumeWaiters; resumeWaiters = []; for (const f of w) f(); };
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    line = line.trim();
    if (line === 'pause') st.paused = true;
    else if (line === 'resume') { st.paused = false; resume(); }
    else if (line === 'stop') { st.stop = true; st.paused = false; resume(); }
    else if (line.startsWith('snapshot ')) {
      const file = line.slice(9);
      try {
        const n = nodes.n;
        writeResult(file, nodes, n, header(true, n));
        out({ type: 'snapshot', out: file });
      } catch (e) { out({ type: 'snapshot', error: e.message }); }
    }
  });

  // ── progress ──
  const ticker = setInterval(() => {
    out({
      type: 'progress', phase: st.paused ? 'paused' : st.phase, files: st.files, dirs: st.dirs, bytes: st.bytes, errors: st.errors,
      pct: Math.round(st.pct * 1e4) / 1e4, current: st.current,
      tops: st.tops.map((t) => ({ name: t.name, dir: t.dir, bytes: t.bytes, state: t.state, type: dominant(t.typeBytes) })),
      biggest: st.biggest,
    });
  }, 180);

  function dominant(tb) {
    let best = 0, bv = -1;
    for (let i = 0; i < tb.length; i++) if (tb[i] > bv) { bv = tb[i]; best = i; }
    return best;
  }

  function updatePct() {
    let p;
    if (st.isDriveRoot && st.driveUsed > 0) p = st.bytes / st.driveUsed;
    else {
      const active = st.tops.reduce((a, t) => a + (t.state === 1 ? 1 : 0), 0);
      p = (st.topDone + active * 0.45) / Math.max(1, st.topCount);
    }
    p = Math.min(0.99, p);
    if (p > st.pct) st.pct = p;
  }

  // One folder's listing came back from a worker: add its entries and return the folders to enter next.
  function processDir(job, res) {
    st.current = job.path;
    if (res.error) {
      if (res.error !== 'ENOENT' && res.error !== 'ENOTDIR') { st.errors++; nodes.flags[job.node] |= F_DENIED; }
      return [];
    }
    const rootLevel = job.depth === 0;
    const base = job.path === '/' ? '/' : job.path + '/';
    const { names, data } = res;
    const local = [];
    const localTypes = new Float64Array(TYPE_COUNT);
    let bytes = 0, files = 0, dirs = 0;
    // Real folders first, so a link next to the folder it points to isn't followed as well.
    if (o.links) for (let d = 0; d < data.length; d += FIELDS) if (data[d] === K_DIR) visitedDirs.add(`${data[d + 5]}:${data[d + 6]}`);
    for (let k = 0; k < names.length; k++) {
      const name = names[k], d = k * FIELDS;
      const kind = data[d];
      if (kind < 0) continue; // vanished while scanning
      const hidden = name.charCodeAt(0) === 46; // "."
      if (!o.hidden && hidden) continue;
      const full = base + name;
      let f = hidden ? F_HIDDEN : 0;
      const mtime = data[d + 3];
      if (kind === K_DIR) {
        dirs++;
        f |= F_DIR;
        const other = mountPoints.has(full);
        if (other) f |= F_REPARSE;
        local.push({ name, size: 0, mtime, f, type: 0, descend: !other && !virtualPoints.has(full), dir: true });
      } else if (kind === K_LINK) {
        f |= F_REPARSE;
        let follow = false;
        // Follow a link only into a folder we haven't been in: never an ancestor, never twice.
        if (o.links && data[d + 7] === 1 && job.depth < 64) {
          const key = `${data[d + 8]}:${data[d + 9]}`;
          if (!visitedDirs.has(key)) { visitedDirs.add(key); follow = true; }
        }
        if (follow) { dirs++; f |= F_DIR; }
        local.push({ name, size: 0, mtime, f, type: 0, descend: follow, dir: follow });
      } else {
        // Allocated size when smaller (sparse files such as VM disks and container images), else the length.
        let size = data[d + 2] > 0 ? Math.min(data[d + 1], data[d + 2] * 512) : data[d + 1];
        if (kind === K_FILE && data[d + 4] > 1) { // hard links count once
          const key = `${data[d + 5]}:${data[d + 6]}`;
          if (seenInodes.has(key)) size = 0; else seenInodes.add(key);
        }
        const type = classify(name);
        bytes += size;
        files++;
        localTypes[type] += size;
        if (size > 64 * 1024 * 1024) offerBig(size, path.relative(o.root, full));
        local.push({ name, size, mtime, f, type, descend: false, dir: false });
      }
    }

    st.bytes += bytes; st.files += files; st.dirs += dirs;
    if (job.top) {
      job.top.bytes += bytes;
      for (let t = 0; t < TYPE_COUNT; t++) job.top.typeBytes[t] += localTypes[t];
    }

    const baseIndex = nodes.n;
    for (const e of local) nodes.add(job.node, e.name, e.size, e.mtime, e.f, e.type);

    if (rootLevel) {
      for (const e of local) {
        const t = { name: e.name, dir: e.dir, bytes: e.dir ? 0 : e.size, state: e.descend ? 0 : 2, pending: 0, typeBytes: new Float64Array(TYPE_COUNT) };
        if (!e.dir) t.typeBytes[e.type] = e.size;
        e.top = t;
        st.tops.push(t);
        if (t.state === 2) st.topDone++;
      }
      st.topCount = local.length;
    }

    // Pushed in reverse so the first folder is worked on first (depth-first).
    const jobs = [];
    for (let i = local.length - 1; i >= 0; i--) {
      const e = local[i];
      if (!e.descend) continue;
      const top = rootLevel ? e.top : job.top;
      if (top) top.pending++;
      jobs.push({ node: baseIndex + i, path: base + e.name, depth: job.depth + 1, top });
    }
    return jobs;
  }

  // Worker threads list folders with blocking calls (much faster than a promise per file) and several
  // folders are read at once. This thread owns the tree, the stack of folders to visit and the protocol.
  const pool = Array.from({ length: Math.max(2, Math.min(8, os.cpus().length)) }, () => (
    { w: new Worker(__filename, { workerData: { links: o.links } }), busy: 0, jobs: new Map() }));
  await new Promise((resolve, reject) => {
    const stack = [{ node: 0, path: o.root, depth: 0, top: null }];
    let active = 0, seq = 0;
    const finish = (job) => {
      if (job.top && --job.top.pending === 0) { job.top.state = 2; st.topDone++; }
      updatePct();
    };
    for (const p of pool) {
      p.w.on('message', ({ id, res }) => {
        const job = p.jobs.get(id);
        p.jobs.delete(id);
        p.busy--;
        active--;
        for (const j of processDir(job, res)) stack.push(j);
        finish(job);
        pump();
      });
      p.w.on('error', reject);
    }
    function pump() {
      while (!st.paused && !st.stop && stack.length) {
        const p = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
        if (p.busy >= 2) break;
        const job = stack.pop();
        if (job.top && job.top.state === 0) job.top.state = 1;
        const id = ++seq;
        p.jobs.set(id, job);
        p.busy++;
        active++;
        p.w.postMessage({ id, dir: job.path });
      }
      if (st.paused && active === 0 && !st.stop) { resumeWaiters.push(pump); return; }
      if (active === 0 && (st.stop || !stack.length)) resolve();
    }
    pump();
  });
  await Promise.all(pool.map((p) => p.w.terminate()));
  st.pct = 1;
  st.phase = 'build';

  writeResult(o.out, nodes, nodes.n, header(st.stop, nodes.n));
  st.finished = true;
  clearInterval(ticker);
  rl.close();
  process.stdin.destroy();
  out({ type: 'done', out: o.out, partial: st.stop, method: 'Walk' });
  return 0;
}

// ───────────────────────── delete ─────────────────────────

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function sizeOf(p) {
  try {
    const s = fs.lstatSync(p);
    if (!s.isDirectory()) return s.isFile() ? s.size : 0;
    let total = 0;
    for (const n of fs.readdirSync(p)) total += sizeOf(path.join(p, n));
    return total;
  } catch { return 0; }
}

function deleteCmd(listFile, permanent) {
  const paths = fs.readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const mounts = readMounts();
  paths.forEach((p, i) => {
    out({ type: 'progress', done: i, total: paths.length, current: p });
    let error = null;
    if (exists(p)) {
      try {
        if (permanent) fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 }); // removes links, never follows them
        else trashItem(p, mounts);
      } catch (e) {
        error = e.code === 'EACCES' || e.code === 'EPERM' ? 'Permission denied' : e.code === 'EBUSY' ? 'In use' : e.message;
      }
    }
    const ok = !exists(p);
    const remaining = ok ? 0 : sizeOf(p);
    if (!ok && (error == null || remaining > 0)) error = error || 'Some files are in use or protected';
    out({ type: 'result', path: p, ok, remaining, error: ok ? null : error });
  });
  out({ type: 'done' });
}

// ───────────────────────── duplicates ─────────────────────────

const SAMPLE = 64 * 1024;
const FULL_HASH_LIMIT = 1024 ** 3;

function readAt(fd, pos, buf) {
  let n = 0;
  while (n < buf.length) {
    const r = fs.readSync(fd, buf, n, buf.length - n, pos + n);
    if (!r) break;
    n += r;
  }
  return buf.subarray(0, n);
}

// First, middle and last 64 KB.
function sampleHash(p, size) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const h = crypto.createHash('md5');
    const buf = Buffer.alloc(SAMPLE);
    h.update(readAt(fd, 0, buf));
    if (size > SAMPLE * 2) {
      h.update(readAt(fd, Math.floor(size / 2), buf));
      h.update(readAt(fd, size - SAMPLE, buf));
    }
    return h.digest('base64');
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function fullHash(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const h = crypto.createHash('md5');
    const buf = Buffer.alloc(1 << 20);
    for (let pos = 0; ; ) {
      const r = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!r) break;
      h.update(buf.subarray(0, r));
      pos += r;
    }
    return h.digest('base64');
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function dupes(listFile) {
  const groups = [];
  let cur = null, curSize = -1;
  for (const line of fs.readFileSync(listFile, 'utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const size = Number(line.slice(0, tab));
    if (size !== curSize || !cur) { cur = []; curSize = size; groups.push({ size, paths: cur }); }
    cur.push(line.slice(tab + 1));
  }
  // Biggest potential savings first.
  groups.sort((a, b) => b.size * (b.paths.length - 1) - a.size * (a.paths.length - 1));
  const totalWork = groups.reduce((a, g) => a + Math.min(g.size, FULL_HASH_LIMIT) * g.paths.length, 0);
  let doneWork = 0, lastTick = 0;
  const started = Date.now();
  const bucket = (map, key, p) => { const l = map.get(key); if (l) l.push(p); else map.set(key, [p]); };

  for (const g of groups) {
    if (Date.now() - started > 240000) break;
    const bySample = new Map();
    for (const p of g.paths) {
      const h = sampleHash(p, g.size);
      if (h) bucket(bySample, h, p);
    }
    for (const sg of bySample.values()) {
      if (sg.length < 2) continue;
      const full = g.size <= FULL_HASH_LIMIT;
      const byHash = new Map();
      for (const p of sg) {
        const h = full ? fullHash(p) : 'sampled'; // big files: samples only
        if (!h) continue;
        bucket(byHash, h, p);
        doneWork += Math.min(g.size, FULL_HASH_LIMIT);
        if (Date.now() - lastTick > 250) {
          lastTick = Date.now();
          out({ type: 'progress', done: doneWork, total: totalWork });
        }
      }
      for (const hg of byHash.values()) if (hg.length >= 2) out({ type: 'group', size: g.size, verified: full, paths: hg });
    }
  }
  out({ type: 'done' });
}

// ───────────────────────── main ─────────────────────────

async function main(args) {
  switch (args[0]) {
    case 'info': info(); return 0;
    case 'scan': return scan(args);
    case 'dupes': dupes(args[1]); return 0;
    case 'delete': deleteCmd(args[1], args[2] === 'permanent'); return 0;
    case undefined: out({ type: 'error', message: 'no command' }); return 2;
    default: out({ type: 'error', message: 'unknown command' }); return 2;
  }
}

if (isMainThread) main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => { out({ type: 'error', message: e.message }); process.exitCode = 1; },
);
