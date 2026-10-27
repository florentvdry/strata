// End-to-end checks for the Linux scanner (scanner/linux): builds a small folder tree in a temp folder, then runs
// info, scan, snapshot, dupes and delete (Trash and permanent) and checks the messages and the .strata file.
// Usage: node scripts/test-scanner.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

if (process.platform !== 'linux') { console.log('The Linux scanner is only tested on Linux.'); process.exit(0); }

const SCANNER = path.join(__dirname, '..', 'scanner', 'linux', 'strata-scan.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-test-'));
const dataHome = path.join(tmp, 'xdg');
const env = { ...process.env, XDG_DATA_HOME: dataHome };

function run(args, { onLine, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCANNER, ...args], { env });
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
    p.on('close', (code) => (code === 0 ? resolve(msgs) : reject(new Error(`exit ${code}: ${err}`))));
    if (input) p.stdin.write(input);
  });
}

// Same layout as parseScan in src/renderer/lib/tree.js.
function parse(file) {
  const b = fs.readFileSync(file);
  assert.strictEqual(b.toString('ascii', 0, 8), 'STRATA01');
  const hlen = b.readInt32LE(8);
  const header = JSON.parse(b.toString('utf8', 12, 12 + hlen));
  let off = (12 + hlen + 7) & ~7;
  const n = b.readInt32LE(off); off += 8;
  const u8 = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const size = new Float64Array(u8.buffer, off, n); off += 8 * n;
  const mtime = new Float64Array(u8.buffer, off, n); off += 8 * n;
  const parent = new Int32Array(u8.buffer, off, n); off += 4 * n;
  const flags = u8.slice(off, off + n); off += n;
  const type = u8.slice(off, off + n); off += n;
  const nlen = b.readInt32LE(off); off += 4;
  const names = b.toString('utf8', off, off + nlen).split('\0');
  assert.strictEqual(off + nlen, b.length, 'no trailing bytes');
  const pathOf = (i) => { const parts = []; for (let c = i; c > 0; c = parent[c]) parts.unshift(names[c]); return parts.join('/'); };
  const byPath = new Map();
  for (let i = 1; i < n; i++) byPath.set(pathOf(i), i);
  return { header, n, size, mtime, parent, flags, type, names, byPath };
}

const write = (rel, bytes, fill = 0x61) => {
  const p = path.join(tmp, 'tree', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, fill));
  return p;
};

