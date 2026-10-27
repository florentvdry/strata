// Cleanup suggestions derived from a scan.
import { F_DIR, F_REPARSE } from './tree.js';
import { T } from './types.js';
import { fmtShort, fmtAgo, fmtMonth, plural } from './format.js';
import { isWin, sep, fold, parentPath } from './platform.js';

export const CATS = [
  { id: 'all', label: 'Everything', hint: 'All suggestions, safest first', dot: 'var(--accent)' },
  { id: 'cache', label: 'Caches & temp', hint: 'Regenerated automatically — safe to remove', dot: '#5B6576', short: 'Temp & caches' },
  { id: 'installer', label: 'Old installers', hint: 'Setup files and disk images you already used', dot: '#A78BFA', short: 'Old installers' },
  { id: 'dupe', label: 'Duplicates', hint: 'Byte-identical copies, one copy is kept', dot: '#F59E0B', short: 'Duplicates' },
  { id: 'media', label: 'Large & old media', hint: 'Big files you haven’t opened in a while', dot: '#3B82F6', short: 'Large & old media' },
  { id: 'dev', label: 'Dev artifacts', hint: 'Dependencies and build output you can restore', dot: '#34D399', short: 'Dev artifacts' },
  { id: 'user', label: 'Added by you', hint: 'Things you picked on the map', dot: '#EC6FB0', short: 'Added by you' },
];

const DAY = 86400;
const now = () => Date.now() / 1000;

// Folders we never suggest anything inside (other than the specific rules below).
// On Linux these are the top-level system folders of the root file system.
const SYSTEM_SEGMENTS = isWin
  ? new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', 'windowsapps', 'recovery', '$windows.~bt', '$windows.~ws'])
  : new Set(['usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32', 'etc', 'boot', 'efi', 'proc', 'sys', 'dev', 'run', 'snap', 'var', 'opt', 'srv', 'lost+found']);

const BROWSERS = (isWin
  ? ['\\google\\chrome\\user data\\', '\\microsoft\\edge\\user data\\', '\\bravesoftware\\brave-browser\\user data\\', '\\mozilla\\firefox\\profiles\\', '\\opera software\\', '\\vivaldi\\user data\\', '\\chromium\\user data\\']
  : ['/google-chrome/', '/chromium/', '/microsoft-edge/', '/bravesoftware/brave-browser/', '/vivaldi/', '/opera/', '/.mozilla/firefox/', '/.cache/mozilla/firefox/']);
