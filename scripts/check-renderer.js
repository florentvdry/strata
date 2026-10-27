// Checks what a build can't catch: every file in the renderer's import map exists, and the
// Content-Security-Policy hash still matches the inline import map (otherwise the window stays blank).
// Usage: node scripts/check-renderer.js [--fix]   (--fix rewrites the CSP hash)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const html = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
let src = fs.readFileSync(html, 'utf8');
const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(src);
if (!map) { console.error('No import map found in index.html'); process.exit(1); }

let failed = false;
for (const [name, target] of Object.entries(JSON.parse(map[1]).imports)) {
  const file = path.resolve(path.dirname(html), target);
  if (!fs.existsSync(file)) {
    console.error(`Import map entry "${name}" points to a missing file: ${target}`);
    failed = true;
  }
}

const hash = `'sha256-${crypto.createHash('sha256').update(map[1]).digest('base64')}'`;
if (!src.includes(hash)) {
  if (process.argv.includes('--fix')) {
    src = src.replace(/'sha256-[A-Za-z0-9+/=]+'/, hash);
    fs.writeFileSync(html, src);
    console.log(`Updated the CSP hash to ${hash}`);
  } else {
    console.error(`The CSP hash doesn't match the import map. Expected ${hash} (run with --fix).`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('Renderer import map and CSP hash are consistent.');
