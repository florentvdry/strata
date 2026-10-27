// Regenerates docs/screenshots/*.png from a made-up drive, so no real files end up in the docs.
// Usage: npm run screenshots   (needs Playwright with Chromium: npm i --no-save playwright && npx playwright install chromium)
// The UI runs in Chromium with a stand-in for the app's bridge (window.strata) that serves the made-up drive.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { buildDemo, encodeScan } from './demo-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const GB = 1024 ** 3, TB = 1024 ** 4;
fs.mkdirSync(OUT, { recursive: true });

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

// ── serve the UI and open it with a stand-in bridge ──
const { chromium } = createRequire(import.meta.url)('playwright');
const UI = path.join(ROOT, 'src', 'renderer');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(UI, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
  if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const bridge = `(() => {
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const none = () => () => {};
  const settings = { accent: '#C6F432', shading: true, scan: { mft: true, hidden: true, links: false }, view: 'treemap', updates: { check: false, channel: 'stable', lastCheck: 0, skipped: '' }, lastSeenVersion: '0.2.0' };
  window.strata = {
    platform: 'win32',
    appInfo: async () => ({ admin: false, version: '0.2.0', user: 'alex', home: 'C:\\\\Users\\\\alex', temp: 'C:\\\\Temp', platform: 'win32', portable: false }),
    drives: async () => ${JSON.stringify(drives)}, settings: async () => settings, saveSettings: async (p) => Object.assign(settings, p),
    recent: async () => ${JSON.stringify(recent)}, pendingScan: async () => null, loadScan: async () => b64('${buf.toString('base64')}'),
    findDupes: async () => [], stat: async () => ({ isDir: true, size: 0 }), exists: async () => true, history: async () => [],
    onScan: none, onDupes: none, onDeleteProgress: none, onUpdate: none, onFileDrop: none,
    updateState: async () => ({ phase: 'idle', mode: 'installer', configured: true, current: '0.2.0' }),
  };
})();`;

fs.writeFileSync("/tmp/bridge-out.js", bridge);
const browser = await chromium.launch();
const page = await (await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(bridge);
page.on('pageerror', (e) => console.error('page error:', e.message));
page.on('requestfailed', (r) => console.error('failed:', r.url()));
page.on('response', (r) => { if (r.status() >= 400) console.error(r.status(), r.url()); });
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => page.evaluate(expression);
const inPage = (body) => evaluate(`(async () => { const A = await import('./actions.js'); const { store } = await import('./lib/store.js'); ${body} })()`);
const viewport = (width, height) => page.setViewportSize({ width, height });
async function shot(name) {
  await wait(700);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`docs/screenshots/${name}.png`);
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.body.innerText.includes('What should we map'), null, { timeout: 20000 }).catch(async (e) => { console.error(await page.evaluate(() => document.body.innerText.slice(0, 300))); throw e; });
  await inPage(`for (let i = 0; i < 40 && !store.state.drives; i++) await new Promise((r) => setTimeout(r, 250));`);
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
  await browser.close();
  server.close();
}
