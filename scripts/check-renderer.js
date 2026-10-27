// Checks what a build can't catch: every file in the renderer's import map exists (otherwise the window stays blank),
// and the vendored copies of Preact and htm are the ones npm installed.
// Usage: node scripts/check-renderer.js [--vendor]   (--vendor copies them from node_modules into src/renderer/vendor)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = path.join(root, 'src', 'renderer', 'index.html');
const vendor = path.join(root, 'src', 'renderer', 'vendor');

// What the UI loads, and where it comes from. Source-map comments are dropped: the app never ships the maps.
const FILES = {
  'preact.mjs': 'node_modules/preact/dist/preact.mjs',
  'hooks.mjs': 'node_modules/preact/hooks/dist/hooks.mjs',
  'htm.module.js': 'node_modules/htm/dist/htm.module.js',
};
const LICENSES = { 'LICENSE-preact.txt': 'node_modules/preact/LICENSE', 'LICENSE-htm.txt': 'node_modules/htm/LICENSE' };
const clean = (s) => s.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');

if (process.argv.includes('--vendor')) {
  fs.mkdirSync(vendor, { recursive: true });
  for (const [name, from] of Object.entries(FILES)) fs.writeFileSync(path.join(vendor, name), clean(fs.readFileSync(path.join(root, from), 'utf8')));
  for (const [name, from] of Object.entries(LICENSES)) fs.copyFileSync(path.join(root, from), path.join(vendor, name));
  console.log('Vendored Preact and htm into src/renderer/vendor.');
  process.exit(0);
}

const src = fs.readFileSync(html, 'utf8');
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

if (fs.existsSync(path.join(root, 'node_modules', 'preact'))) {
  for (const [name, from] of Object.entries(FILES)) {
    const have = fs.existsSync(path.join(vendor, name)) && fs.readFileSync(path.join(vendor, name), 'utf8');
    if (have !== clean(fs.readFileSync(path.join(root, from), 'utf8'))) {
      console.error(`vendor/${name} differs from ${from}. Run: npm run vendor`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('Renderer import map and vendored libraries are consistent.');
