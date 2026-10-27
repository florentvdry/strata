// Search syntax: words match names; *.mkv style globs; >1 GB / <500MB size filters; type:video.
import { TYPES } from './types.js';
import { F_DIR } from './tree.js';

const UNIT = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 };

export function parseQuery(q) {
  const f = { words: [], globs: [], min: 0, max: Infinity, types: [], empty: true };
  let rest = q.replace(/([<>]=?)\s*(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb|[bkmgt])?\b/gi, (m, op, num, unit) => {
    const v = parseFloat(num.replace(',', '.')) * (UNIT[(unit || 'mb').toLowerCase()] || 1);
    if (op[0] === '>') f.min = Math.max(f.min, v); else f.max = Math.min(f.max, v);
    f.empty = false;
    return ' ';
  });
  rest = rest.replace(/\b(?:type|kind):(\S+)/gi, (m, t) => {
    const want = t.toLowerCase();
    TYPES.forEach((ty, i) => { if (ty.id.startsWith(want) || ty.l.toLowerCase().startsWith(want)) f.types.push(i); });
    if (!f.types.length) f.types.push(-1);
    f.empty = false;
    return ' ';
  });
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    f.empty = false;
    if (/[*?]/.test(tok)) {
      const re = '^' + tok.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      f.globs.push(new RegExp(re));
    } else f.words.push(tok.toLowerCase());
  }
  return f;
}

// Matching nodes under `root`, biggest first. Folders only match by name.
export function runSearch(tree, root, f, limit = 500) {
  if (f.empty) return { hits: [], count: 0, bytes: 0 };
  const { names, size, flags, removed, n } = tree;
  const hits = [];
  let count = 0, bytes = 0;
  const nameOnly = f.min === 0 && f.max === Infinity && !f.types.length;
  // Root and its subtree are contiguous only in DFS order, so check ancestry for non-root searches.
  const under = root === 0 ? null : new Uint8Array(n);
  if (under) under[root] = 1;
  for (let i = 1; i < n; i++) {
    if (removed[i]) continue;
    if (under) { if (!under[tree.parent[i]]) continue; under[i] = 1; }
    const isDir = (flags[i] & F_DIR) !== 0;
    if (isDir && !nameOnly) continue;
    if (!isDir) {
      const s = size[i];
      if (s < f.min || s > f.max) continue;
      if (f.types.length && !f.types.includes(tree.type[i])) continue;
    }
    if (f.words.length || f.globs.length) {
      const nm = names[i].toLowerCase();
      let ok = true;
      for (const w of f.words) if (!nm.includes(w)) { ok = false; break; }
      if (ok) for (const g of f.globs) if (!g.test(nm)) { ok = false; break; }
      if (!ok) continue;
    }
    count++;
    bytes += size[i];
    hits.push(i);
  }
  hits.sort((a, b) => size[b] - size[a]);
  return { hits: hits.slice(0, limit), count, bytes };
}
