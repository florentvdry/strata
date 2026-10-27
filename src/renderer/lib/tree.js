// The in-memory scan result: flat typed arrays, parents before children.
import { TYPE_COUNT, typeOfName } from './types.js';
import { sep, fold } from './platform.js';

export const F_DIR = 1, F_HIDDEN = 2, F_SYSTEM = 4, F_REPARSE = 8, F_DENIED = 16, F_CLOUD = 32;

export function parseScan(bytes) {
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteOffset % 8 !== 0) u8 = u8.slice();
  const buf = u8.buffer, base = u8.byteOffset;
  const dv = new DataView(buf, base, u8.byteLength);
  const magic = new TextDecoder().decode(u8.subarray(0, 8));
  if (magic !== 'STRATA01') throw new Error('Not a Strata scan file');
  const hlen = dv.getInt32(8, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hlen)));
  let off = (12 + hlen + 7) & ~7;
  const n = dv.getInt32(off, true);
  off += 8;
  const size = new Float64Array(buf, base + off, n); off += 8 * n;
  const mtime = new Float64Array(buf, base + off, n); off += 8 * n;
  const parent = new Int32Array(buf, base + off, n); off += 4 * n;
  const flags = new Uint8Array(buf, base + off, n); off += n;
  const type = new Uint8Array(buf, base + off, n); off += n;
  const nlen = dv.getInt32(off, true); off += 4;
  const names = new TextDecoder().decode(u8.subarray(off, off + nlen)).split('\0');
  return new Tree(header, n, size, mtime, parent, flags, type, names);
}

export class Tree {
  constructor(header, n, size, mtime, parent, flags, type, names) {
    this.header = header;
    this.n = n;
    this.size = size;          // aggregated below for folders
    this.mtime = mtime;
    this.parent = parent;
    this.flags = flags;
    this.type = type;
    this.names = names;
    this.files = new Int32Array(n);  // files under each node (1 for a file)
    this.removed = new Uint8Array(n);
    this.version = 0;
    this.aggregate();
    this.buildChildren();
    this.buildTypes();
  }

  aggregate() {
    const { n, size, parent, flags, files } = this;
    for (let i = 0; i < n; i++) if (!(flags[i] & F_DIR)) files[i] = 1;
    for (let i = n - 1; i > 0; i--) {
      const p = parent[i];
      size[p] += size[i];
      files[p] += files[i];
    }
  }