const BROWSER_CACHE = new Set(['cache', 'code cache', 'gpucache', 'cache2', 'grshadercache', 'shadercache', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache', 'startupcache']);
const GENERIC_CACHE = new Set(['cache', 'caches', 'gpucache', 'code cache', 'cachestorage', 'shadercache', 'cache_data', 'blob_storage', 'crashpad']);
const FRAMEWORK_CACHE = new Set(['.next', '.nuxt', '.parcel-cache', '.turbo', '.svelte-kit', '.angular']);
const INSTALLER_EXT = /\.(exe|msi|msix|msixbundle|appx|appxbundle|deb|rpm|appimage|flatpakref)$/i;
const IMAGE_EXT = /\.(iso|img|dmg)$/i;
// Linux app data lives in dot-folders of the home folder (XDG base directories, Flatpak's ~/.var).
const LINUX_APPDATA = new Set(['.config', '.local', '.cache', '.var', '.mozilla']);
// Children of ~/.cache handled by a more specific rule (browsers, packages).
const LINUX_CACHE_SKIP = /^(google-chrome|chromium|microsoft-edge|bravesoftware|vivaldi|opera|mozilla|thumbnails|pip|yarn|go-build|ms-playwright|pnpm)$/;
// Package manager downloads, by distribution family. They need admin rights to remove.
const PKG_CACHES = [
  ['/var/cache/apt/archives', 'APT package cache', 'Downloaded .deb packages · or run sudo apt clean'],
  ['/var/cache/dnf', 'DNF package cache', 'Downloaded packages and metadata · or run sudo dnf clean all'],
  ['/var/cache/yum', 'YUM package cache', 'Downloaded packages and metadata · or run sudo yum clean all'],
  ['/var/cache/pacman/pkg', 'Pacman package cache', 'Every downloaded package version · or run sudo paccache -r'],
  ['/var/cache/zypp/packages', 'Zypper package cache', 'Downloaded packages · or run sudo zypper clean'],
];
const DOWNLOADS = new Set(['downloads', 'téléchargements', 'descargas', 'scaricati', 'transferências']);

export function buildSuggestions(tree, env, dupes) {
  const { n, names, parent, flags, size, removed } = tree;
  const lower = (i) => names[i].toLowerCase();
  const items = [];
  const groups = new Map(); // key → item collecting several folders
  const covered = new Uint8Array(n); // inside something already suggested
  const sys = new Uint8Array(n);     // inside a system location
  const appdata = new Uint8Array(n); // inside AppData
  const downloads = new Uint8Array(n);
  const dotted = new Uint8Array(n);  // inside a dot-folder such as .vscode
  const rootPath = names[0].endsWith(sep) ? names[0].slice(0, -1) : names[0];
  const rootSeg = rootPath.split(sep).map((s) => s.toLowerCase());
  // Linux: only the first segment says "system" (/usr/…), a project's bin/ or lib/ folder doesn't.
  const rootIsSystem = isWin ? rootSeg.some((s) => SYSTEM_SEGMENTS.has(s)) : SYSTEM_SEGMENTS.has(rootSeg[1]);
  const rootInAppData = isWin ? rootSeg.includes('appdata') : rootSeg.some((s) => LINUX_APPDATA.has(s));
  sys[0] = rootIsSystem ? 1 : 0;
  appdata[0] = rootInAppData ? 1 : 0;
  downloads[0] = rootSeg.some((s) => DOWNLOADS.has(s)) ? 1 : 0;
  // Absolute paths of the folders Linux rules look for.
  const home = env && env.home ? env.home.replace(/\/+$/, '') : '';
  const homeCache = home + '/.cache';

  const lpath = (i) => tree.path(i).toLowerCase();
  const hasChild = (i, re) => tree.kids(i).some((c) => re.test(names[c]));

  function add(it) {
    for (const i of it.nodes) markCovered(i);
    it.v = it.nodes.reduce((a, i) => a + size[i], 0);
    if (it.v > 0) items.push(it);
  }
  function markCovered(i) { covered[i] = 1; }
  function group(key, make, i) {
    let g = groups.get(key);
    if (!g) { g = make(); g.nodes = []; g.targets = []; groups.set(key, g); }
    g.nodes.push(i);
    g.targets.push({ path: tree.path(i), contentsOnly: !!g.contentsOnly });
    markCovered(i);
  }
  function single(cat, i, name, reason, risk, opts = {}) {
    add({ id: `${cat}:${tree.path(i)}`, cat, name, path: tree.path(i), nodes: [i], targets: [{ path: tree.path(i), contentsOnly: !!opts.contentsOnly }], reason, risk, ...opts });
  }

  const genericCaches = [];
  for (let i = 1; i < n; i++) {
    const p = parent[i];
    covered[i] = covered[p];
    const nm = lower(i);
    // On Linux only a scan of / has /usr, /etc… as its direct children.
    sys[i] = sys[p] || (p === 0 && SYSTEM_SEGMENTS.has(nm) && (isWin || rootPath === '')) || nm === 'windowsapps' ? 1 : 0;
    appdata[i] = appdata[p] || nm === 'appdata' || (!isWin && LINUX_APPDATA.has(nm)) ? 1 : 0;
    downloads[i] = downloads[p] || DOWNLOADS.has(nm) ? 1 : 0;
    dotted[i] = dotted[p] || nm.startsWith('.') ? 1 : 0;
    if (removed[i] || covered[i]) continue;
    if (!(flags[i] & F_DIR) || (flags[i] & F_REPARSE)) continue;
    const pn = p >= 0 ? lower(p) : '';
    const gp = p > 0 ? lower(parent[p]) : '';
    // Project folders only: not tool installs (Program Files, AppData) or editor/tool dot-folders.
    const inProject = !sys[p] && !appdata[p] && !dotted[p];

    // ── caches & temp ──
    if (nm === 'temp' && pn === 'local' && gp === 'appdata') {
      single('cache', i, 'Windows temp files', ageReason(tree, i, 'opened'), 'safe', { contentsOnly: true });
      continue;
    }
    if (nm === 'temp' && pn === 'windows') {
      single('cache', i, 'System temp files', ageReason(tree, i, 'touched'), 'safe', { contentsOnly: true });
      continue;
    }
    if (nm === 'download' && pn === 'softwaredistribution') {
      single('cache', i, 'Windows Update leftovers', 'Installed updates already applied', 'safe', { contentsOnly: true });
      continue;
    }
    if (nm === 'cache' && pn === 'deliveryoptimization') {
      single('cache', i, 'Delivery Optimization files', 'Update files shared with other PCs', 'safe', { contentsOnly: true });
      continue;
    }
    if ((nm === 'crashdumps' && pn === 'local') || (nm === 'minidump' && pn === 'windows') || ((nm === 'reportarchive' || nm === 'reportqueue') && pn === 'wer')) {
      group('crash', () => ({ id: 'cache:crash', cat: 'cache', name: 'Crash dumps & error reports', reason: 'Only useful for debugging crashes', risk: 'safe', contentsOnly: true }), i);
      continue;
    }
    if (BROWSER_CACHE.has(nm)) {
      const lp = lpath(i);
      if (BROWSERS.some((b) => lp.includes(b))) {
        group('browser', () => ({ id: 'cache:browser', cat: 'cache', name: 'Browser caches', reason: 'Close browsers before cleaning', risk: 'safe', contentsOnly: true }), i);
        continue;
      }
    }
    if ((nm === 'd3dscache' && pn === 'local') || ((nm === 'dxcache' || nm === 'glcache' || nm === 'dxccache' || nm === 'vkcache' || nm === 'optixcache') && (pn === 'nvidia' || pn === 'amd' || pn === 'nv_cache')) || (nm === 'shadercache' && (pn === 'intel' || pn === 'steamapps')) || (nm === 'shadercache' && pn === 'steam')) {
      group('shader', () => ({ id: 'cache:shader', cat: 'cache', name: 'Shader caches', reason: 'Rebuilt automatically on next launch', risk: 'safe', contentsOnly: true }), i);
      continue;
    }
    if (!isWin) {
      const ap = tree.path(i);
      if (ap === '/tmp' || ap === '/var/tmp') {
        single('cache', i, ap === '/tmp' ? 'Temporary files' : 'Long-lived temporary files', ageReason(tree, i, 'touched'), 'review', { contentsOnly: true });
        continue;
      }
      if (ap === '/var/lib/systemd/coredump' || ap === '/var/crash') {
        group('crash', () => ({ id: 'cache:crash', cat: 'cache', name: 'Crash dumps & error reports', reason: 'Only useful for debugging crashes', risk: 'safe', contentsOnly: true }), i);
        continue;
      }
      const pkg = PKG_CACHES.find((c) => c[0] === ap);
      if (pkg) {
        single('cache', i, pkg[1], pkg[2], 'review', { contentsOnly: true });
        continue;
      }
      if (ap === homeCache + '/thumbnails') {
        single('cache', i, 'Thumbnail cache', 'Previews your file manager rebuilds as needed', 'safe', { contentsOnly: true });
        continue;
      }
      if (parentPath(ap) === homeCache && !LINUX_CACHE_SKIP.test(nm) && size[i] >= 64 * 1024 ** 2) {
        genericCaches.push(i); // ~/.cache/<app>: by definition safe to lose, but apps may be slow to rebuild it
        continue;
      }
    }

    // ── dev artifacts ──
    if (!inProject) {
      const pkg = packageCache(nm, pn, gp);
      if (pkg && !sys[p]) single('dev', i, pkg, 'Package downloads, fetched again when needed', 'review', { contentsOnly: true });
      else if (appdata[i] && !sys[i] && GENERIC_CACHE.has(nm) && size[i] >= 64 * 1024 ** 2) genericCaches.push(i);
      continue;
    }
    if (nm === 'node_modules') {
      group('node_modules', () => ({ id: 'dev:node_modules', cat: 'dev', name: 'node_modules', reason: 'Reinstall with your package manager', risk: 'review' }), i);
      continue;
    }
    if (nm === '__pycache__') {
      group('pycache', () => ({ id: 'dev:pycache', cat: 'dev', name: '__pycache__', reason: 'Recreated automatically by Python', risk: 'review' }), i);
      continue;
    }
    if (nm === 'target' && hasChild(p, /^cargo\.toml$/i)) {
      group('rust', () => ({ id: 'dev:rust', cat: 'dev', name: 'Rust build output', reason: 'Rebuilt by cargo build', risk: 'review' }), i);
      continue;
    }
    if ((nm === 'obj' || nm === 'bin') && hasChild(p, /\.(cs|fs|vb)proj$/i)) {
      group('dotnet', () => ({ id: 'dev:dotnet', cat: 'dev', name: '.NET build output', reason: 'Rebuilt by dotnet build', risk: 'review' }), i);
      continue;
    }
    if (FRAMEWORK_CACHE.has(nm)) {
      group('fw', () => ({ id: 'dev:framework', cat: 'dev', name: 'Framework build caches', reason: 'Rebuilt on next build', risk: 'review' }), i);
      continue;
    }
    if ((nm === '.venv' || nm === 'venv') && hasChild(i, /^pyvenv\.cfg$/i)) {
      group('venv', () => ({ id: 'dev:venv', cat: 'dev', name: 'Python virtual environments', reason: 'Recreate with pip install -r requirements.txt', risk: 'review' }), i);
      continue;
    }
    const pkgCache = packageCache(nm, pn, gp);
    if (pkgCache) {
      single('dev', i, pkgCache, 'Package downloads, fetched again when needed', 'review', { contentsOnly: true });
      continue;
    }
  }

  for (const g of groups.values()) {
    if (g.id === 'dev:node_modules') { g.name = `node_modules (${plural(g.nodes.length, 'project')})`; }
    else if (g.nodes.length > 1 && g.cat === 'dev') g.name = `${g.name} (${g.nodes.length})`;
    if (g.id === 'cache:browser') g.reason += ` · ${plural(g.nodes.length, 'folder')}`;
    g.path = g.nodes.length === 1 ? tree.path(g.nodes[0]) : commonPath(g.nodes.map((i) => tree.path(i))) || `${g.nodes.length} folders`;
    add(g);
  }

  genericCaches.sort((a, b) => size[b] - size[a]);
  for (const i of genericCaches.slice(0, 12)) {
    if (tree.ancestors(i).some((a) => a !== i && covered[a])) continue;
    single('cache', i, `${appName(tree, i)} cache`, 'Rebuilt by the app as needed', 'review', { contentsOnly: true });
  }

  // ── files: installers, disk images, media ──
  const media = [];
  let largest = -1;
  const t = now();
  for (let i = 1; i < n; i++) {
    if (removed[i] || (flags[i] & F_DIR) || covered[parent[i]] || sys[parent[i]]) continue;
    const s = size[i];
    if (s > (largest < 0 ? 0 : size[largest])) largest = i;
    const nm = names[i];
    const age = t - tree.mtime[i];
    if (IMAGE_EXT.test(nm) && s >= 100 * 1024 ** 2 && !appdata[parent[i]]) {
      single('installer', i, nm, `Disk image downloaded ${fmtAgo(tree.mtime[i])}`, 'review', { defaultOn: true });
    } else if (INSTALLER_EXT.test(nm) && downloads[parent[i]] && s >= 5 * 1024 ** 2 && age > 14 * DAY) {
      single('installer', i, nm, `Installer downloaded ${fmtAgo(tree.mtime[i])}`, 'review', { defaultOn: true });
    } else {
      const ty = tree.type[i];
      if ((ty === T.video || ty === T.audio || ty === T.image) && s >= 512 * 1024 ** 2 && !appdata[parent[i]]) media.push(i);
    }
  }
  media.sort((a, b) => size[b] - size[a]);
  for (const i of media.slice(0, 25)) {
    const age = t - tree.mtime[i];
    if (i === largest) single('media', i, names[i], 'Largest file on the drive', 'review');
    else if (age > 90 * DAY) single('media', i, names[i], `Not modified since ${fmtMonth(tree.mtime[i])}`, 'review');
    else if (size[i] >= 2 * 1024 ** 3) single('media', i, names[i], `${(size[i] / 1024 ** 3).toFixed(1)} GB in a single file`, 'review');
  }

  // ── duplicates ──
  for (const g of dupes || []) {
    const ids = g.paths.map((p) => tree.lookup(p)).filter((i) => i > 0 && !removed[i]);
    if (ids.length < 2) continue;
    ids.sort((a, b) => tree.mtime[a] - tree.mtime[b] || tree.path(a).length - tree.path(b).length);
    const keep = ids[0];
    for (const i of ids.slice(1)) {
      if (covered[i]) continue;
      const safe = g.verified && isUserContent(tree.path(i), env);
      single('dupe', i, names[i], `${g.verified ? 'Identical to' : 'Same size & samples as'} ${tree.rel(keep)}`, safe ? 'safe' : 'review', { keep: tree.path(keep) });
    }
  }

  for (const it of items) {
    if (it.defaultOn === undefined) it.defaultOn = it.risk === 'safe';
    if (!it.path) it.path = it.targets.length === 1 ? it.targets[0].path : `${it.targets.length} folders`;
  }
  return items;
}

// Files the user put in the queue from the map.
export function userItem(tree, i) {
  const isDir = tree.isDir(i);
  const p = tree.path(i);
  return {
    id: `user:${p}`, cat: 'user', name: tree.name(i), path: parentPath(p), nodes: [i],
    targets: [{ path: p, contentsOnly: false }], v: tree.size[i], risk: 'review', defaultOn: true,
    reason: isDir ? `Folder · ${plural(tree.files[i], 'file')}` : `Last modified ${fmtAgo(tree.mtime[i])}`,
  };
}

function packageCache(nm, pn, gp) {
  if (nm === 'npm-cache' || (nm === '_cacache' && pn === '.npm')) return 'npm cache';
  if ((nm === 'cache' && pn === 'pip') || (nm === 'pip' && pn === '.cache')) return 'pip cache';
  if ((nm === 'cache' && pn === 'yarn') || (nm === 'yarn' && pn === '.cache')) return 'Yarn cache';
  if (nm === 'packages' && pn === '.nuget') return 'NuGet packages';
  if (nm === 'v3-cache' && pn === 'nuget') return 'NuGet HTTP cache';
  if (nm === 'go-build') return 'Go build cache';
  if (nm === 'registry' && pn === '.cargo') return 'Cargo registry';
  if (nm === 'caches' && pn === '.gradle') return 'Gradle caches';
  if (nm === 'repository' && pn === '.m2') return 'Maven repository';
  if (nm === 'store' && pn === 'pnpm') return 'pnpm store';
  if (nm === 'ms-playwright') return 'Playwright browsers';
  return null;
}

function appName(tree, i) {
  const anc = tree.ancestors(i).map((a) => tree.name(a));
  const k = anc.findIndex((s) => (isWin ? /^(local|roaming|locallow)$/i : /^(\.cache|\.config)$/).test(s));
  let name = k >= 0 && anc[k + 1] ? anc[k + 1] : tree.name(tree.parent[i]);
  if (/^(packages|programs)$/i.test(name) && anc[k + 2]) name = anc[k + 2].replace(/_[a-z0-9]{10,}$/i, '').split('.').pop();
  return name;
}

function commonPath(paths) {
  if (!paths.length) return '';
  let parts = paths[0].split(sep);
  for (const p of paths.slice(1)) {
    const q = p.split(sep);
    let k = 0;
    while (k < parts.length && k < q.length && fold(parts[k]) === fold(q[k])) k++;
    parts = parts.slice(0, k);
  }
  const s = parts.join(sep);
  return s.length > (isWin ? 3 : 1) ? s : '';
}

// "41k files, none opened in 30 days"
function ageReason(tree, i, verb) {
  let newest = 0;
  const stack = [i];
  while (stack.length) {
    const d = stack.pop();
    for (const c of tree.kids(d)) {
      if (tree.isDir(c)) stack.push(c);
      else if (tree.mtime[c] > newest) newest = tree.mtime[c];
    }
  }
  const files = tree.files[i];
  const days = Math.floor((now() - newest) / DAY);
  const count = `${fmtShort(files)} ${files === 1 ? 'file' : 'files'}`;
  if (!newest) return count;
  if (days >= 2) return `${count}, none ${verb} in ${days} days`;
  return `${count} · some may be in use`;
}

// Sum of checked items without counting nested ones twice.
export function selectionStats(tree, items, on) {
  const chosen = items.filter((it) => on[it.id]);
  const nodes = new Set();
  for (const it of chosen) for (const i of it.nodes) nodes.add(i);
  let bytes = 0;
  for (const i of nodes) {
    let nested = false;
    for (let p = tree.parent[i]; p > 0 || p === 0; p = p === 0 ? -1 : tree.parent[p]) { if (nodes.has(p)) { nested = true; break; } }
    if (!nested) bytes += tree.size[i];
  }
  return { chosen, bytes, review: chosen.filter((it) => it.risk === 'review').length };
}

// Personal folders, where an extra copy of a file is almost always just clutter.
const USER_FOLDERS = /[\\/](desktop|documents|downloads|pictures|videos|music|onedrive[^\\/]*|bureau|téléchargements|vidéos|musique)[\\/]/i;

export function isUserContent(path, env) {
  if (USER_FOLDERS.test(path)) return true;
  // Linux: other drives are mounted under /media, /mnt or /run/media.
  if (!isWin) return /^\/(media|mnt|run\/media)\//.test(path);
  const sysDrive = env && env.home ? env.home.slice(0, 2).toLowerCase() : 'c:';
  return path.slice(0, 2).toLowerCase() !== sysDrive;
}

// Candidate groups for the duplicate finder: same size, user content types, outside system,
// app, tool and cache folders (where identical files are often there on purpose).
const DUPE_TYPES = new Set([T.video, T.image, T.audio, T.doc, T.archive]);
export function dupeCandidates(tree, minSize = 1024 * 1024) {
  const { n, names, parent, flags, size, removed } = tree;
  const skip = new Uint8Array(n);
  const SKIP = new Set([...SYSTEM_SEGMENTS, 'appdata', 'node_modules', 'steamapps', 'steamlibrary', 'epic games', 'site-packages', '$recycle.bin', 'mods']);
  const bad = (s) => SKIP.has(s) || s.startsWith('.') || s.includes('cache');
  skip[0] = names[0].toLowerCase().split(sep).slice(1).some(bad) ? 1 : 0;
  const bySize = new Map();
  for (let i = 1; i < n; i++) {
    const p = parent[i];
    if (flags[i] & F_DIR) { skip[i] = skip[p] || bad(names[i].toLowerCase()) ? 1 : 0; continue; }
    if (skip[p] || removed[i] || size[i] < minSize || !DUPE_TYPES.has(tree.type[i])) continue;
    const s = size[i];
    const l = bySize.get(s);
    if (l) l.push(i); else bySize.set(s, [i]);
  }
  const groups = [];
  let files = 0;
  for (const [s, ids] of bySize) {
    if (ids.length < 2 || ids.length > 50) continue;
    groups.push({ size: s, paths: ids.map((i) => tree.path(i)) });
    files += ids.length;
  }
  groups.sort((a, b) => b.size * (b.paths.length - 1) - a.size * (a.paths.length - 1));
  // Keep the work bounded on huge drives.
  let budget = 20000;
  return groups.filter((g) => (budget -= g.paths.length) >= 0);
}
