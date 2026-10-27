// Compares two .strata files item by item: same paths, sizes, flags, types and modification times.
// Used to check that the Rust scanner gives the same results as the scanner it replaces, and that the
// NTFS fast scan gives the same tree as a normal folder walk.
//
//   node scripts/compare-scans.js <a.strata> <b.strata> [--tolerance N] [--flags MASK] [--quiet]
//
// --tolerance N   accept up to N differing items (for live system folders that change between two scans)
// --flags MASK    only compare these flag bits (default: every bit)
// Folder modification times are not compared: a folder's entry in its parent's index is updated lazily.
const { parseStrata, F_DIR } = require('./lib/strata-file');

// ignoreReplacement: names that aren't valid UTF-8 (shown with U+FFFD) may be missing on one side only.
function compareScans(fileA, fileB, { tolerance = 0, flagsMask = 0xff, mtimeSlack = 1, ignoreReplacement = false } = {}) {
  const a = parseStrata(fileA), b = parseStrata(fileB);
  const diffs = [];
  const note = (p, what) => diffs.push(`${p || '(root)'}: ${what}`);
  const skip = (p) => ignoreReplacement && p.includes('\uFFFD');

  // Hard links count once, on whichever link a scanner reaches first: a size moving from one link to another is fine
  // as long as the same bytes are counted in total.
  const moved = [];
  let movedA = 0, movedB = 0;
  for (const [p, i] of a.byPath) {
    const j = b.byPath.get(p);
    if (j === undefined) { if (!skip(p)) note(p, `only in ${fileA}`); continue; }
    const dir = a.flags[i] & F_DIR;
    if (a.size[i] !== b.size[j]) {
      if (a.size[i] === 0 || b.size[j] === 0) { moved.push(`${p}: size ${a.size[i]} ≠ ${b.size[j]}`); movedA += a.size[i]; movedB += b.size[j]; }
      else note(p, `size ${a.size[i]} ≠ ${b.size[j]}`);
    }
    if ((a.flags[i] & flagsMask) !== (b.flags[j] & flagsMask)) note(p, `flags ${a.flags[i]} ≠ ${b.flags[j]}`);
    if (a.type[i] !== b.type[j]) note(p, `type ${a.type[i]} ≠ ${b.type[j]}`);
    if (!dir && Math.abs(a.mtime[i] - b.mtime[j]) > mtimeSlack) note(p, `mtime ${a.mtime[i]} ≠ ${b.mtime[j]}`);
  }
  for (const p of b.byPath.keys()) if (!a.byPath.has(p) && !skip(p)) note(p, `only in ${fileB}`);
  if (movedA !== movedB) for (const m of moved) diffs.push(m);

  // Header: what describes the scan, not when or how long it took.
  const ha = a.header, hb = b.header;
  for (const k of ['root', 'fs', 'cluster', 'total', 'partial']) {
    if (JSON.stringify(ha[k]) !== JSON.stringify(hb[k])) note('', `header.${k} ${JSON.stringify(ha[k])} ≠ ${JSON.stringify(hb[k])}`);
  }
  if (tolerance === 0 && !ignoreReplacement) {
    for (const k of ['files', 'dirs', 'bytes']) if (ha[k] !== hb[k]) note('', `header.${k} ${ha[k]} ≠ ${hb[k]}`);
  }
  return { ok: diffs.length <= tolerance, diffs, nodes: [a.n, b.n] };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const k = args.indexOf(name); if (k < 0) return def; const v = args[k + 1]; args.splice(k, 2); return v; };
  const tolerance = Number(opt('--tolerance', 0));
  const flagsMask = Number(opt('--flags', 0xff));
  const quiet = args.includes('--quiet');
  const files = args.filter((x) => !x.startsWith('--'));
  if (files.length !== 2) {
    console.error('Usage: node scripts/compare-scans.js <a.strata> <b.strata> [--tolerance N] [--flags MASK] [--quiet]');
    process.exit(2);
  }
  const r = compareScans(files[0], files[1], { tolerance, flagsMask });
  if (!quiet || !r.ok) for (const d of r.diffs.slice(0, 50)) console.log(d);
  if (r.diffs.length > 50) console.log(`… and ${r.diffs.length - 50} more`);
  console.log(`${r.nodes[0]} / ${r.nodes[1]} items, ${r.diffs.length} difference(s)${tolerance ? ` (tolerance ${tolerance})` : ''}: ${r.ok ? 'same' : 'DIFFERENT'}`);
  process.exit(r.ok ? 0 : 1);
}

module.exports = { compareScans };
