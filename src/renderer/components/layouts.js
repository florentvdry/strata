// Canvas layouts for the space map. Each returns { paint(ctx, opts), hit(x, y), outline(ctx, id, mode) }.
import { TYPES } from '../lib/types.js';
import { squarify } from '../lib/squarify.js';
import { fmtBytes } from '../lib/format.js';

const BG = '#0B0D10';
const MIN_AREA = 3;      // px² below which children are lumped together
const LABEL_W = 84, LABEL_H = 40;

// Unit-square cushion gradient (the design's "radial-gradient(ellipse at 30% 22%, …)"), reused for every tile.
function cushion(ctx) {
  const g = ctx.createRadialGradient(0.3, 0.22, 0, 0.3, 0.22, 1.05);
  g.addColorStop(0, 'rgba(255,255,255,.34)');
  g.addColorStop(0.48, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,.34)');
  return g;
}

function ellipsize(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

function dimmed(tree, id, marked, opts) {
  if (opts.mark && !marked) return true;
  if (opts.typeFilter >= 0 && tree.typeOf(id) !== opts.typeFilter) return true;
  return false;
}

// Rect list shared by the treemap and columns views.
class Rects {
  constructor() { this.x = []; this.y = []; this.w = []; this.h = []; this.id = []; this.m = []; this.lump = []; this.byId = new Map(); }
  push(x, y, w, h, id, marked, lump) {
    const k = this.x.length;
    this.x.push(x); this.y.push(y); this.w.push(w); this.h.push(h); this.id.push(id); this.m.push(marked); this.lump.push(lump);
    if (!this.byId.has(id)) this.byId.set(id, k);
    return k;
  }
  hit(px, py) {
    for (let k = this.x.length - 1; k >= 0; k--) {
      const x = this.x[k], y = this.y[k];
      if (px >= x && py >= y && px < x + this.w[k] && py < y + this.h[k]) return k;
    }
    return -1;
  }
}

function paintRects(ctx, tree, R, opts, labels) {
  const g = opts.shading ? cushion(ctx) : null;
  const dpr = opts.dpr;
  for (let k = 0; k < R.x.length; k++) {
    const x = R.x[k], y = R.y[k], w = R.w[k], h = R.h[k];
    if (w < 0.4 || h < 0.4) continue;
    const id = R.id[k];
    const ty = TYPES[tree.typeOf(id)];
    ctx.globalAlpha = dimmed(tree, id, R.m[k], opts) ? 0.16 : 1;
    ctx.fillStyle = ty.c;
    ctx.fillRect(x, y, w, h);
    if (g && w >= 3 && h >= 3) {
      ctx.setTransform(dpr * w, 0, 0, dpr * h, dpr * x, dpr * y);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1, 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (w >= 4 && h >= 4) {
      ctx.strokeStyle = 'rgba(11,13,16,.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
  }
  ctx.globalAlpha = 1;
  if (!labels) return;
  for (let k = 0; k < R.x.length; k++) {
    const w = R.w[k], h = R.h[k];
    if (w <= LABEL_W || h <= LABEL_H || R.lump[k]) continue;
    const id = R.id[k];
    if (dimmed(tree, id, R.m[k], opts)) continue;
    const ty = TYPES[tree.typeOf(id)];
    ctx.fillStyle = ty.fg;
    ctx.font = '600 12px Geist, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(ellipsize(ctx, tree.name(id), w - 16), R.x[k] + 8, R.y[k] + 6);
    ctx.globalAlpha = 0.85;
    ctx.font = '400 11px "Geist Mono", monospace';
    ctx.fillText(ellipsize(ctx, fmtBytes(tree.size[id]), w - 16), R.x[k] + 8, R.y[k] + 21);
    ctx.globalAlpha = 1;
  }
}

function outlineRect(ctx, x, y, w, h, mode) {
  if (mode === 'hover') {
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
  }
}

// ───────────── treemap ─────────────

export function layoutTreemap(tree, root, W, H, mark, { labels = true } = {}) {
  const R = new Rects();
  const dirs = new Map();
  const { size } = tree;

  function lay(i, x, y, w, h, depth, marked) {
    if (w < 0.3 || h < 0.3) return;
    const m = marked || !!(mark && mark[i]);
    if (!tree.isDir(i)) { R.push(x, y, w, h, i, m, false); return; }
    dirs.set(i, [x, y, w, h]);
    const total = size[i];
    const kids = tree.kids(i);
    if (!kids.length || total <= 0 || (depth > 0 && w * h < 24)) { R.push(x, y, w, h, i, m, true); return; }
    let pad = depth === 0 ? 0 : depth === 1 ? 3 : 1;
    if (w <= pad * 2 + 6 || h <= pad * 2 + 6) pad = 0;
    const ix = x + pad, iy = y + pad, iw = w - pad * 2, ih = h - pad * 2;
    const area = iw * ih;
    const vals = [], ids = [];
    let used = 0;
    for (const c of kids) {
      const s = size[c];
      if (s <= 0 || (s / total) * area < MIN_AREA) break;
      vals.push(s); ids.push(c); used += s;
    }
    if (total - used > 0 && (total - used) / total * area >= 0.5) { vals.push(total - used); ids.push(-1); }
    const rects = squarify(vals, ix, iy, iw, ih);
    for (let k = 0; k < ids.length; k++) {
      const [rx, ry, rw, rh] = rects[k];
      if (ids[k] < 0) R.push(rx, ry, rw, rh, i, m, true);
      else lay(ids[k], rx, ry, rw, rh, depth + 1, m);
    }
  }
  lay(root, 0, 0, W, H, 0, false);

  // Where to draw the selection: the item's own block, or the smallest drawn folder holding it.
  function rectOf(id) {
    if (!tree.isDir(id) && R.byId.has(id)) {
      const k = R.byId.get(id);
      return [R.x[k], R.y[k], R.w[k], R.h[k]];
    }
    for (let c = id; ; c = tree.parent[c]) {
      if (c === root || c === 0) return null; // too small to see: don't outline the whole map
      if (dirs.has(c)) return dirs.get(c);
    }
  }

  return {
    paint(ctx, opts) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      paintRects(ctx, tree, R, opts, labels);
    },
    hit(x, y) { const k = R.hit(x, y); return k < 0 ? -1 : R.id[k]; },
    outline(ctx, id, mode) {
      const r = mode === 'hover' && R.byId.has(id) ? [R.x[R.byId.get(id)], R.y[R.byId.get(id)], R.w[R.byId.get(id)], R.h[R.byId.get(id)]] : rectOf(id);
      if (r && id !== root) outlineRect(ctx, r[0], r[1], r[2], r[3], mode);
    },
  };
}

// ───────────── columns (icicle) ─────────────

export function layoutColumns(tree, root, W, H, mark) {
  const MAXD = 7;
  const tmp = [];
  let maxDepth = 1;
  const { size } = tree;
  function lay(i, y0, y1, depth, marked) {
    const total = size[i];
    if (total <= 0) return;
    let y = y0;
    for (const c of tree.kids(i)) {
      const h = (y1 - y0) * size[c] / total;
      if (h < 0.6) { // lump the rest
        tmp.push({ y, h: y1 - y, d: depth, id: i, m: marked || !!(mark && mark[i]), lump: true });
        break;
      }
      const m = marked || !!(mark && mark[c]);
      tmp.push({ y, h, d: depth, id: c, m, lump: false });
      if (depth > maxDepth) maxDepth = depth;
      if (tree.isDir(c) && depth < MAXD && h >= 2) lay(c, y, y + h, depth + 1, m);
      y += h;
    }
  }
  lay(root, 0, H, 1, !!(mark && mark[root]));
  const cols = Math.max(2, Math.min(MAXD, maxDepth));
  const cw = W / cols;
  const R = new Rects();
  for (const t of tmp) if (t.d <= cols) R.push((t.d - 1) * cw, t.y, cw - 2, t.h, t.id, t.m, t.lump);
  return {
    paint(ctx, opts) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      paintRects(ctx, tree, R, opts, true);
    },
    hit(x, y) { const k = R.hit(x, y); return k < 0 ? -1 : R.id[k]; },
    outline(ctx, id, mode) {
      for (let c = id; c >= 0; c = c === 0 ? -1 : tree.parent[c]) {
        const k = R.byId.get(c);
        if (k !== undefined) { outlineRect(ctx, R.x[k], R.y[k], R.w[k], R.h[k], mode); return; }
        if (c === root) return;
      }
    },
  };
}

// ───────────── sunburst ─────────────

export function layoutSunburst(tree, root, W, H, mark) {
  const LEVELS = 6;
  const cx = W / 2, cy = H / 2;
  const R = Math.max(10, Math.min(W, H) / 2 - 8);
  const r0 = R * 0.24;
  const ring = (R - r0) / LEVELS;
  const segs = []; // { a0, a1, d, id, m, lump }
  const { size } = tree;
  function lay(i, a0, a1, d, marked) {
    const total = size[i];
    if (total <= 0 || d > LEVELS) return;
    let a = a0;
    for (const c of tree.kids(i)) {
      const span = (a1 - a0) * size[c] / total;
      if (span < 0.003) {
        if (a1 - a > 0.003) segs.push({ a0: a, a1, d, id: i, m: marked || !!(mark && mark[i]), lump: true });
        break;
      }
      const m = marked || !!(mark && mark[c]);
      segs.push({ a0: a, a1: a + span, d, id: c, m, lump: false });
      if (tree.isDir(c)) lay(c, a, a + span, d + 1, m);
      a += span;
    }
  }
  lay(root, 0, Math.PI * 2, 1, !!(mark && mark[root]));
  const byId = new Map();
  segs.forEach((sg, k) => { if (!byId.has(sg.id)) byId.set(sg.id, k); });

  const arc = (ctx, sg, inset = 0) => {
    const ri = r0 + (sg.d - 1) * ring + 1 + inset, ro = r0 + sg.d * ring - inset;
    const gap = Math.min(0.004, (sg.a1 - sg.a0) * 0.15);
    const a0 = sg.a0 - Math.PI / 2 + gap, a1 = sg.a1 - Math.PI / 2 - gap;
    ctx.beginPath();
    ctx.arc(cx, cy, ro, a0, Math.max(a0, a1));
    ctx.arc(cx, cy, ri, Math.max(a0, a1), a0, true);
    ctx.closePath();
  };

  return {
    paint(ctx, opts) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      for (const sg of segs) {
        const ty = TYPES[tree.typeOf(sg.id)];
        ctx.globalAlpha = dimmed(tree, sg.id, sg.m, opts) ? 0.16 : 1;
        arc(ctx, sg);
        ctx.fillStyle = ty.c;
        ctx.fill();
        if (opts.shading) {
          const ri = r0 + (sg.d - 1) * ring, ro = r0 + sg.d * ring;
          const g = ctx.createRadialGradient(cx, cy, ri, cx, cy, ro);
          g.addColorStop(0, 'rgba(255,255,255,.26)');
          g.addColorStop(0.5, 'rgba(255,255,255,0)');
          g.addColorStop(1, 'rgba(0,0,0,.30)');
          ctx.fillStyle = g;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      // Labels on big first-ring segments.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const sg of segs) {
        if (sg.d > 2 || sg.lump || dimmed(tree, sg.id, sg.m, opts)) continue;
        const mid = (sg.a0 + sg.a1) / 2 - Math.PI / 2;
        const rr = r0 + (sg.d - 0.5) * ring;
        const arcLen = (sg.a1 - sg.a0) * rr;
        if (arcLen < 70 || ring < 34) continue;
        ctx.fillStyle = TYPES[tree.typeOf(sg.id)].fg;
        ctx.font = '600 11px Geist, system-ui, sans-serif';
        ctx.fillText(ellipsize(ctx, tree.name(sg.id), Math.min(arcLen - 12, ring * 2.2)), cx + Math.cos(mid) * rr, cy + Math.sin(mid) * rr);
      }
      // Centre: the folder being shown.
      ctx.beginPath();
      ctx.arc(cx, cy, r0 - 3, 0, Math.PI * 2);
      ctx.fillStyle = '#14171C';
      ctx.fill();
      ctx.strokeStyle = '#262B33';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#E6E8EB';
      ctx.font = '600 13px Geist, system-ui, sans-serif';
      ctx.fillText(ellipsize(ctx, tree.name(root), r0 * 1.6), cx, cy - 9);
      ctx.fillStyle = '#9BA3AF';
      ctx.font = '400 12px "Geist Mono", monospace';
      ctx.fillText(fmtBytes(size[root]), cx, cy + 9);
      if (root !== 0) {
        ctx.font = '400 11px Geist, system-ui, sans-serif';
        ctx.fillStyle = '#7B8390';
        ctx.fillText('click to go up', cx, cy + 27);
      }
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    },
    hit(x, y) {
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r < r0) return -2;
      if (r > R) return -1;
      const d = Math.ceil((r - r0) / ring);
      let a = Math.atan2(dy, dx) + Math.PI / 2;
      if (a < 0) a += Math.PI * 2;
      for (const sg of segs) if (sg.d === d && a >= sg.a0 && a < sg.a1) return sg.id;
      return -1;
    },
    outline(ctx, id, mode) {
      for (let c = id; c >= 0; c = c === 0 ? -1 : tree.parent[c]) {
        const k = byId.get(c);
        if (k !== undefined) {
          arc(ctx, segs[k], mode === 'hover' ? 0 : 1);
          if (mode === 'hover') { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fill(); }
          else { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2; ctx.stroke(); }
          return;
        }
        if (c === root) return;
      }
    },
  };
}

export const LAYOUTS = { treemap: layoutTreemap, sunburst: layoutSunburst, columns: layoutColumns };
