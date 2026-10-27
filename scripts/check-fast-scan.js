// Windows, as administrator: checks that the NTFS fast scan (--mft) finds the same tree as a normal folder walk,
// item by item (scripts/compare-scans.js), on a generated folder on the system drive. Then times a full fast scan.
//
//   node scripts/check-fast-scan.js [--scanner bin/strata-scan.exe] [--bench]
//
// Elsewhere, or without administrator rights, it says so and exits successfully.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { compareScans } = require('./compare-scans');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const k = args.indexOf('--scanner');
const SCANNER = path.resolve(k >= 0 ? args[k + 1] : path.join(ROOT, 'bin', 'strata-scan.exe'));
const BENCH = args.includes('--bench');

if (process.platform !== 'win32') { console.log('The fast scan is Windows only: nothing to check.'); process.exit(0); }
try { execFileSync('net', ['session'], { stdio: 'ignore' }); } catch { console.log('Not administrator: the fast scan is not checked.'); process.exit(0); }

// On the system drive (NTFS), so the fast scan can read it.
const drive = `${process.env.SystemDrive || 'C:'}\\`;
const tmp = fs.mkdtempSync(path.join(drive, 'strata-fast-scan-'));
const outDir = path.join(tmp, '_out');
fs.mkdirSync(outDir);
let failures = 0;

function scan(root, out, flags) {
  return new Promise((resolve, reject) => {
    const a = ['scan', root, out, ...flags];
    const p = spawn(SCANNER, a, { windowsHide: true });
    let buf = '', err = '', done = null, notice = null;
    const t0 = process.hrtime.bigint();
    p.stdout.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n); buf = buf.slice(n + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.type === 'done') done = m;
        if (m.type === 'notice') notice = m.message;
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0 || !done) reject(new Error(`scan ${a.join(' ')}: exit ${code} ${err}`));
      else resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, method: done.method, notice });
    });
  });
}

let seq = 0;
async function compare(label, root, flags) {
  const walk = path.join(outDir, `${++seq}-walk.strata`), mft = path.join(outDir, `${seq}-mft.strata`);
  const rw = await scan(root, walk, flags);
  const rm = await scan(root, mft, ['--mft', ...flags]);
  if (rm.method !== 'MFT') {
    console.log(`✗ ${label}: the fast scan wasn't used (${rm.notice || 'no notice'})`);
    failures++;
    return;
  }
  const r = compareScans(walk, mft);
  console.log(`${r.ok ? '✓' : '✗'} ${label}: ${r.nodes[0]} / ${r.nodes[1]} items, ${r.diffs.length} difference(s) — walk ${Math.round(rw.ms)} ms, fast ${Math.round(rm.ms)} ms`);
  if (!r.ok) { for (const d of r.diffs.slice(0, 30)) console.log(`    ${d}`); failures++; }
}

const write = (rel, bytes, fill = 0x61) => {
  const p = path.join(tmp, 'tree', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, fill));
  return p;
};

// No hard links: the fast scan shows a hard-linked file once, a folder walk once per name.
function buildTree() {
  const t = path.join(tmp, 'tree');
  for (let n = 0; n < 300; n++) write(`spread/d${n % 17}/e${n % 5}/f${n}.${['txt', 'mp4', 'zip', 'js', 'png', 'dat'][n % 6]}`, (n * 7919) % 50000);
  write('deep/' + Array.from({ length: 30 }, (_, i) => `level${i}`).join('/') + '/bottom.bin', 1234);
  write('names/café \u{1F600} 中文.txt', 10);
  write('names/with space and.dots.tar.gz', 10);
  write('empty-file', 0);
  fs.mkdirSync(path.join(t, 'empty-dir'));
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.writeFileSync(path.join(tmp, 'outside', 'x.dat'), Buffer.alloc(777));
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(t, 'junction-out'), 'junction');
  fs.symlinkSync(t, path.join(t, 'deep', 'junction-loop'), 'junction');
  // Paths over 260 characters.
  write('long/' + Array.from({ length: 12 }, (_, i) => `a-rather-long-folder-name-${i}`).join('/') + '/long-file.txt', 4321);
  const h = write('attrs/hidden.txt', 11), sys = write('attrs/system.txt', 12), ro = write('attrs/readonly.txt', 13);
  execFileSync('attrib', ['+h', h]);
  execFileSync('attrib', ['+s', sys]);
  execFileSync('attrib', ['+r', ro]);
  const hd = path.join(t, 'attrs', 'hidden-dir');
  fs.mkdirSync(hd);
  fs.writeFileSync(path.join(hd, 'inside.txt'), 'x');
  execFileSync('attrib', ['+h', hd]);
  try { execFileSync('compact', ['/c', '/q', write('attrs/compressed.txt', 100000)], { stdio: 'ignore' }); } catch { /* not supported */ }
  return t;
}

async function main() {
  const tree = buildTree();
  await compare('fast scan vs folder walk', tree, []);
  await compare('fast scan vs folder walk, --hidden', tree, ['--hidden']);
  if (BENCH) {
    const runs = [];
    for (let n = 0; n < 2; n++) runs.push((await scan(drive, path.join(outDir, 'drive.strata'), ['--mft', '--hidden'])).ms);
    console.log(`⏱ fast scan of ${drive}: ${Math.round(Math.min(...runs))} ms`);
  }
}

main().then(
  () => { fs.rmSync(tmp, { recursive: true, force: true }); if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); } console.log('Fast scan matches the folder walk.'); },
  (e) => { fs.rmSync(tmp, { recursive: true, force: true }); console.error(e); process.exit(1); },
);
