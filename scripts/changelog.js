// CHANGELOG.md is the one place release notes are written. This script reads it for everything else.
//
//   node scripts/changelog.js check               format, versions in step, generated files up to date (CI)
//   node scripts/changelog.js sync                writes src/renderer/lib/changelog-data.js (the app's "What's new")
//   node scripts/changelog.js notes <version>     release notes as Markdown (GitHub release, update manifest); "unreleased" works too
//   node scripts/changelog.js release <version>   moves Unreleased under <version>, bumps the version everywhere, syncs
//   node scripts/changelog.js site                writes the website's changelog, feed and latest-release data
//
// Notes keep out the "Internal" section (CI, tests, docs); pass --internal to include it.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const file = (...p) => path.join(root, ...p);
const read = (...p) => fs.readFileSync(file(...p), 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(file(p)), { recursive: true }); fs.writeFileSync(file(p), s); };

const GENERATED = 'src/renderer/lib/changelog-data.js';
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

async function lib() {
  return import(pathToFileURL(file('src', 'renderer', 'lib', 'changelog.js')).href);
}

function generatedModule(L, releases) {
  const data = releases.filter((r) => r.date).map(L.publicEntry).filter((e) => !L.isEmpty(e));
  return `// Generated from CHANGELOG.md by \`npm run sync:changelog\`. Don't edit.\nexport default ${JSON.stringify(data, null, 2)};\n`;
}

// Everything that carries the app's version: [file, how to read it, how to rewrite it].
const cargoHead = (text) => text.slice(0, text.search(/^\[(?!package\])/m));
const VERSION_FILES = [
  ['package.json', (t) => JSON.parse(t).version],
  ['src/app/Cargo.toml', (t) => /^version\s*=\s*"([^"]+)"/m.exec(cargoHead(t))[1]],
  ['src/app/Cargo.lock', (t) => (/name = "strata"\r?\nversion = "([^"]+)"/.exec(t) || [])[1]],
  ['scanner/Cargo.toml', (t) => /^version\s*=\s*"([^"]+)"/m.exec(cargoHead(t))[1]],
  ['scanner/Cargo.lock', (t) => (/name = "strata-scan"\r?\nversion = "([^"]+)"/.exec(t) || [])[1]],
  ['scanner/fuzz/Cargo.lock', (t) => (/name = "strata-scan"\r?\nversion = "([^"]+)"/.exec(t) || [])[1]],
];

