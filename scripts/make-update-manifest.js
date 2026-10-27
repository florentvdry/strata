// Builds latest.json, the file the app's updater reads, from the signed files in dist/. Also SHA256SUMS.txt.
//
//   node scripts/make-update-manifest.js --notes-file notes.md [--dir dist]
//
// Keys follow the updater's naming: <os>-<arch>-<how it was installed>. The app asks for the one that matches
// how it runs (see src/app/updates.rs); `windows-x86_64` and `linux-x86_64` are what builds that can't
// update themselves (tar.gz, pacman) look up, to learn there is a new version.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const root = path.join(__dirname, '..');
const dir = path.resolve(opt('dir', path.join(root, 'dist')));
const version = opt('version', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
const repo = opt('repo', 'https://github.com/florentvdry/strata');
const notes = opt('notes-file') ? fs.readFileSync(opt('notes-file'), 'utf8').trim() : '';

const FILES = {
  'windows-x86_64-nsis': `Strata-Setup-${version}.exe`,
  'windows-x86_64-portable': `Strata-${version}-Portable.exe`,
  'linux-x86_64-appimage': `Strata-${version}-x86_64.AppImage`,
  'linux-x86_64-deb': `Strata-${version}-amd64.deb`,
  'linux-x86_64-rpm': `Strata-${version}-x86_64.rpm`,
};
const FALLBACK = { 'windows-x86_64': 'windows-x86_64-nsis', 'linux-x86_64': 'linux-x86_64-appimage' };

const platforms = {};
for (const [key, name] of Object.entries(FILES)) {
  const sig = path.join(dir, `${name}.sig`);
  if (!fs.existsSync(path.join(dir, name)) || !fs.existsSync(sig)) continue;
  platforms[key] = { signature: fs.readFileSync(sig, 'utf8').trim(), url: `${repo}/releases/download/v${version}/${name}` };
}
for (const [key, from] of Object.entries(FALLBACK)) if (platforms[from]) platforms[key] = platforms[from];
if (!Object.keys(platforms).length) { console.error(`No signed files in ${dir}. Was TAURI_SIGNING_PRIVATE_KEY set for the build?`); process.exit(1); }

fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);

const sums = fs.readdirSync(dir).filter((n) => /^Strata-.*\.(exe|deb|rpm|AppImage|pacman|tar\.gz)$/.test(n)).sort().map((n) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex')}  ${n}`);
fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
console.log(`SHA256SUMS.txt: ${sums.length} files`);
