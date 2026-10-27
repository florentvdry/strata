// A made-up but realistic C: drive for screenshots, in the scanner's .strata format.
// Deterministic: the same seed always gives the same tree.

const GB = 1024 ** 3, MB = 1024 ** 2, KB = 1024;
const DAY = 86400;
const T = { other: 0, video: 1, app: 2, system: 3, image: 4, archive: 5, code: 6, audio: 7, doc: 8 };
const F_DIR = 1, F_HIDDEN = 2, F_SYSTEM = 4;

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDemo(now = Date.UTC(2026, 9, 27, 0, 12) / 1000) {
  const r = rng(42);
  const between = (a, b) => a + (b - a) * r();
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const nodes = [{ parent: -1, name: 'C:\\', size: 0, mtime: now, flags: F_DIR, type: 0 }];
  const ago = (days) => now - days * DAY - Math.floor(r() * DAY);

  const dir = (parent, name, flags = 0) => { nodes.push({ parent, name, size: 0, mtime: ago(between(1, 400)), flags: F_DIR | flags, type: 0 }); return nodes.length - 1; };
  const file = (parent, name, size, type, mtime = ago(between(1, 700)), flags = 0) => { nodes.push({ parent, name, size: Math.round(size), mtime, flags, type }); return nodes.length - 1; };
  const path = (parent, ...names) => names.reduce((p, n) => dir(p, n), parent);
  // `count` files whose sizes add up to roughly `total`, with a long tail like real folders.
  const spread = (parent, count, total, type, name, ages = [1, 700]) => {
    const w = Array.from({ length: count }, () => Math.pow(r(), 2.2) + 0.02);
    const sum = w.reduce((a, b) => a + b, 0);
    w.forEach((x, k) => file(parent, name(k), (x / sum) * total, type, ago(between(ages[0], ages[1]))));
  };

  // ── Users\alex ──
  const alex = path(0, 'Users', 'alex');
  const videos = dir(alex, 'Videos');
  const obs = dir(videos, 'OBS');
  file(obs, 'rec_2026-09-28.mkv', 48.2 * GB, T.video, ago(29));
  file(obs, 'rec_2026-10-19.mkv', 31.4 * GB, T.video, ago(8));
  file(videos, 'stream_archive_q3.mkv', 22.1 * GB, T.video, ago(110));
  spread(dir(obs, 'clips'), 36, 6.5 * GB, T.video, (k) => `clip_${String(k + 1).padStart(3, '0')}.mp4`, [5, 300]);

  const pics = dir(alex, 'Pictures');
  for (const y of ['2024', '2025', '2026']) {
    spread(path(pics, 'Camera Roll', y), 700, 3.1 * GB, T.image, (k) => `IMG_${y.slice(2)}${String(k + 1000)}.jpg`, y === '2026' ? [1, 300] : [300, 700]);
  }
  spread(dir(pics, 'Screenshots'), 420, 2.6 * GB, T.image, (k) => `Screenshot ${2024 + (k % 3)}-${String((k % 12) + 1).padStart(2, '0')}-${String((k % 28) + 1).padStart(2, '0')} ${k}.png`);
  const exportDir = dir(pics, 'Export');
  spread(exportDir, 160, 1.4 * GB, T.image, (k) => `export_${k}.jpg`);
  const lr = dir(pics, 'Lightroom');
  file(lr, 'Lightroom Catalog.lrcat', 1.1 * GB, T.image, ago(2));
  spread(dir(lr, 'Lightroom Catalog Previews.lrdata'), 900, 8.0 * GB, T.image, (k) => `${(k * 2654435761 >>> 0).toString(16)}.lrprev`, [2, 400]);

  const appdata = dir(alex, 'AppData', F_HIDDEN);
  const local = dir(appdata, 'Local');
  spread(dir(local, 'Temp'), 3200, 11.2 * GB, T.system, (k) => `${pick(['tmp', '~DF', 'msi', 'chrome_'])}${(k * 7919).toString(16).toUpperCase()}.tmp`, [31, 400]);
  const chrome = path(local, 'Google', 'Chrome', 'User Data', 'Default');
  spread(path(chrome, 'Cache', 'Cache_Data'), 900, 0.42 * GB, T.other, (k) => `f_${String(k).padStart(6, '0')}`);
  spread(dir(chrome, 'Code Cache'), 300, 0.18 * GB, T.other, (k) => `${(k * 104729).toString(16)}_0`);
  spread(path(local, 'Spotify', 'Storage'), 600, 4.8 * GB, T.audio, (k) => `${(k * 15485863).toString(16)}.file`);
  spread(path(local, 'NVIDIA', 'DXCache'), 120, 2.1 * GB, T.other, (k) => `${(k * 179424673).toString(16)}.nvph`);
  spread(dir(local, 'CrashDumps'), 4, 0.6 * GB, T.system, (k) => `Game.exe.${1200 + k}.dmp`, [40, 200]);
  spread(path(local, 'Discord', 'Cache'), 400, 0.9 * GB, T.other, (k) => `data_${k}`);
  spread(path(appdata, 'Roaming', 'Code', 'User'), 80, 0.12 * GB, T.code, (k) => `state_${k}.json`);

  const projects = dir(alex, 'Projects');
  const projNames = ['portfolio', 'shop-frontend', 'api-gateway', 'design-system', 'blog', 'admin-panel', 'chat-app', 'landing', 'docs-site', 'mobile-web', 'analytics', 'cli-tools', 'game-jam', 'weather-app'];
  for (const name of projNames) {
    const p = dir(projects, name);
    file(p, 'package.json', 2 * KB, T.code, ago(between(1, 200)));
    spread(dir(p, 'src'), 40, between(2, 12) * MB, T.code, (k) => `module${k}.ts`);
    const nm = dir(p, 'node_modules');
    for (const pkg of ['react', 'typescript', 'webpack', 'esbuild', '@babel', 'lodash', 'next', 'eslint']) {
      spread(dir(nm, pkg), 30, between(15, 90) * MB, T.code, (k) => `index${k}.js`);
    }
  }
  const rust = dir(projects, 'rust-cli');
  file(rust, 'Cargo.toml', 1 * KB, T.code);
  spread(path(rust, 'target', 'debug', 'deps'), 260, 1.8 * GB, T.code, (k) => `lib${k}.rlib`, [3, 60]);
  const py = dir(projects, 'ml-notebook');
  const venv = dir(py, '.venv');
  file(venv, 'pyvenv.cfg', 300, T.other);
  spread(path(venv, 'Lib', 'site-packages'), 400, 0.9 * GB, T.code, (k) => `mod_${k}.py`);

  const downloads = dir(alex, 'Downloads');
  file(downloads, 'Win11_x64.iso', 6.2 * GB, T.archive, ago(240));
  file(downloads, 'backup_2026-08.zip', 2.2 * GB, T.archive, ago(70));
  file(downloads, 'VSCodeUserSetup-x64.exe', 98 * MB, T.app, ago(150));
  file(downloads, 'node-v22-x64.msi', 31 * MB, T.archive, ago(120));
  file(downloads, 'SteamSetup.exe', 2.3 * MB, T.app, ago(300));
  file(downloads, 'DiscordSetup.exe', 112 * MB, T.app, ago(90));
  spread(dir(downloads, 'misc'), 140, 3.1 * GB, T.archive, (k) => `${pick(['assets', 'export', 'photos', 'invoice', 'dataset'])}_${k}.${pick(['zip', '7z', 'zip', 'pdf'])}`);

  const docs = dir(alex, 'Documents');
  spread(docs, 520, 3.4 * GB, T.doc, (k) => `${pick(['Report', 'Invoice', 'Notes', 'Budget', 'Slides'])} ${k}.${pick(['pdf', 'docx', 'xlsx', 'pptx'])}`);
  file(dir(docs, 'Backups'), 'backup_2026-08.zip', 2.2 * GB, T.archive, ago(75));
  spread(dir(alex, 'Music'), 380, 2.4 * GB, T.audio, (k) => `Track ${k + 1}.${pick(['mp3', 'flac', 'mp3'])}`);
  spread(dir(alex, 'Desktop'), 30, 0.3 * GB, T.doc, (k) => `notes_${k}.${pick(['txt', 'pdf', 'png'])}`);

  // ── Games ──
  const steamapps = path(0, 'Games', 'SteamLibrary', 'steamapps');
  const common = dir(steamapps, 'common');
  for (const [name, gb] of [['Open-World RPG', 42.6], ['Racing Sim', 28.3], ['Battle Royale', 18.4], ['Survival Sandbox', 12.1], ['Card Roguelike', 4.2]]) {
    const g = dir(common, name);
    const paks = path(g, 'Content', 'Paks');
    const pakCount = Math.max(2, Math.round(gb / 6));
    spread(paks, pakCount, gb * 0.78 * GB, T.app, (k) => `pakchunk${k}-Windows.pak`, [10, 200]);
    spread(path(g, 'Content', 'Movies'), 24, gb * 0.08 * GB, T.app, (k) => `cinematic_${k}.bik`);
    spread(path(g, 'Binaries', 'Win64'), 60, gb * 0.04 * GB, T.app, (k) => (k === 0 ? `${name.replace(/\W/g, '')}.exe` : `lib${k}.dll`));
    spread(path(g, 'Content', 'Assets'), 700, gb * 0.10 * GB, T.app, (k) => `asset_${k}.uasset`);
  }
  spread(dir(steamapps, 'shadercache'), 300, 3.4 * GB, T.other, (k) => `${k}.foz`);

  // ── Windows ──
  const win = dir(0, 'Windows');
  spread(dir(win, 'WinSxS'), 5200, 14.1 * GB, T.app, (k) => `${pick(['amd64_microsoft-windows', 'x86_netfx4', 'wow64_microsoft-windows'])}-${k}.${pick(['dll', 'dll', 'mum', 'cat', 'manifest'])}`);
  spread(dir(win, 'System32'), 3800, 9.3 * GB, T.app, (k) => `${pick(['win', 'nt', 'd3d', 'msvc', 'shell', 'kernel'])}${k}.${pick(['dll', 'dll', 'exe', 'sys', 'mui'])}`);
  spread(dir(win, 'Installer'), 180, 7.2 * GB, T.archive, (k) => `${(k * 2246822519 >>> 0).toString(16)}.${pick(['msi', 'msp'])}`);
  spread(path(win, 'SoftwareDistribution', 'Download'), 90, 4.4 * GB, T.archive, (k) => `${(k * 3266489917 >>> 0).toString(16)}.${pick(['cab', 'psf', 'esd'])}`, [20, 90]);
  spread(dir(win, 'Fonts'), 400, 1.2 * GB, T.other, (k) => `font${k}.ttf`);
  spread(dir(win, 'Logs'), 600, 1.9 * GB, T.system, (k) => `${pick(['CBS', 'DISM', 'WindowsUpdate'])}_${k}.${pick(['log', 'etl'])}`);
  spread(dir(win, 'Temp'), 300, 0.8 * GB, T.system, (k) => `tmp${k}.tmp`, [10, 200]);

  // ── Program Files ──
  const pf = dir(0, 'Program Files');
  for (const [name, gb] of [['Adobe', 4.1], ['Microsoft Office', 3.6], ['NVIDIA Corporation', 1.9], ['Docker', 2.2], ['Blender Foundation', 1.4], ['Mozilla Firefox', 0.4]]) {
    spread(dir(pf, name), 260, gb * GB, T.app, (k) => `${pick(['app', 'core', 'plugin', 'res'])}${k}.${pick(['dll', 'exe', 'dat', 'pak'])}`);
  }
  const pfx = dir(0, 'Program Files (x86)');
  for (const [name, gb] of [['Steam', 1.6], ['Microsoft', 1.2], ['Common Files', 0.7]]) {
    spread(dir(pfx, name), 200, gb * GB, T.app, (k) => `${name.split(' ')[0].toLowerCase()}${k}.${pick(['dll', 'exe'])}`);
  }
  const pd = dir(0, 'ProgramData', F_HIDDEN);
  file(path(pd, 'DockerDesktop', 'vm-data'), 'ext4.vhdx', 9.6 * GB, T.archive, ago(1));
  spread(dir(pd, 'Package Cache'), 120, 2.1 * GB, T.archive, (k) => `pkg${k}.msi`);

  // ── dev ──
  const dev = dir(0, 'dev');
  const webapp = dir(dev, 'webapp');
  file(webapp, 'package.json', 3 * KB, T.code);
  spread(dir(webapp, 'node_modules'), 900, 3.1 * GB, T.code, (k) => `dep${k}.js`);
  spread(dir(webapp, 'vendor'), 300, 3.9 * GB, T.code, (k) => `bundle${k}.js`);
  file(dev, 'docker-images.tar', 5.6 * GB, T.archive, ago(160));
  spread(dir(dev, 'side-project'), 200, 2.4 * GB, T.code, (k) => `file${k}.${pick(['ts', 'json', 'wasm'])}`);
  spread(dir(dev, 'datasets'), 40, 2.2 * GB, T.doc, (k) => `table_${k}.csv`);

  // ── root files ──
  file(0, 'pagefile.sys', 16.0 * GB, T.system, ago(0), F_HIDDEN | F_SYSTEM);
  file(0, 'hiberfil.sys', 12.8 * GB, T.system, ago(0), F_HIDDEN | F_SYSTEM);
  file(0, 'swapfile.sys', 256 * MB, T.system, ago(0), F_HIDDEN | F_SYSTEM);

  return nodes;
}