async function main() {
  // ── fixture ──
  write('video/movie.mkv', 300000);
  write('video/clip.mp4', 4096);
  write('docs/a/report.pdf', 1000);
  write('docs/a/b/c/deep.txt', 10);
  write('.hidden/secret.bin', 5000);
  write('dupes/one.zip', 2 * 1024 * 1024, 0x41);
  write('dupes/two.zip', 2 * 1024 * 1024, 0x41);
  write('dupes/other.zip', 2 * 1024 * 1024, 0x42);
  write('lib/libfoo.so.1.2', 2000);
  fs.linkSync(path.join(tmp, 'tree/video/clip.mp4'), path.join(tmp, 'tree/video/clip-hardlink.mp4'));
  fs.symlinkSync(path.join(tmp, 'tree/docs'), path.join(tmp, 'tree/docs-link'));
  fs.symlinkSync(path.join(tmp, 'tree'), path.join(tmp, 'tree/docs/loop'));
  fs.mkdirSync(path.join(tmp, 'tree/empty'));
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.writeFileSync(path.join(tmp, 'outside/x.dat'), Buffer.alloc(777));
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'tree/ext-link'));
  const root = path.join(tmp, 'tree');

  // ── info ──
  const [inf] = await run(['info']);
  assert.strictEqual(inf.type, 'info');
  assert.ok(Array.isArray(inf.drives) && inf.drives.length > 0, 'at least one drive');
  for (const d of inf.drives) {
    assert.ok(d.root.startsWith('/') && d.total > 0 && d.free >= 0 && d.fs, `drive fields: ${JSON.stringify(d)}`);
  }
  console.log(`info: ${inf.drives.map((d) => `${d.root} (${d.fs})`).join(', ')}`);

  // ── scan, without hidden files and links ──
  const out1 = path.join(tmp, 'a.strata');
  const msgs = await run(['scan', root, out1]);
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done && !done.partial && done.method === 'Walk', 'done message');
  const s = parse(out1);
  assert.strictEqual(s.names[0], root);
  assert.strictEqual(s.parent[0], -1);
  for (let i = 1; i < s.n; i++) assert.ok(s.parent[i] < i, 'parents come before children');
  assert.ok(!s.byPath.has('.hidden'), 'hidden folder skipped without --hidden');
  const mkv = s.byPath.get('video/movie.mkv');
  assert.ok(s.size[mkv] > 0 && s.size[mkv] <= 300000 + 4096, 'file size');
  assert.strictEqual(s.type[mkv], 1, 'mkv is video');
  assert.strictEqual(s.type[s.byPath.get('lib/libfoo.so.1.2')], 2, 'versioned .so is an app file');
  const clips = [s.byPath.get('video/clip.mp4'), s.byPath.get('video/clip-hardlink.mp4')].map((i) => s.size[i]);
  assert.ok(clips.includes(0) && clips.some((x) => x > 0), 'hard link counted once');
  const link = s.byPath.get('docs-link');
  assert.ok(s.flags[link] & 8, 'symlink flagged as link');
  assert.ok(!(s.flags[link] & 1), 'symlink not followed');
  assert.ok(s.byPath.has('docs/a/b/c/deep.txt'), 'deep file');
  assert.ok(s.flags[s.byPath.get('empty')] & 1, 'empty folder');
  assert.strictEqual(s.header.root, root);
  assert.ok(s.header.files >= 9 && s.header.total > 0, 'header counts');
  console.log(`scan: ${s.n} nodes, ${s.header.files} files, ${s.header.dirs} folders`);

  // ── scan with hidden files and links: the loop back to the root must not be entered ──
  const out2 = path.join(tmp, 'b.strata');
  await run(['scan', root, out2, '--hidden', '--links']);
  const s2 = parse(out2);
  assert.ok(s2.byPath.has('.hidden/secret.bin'), 'hidden file with --hidden');
  assert.ok(s2.flags[s2.byPath.get('.hidden')] & 2, 'hidden flag');
  assert.ok(s2.byPath.has('docs/a/report.pdf') && !s2.byPath.has('docs-link/a/report.pdf'), 'a link to a folder that is scanned anyway is not followed');
  assert.ok(s2.byPath.has('ext-link/x.dat'), 'a link to a folder elsewhere is followed');
  assert.ok(!s.byPath.has('ext-link/x.dat'), '…but only with --links');
  assert.ok(![...s2.byPath.keys()].some((k) => k.includes('loop/')), 'no loop into an ancestor');
  console.log(`scan --hidden --links: ${s2.n} nodes`);

  // ── snapshot and stop, on a bigger tree ──
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
  assert.ok(parse(snap).header.partial, 'snapshot is partial');
  assert.ok(msgs3.some((m) => m.type === 'progress' && m.phase === 'paused'), 'paused progress');
  parse(out3);
  console.log('snapshot, pause, resume, stop: ok');

  // ── dupes ──
  const list = path.join(tmp, 'dupes.txt');
  const size = 2 * 1024 * 1024;
  fs.writeFileSync(list, ['one', 'two', 'other'].map((n) => `${size}\t${path.join(root, 'dupes', n + '.zip')}`).join('\n'));
  const groups = (await run(['dupes', list])).filter((m) => m.type === 'group');
  assert.strictEqual(groups.length, 1, 'one duplicate group');
  assert.deepStrictEqual(groups[0].paths.map((p) => path.basename(p)).sort(), ['one.zip', 'two.zip']);
  assert.ok(groups[0].verified);
  console.log('dupes: ok');

  // ── delete: Trash, then permanent ──
  const trashed = path.join(root, 'docs');
  const gone = path.join(root, 'video', 'movie.mkv');
  fs.writeFileSync(list, trashed);
  const r1 = (await run(['delete', list, 'recycle'])).filter((m) => m.type === 'result');
  assert.ok(r1[0].ok, `moved to Trash: ${r1[0].error}`);
  assert.ok(!fs.existsSync(trashed));
  const { trashEntries } = require('../scanner/linux/trash');
  process.env.XDG_DATA_HOME = dataHome;
  const entries = trashEntries(trashed).filter((e) => e.original === trashed);
  assert.strictEqual(entries.length, 1, 'trashinfo found');
  // Same file system as the (not yet created) home Trash: it goes there, not to a $topdir/.Trash-$uid.
  assert.ok(entries[0].info.startsWith(path.join(dataHome, 'Trash') + path.sep), `home Trash used, got ${entries[0].info}`);
  assert.ok(fs.existsSync(path.join(entries[0].data, 'a', 'report.pdf')), 'content in Trash/files');
  assert.ok(Math.abs(entries[0].deletedAt - Date.now()) < 60000, 'deletion date');
  // Trashing a second item with the same name gets a new name.
  fs.mkdirSync(trashed);
  await run(['delete', list, 'recycle']);
  assert.strictEqual(trashEntries(trashed).filter((e) => e.original === trashed).length, 2, 'second item with the same name');
  fs.writeFileSync(list, gone);
  const r2 = (await run(['delete', list, 'permanent'])).filter((m) => m.type === 'result');
  assert.ok(r2[0].ok && !fs.existsSync(gone), 'deleted permanently');
  console.log('delete (Trash and permanent): ok');

  console.log('All scanner checks passed.');
}

main().then(
  () => fs.rmSync(tmp, { recursive: true, force: true }),
  (e) => { console.error(e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); },
);
