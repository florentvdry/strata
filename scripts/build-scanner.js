// Builds the scanner (scanner/, Rust) and copies it to bin/strata-scan (bin/strata-scan.exe on Windows).
//
//   node scripts/build-scanner.js [--if-missing] [--debug]
//
// --if-missing   skip the build when bin/ is newer than the scanner's sources
// --debug        unoptimized build (faster to compile)
// Target: x86_64-pc-windows-msvc on Windows; on Linux a static musl binary that runs on every distribution
// (x86_64-unknown-linux-musl) when that target is installed, else the default one. STRATA_SCANNER_TARGET overrides it.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const crate = path.join(root, 'scanner');
const exe = process.platform === 'win32' ? 'strata-scan.exe' : 'strata-scan';
const out = path.join(root, 'bin', exe);
const debug = process.argv.includes('--debug');

function newestSource(dir) {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSource(p));
    else newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

if (process.argv.includes('--if-missing') && fs.existsSync(out)) {
  const sources = Math.max(newestSource(path.join(crate, 'src')), ...['Cargo.toml', 'Cargo.lock'].map((f) => fs.statSync(path.join(crate, f)).mtimeMs));
  if (fs.statSync(out).mtimeMs >= sources) process.exit(0);
}

if (spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status !== 0) {
  console.error('Building the scanner needs Rust (cargo). Install it from https://rustup.rs, then run this again.');
  process.exit(1);
}

function installedTargets() {
  const r = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8', shell: process.platform === 'win32' });
  return r.status === 0 ? r.stdout.split(/\r?\n/) : [];
}

let target = process.env.STRATA_SCANNER_TARGET || null;
if (!target && process.platform === 'win32') target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
if (!target && process.platform === 'linux') {
  const musl = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
  if (installedTargets().includes(musl)) target = musl;
  else console.warn(`Note: ${musl} isn't installed (rustup target add ${musl}); building for this machine's libc only.`);
}

const args = ['build', '--locked', '--manifest-path', path.join(crate, 'Cargo.toml')];
if (!debug) args.push('--release');
if (target) args.push('--target', target);
try {
  execFileSync('cargo', args, { stdio: 'inherit', shell: process.platform === 'win32' });
} catch {
  process.exit(1);
}

const built = path.join(crate, 'target', ...(target ? [target] : []), debug ? 'debug' : 'release', exe);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(built, out);
fs.chmodSync(out, 0o755);
console.log(`Built ${path.relative(root, out)}${target ? ` (${target})` : ''}`);
