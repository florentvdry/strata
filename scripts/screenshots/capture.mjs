// Regenerates docs/screenshots/*.png from a made-up drive, so no real files end up in the docs.
// Usage: npm run screenshots   (needs Node 22+ for the built-in WebSocket)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { buildDemo, encodeScan } from './demo-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 9347;
const GB = 1024 ** 3, TB = 1024 ** 4;
const electron = createRequire(import.meta.url)('electron');

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-scanner.js'), '--if-missing'], { stdio: 'inherit' });
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-shots-'));

// ── demo data ──
const now = Date.UTC(2026, 9, 27, 0, 12) / 1000;
const nodes = buildDemo(now);
const DISK = 476 * GB;
let total = 0;
for (const n of nodes) total += n.size;
const used = total + 3.2 * GB;
const { buf } = encodeScan(nodes, { root: 'C:\\', fs: 'NTFS', cluster: 4096, total: DISK, free: DISK - used, method: 'MFT', scannedAt: Date.now() - 6 * 60 * 1000, duration: 41, partial: false, options: { mft: true, hidden: true, links: false } });

const drives = [
  { letter: 'C', root: 'C:\\', label: '', fs: 'NTFS', total: DISK, free: DISK - used, kind: 'Fixed', bus: 'NVMe', media: 'SSD', cluster: 4096, system: true },
  { letter: 'D', root: 'D:\\', label: 'Data', fs: 'NTFS', total: 2 * TB, free: 0.84 * TB, kind: 'Fixed', bus: 'SATA', media: 'SSD', cluster: 4096, system: false },
  { letter: 'E', root: 'E:\\', label: 'Backup', fs: 'exFAT', total: 1 * TB, free: 0.068 * TB, kind: 'Fixed', bus: 'USB', media: 'HDD', cluster: 131072, system: false },
];
const recent = [
  { id: 'demo-c', root: 'C:\\', scannedAt: Date.now() - 6 * 60 * 1000, bytes: total, method: 'MFT' },
  { id: 'demo-d', root: 'D:\\Media', scannedAt: Date.now() - 26 * 3600 * 1000, bytes: 612 * GB, method: 'MFT' },
  { id: 'demo-dl', root: 'C:\\Users\\alex\\Downloads', scannedAt: Date.now() - 6 * 86400 * 1000, bytes: 18.6 * GB, method: 'Walk' },
];

// Top-level folders as the scanner reports them mid-scan.
const topSize = new Map();
const topOf = new Int32Array(nodes.length);
for (let i = 1; i < nodes.length; i++) {
  topOf[i] = nodes[i].parent === 0 ? i : topOf[nodes[i].parent];
  topSize.set(topOf[i], (topSize.get(topOf[i]) || 0) + nodes[i].size);
}
const state = { Users: [2, 1, 1], Games: [1, 0.55, 2], 'pagefile.sys': [2, 1, 3], 'hiberfil.sys': [2, 1, 3], 'swapfile.sys': [2, 1, 3] };
const tops = [...topSize].map(([i, s]) => {
  const n = nodes[i];
  const [st, part, type] = state[n.name] || [0, 0, 0];
  return { name: n.name, dir: !!(n.flags & 1), bytes: Math.round(s * part), state: st, type };
});
const counted = tops.reduce((a, t) => a + t.bytes, 0);
const scan = {
  id: 'demo', root: 'C:\\', options: { mft: true, hidden: true, links: false }, phase: 'mft', pct: 0.64,
  files: 822406, dirs: 137118, bytes: counted, notice: null, error: null, paused: false, done: false,
  current: 'C:\\Users\\alex\\AppData\\Local\\Packages\\Microsoft.WindowsStore_8wekyb3d8bbwe\\LocalCache\\Roaming\\cache_0042.bin',
  tops, biggest: [
    { path: 'Users\\alex\\Videos\\OBS\\rec_2026-09-28.mkv', size: 48.2 * GB, type: 1 },
    { path: 'Games\\SteamLibrary\\steamapps\\common\\Open-World RPG\\Content\\Paks\\pakchunk0-Windows.pak', size: 9.4 * GB, type: 2 },
    { path: 'pagefile.sys', size: 16 * GB, type: 3 },
  ].sort((a, b) => b.size - a.size),
  startedAt: Date.now() - 27000, pausedAt: 0, pausedTotal: 0,
};
const dupes = [{ size: nodes.find((n) => n.name === 'backup_2026-08.zip').size, verified: true, paths: ['C:\\Users\\alex\\Documents\\Backups\\backup_2026-08.zip', 'C:\\Users\\alex\\Downloads\\backup_2026-08.zip'] }];

// ── drive the app ──
const app = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { env: { ...process.env, STRATA_DATA_DIR: path.join(tmp, 'data') }, stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* starting */ }
    await wait(250);
  }
  throw new Error('Strata did not start');
}
const ws = new WebSocket(await connect());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result.result.value;
};
const inPage = (body) => evaluate(`(async () => { const A = await import('./actions.js'); const { store } = await import('./lib/store.js'); ${body} })()`);
const viewport = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
async function shot(name) {
  await wait(700);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  console.log(`docs/screenshots/${name}.png`);
}

try {
  await send('Page.enable');
  await viewport(1440, 900);
  for (let i = 0; i < 80 && !(await evaluate(`document.body.innerText.includes('What should we map')`)); i++) await wait(250);
  await inPage(`for (let i = 0; i < 40 && !store.state.drives; i++) await new Promise((r) => setTimeout(r, 250));`);
  await inPage(`store.set({ drives: ${JSON.stringify(drives)}, recent: ${JSON.stringify(recent)}, info: { ...store.state.info, admin: false, home: 'C:\\\\Users\\\\alex' } });`);
  await shot('start');

  await inPage(`store.set({ scan: ${JSON.stringify(scan)}, screen: 'scanning' });`);
  await shot('scanning');

  const b64 = buf.toString('base64');
  await inPage(`
    const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
    store.set({ scan: null });
    A.loadTree(bytes, 'demo-c');
    // Let the app's own duplicate search (which can't read the made-up files) finish before injecting results.
    for (let i = 0; i < 80 && ['pending', 'running'].includes(store.state.dupes.status); i++) await new Promise((r) => setTimeout(r, 250));
    store.set({ dupes: { status: 'done', pct: 1, groups: ${JSON.stringify(dupes)} } });
    A.rebuildCleanup();
    const tr = store.state.tree;
    A.select(tr.lookup('C:\\\\Users\\\\alex\\\\Videos\\\\OBS\\\\rec_2026-09-28.mkv'), { reveal: false });
    const open = new Set([0, tr.lookup('C:\\\\Users')]);
    store.set({ ex: { ...store.state.ex, open }, screen: 'explorer' });
  `);
  await viewport(1440, 1080);
  await shot('explorer');
  await inPage(`await A.setView('sunburst');`);
  await shot('sunburst');
  await inPage(`await A.setView('columns');`);
  await shot('columns');
  await inPage(`await A.setView('treemap'); A.setQuery('*.mkv >1 GB');`);
  await evaluate(`document.querySelector('input[type=search]').value = '*.mkv >1 GB'`);
  await shot('search');
  await inPage(`A.setQuery(''); A.go('cleanup');`);
  await evaluate(`document.querySelector('input[type=search]') && (document.querySelector('input[type=search]').value = '')`);
  await viewport(1440, 900);
  await shot('cleanup');
} finally {
  ws.close();
  app.kill();
  await wait(500);
  fs.rmSync(tmp, { recursive: true, force: true });
}