export function encodeScan(nodes, header) {
  let files = 0, dirs = 0, bytes = 0;
  for (const n of nodes) { if (n.flags & F_DIR) dirs++; else { files++; bytes += n.size; } }
  const h = Buffer.from(JSON.stringify({ version: 1, ...header, files, dirs: dirs - 1, bytes, errors: 0 }));
  const names = Buffer.from(nodes.map((n) => n.name).join('\0'), 'utf8');
  const n = nodes.length;
  let head = 8 + 4 + h.length;
  const pad = (8 - (head % 8)) % 8;
  const buf = Buffer.alloc(head + pad + 8 + n * (8 + 8 + 4 + 1 + 1) + 4 + names.length);
  let o = 0;
  buf.write('STRATA01', o, 'ascii'); o += 8;
  buf.writeInt32LE(h.length, o); o += 4;
  h.copy(buf, o); o += h.length + pad;
  buf.writeInt32LE(n, o); o += 8;
  for (const x of nodes) { buf.writeDoubleLE(x.size, o); o += 8; }
  for (const x of nodes) { buf.writeDoubleLE(x.mtime, o); o += 8; }
  for (const x of nodes) { buf.writeInt32LE(x.parent, o); o += 4; }
  for (const x of nodes) buf[o++] = x.flags;
  for (const x of nodes) buf[o++] = x.type;
  buf.writeInt32LE(names.length, o); o += 4;
  names.copy(buf, o);
  return { buf, files, dirs: dirs - 1, bytes };
}
