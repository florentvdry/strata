const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const lib = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'renderer', 'lib', 'changelog.js')).href);

const SAMPLE = `# Changelog

Intro text.

## [Unreleased]

### Added

- Something coming.

## [0.2.0] - 2026-11-01

Faster and on Linux.

### Added

- **Linux support** for the usual distributions.
  - AppImage, deb and rpm.
  - Wrapped
    continuation line.
- A second feature.

### Internal

- CI runs the tests.

### Fixed

- A bug.

## [0.2.0-beta.1] - 2026-10-30

### Changed

- Beta thing.

## [0.1.0] - 2026-10-27

First public release.

[Unreleased]: https://github.com/o/r/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/o/r/compare/v0.1.0...v0.2.0
`;

test('parses versions, summaries, sections and nested items', async () => {
  const L = await lib();
  const { unreleased, releases } = L.parseChangelog(SAMPLE);
  assert.strictEqual(unreleased.sections[0].items[0].text, 'Something coming.');
  assert.deepStrictEqual(releases.map((r) => r.version), ['0.2.0', '0.2.0-beta.1', '0.1.0']);
  assert.strictEqual(releases[0].summary, 'Faster and on Linux.');
  assert.strictEqual(releases[1].prerelease, true);
  const added = releases[0].sections.find((s) => s.title === 'Added');
  assert.strictEqual(added.items.length, 2);
  assert.deepStrictEqual(added.items[0].children, ['AppImage, deb and rpm.', 'Wrapped continuation line.']);
  assert.strictEqual(releases[2].summary, 'First public release.');
});

test('orders versions like semver, pre-releases before their release', async () => {
  const L = await lib();
  const sorted = ['0.2.0', '0.10.0', '0.2.0-beta.2', '0.2.0-beta.10', '0.2.0-alpha', '1.0.0', '0.1.9'].sort(L.compareVersions);
  assert.deepStrictEqual(sorted, ['0.1.9', '0.2.0-alpha', '0.2.0-beta.2', '0.2.0-beta.10', '0.2.0', '0.10.0', '1.0.0']);
});

test('release notes leave out Internal and survive a round trip', async () => {
  const L = await lib();
  const entry = L.parseChangelog(SAMPLE).releases[0];
  const md = L.renderNotes(entry);
  assert.ok(!md.includes('Internal') && !md.includes('CI runs'));
  assert.ok(md.includes('### Added') && md.includes('### Fixed'));
  const back = L.parseNotes(md);
  assert.strictEqual(back.summary, 'Faster and on Linux.');
  assert.deepStrictEqual(back.sections.map((s) => s.title), ['Added', 'Fixed']);
  assert.ok(L.renderNotes(entry, { internal: true }).includes('CI runs the tests.'));
});

test('between() lists what changed since the version someone last ran', async () => {
  const L = await lib();
  const { releases } = L.parseChangelog(SAMPLE);
  assert.deepStrictEqual(L.between(releases, '0.1.0', '0.2.0').map((r) => r.version), ['0.2.0', '0.2.0-beta.1']);
  assert.deepStrictEqual(L.between(releases, '0.2.0-beta.1', '0.2.0').map((r) => r.version), ['0.2.0']);
  assert.deepStrictEqual(L.between(releases, '0.2.0', '0.2.0'), []);
});

test('the repository changelog passes its own check', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'changelog.js'), 'check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

test('a release bumps the version everywhere and leaves a changelog that passes the check', () => {
  const fs = require('fs');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const root = path.join(__dirname, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-release-'));
  const files = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'scripts/changelog.js', 'src/renderer/package.json', 'src/renderer/lib/changelog.js',
    'src/renderer/lib/changelog-data.js', 'src/app/Cargo.toml', 'src/app/Cargo.lock', 'scanner/Cargo.toml', 'scanner/Cargo.lock', 'scanner/fuzz/Cargo.lock'];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(tmp, f));
  }
  const run = (...args) => spawnSync(process.execPath, [path.join(tmp, 'scripts', 'changelog.js'), ...args], { cwd: tmp, encoding: 'utf8' });
  const r = run('release', '9.9.9', '--date=2030-01-02');
  assert.strictEqual(r.status, 0, r.stderr);
  const read = (f) => fs.readFileSync(path.join(tmp, f), 'utf8');
  assert.strictEqual(JSON.parse(read('package.json')).version, '9.9.9');
  assert.strictEqual(JSON.parse(read('package-lock.json')).packages[''].version, '9.9.9');
  assert.match(read('src/app/Cargo.toml'), /^version = "9\.9\.9"$/m);
  assert.match(read('scanner/Cargo.toml'), /^version = "9\.9\.9"$/m);
  assert.match(read('src/app/Cargo.lock'), /name = "strata"\r?\nversion = "9\.9\.9"/);
  for (const f of ['scanner/Cargo.lock', 'scanner/fuzz/Cargo.lock']) assert.match(read(f), /name = "strata-scan"\r?\nversion = "9\.9\.9"/);
  assert.match(read('CHANGELOG.md'), /## \[9\.9\.9\] - 2030-01-02/);
  assert.match(read('CHANGELOG.md'), /^\[Unreleased\]: .*\/compare\/v9\.9\.9\.\.\.HEAD$/m);
  const check = run('check');
  assert.strictEqual(check.status, 0, check.stderr);
  // One file out of step is reported.
  fs.writeFileSync(path.join(tmp, 'scanner/Cargo.toml'), read('scanner/Cargo.toml').replace('version = "9.9.9"', 'version = "1.0.0"'));
  const bad = run('check');
  assert.notStrictEqual(bad.status, 0);
  assert.ok(bad.stderr.includes('scanner/Cargo.toml says 1.0.0'));
});
