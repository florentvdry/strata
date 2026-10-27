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