async function check() {
  const L = await lib();
  const md = read('CHANGELOG.md');
  const { unreleased, releases } = L.parseChangelog(md);
  const problems = [];
  if (!unreleased) problems.push('There is no "## [Unreleased]" section.');
  const seen = new Set();
  releases.forEach((r, i) => {
    if (!SEMVER.test(r.version)) problems.push(`"${r.version}" isn't a version like 1.2.3 or 1.2.3-beta.1.`);
    if (!r.date) problems.push(`[${r.version}] has no date (use "## [${r.version}] - YYYY-MM-DD").`);
    if (seen.has(r.version)) problems.push(`[${r.version}] appears twice.`);
    seen.add(r.version);
    if (i > 0 && L.compareVersions(releases[i - 1].version, r.version) <= 0) problems.push(`[${r.version}] should come after [${releases[i - 1].version}]: newest first.`);
    for (const s of r.sections) if (!L.SECTIONS.includes(s.title)) problems.push(`[${r.version}] has an unknown section "${s.title}" (${L.SECTIONS.join(', ')}).`);
    if (!new RegExp(`^\\[${r.version.replace(/[.+]/g, '\\$&')}\\]: https?://`, 'm').test(md)) problems.push(`Missing the link line "[${r.version}]: https://…" at the bottom.`);
  });
  if (unreleased && !/^\[Unreleased\]: https?:\/\//m.test(md)) problems.push('Missing the "[Unreleased]: https://…" link line at the bottom.');

  const found = VERSION_FILES.map(([f, get]) => [f, get(read(...f.split('/')))]);
  const pkg = found[0][1];
  for (const [f, v] of found) if (v !== pkg) problems.push(`${f} says ${v}, package.json says ${pkg}. \`npm run release\` bumps them together.`);
  if (releases[0] && L.compareVersions(pkg, releases[0].version) < 0) problems.push(`package.json (${pkg}) is older than the newest changelog entry (${releases[0].version}).`);

  const expected = generatedModule(L, releases);
  if (!fs.existsSync(file(GENERATED)) || read(GENERATED) !== expected) problems.push(`${GENERATED} is out of date. Run: npm run sync:changelog`);

  if (problems.length) {
    console.error(`CHANGELOG.md:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Changelog OK: ${releases.length} versions, ${unreleased ? unreleased.sections.reduce((n, s) => n + s.items.length, 0) : 0} unreleased entries.`);
}

async function sync() {
  const L = await lib();
  write(GENERATED, generatedModule(L, L.parseChangelog(read('CHANGELOG.md')).releases));
  console.log(`Wrote ${GENERATED}`);
}

async function notes(version, internal) {
  const L = await lib();
  const { unreleased, releases } = L.parseChangelog(read('CHANGELOG.md'));
  const entry = /^unreleased$/i.test(version) ? unreleased : releases.find((r) => r.version === version.replace(/^v/, ''));
  if (!entry) { console.error(`No changelog entry for ${version}.`); process.exit(1); }
  const text = L.renderNotes(entry, { internal });
  if (!text) { console.error(`The entry for ${version} is empty.`); process.exit(1); }
  process.stdout.write(`${text}\n`);
}

function bump(version) {
  const sub = (p, re, to) => { const s = read(...p.split('/')); if (!re.test(s)) throw new Error(`Couldn't find the version in ${p}`); write(p, s.replace(re, to)); };
  sub('package.json', /("version":\s*")[^"]+(")/, `$1${version}$2`);
  const lock = JSON.parse(read('package-lock.json'));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  for (const p of ['src/app/Cargo.toml', 'scanner/Cargo.toml']) {
    const cargo = read(...p.split('/'));
    const head = cargoHead(cargo);
    write(p, cargo.replace(head, head.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`)));
  }
  sub('src/app/Cargo.lock', /(name = "strata"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
  for (const p of ['scanner/Cargo.lock', 'scanner/fuzz/Cargo.lock']) sub(p, /(name = "strata-scan"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
}

async function release(version, dateArg) {
  const L = await lib();
  version = (version || '').replace(/^v/, '');
  if (!SEMVER.test(version)) { console.error('Usage: npm run release -- <version>   e.g. 0.2.0 or 0.3.0-beta.1'); process.exit(1); }
  const md = read('CHANGELOG.md');
  const { unreleased, releases } = L.parseChangelog(md);
  if (!unreleased || L.isEmpty(L.publicEntry(unreleased)) && !unreleased.sections.some((s) => s.items.length)) { console.error('Nothing under [Unreleased] to release.'); process.exit(1); }
  if (releases.some((r) => r.version === version)) { console.error(`[${version}] is already in the changelog.`); process.exit(1); }
  const prev = releases[0] && releases[0].version;
  if (prev && L.compareVersions(version, prev) <= 0) { console.error(`${version} isn't newer than ${prev}.`); process.exit(1); }
  const date = dateArg || new Date().toISOString().slice(0, 10);

  const repo = /^\[Unreleased\]: (https?:\/\/[^\s]+?)\/compare\//m.exec(md);
  if (!repo) { console.error('Missing the "[Unreleased]: …/compare/…" link line.'); process.exit(1); }
  let out = md.replace(/^## \[Unreleased\].*$/m, `## [Unreleased]\n\n## [${version}] - ${date}`);
  const refs = [`[Unreleased]: ${repo[1]}/compare/v${version}...HEAD`, prev ? `[${version}]: ${repo[1]}/compare/v${prev}...v${version}` : `[${version}]: ${repo[1]}/releases/tag/v${version}`];
  out = out.replace(/^\[Unreleased\]: .*$/m, refs.join('\n'));
  write('CHANGELOG.md', out);
  bump(version);
  await sync();
  console.log(`\nReleased ${version} (${date}). Next:\n  git add -A && git commit -m "Release ${version}"\n  open a pull request, merge it, then tag the merge commit:\n  git tag v${version} && git push origin v${version}\nThe Release workflow builds, signs and publishes it.`);
}

function xml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

async function site() {
  const L = await lib();
  const { releases } = L.parseChangelog(read('CHANGELOG.md'));
  const repo = /^\[Unreleased\]: (https?:\/\/[^\s]+?)\/compare\//m.exec(read('CHANGELOG.md'))[1];
  const published = releases.filter((r) => r.date).map(L.publicEntry).filter((e) => !L.isEmpty(e));
  write('website/assets/changelog.json', `${JSON.stringify(published, null, 2)}\n`);
  const latest = published.find((r) => !r.prerelease) || published[0];
  const v = latest.version, dl = (name) => `${repo}/releases/download/v${v}/${name}`;
  write('website/assets/release.json', `${JSON.stringify({
    version: v, date: latest.date, url: `${repo}/releases/tag/v${v}`,
    files: {
      setup: dl(`Strata-Setup-${v}.exe`), portable: dl(`Strata-${v}-Portable.exe`),
      // 0.1.0 was Windows only; the Linux files and checksums exist from 0.2.0 on.
      ...(L.compareVersions(v, '0.2.0-beta.0') < 0 ? {} : {
        deb: dl(`Strata-${v}-amd64.deb`), rpm: dl(`Strata-${v}-x86_64.rpm`), pacman: dl(`Strata-${v}-x64.pacman`),
        appimage: dl(`Strata-${v}-x86_64.AppImage`), tar: dl(`Strata-${v}-x64.tar.gz`), checksums: dl('SHA256SUMS.txt'),
      }),
    },
  }, null, 2)}\n`);
  const items = published.slice(0, 20).map((r) => `    <item>
      <title>Strata ${xml(r.version)}</title>
      <link>${xml(`${repo}/releases/tag/v${r.version}`)}</link>
      <guid isPermaLink="false">strata-${xml(r.version)}</guid>
      <pubDate>${new Date(`${r.date}T12:00:00Z`).toUTCString()}</pubDate>
      <description>${xml(L.renderNotes(r))}</description>
    </item>`).join('\n');
  write('website/public/changelog.xml', `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Strata releases</title>
    <link>${xml(repo)}/releases</link>
    <description>What changed in each version of Strata.</description>
${items}
  </channel>
</rss>
`);
  console.log(`Site data for ${published.length} versions, latest ${v}.`);
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const pos = args.filter((a) => !a.startsWith('--'));
  const date = (args.find((a) => a.startsWith('--date=')) || '').slice(7) || undefined;
  if (cmd === 'check') await check();
  else if (cmd === 'sync') await sync();
  else if (cmd === 'notes') await notes(pos[0] || '', flag('internal'));
  else if (cmd === 'release') await release(pos[0], date);
  else if (cmd === 'site') await site();
  else { console.error('Usage: node scripts/changelog.js <check|sync|notes <version>|release <version>|site>'); process.exit(2); }
})().catch((e) => { console.error(e.message); process.exit(1); });
