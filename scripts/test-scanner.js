// End-to-end checks for a scanner: builds a small folder tree in a temp folder, then runs info, scan, snapshot,
// pause/resume/stop, dupes, delete (Recycle Bin or Trash, and permanent), trash-list and restore, and checks the
// messages and the .strata file.
//
//   node scripts/test-scanner.js [scanner]
//
// [scanner] defaults to bin/strata-scan(.exe). The scanners being replaced can be checked too, for comparison:
// bin/StrataScan.exe (Windows) and scanner/linux/strata-scan.js (Linux). They don't have trash-list and restore.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { parseStrata } = require('./lib/strata-file');

const IS_WIN = process.platform === 'win32';
const ROOT = path.join(__dirname, '..');
const SCANNER = path.resolve(process.argv[2] || path.join(ROOT, 'bin', IS_WIN ? 'strata-scan.exe' : 'strata-scan'));
const IS_JS = SCANNER.endsWith('.js');
const LEGACY = IS_JS || /StrataScan\.exe$/i.test(SCANNER);

if (!fs.existsSync(SCANNER)) { console.error(`Scanner not found: ${SCANNER} (run npm run build:scanner)`); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-test-'));
const dataHome = path.join(tmp, 'xdg');
const env = { ...process.env, XDG_DATA_HOME: dataHome };

function run(args, { onLine, input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = IS_JS ? spawn(process.execPath, [SCANNER, ...args], { env }) : spawn(SCANNER, args, { env, windowsHide: true });
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout: ${args.join(' ')}`)); }, timeout);
    const msgs = [];
    let buf = '', err = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        msgs.push(m);
        if (onLine) onLine(m, p);
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(msgs) : reject(new Error(`exit ${code}: ${err}`)); });
    if (input) p.stdin.write(input);
  });
}

const write = (rel, bytes, fill = 0x61) => {
  const p = path.join(tmp, 'tree', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, fill));
  return p;
};
// Folder links: symlinks on Linux, junctions on Windows (no privilege needed).
const linkDir = (target, at) => fs.symlinkSync(target, at, IS_WIN ? 'junction' : 'dir');
const hide = (p) => { if (IS_WIN) execFileSync('attrib', ['+h', p]); };

async function main() {
  console.log(`Testing ${path.relative(ROOT, SCANNER) || SCANNER}${LEGACY ? ' (legacy scanner)' : ''}`);
  // ── fixture ──
  write('video/movie.mkv', 300000);
  write('video/clip.mp4', 4096);
  write('docs/a/report.pdf', 1000);
  write('docs/a/b/c/deep.txt', 10);
  write('.hidden/secret.bin', 5000);
  hide(path.join(tmp, 'tree', '.hidden'));
  write('dupes/one.zip', 2 * 1024 * 1024, 0x41);
  write('dupes/two.zip', 2 * 1024 * 1024, 0x41);
  write('dupes/other.zip', 2 * 1024 * 1024, 0x42);
  write('lib/libfoo.so.1.2', 2000);
  write('café \u{1F600}/naïve.txt', 7);
  fs.linkSync(path.join(tmp, 'tree/video/clip.mp4'), path.join(tmp, 'tree/video/clip-hardlink.mp4'));
  linkDir(path.join(tmp, 'tree/docs'), path.join(tmp, 'tree/docs-link'));
  linkDir(path.join(tmp, 'tree'), path.join(tmp, 'tree/docs/loop'));
  fs.mkdirSync(path.join(tmp, 'tree/empty'));
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.writeFileSync(path.join(tmp, 'outside/x.dat'), Buffer.alloc(777));
  linkDir(path.join(tmp, 'outside'), path.join(tmp, 'tree/ext-link'));
  const root = path.join(tmp, 'tree');

  // ── errors ──
  await assert.rejects(run([]), /exit 2/, 'no command');
  await assert.rejects(run(['nope']), /exit 2/, 'unknown command');
  const missing = await run(['scan', path.join(tmp, 'missing'), path.join(tmp, 'x.strata')]).catch((e) => e);
  assert.ok(missing instanceof Error && /exit 1/.test(missing.message), 'missing folder exits with 1');

  // ── info ──
  const [inf] = await run(['info']);
  assert.strictEqual(inf.type, 'info');
  assert.strictEqual(typeof inf.admin, 'boolean');
  assert.ok(Array.isArray(inf.drives) && inf.drives.length > 0, 'at least one drive');
  for (const d of inf.drives) {
    if (IS_WIN) assert.ok(/^[A-Z]$/.test(d.letter) && d.root === `${d.letter}:\\`, `drive letter: ${JSON.stringify(d)}`);
    else assert.ok(d.letter === null && d.root.startsWith('/'), `drive root: ${JSON.stringify(d)}`);
    assert.ok(d.total > 0 && d.free >= 0 && d.fs && d.cluster > 0 && typeof d.system === 'boolean', `drive fields: ${JSON.stringify(d)}`);
    for (const k of ['label', 'kind', 'bus', 'media']) assert.ok(k in d, `drive has ${k}`);
  }
  assert.ok(inf.drives.some((d) => d.system), 'one drive holds the system');
  if (!LEGACY) assert.ok(Array.isArray(inf.trashDirs), 'trashDirs');
  console.log(`info: ${inf.drives.map((d) => `${d.root} (${d.fs}${d.bus ? `, ${d.bus}` : ''}${d.media ? `, ${d.media}` : ''})`).join(', ')}`);

  // ── scan, without hidden files and links ──
  const out1 = path.join(tmp, 'a.strata');
  const msgs = await run(['scan', root, out1]);
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done && !done.partial && done.method === 'Walk' && done.out === out1, 'done message');
  const s = parseStrata(out1);
  assert.strictEqual(s.names[0], root);
  assert.strictEqual(s.parent[0], -1);
  assert.ok(!s.byPath.has('.hidden'), 'hidden folder skipped without --hidden');
  const mkv = s.byPath.get('video/movie.mkv');
  assert.ok(s.size[mkv] > 0 && s.size[mkv] <= 300000 + 4096, 'file size');
  assert.strictEqual(s.type[mkv], 1, 'mkv is video');
  assert.ok(s.mtime[mkv] > Date.now() / 1000 - 3600 && s.mtime[mkv] < Date.now() / 1000 + 60, 'modification time');
  if (!IS_WIN || !LEGACY) assert.strictEqual(s.type[s.byPath.get('lib/libfoo.so.1.2')], 2, 'versioned .so is an app file');
  assert.ok(s.byPath.has('café \u{1F600}/naïve.txt'), 'non-ASCII names');
  if (!IS_WIN) {
    const clips = [s.byPath.get('video/clip.mp4'), s.byPath.get('video/clip-hardlink.mp4')].map((i) => s.size[i]);
    assert.ok(clips.includes(0) && clips.some((x) => x > 0), 'hard link counted once');
  }
  const link = s.byPath.get('docs-link');
  assert.ok(s.flags[link] & 8, 'folder link flagged as link');
  assert.ok(!(s.flags[link] & 1) || IS_WIN, 'symlink not followed');
  assert.ok(![...s.byPath.keys()].some((k) => k.startsWith('docs-link/')), 'link not entered without --links');
  assert.ok(s.byPath.has('docs/a/b/c/deep.txt'), 'deep file');
  assert.ok(s.flags[s.byPath.get('empty')] & 1, 'empty folder');
  assert.strictEqual(s.header.root, root);
  assert.strictEqual(s.header.method, 'Walk');
  assert.ok(s.header.files >= 10 && s.header.total > 0 && s.header.dirs >= 8, 'header counts');
  const big = msgs.filter((m) => m.type === 'progress');
  for (const m of big) for (const k of ['phase', 'files', 'dirs', 'bytes', 'errors', 'pct', 'current', 'tops', 'biggest']) assert.ok(k in m, `progress has ${k}`);
  console.log(`scan: ${s.n} nodes, ${s.header.files} files, ${s.header.dirs} folders`);

  // ── scan with hidden files and links: the loop back to the root must not be entered ──
  const out2 = path.join(tmp, 'b.strata');
  await run(['scan', root, out2, '--hidden', '--links']);
  const s2 = parseStrata(out2);
  assert.ok(s2.byPath.has('.hidden/secret.bin'), 'hidden file with --hidden');
  assert.ok(s2.flags[s2.byPath.get('.hidden')] & 2, 'hidden flag');
  // Linux knows a folder by device and inode, so a link to a folder that is scanned anyway is not followed.
  if (!IS_WIN) assert.ok(s2.byPath.has('docs/a/report.pdf') && !s2.byPath.has('docs-link/a/report.pdf'), 'a link to a folder that is scanned anyway is not followed');
  assert.ok(s2.byPath.has('ext-link/x.dat'), 'a link to a folder elsewhere is followed');
  assert.ok(!s.byPath.has('ext-link/x.dat'), '…but only with --links');
  assert.ok(![...s2.byPath.keys()].some((k) => k.includes('loop/')), 'no loop into an ancestor');
  console.log(`scan --hidden --links: ${s2.n} nodes`);

  // ── snapshot, pause, resume and stop, on a bigger tree ──
  for (let k = 0; k < 400; k++) write(`many/d${k % 40}/f${k}.txt`, 100);
  const out3 = path.join(tmp, 'c.strata');
  const snap = path.join(tmp, 'c.partial.strata');
  let asked = false;
  const msgs3 = await run(['scan', root, out3], {
    input: 'pause\n',
    onLine: (m, p) => {
      if (m.type === 'progress' && !asked) { asked = true; p.stdin.write(`snapshot ${snap}\nresume\n`); }
      if (m.type === 'snapshot') { assert.ok(!m.error, m.error); p.stdin.write('stop\n'); }
    },
  });
  assert.ok(msgs3.some((m) => m.type === 'snapshot' && m.out === snap), 'snapshot written');
  assert.ok(parseStrata(snap).header.partial, 'snapshot is partial');
  assert.ok(msgs3.some((m) => m.type === 'progress' && m.phase === 'paused'), 'paused progress');
  parseStrata(out3);
  console.log('snapshot, pause, resume, stop: ok');

  // ── dupes ──
  const list = path.join(tmp, 'dupes.txt');
  const size = 2 * 1024 * 1024;
  fs.writeFileSync(list, ['one', 'two', 'other'].map((n) => `${size}\t${path.join(root, 'dupes', n + '.zip')}`).join('\n'));
  const dm = await run(['dupes', list]);
  const groups = dm.filter((m) => m.type === 'group');
  assert.strictEqual(groups.length, 1, 'one duplicate group');
  assert.deepStrictEqual(groups[0].paths.map((p) => path.basename(p)).sort(), ['one.zip', 'two.zip']);
  assert.ok(groups[0].verified && groups[0].size === size);
  assert.strictEqual(dm[dm.length - 1].type, 'done');
  console.log('dupes: ok');

  // ── delete: Recycle Bin / Trash, then permanent ──
  const trashed = path.join(root, 'docs');
  fs.rmSync(path.join(root, 'docs', 'loop'), { recursive: false, force: true });
  fs.writeFileSync(list, trashed);
  const r1 = (await run(['delete', list, 'recycle'], { timeout: 60000 })).filter((m) => m.type === 'result');
  assert.ok(r1[0].ok && r1[0].remaining === 0 && r1[0].error === null, `moved to the ${IS_WIN ? 'Recycle Bin' : 'Trash'}: ${r1[0].error}`);
  assert.ok(!fs.existsSync(trashed));
  if (!LEGACY) {
    const entries = (await run(['trash-list', trashed])).filter((m) => m.type === 'entry' && m.original === trashed);
    assert.strictEqual(entries.length, 1, 'found in the Recycle Bin / Trash');
    const e = entries[0];
    assert.ok(Math.abs(e.deletedAt - Date.now()) < 120000, `deletion date ${e.deletedAt}`);
    assert.ok(fs.existsSync(path.join(e.data, 'a', 'report.pdf')), 'content kept');
    if (!IS_WIN) assert.ok(e.info.startsWith(path.join(dataHome, 'Trash') + path.sep), `home Trash used, got ${e.info}`);
    // Restore puts it back.
    fs.writeFileSync(list, e.info);
    const rr = (await run(['restore', list])).filter((m) => m.type === 'result');
    assert.ok(rr[0].ok && rr[0].path === trashed, `restored: ${rr[0].error}`);
    assert.ok(fs.existsSync(path.join(trashed, 'a', 'report.pdf')) && !fs.existsSync(e.info), 'back in place');
    // Restoring over something that exists is refused.
    fs.writeFileSync(list, trashed);
    await run(['delete', list, 'recycle']);
    fs.mkdirSync(trashed);
    const again = (await run(['trash-list', trashed])).filter((m) => m.type === 'entry' && m.original === trashed);
    fs.writeFileSync(list, again[0].info);
    const rr2 = (await run(['restore', list])).filter((m) => m.type === 'result');
    assert.ok(!rr2[0].ok && rr2[0].error, 'restore refused when the place is taken');
    fs.rmSync(trashed, { recursive: true });
  } else if (!IS_WIN) {
    const { trashEntries } = require('../scanner/linux/trash');
    process.env.XDG_DATA_HOME = dataHome;
    assert.strictEqual(trashEntries(trashed).filter((e) => e.original === trashed).length, 1, 'trashinfo found');
  }
  if (!IS_WIN) {
    // Trashing a second item with the same name gets a new name.
    fs.mkdirSync(trashed);
    fs.writeFileSync(list, trashed);
    const r = (await run(['delete', list, 'recycle'])).filter((m) => m.type === 'result');
    assert.ok(r[0].ok, 'second item with the same name');
  }
  const gone = [path.join(root, 'video', 'movie.mkv'), path.join(root, 'many'), path.join(root, 'ext-link')];
  fs.writeFileSync(list, gone.join('\n'));
  const r2 = (await run(['delete', list, 'permanent'])).filter((m) => m.type === 'result');
  assert.ok(r2.every((r) => r.ok) && gone.every((g) => !fs.existsSync(g)), 'deleted permanently');
  assert.ok(fs.existsSync(path.join(tmp, 'outside', 'x.dat')), 'a link is removed, not what it points to');
  console.log('delete (Recycle Bin / Trash and permanent), trash-list, restore: ok');

  console.log('All scanner checks passed.');
}

main().then(
  () => fs.rmSync(tmp, { recursive: true, force: true }),
  (e) => { console.error(e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); },
);