  buildChildren() {
    const { n, parent, size } = this;
    const start = new Int32Array(n + 1);
    for (let i = 1; i < n; i++) start[parent[i] + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const fill = start.slice(0, n);
    const list = new Int32Array(Math.max(0, n - 1));
    for (let i = 1; i < n; i++) list[fill[parent[i]]++] = i;
    const bySize = (a, b) => size[b] - size[a];
    for (let i = 0; i < n; i++) {
      const a = start[i], b = start[i + 1];
      if (b - a > 1) list.subarray(a, b).sort(bySize);
    }
    this.childStart = start;
    this.childList = list;
  }

  // Bytes per file type for every folder, so folders can be coloured by what fills them.
  buildTypes() {
    const { n, parent, flags, size, type } = this;
    const dirIndex = new Int32Array(n).fill(-1);
    let dirs = 0;
    for (let i = 0; i < n; i++) if (flags[i] & F_DIR) dirIndex[i] = dirs++;
    const tb = new Float64Array(dirs * TYPE_COUNT);
    for (let i = n - 1; i > 0; i--) {
      const p = dirIndex[parent[i]] * TYPE_COUNT;
      if (flags[i] & F_DIR) {
        const c = dirIndex[i] * TYPE_COUNT;
        for (let t = 0; t < TYPE_COUNT; t++) tb[p + t] += tb[c + t];
      } else tb[p + type[i]] += size[i];
    }
    this.dirIndex = dirIndex;
    this.typeBytes = tb;
    this.dom = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.dom[i] = (flags[i] & F_DIR) ? this.dominantOf(i) : type[i];
  }

  dominantOf(i) {
    const d = this.dirIndex[i];
    if (d < 0) return this.type[i];
    const o = d * TYPE_COUNT;
    let best = 0, bv = -1;
    for (let t = 0; t < TYPE_COUNT; t++) if (this.typeBytes[o + t] > bv) { bv = this.typeBytes[o + t]; best = t; }
    return best;
  }

  // Bytes per type under node i.
  typesUnder(i) {
    const out = new Float64Array(TYPE_COUNT);
    if (!this.isDir(i)) { out[this.type[i]] = this.size[i]; return out; }
    const o = this.dirIndex[i] * TYPE_COUNT;
    for (let t = 0; t < TYPE_COUNT; t++) out[t] = this.typeBytes[o + t];
    return out;
  }

  isDir(i) { return (this.flags[i] & F_DIR) !== 0; }
  get root() { return 0; }
  get total() { return this.size[0]; }

  // Live children of i, biggest first.
  kids(i) {
    const out = [];
    const { childStart, childList, removed } = this;
    for (let k = childStart[i], e = childStart[i + 1]; k < e; k++) {
      const c = childList[k];
      if (!removed[c]) out.push(c);
    }
    return out;
  }

  childCount(i) {
    let c = 0;
    for (let k = this.childStart[i], e = this.childStart[i + 1]; k < e; k++) if (!this.removed[this.childList[k]]) c++;
    return c;
  }

  name(i) { return this.names[i]; }

  path(i) {
    if (i === 0) return this.names[0];
    const parts = [];
    for (let c = i; c > 0; c = this.parent[c]) parts.push(this.names[c]);
    parts.reverse();
    const root = this.names[0];
    return (root.endsWith(sep) ? root : root + sep) + parts.join(sep);
  }

  // Path relative to the scan root.
  rel(i) {
    const p = this.path(i), r = this.names[0];
    return p.slice(r.endsWith(sep) ? r.length : r.length + 1) || p;
  }

  ancestors(i) {
    const out = [];
    for (let c = i; c >= 0; c = c === 0 ? -1 : this.parent[c]) out.push(c);
    return out.reverse();
  }

  isUnder(i, anc) {
    for (let c = i; ; c = this.parent[c]) {
      if (c === anc) return true;
      if (c === 0) return false;
    }
  }

  depth(i) { let d = 0; for (let c = i; c > 0; c = this.parent[c]) d++; return d; }

  childNamed(i, name) {
    const want = fold(name);
    for (let k = this.childStart[i], e = this.childStart[i + 1]; k < e; k++) {
      const c = this.childList[k];
      if (!this.removed[c] && fold(this.names[c]) === want) return c;
    }
    return -1;
  }

  // Absolute path → node, or -1 when it's outside this scan.
  lookup(abs) {
    const strip = (p) => (p.endsWith(sep) ? p.slice(0, -1) : p);
    const root = strip(this.names[0]);
    const a = strip(abs);
    if (fold(a) === fold(root)) return 0;
    if (!fold(a).startsWith(fold(root) + sep)) return -1;
    let cur = 0;
    for (const part of a.slice(root.length + 1).split(sep)) {
      if (!part) continue;
      cur = this.childNamed(cur, part);
      if (cur < 0) return -1;
    }
    return cur;
  }

  // Take a node out of the tree (after it was deleted on disk). With `keep`, the node stays as an
  // opaque block of `remaining` bytes (a folder that was emptied, or only partly deleted).
  remove(i, remaining = 0, keep = remaining > 0) {
    if (i === 0 && !keep) return;
    const delta = Math.max(0, this.size[i] - remaining);
    const fdelta = keep ? this.files[i] - (remaining > 0 ? 1 : 0) : this.files[i];
    const tdelta = this.typesUnder(i);
    const scale = this.size[i] > 0 ? delta / this.size[i] : 0;
    if (keep) {
      for (const c of this.kids(i)) this.markRemoved(c);
      this.size[i] = remaining;
      this.files[i] -= fdelta;
      if (this.dirIndex[i] >= 0) {
        const o = this.dirIndex[i] * TYPE_COUNT;
        for (let t = 0; t < TYPE_COUNT; t++) this.typeBytes[o + t] *= 1 - scale;
      }
    } else this.markRemoved(i);
    if (i === 0) { this.version++; return; }
    for (let p = this.parent[i]; ; p = this.parent[p]) {
      this.size[p] -= delta;
      this.files[p] -= fdelta;
      const o = this.dirIndex[p] * TYPE_COUNT;
      for (let t = 0; t < TYPE_COUNT; t++) this.typeBytes[o + t] = Math.max(0, this.typeBytes[o + t] - tdelta[t] * scale);
      this.dom[p] = this.dominantOf(p);
      this.resortChildren(p);
      if (p === 0) break;
    }
    this.version++;
  }

  markRemoved(i) {
    this.removed[i] = 1;
    if (!this.isDir(i)) return;
    const stack = [i];
    while (stack.length) {
      const d = stack.pop();
      for (let k = this.childStart[d], e = this.childStart[d + 1]; k < e; k++) {
        const c = this.childList[k];
        this.removed[c] = 1;
        if (this.flags[c] & F_DIR) stack.push(c);
      }
    }
  }

  resortChildren(p) {
    const { childStart, childList, size } = this;
    const a = childStart[p], b = childStart[p + 1];
    if (b - a > 1) childList.subarray(a, b).sort((x, y) => size[y] - size[x]);
  }

  // Every live file, as a generator of node ids (used by search and smart views).
  *allFiles() {
    const { n, flags, removed } = this;
    for (let i = 1; i < n; i++) if (!(flags[i] & F_DIR) && !removed[i]) yield i;
  }

  typeOf(i) { return this.isDir(i) ? this.dom[i] : this.type[i]; }
}

export { typeOfName };
