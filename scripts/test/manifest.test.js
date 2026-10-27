const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('the update manifest lists only signed files, with fallbacks and checksums', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-manifest-'));
  const v = '1.2.3';
  const files = [`Strata-Setup-${v}.exe`, `Strata-${v}-Portable.exe`, `Strata-${v}-x86_64.AppImage`, `Strata-${v}-amd64.deb`, `Strata-${v}-x64.tar.gz`];
  for (const f of files) fs.writeFileSync(path.join(dir, f), f);
  for (const f of files.slice(0, 3)) fs.writeFileSync(path.join(dir, `${f}.sig`), `sig-of-${f}\n`);
  fs.writeFileSync(path.join(dir, 'notes.md'), '### Added\n\n- A thing');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'make-update-manifest.js'), '--dir', dir, '--version', v, '--notes-file', path.join(dir, 'notes.md')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
  assert.strictEqual(m.version, v);
  assert.strictEqual(m.notes, '### Added\n\n- A thing');
  assert.deepStrictEqual(Object.keys(m.platforms).sort(), ['linux-x86_64', 'linux-x86_64-appimage', 'windows-x86_64', 'windows-x86_64-nsis', 'windows-x86_64-portable']);
  assert.strictEqual(m.platforms['windows-x86_64-portable'].signature, `sig-of-Strata-${v}-Portable.exe`);
  assert.strictEqual(m.platforms['linux-x86_64'].url, `https://github.com/florentvdry/strata/releases/download/v${v}/Strata-${v}-x86_64.AppImage`);
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.strictEqual(sums.length, files.length);
  assert.ok(sums.every((l) => /^[0-9a-f]{64}  Strata-/.test(l)));
});

test('no manifest without signatures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-manifest-'));
  fs.writeFileSync(path.join(dir, 'Strata-Setup-1.0.0.exe'), 'x');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'make-update-manifest.js'), '--dir', dir, '--version', '1.0.0'], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.includes('No signed files'));
});
