// Starts the built app on a small folder tree and waits until it has scanned it and saved the result:
// the window opens, the UI loads, the embedded scanner unpacks and runs, and scan files are written.
//
//   node scripts/smoke-test.js [path to the strata executable]      (Linux needs a display: xvfb-run -a node …)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const exe = process.argv[2] || path.join(root, 'src', 'app', 'target', 'release', process.platform === 'win32' ? 'strata.exe' : 'strata');
if (!fs.existsSync(exe)) { console.error(`No executable at ${exe}`); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-smoke-'));
const tree = path.join(tmp, 'tree');
fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
fs.writeFileSync(path.join(tree, 'one.bin'), Buffer.alloc(300000, 1));
fs.writeFileSync(path.join(tree, 'a', 'two.bin'), Buffer.alloc(200000, 2));
fs.writeFileSync(path.join(tree, 'a', 'b', 'three.txt'), 'hello');
const data = path.join(tmp, 'data');
const pending = Buffer.from(JSON.stringify({ root: tree, options: { mft: false, hidden: true, links: false } })).toString('base64');

let log = '';
const app = spawn(exe, [`--strata-scan=${pending}`], { env: { ...process.env, STRATA_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
app.stdout.on('data', (d) => { log += d; });
app.stderr.on('data', (d) => { log += d; });
let exited = null;
app.on('exit', (code) => { exited = code; });

const index = path.join(data, 'scans', 'index.json');
const started = Date.now();
(async () => {
  while (Date.now() - started < 90000) {
    if (exited !== null) break;
    try {
      const list = JSON.parse(fs.readFileSync(index, 'utf8'));
      if (list.length && list[0].files === 3 && list[0].bytes >= 500000) {
        console.log(`Smoke test passed: scanned ${list[0].files} files, ${list[0].bytes} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
        finish(0);
        return;
      }
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(exited !== null ? `The app exited early (code ${exited}).` : 'Timed out waiting for the scan.');
  console.error(log.split('\n').filter((l) => !/libEGL|DRI3/.test(l)).join('\n'));
  finish(1);
})();

function finish(code) {
  try { app.kill(); } catch { /* gone */ }
  // WebView2 can still hold its profile files for a moment on Windows; the result is already known, so a leftover temp folder isn't a failure.
  setTimeout(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.warn(`Couldn't remove ${tmp}: ${e.code}`); }
    process.exit(code);
  }, 500);
}
