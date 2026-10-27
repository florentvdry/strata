// Reads a .strata scan file (same layout as parseScan in src/renderer/lib/tree.js), for the test scripts.
const fs = require('fs');

const F_DIR = 1;

function parseStrata(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 8) !== 'STRATA01') throw new Error(`${file}: not a .strata file`);
  const hlen = b.readInt32LE(8);
  const header = JSON.parse(b.toString('utf8', 12, 12 + hlen));
  let off = (12 + hlen + 7) & ~7;
  const n = b.readInt32LE(off); off += 8;
  const u8 = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const size = new Float64Array(u8.buffer, off, n); off += 8 * n;
  const mtime = new Float64Array(u8.buffer, off, n); off += 8 * n;
  const parent = new Int32Array(u8.buffer, off, n); off += 4 * n;
  const flags = u8.slice(off, off + n); off += n;
  const type = u8.slice(off, off + n); off += n;
  const nlen = b.readInt32LE(off); off += 4;
  const names = b.toString('utf8', off, off + nlen).split('\0');
  if (off + nlen !== b.length) throw new Error(`${file}: trailing bytes`);
  if (names.length !== n) throw new Error(`${file}: ${names.length} names for ${n} nodes`);
  for (let i = 1; i < n; i++) if (!(parent[i] >= 0 && parent[i] < i)) throw new Error(`${file}: node ${i} comes before its parent`);
  // Paths relative to the root, joined with "/".
  const rel = new Array(n);
  rel[0] = '';
  for (let i = 1; i < n; i++) rel[i] = parent[i] === 0 ? names[i] : `${rel[parent[i]]}/${names[i]}`;
  const byPath = new Map();
  for (let i = 1; i < n; i++) byPath.set(rel[i], i);
  return { header, n, size, mtime, parent, flags, type, names, rel, byPath };
}

module.exports = { parseStrata, F_DIR };
