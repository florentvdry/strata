// Runs the Rust scanner and the scanner it replaces on the same folders and compares the scan files item by item
// (scripts/compare-scans.js). On Windows, as administrator, it also compares the NTFS fast scan with a normal walk.
//
//   node scripts/parity.js <legacy scanner> [--scanner bin/strata-scan] [--bench] [--live]
//
// <legacy scanner>  bin/StrataScan.exe on Windows, scanner/linux/strata-scan.js on Linux
// --bench           also times both on a generated tree of 200,000 files (and, on Windows as admin, a full fast scan of C:)
// --live            also compares live system folders (/usr, C:\Windows\System32), with a small tolerance
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareScans } = require('./compare-scans');
const { parseStrata } = require('./lib/strata-file');

const IS_WIN = process.platform === 'win32';
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const k = args.indexOf(name); if (k < 0) return def; const v = args[k + 1]; args.splice(k, 2); return v; };
const NEW = path.resolve(opt('--scanner', path.join(ROOT, 'bin', IS_WIN ? 'strata-scan.exe' : 'strata-scan')));
const BENCH = args.includes('--bench');
const LIVE = args.includes('--live');
const LEGACY = args.find((a) => !a.startsWith('--')) && path.resolve(args.find((a) => !a.startsWith('--')));
if (!LEGACY) { console.error('Usage: node scripts/parity.js <legacy scanner> [--scanner path] [--bench] [--live]'); process.exit(2); }

// On Windows the tree goes on the system drive, so the fast scan (C: is NTFS) can be compared too.
const base = IS_WIN ? path.join(process.env.SystemDrive || 'C:', '\\') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(base, 'strata-parity-'));
const outDir = path.join(tmp, '_out');
fs.mkdirSync(outDir);
let failures = 0;

function scan(scanner, root, out, flags) {
  return new Promise((resolve, reject) => {
    const a = ['scan', root, out, ...flags];
    const p = scanner.endsWith('.js') ? spawn(process.execPath, [scanner, ...a]) : spawn(scanner, a, { windowsHide: true });
    let buf = '', err = '', done = null, notice = null;
    const t0 = process.hrtime.bigint();
    p.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.type === 'done') done = m;
        if (m.type === 'notice') notice = m.message;
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (code !== 0 || !done) reject(new Error(`${path.basename(scanner)} ${a.join(' ')}: exit ${code} ${err}`));
      else resolve({ ms, method: done.method, notice });
    });
  });
}

let seq = 0;
async function compare(label, root, flagsA, flagsB = flagsA, { a = LEGACY, b = NEW, tolerance = 0, expectB } = {}) {
  const fa = path.join(outDir, `${++seq}a.strata`), fb = path.join(outDir, `${seq}b.strata`);
  const ra = await scan(a, root, fa, flagsA);
  const rb = await scan(b, root, fb, flagsB);
  if (expectB && rb.method !== expectB) {
    console.log(`✗ ${label}: expected method ${expectB}, got ${rb.method} (${rb.notice || 'no notice'})`);
    failures++;
    return;
  }
  const r = compareScans(fa, fb, { tolerance, ignoreReplacement: true });
  console.log(`${r.ok ? '✓' : '✗'} ${label}: ${r.nodes[0]} / ${r.nodes[1]} items, ${r.diffs.length} difference(s)` +
    `${tolerance ? ` (tolerance ${tolerance})` : ''} — ${Math.round(ra.ms)} ms vs ${Math.round(rb.ms)} ms`);
  if (!r.ok) { for (const d of r.diffs.slice(0, 30)) console.log(`    ${d}`); failures++; }
}

const write = (rel, bytes, fill = 0x61) => {
  const p = path.join(tmp, 'tree', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, fill));
  return p;
};

function buildTree() {
  const t = path.join(tmp, 'tree');
  for (let k = 0; k < 300; k++) write(`spread/d${k % 17}/e${k % 5}/f${k}.${['txt', 'mp4', 'zip', 'js', 'png', 'dat'][k % 6]}`, (k * 7919) % 50000);
  write('deep/' + Array.from({ length: 30 }, (_, i) => `level${i}`).join('/') + '/bottom.bin', 1234);
  write('names/caf\u00e9 \u{1F600} \u4e2d\u6587.txt', 10);
  write('names/with space and.dots.tar.gz', 10);
  write('empty-file', 0);
  fs.mkdirSync(path.join(t, 'empty-dir'));
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.writeFileSync(path.join(tmp, 'outside', 'x.dat'), Buffer.alloc(777));
  if (IS_WIN) {
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
    try { execFileSync('compact', ['/c', '/q', write('attrs/compressed.txt', 100000)], { stdio: 'ignore' }); } catch { /* not NTFS */ }
  } else {
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(t, 'link-out'));
    fs.symlinkSync(t, path.join(t, 'deep', 'link-loop'));
    fs.symlinkSync(path.join(t, 'nowhere'), path.join(t, 'broken-link'));
    fs.symlinkSync(path.join(t, 'spread'), path.join(t, 'link-to-spread'));
    write('hard/a.bin', 9000);
    fs.linkSync(path.join(t, 'hard/a.bin'), path.join(t, 'hard/b.bin'));
    // Sparse: 10 MB long, nothing allocated.
    const sp = path.join(t, 'sparse.img');
    fs.closeSync(fs.openSync(sp, 'w'));
    fs.truncateSync(sp, 10 * 1024 * 1024);
    write('.hidden-dir/inside.txt', 5);
    write('.hidden-file', 6);
    // Names that aren't valid UTF-8: the old scanner can't stat them and leaves them out; the new one keeps them.
    try { fs.writeFileSync(Buffer.from(path.join(t, 'names') + '/bad-\xff-name.txt', 'latin1'), 'x'); } catch { /* fs refuses */ }
    if (process.getuid && process.getuid() !== 0) {
      const denied = path.join(t, 'denied');
      fs.mkdirSync(denied);
      fs.writeFileSync(path.join(denied, 'secret'), 'x');
      fs.chmodSync(denied, 0);
    }
    // A file system mounted inside the tree is listed but not entered (needs root, e.g. sudo in CI).
    if (process.env.STRATA_PARITY_MOUNT) {
      const m = path.join(t, 'mounted');
      fs.mkdirSync(m);
      try { execFileSync('sudo', ['-n', 'mount', '-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', m]); fs.writeFileSync(path.join(t, '.mounted'), m); } catch (e) { console.log(`(no nested mount: ${e.message.split('\n')[0]})`); }
    }
  }
  return t;
}

