// Keeps the translation catalogs in step with the code.
// Usage: node scripts/i18n.js [--keys | --check]
//   --keys   print every t('…') key found in src/renderer as JSON (what translators work from)
//   --check  fail if a catalog is missing keys, has leftover ones, or drops a {placeholder}
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src', 'renderer');
const dir = path.join(root, 'locales');

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return e.name === 'vendor' || e.name === 'locales' ? [] : walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

// t('text' …), t("text" …) and t(`text` …) with no ${} inside; the English text is the key.
function keys() {
  const found = new Set();
  const re = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g;
  for (const f of walk(root)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const raw = m[1] ?? m[2] ?? m[3];
      found.add(raw.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'));
    }
  }
  return [...found].sort();
}

// Which placeholders a text uses. Plural branches repeat them, and a language with fewer branches repeats them less.
const names = (s) => [...new Set([...s.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1]))].sort().join(',');

if (process.argv.includes('--keys')) {
  console.log(JSON.stringify(keys(), null, 2));
} else if (process.argv.includes('--check')) {
  const all = keys();
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^export default/, 'module.exports =');
    const m = { exports: {} };
    new Function('module', src)(m);
    const cat = m.exports;
    const missing = all.filter((k) => !(k in cat));
    const extra = Object.keys(cat).filter((k) => !all.includes(k));
    const broken = Object.keys(cat).filter((k) => all.includes(k) && names(k) !== names(cat[k]));
    for (const [what, list] of [['missing', missing], ['unused', extra], ['placeholder mismatch', broken]]) {
      if (list.length) { bad += list.length; console.error(`${f}: ${list.length} ${what}: ${list.slice(0, 5).join(' | ')}${list.length > 5 ? ' …' : ''}`); }
    }
  }
  if (bad) process.exit(1);
  console.log('Translations are complete.');
} else {
  console.error('Usage: node scripts/i18n.js --keys | --check');
  process.exit(1);
}
