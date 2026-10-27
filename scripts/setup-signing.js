// One-time setup of update signing: makes the key pair, puts the public key in tauri.conf.json and prints what to
// store as GitHub secrets. Run it once, keep the private key safe: updates can't be signed without it, and every
// install built with this public key only accepts updates signed by it.
//
//   node scripts/setup-signing.js [--force]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const conf = path.join(root, 'src', 'app', 'tauri.conf.json');
const text = fs.readFileSync(conf, 'utf8');
const current = JSON.parse(text).plugins.updater.pubkey;
if (!current.startsWith('REPLACE') && !process.argv.includes('--force')) {
  console.error('tauri.conf.json already has a public key. Replacing it makes existing installs reject new updates; pass --force if that is what you want.');
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-key-'));
const key = path.join(dir, 'strata.key');
const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
execFileSync(bin, ['signer', 'generate', '--ci', '-w', key], { stdio: 'ignore', shell: process.platform === 'win32' });
const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim();
const priv = fs.readFileSync(key, 'utf8').trim();
fs.writeFileSync(conf, text.replace(current, pub));
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Public key written to src/app/tauri.conf.json. Commit it.

Now store the PRIVATE key as a GitHub Actions secret named TAURI_SIGNING_PRIVATE_KEY (Settings › Secrets and variables › Actions),
and keep a copy somewhere safe (a password manager). It is shown once:

${priv}

The key has no password. To add one, generate it yourself with: npm run tauri -- signer generate -w strata.key
and also store TAURI_SIGNING_PRIVATE_KEY_PASSWORD.`);