function buildBig(count) {
  const t = path.join(tmp, 'big');
  const perDir = 500;
  for (let d = 0; d < count / perDir; d++) {
    const dir = path.join(t, `g${d % 20}`, `d${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < perDir; k++) fs.writeFileSync(path.join(dir, `file${k}.${k % 3 ? 'txt' : 'bin'}`), '');
  }
  return t;
}

function isAdmin() {
  if (!IS_WIN) return false;
  try { execFileSync('net', ['session'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function main() {
  console.log(`Legacy: ${path.relative(ROOT, LEGACY)}   New: ${path.relative(ROOT, NEW)}`);
  const tree = buildTree();
  await compare('tree', tree, []);
  await compare('tree --hidden', tree, ['--hidden']);
  await compare('tree --hidden --links', tree, ['--hidden', '--links']);

  if (IS_WIN && isAdmin()) {
    await compare('tree: fast scan, new vs legacy', tree, ['--mft', '--hidden'], ['--mft', '--hidden'], { expectB: 'MFT' });
    await compare('tree: fast scan vs folder walk (new)', tree, ['--hidden'], ['--mft', '--hidden'], { a: NEW, expectB: 'MFT' });
    await compare('tree: fast scan vs folder walk, no hidden (new)', tree, [], ['--mft'], { a: NEW, expectB: 'MFT' });
  } else if (IS_WIN) {
    console.log('(not administrator: fast scan not compared)');
  }

  if (LIVE) {
    if (IS_WIN) await compare('C:\\Windows\\System32 --hidden', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), ['--hidden'], ['--hidden'], { tolerance: 50 });
    else {
      await compare('/usr --hidden', '/usr', ['--hidden'], ['--hidden'], { tolerance: 5 });
      await compare('home', os.homedir(), [], [], { tolerance: 50 });
    }
  }

  if (BENCH) {
    const big = buildBig(200000);
    const time = async (scanner, flags = []) => {
      const runs = [];
      for (let k = 0; k < 3; k++) runs.push((await scan(scanner, big, path.join(outDir, 'bench.strata'), flags)).ms);
      return runs.sort((x, y) => x - y)[1];
    };
    const tl = await time(LEGACY), tn = await time(NEW);
    report('200,000 files', tl, tn);
    if (IS_WIN && isAdmin()) {
      const c = `${process.env.SystemDrive || 'C:'}\\`;
      const one = async (s) => (await scan(s, c, path.join(outDir, 'c.strata'), ['--mft', '--hidden'])).ms;
      const ml = Math.min(await one(LEGACY), await one(LEGACY)), mn = Math.min(await one(NEW), await one(NEW));
      report(`fast scan of ${c}`, ml, mn);
    }
  }
}

function report(label, legacy, rust) {
  const ratio = rust / legacy;
  console.log(`⏱ ${label}: legacy ${Math.round(legacy)} ms, new ${Math.round(rust)} ms (${ratio < 1 ? `${(1 / ratio).toFixed(2)}× faster` : `${ratio.toFixed(2)}× slower`})`);
  if (ratio > 1.1 && process.env.GITHUB_ACTIONS) console.log(`::warning::${label}: the new scanner took ${ratio.toFixed(2)}× as long as the old one`);
}

function cleanup() {
  const marker = path.join(tmp, 'tree', '.mounted');
  if (fs.existsSync(marker)) { try { execFileSync('sudo', ['-n', 'umount', fs.readFileSync(marker, 'utf8')]); } catch { /* keep going */ } }
  const denied = path.join(tmp, 'tree', 'denied');
  if (fs.existsSync(denied)) fs.chmodSync(denied, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(
  () => { cleanup(); if (failures) { console.log(`${failures} comparison(s) failed`); process.exit(1); } console.log('Same results.'); },
  (e) => { cleanup(); console.error(e); process.exit(1); },
);
