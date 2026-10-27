// Explorer — treemap, tree & details.
import { useMemo, useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { useStore, hover, store } from '../lib/store.js';
import { Logo, Icon } from '../components/ui.js';
import { SpaceMap, MiniMap } from '../components/map.js';
import { TYPES, SHADE } from '../lib/types.js';
import { parseQuery, runSearch } from '../lib/search.js';
import { CATS, selectionStats } from '../lib/cleanup.js';
import { bytesParts, fmtBytes, fmtPair, fmtPct, fmtShort, fmtWhen, fmtDur, plural } from '../lib/format.js';
import { isWin, trimSep, TRASH, FILE_MANAGER } from '../lib/platform.js';
import { driveName } from './start.js';
import * as A from '../actions.js';

const YEAR = 365 * 86400;

// Sidebar values: whole numbers from 10 up so labels like "Untouched for 1 year" keep their room.
const compact = (b) => {
  const p = bytesParts(b);
  return parseFloat(p.num) >= 10 ? `${Math.round(parseFloat(p.num))} ${p.unit}` : `${p.num} ${p.unit}`;
};

const VIEWS = [
  { id: 'treemap', label: 'Treemap', hint: 'Every block is a file, sized by bytes' },
  { id: 'sunburst', label: 'Sunburst', hint: 'Rings are folder levels, sized by bytes' },
  { id: 'columns', label: 'Columns', hint: 'Each column goes one folder deeper' },
];

// ───────────── derived data ─────────────

function largestFiles(tree, limit = 100) {
  const top = [];
  let min = 0;
  const { n, flags, size, removed } = tree;
  for (let i = 1; i < n; i++) {
    if ((flags[i] & 1) || removed[i]) continue;
    const s = size[i];
    if (top.length >= limit && s <= min) continue;
    let k = top.length;
    while (k > 0 && size[top[k - 1]] < s) k--;
    top.splice(k, 0, i);
    if (top.length > limit) top.pop();
    min = size[top[top.length - 1]];
  }
  return top;
}

function untouched(tree) {
  const cutoff = Date.now() / 1000 - YEAR;
  const ids = [];
  let bytes = 0;
  const { n, flags, size, removed, mtime } = tree;
  for (let i = 1; i < n; i++) {
    if ((flags[i] & 1) || removed[i] || !mtime[i] || mtime[i] > cutoff) continue;
    ids.push(i);
    bytes += size[i];
  }
  ids.sort((a, b) => size[b] - size[a]);
  return { ids: ids.slice(0, 500), count: ids.length, bytes };
}

function dupeGroups(tree, groups) {
  const out = [];
  for (const g of groups) {
    const ids = g.paths.map((p) => tree.lookup(p)).filter((i) => i > 0 && !tree.removed[i]);
    if (ids.length > 1) out.push({ ids, size: g.size, wasted: g.size * (ids.length - 1), verified: g.verified });
  }
  return out.sort((a, b) => b.wasted - a.wasted);
}

// ───────────── table rows ─────────────

function treeRows(tree, root, open, more) {
  const rows = [];
  function walk(i, depth) {
    const kids = tree.kids(i);
    const lim = more[i] || 200;
    for (let k = 0; k < Math.min(kids.length, lim); k++) {
      const c = kids[k];
      const dir = tree.isDir(c) && tree.childCount(c) > 0;
      rows.push({ id: c, depth, dir, open: dir && open.has(c) });
      if (dir && open.has(c) && rows.length < 4000) walk(c, depth + 1);
    }
    if (kids.length > lim) rows.push({ more: i, depth, count: kids.length - lim });
  }
  walk(root, 0);
  return rows;
}

function Row({ tree, r, sel, accent, maxV, total, flat }) {
  const id = r.id;
  const isSel = id === sel;
  const ty = TYPES[tree.typeOf(id)];
  const size = tree.size[id];
  const bar = `width: ${maxV ? Math.min(100, size / maxV * 100) : 0}%; background: ${r.dir ? accent : ty.c}`;
  const name = flat ? r.label || tree.name(id) : tree.name(id);
  return html`
    <div class=${`hov-row${isSel ? ' sel' : ''}`} data-id=${id} onClick=${() => A.select(id, { reveal: false })} onDblClick=${() => (r.dir || tree.isDir(id) ? A.zoomTo(id) : window.strata.open(tree.path(id)))}
      onContextMenu=${(e) => { e.preventDefault(); A.select(id, { reveal: false }); A.nodeMenu(id); }}
      style="display: grid; grid-template-columns: minmax(0, 1fr) 140px 84px 56px; gap: 12px; align-items: center; padding: 0 12px; min-height: 36px; border-bottom: 1px solid #1B1F25; cursor: default">
      <div style=${`display: flex; align-items: center; gap: 8px; min-width: 0; padding-left: ${r.depth * 22}px`} title=${flat ? tree.path(id) : tree.name(id)}>
        ${r.dir ? html`
          <button type="button" onClick=${(e) => { e.stopPropagation(); flat ? A.zoomTo(id) : A.toggleOpen(id); }} aria-expanded=${r.open ? 'true' : 'false'} style="display: flex; align-items: center; gap: 8px; min-width: 0; height: 36px; padding: 0; border: 0; background: transparent; color: #E6E8EB; cursor: pointer; font-weight: 500">
            ${Icon.chevron(r.open ? 'flex: none; transform: rotate(90deg); transition: transform .15s' : 'flex: none; transition: transform .15s')}
            ${Icon.folder()}
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${name}</span>
          </button>` : html`
          <span style="width: 14px; flex: none"></span>
          ${tree.isDir(id) ? Icon.folder() : html`<span style=${`width: 10px; height: 10px; border-radius: 3px; flex: none; background: ${ty.c}`}></span>`}
          <span style="display: flex; flex-direction: column; min-width: 0">
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #C9CED6">${name}</span>
            ${flat && r.sub && html`<span style="font-family: 'Geist Mono', monospace; font-size: 11px; color: #7B8390; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${r.sub}</span>`}
          </span>`}
      </div>
      <span style="display: block; height: 6px; border-radius: 3px; background: #22262D; overflow: hidden"><span style=${`display: block; height: 100%; border-radius: 3px; ${bar}`}></span></span>
      <span style="text-align: right; font-family: 'Geist Mono', monospace; font-size: 12px">${fmtBytes(size)}</span>
      <span style="text-align: right; font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF">${fmtPct(size, total)}</span>
    </div>`;
}

// ───────────── pieces ─────────────

function Breadcrumb({ tree, zoom }) {
  const anc = tree.ancestors(zoom);
  const rootName = isWin ? tree.names[0].replace(/\\$/, '') : trimSep(tree.names[0]);
  const rootLabel = isWin ? (/^[A-Za-z]:$/.test(rootName) ? rootName : rootName.split('\\').pop()) : (rootName === '/' ? '/' : rootName.split('/').pop());
  const label = (i) => (i === 0 ? rootLabel : tree.name(i));
  let crumbs = anc.map((i) => ({ i, l: label(i) }));
  if (crumbs.length > 6) crumbs = [crumbs[0], { i: -1, l: '…' }, ...crumbs.slice(-4)];
  return html`
    <nav aria-label="Breadcrumb" title=${tree.path(zoom)} style="display: flex; align-items: center; gap: 6px; font-family: 'Geist Mono', monospace; font-size: 13px; color: #9BA3AF; padding: 6px 10px; background: #181C22; border: 1px solid #262B33; border-radius: 8px; min-width: 0; max-width: 44vw; overflow: hidden; white-space: nowrap">
      ${crumbs.map((c, k) => html`
        ${k > 0 && html`<span aria-hidden="true">/</span>`}
        ${c.i < 0 ? html`<span>…</span>` : html`<button type="button" class="crumb" onClick=${() => A.zoomTo(c.i)} aria-current=${c.i === zoom ? 'page' : undefined}
          style=${`color: ${k === 0 || c.i === zoom ? '#E6E8EB' : '#9BA3AF'}; overflow: hidden; text-overflow: ellipsis; max-width: 200px`}>${c.l}</button>`}`)}
    </nav>`;
}

function SearchBox({ query }) {
  const ref = useRef(null);
  const [val, setVal] = useState(query);
  const timer = useRef(null);
  useEffect(() => { if (query !== val && document.activeElement !== ref.current) setVal(query); }, [query]);
  useEffect(() => {
    const onKey = (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current.focus(); ref.current.select(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  function onInput(e) {
    const v = e.currentTarget.value;
    setVal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => A.setQuery(v), 160);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); setVal(''); A.setQuery(''); ref.current.blur(); }
    if (e.key === 'Enter') { clearTimeout(timer.current); A.setQuery(e.currentTarget.value); }
  }
  return html`
    <label style="display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 38px; background: #181C22; border: 1px solid #262B33; border-radius: 8px; min-width: 240px; box-sizing: border-box">
      ${Icon.search()}
      <span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)">Search files</span>
      <input ref=${ref} type="search" value=${val} onInput=${onInput} onKeyDown=${onKeyDown} placeholder="Search files, *.mkv, >1 GB…" style="background: transparent; border: 0; outline: none; color: #E6E8EB; font: inherit; width: 100%" />
      <kbd style="font-family: 'Geist Mono', monospace; font-size: 11px; color: #9BA3AF; border: 1px solid #333944; border-radius: 4px; padding: 1px 5px; white-space: nowrap">Ctrl K</kbd>
    </label>`;
}

function Stat({ label, value, accent }) {
  const p = bytesParts(value, 1);
  return html`
    <div style="padding: 14px 16px; border-radius: 12px; background: #14171C; border: 1px solid #22262D; display: flex; flex-direction: column; gap: 4px">
      <span style="font-size: 12px; color: #9BA3AF">${label}</span>
      <span style=${`font-size: 24px; font-weight: 600; letter-spacing: -0.02em; ${accent ? 'color: var(--accent)' : ''}`}>${p.num} <span style=${`font-size: 14px; ${accent ? '' : 'color: #9BA3AF;'} font-weight: 500`}>${p.unit}</span></span>
    </div>`;
}

function SmartButton({ id, label, value, active }) {
  return html`
    <button type="button" class="hov-quiet" aria-pressed=${active ? 'true' : 'false'} onClick=${() => A.setPanel(active ? 'folders' : id)}
      style=${`display: flex; justify-content: space-between; align-items: center; gap: 8px; height: 36px; padding: 0 10px; border: 0; border-radius: 8px; background: ${active ? '#1E232A' : 'transparent'}; color: ${active ? '#E6E8EB' : '#C9CED6'}; cursor: pointer; text-align: left; ${active ? 'font-weight: 600' : ''}`}>
      <span style="min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${label}</span><span style="flex: none; font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; font-weight: 400">${value}</span>
    </button>`;
}

function Footer({ tree, scan, partial }) {
  const hv = useStore(hover);
  let status = 'Hover a block to inspect · click to select · double-click to zoom in';
  if (hv.id >= 0 && tree && hv.id < tree.n) status = `${tree.path(hv.id)}  —  ${fmtBytes(tree.size[hv.id])}`;
  const h = tree.header;
  const cluster = h.cluster >= 1024 ? `${h.cluster / 1024} KB` : `${h.cluster} B`;
  return html`
    <footer style="display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 8px 20px; border-top: 1px solid #22262D; background: #12151A; font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; min-height: 36px; box-sizing: border-box; position: sticky; bottom: 0; z-index: 5">
      <span style=${`width: 8px; height: 8px; border-radius: 4px; background: ${partial && scan ? '#F59E0B' : 'var(--accent)'}`}></span>
      <span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #C9CED6">${status}</span>
      ${partial && scan && html`<span style="color: #F5B54A">Partial results · scan ${Math.floor(scan.pct * 100)}%${scan.paused ? ' (paused)' : ''} · <a href="#" onClick=${(e) => { e.preventDefault(); A.go('scanning'); }}>View progress</a></span>`}
      ${partial && !scan && html`<span style="color: #F5B54A">Partial results</span>`}
      <span>${h.fs || 'Folder'}${h.fs ? ` · ${cluster} clusters` : ''}</span>
      <span>v${store.state.info.version.replace(/\.0$/, '')}</span>
    </footer>`;
}

function Details({ tree, node, ex, settings, cleanup, drive, queue }) {
  const accent = settings.accent;
  const v = tree.version;
  const isDir = tree.isDir(node);
  const ty = TYPES[tree.typeOf(node)];
  const size = tree.size[node];
  const parentSize = node > 0 ? tree.size[tree.parent[node]] : size;
  const capacity = drive ? drive.total : tree.header.total;
  const it = A.itemForNode(node);
  const queued = !!(it && cleanup.on[it.id]);
  const byCat = CATS.filter((c) => c.id !== 'all').map((c) => {
    const st = selectionStats(tree, cleanup.items.filter((i) => i.cat === c.id), cleanup.on);
    return { c, bytes: st.bytes, n: st.chosen.length };
  }).filter((x) => x.n > 0);
  const label = (c) => (c.id === 'installer' && cleanup.items.some((i) => i.cat === 'installer' && cleanup.on[i.id] && /\.iso$/i.test(i.name)) ? 'Old installers (.iso)' : c.short);
  return html`
    <aside aria-label="Selection details" style="flex: 1 1 288px; max-width: 100%; padding: 20px; border-left: 1px solid #22262D; display: flex; flex-direction: column; gap: 20px; box-sizing: border-box; background: #101317">
      <div style="display: flex; flex-direction: column; gap: 10px">
        <span style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0">Selected</span>
        ${isDir && size > 0
          ? html`<${MiniMap} tree=${tree} version=${v} node=${node} shading=${settings.shading} />`
          : html`<div style=${`height: 96px; border-radius: 12px; background-color: ${ty.c}; ${settings.shading ? `background-image: ${SHADE};` : ''}`}></div>`}
        <h2 style="margin: 4px 0 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; word-break: break-all">${tree.name(node)}</h2>
        <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; word-break: break-all">${tree.path(node)}</span>
      </div>
      <dl style="margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 10px 16px; font-size: 13px">
        <dt style="color: #9BA3AF">Size</dt><dd style="margin: 0; text-align: right; font-family: 'Geist Mono', monospace">${fmtBytes(size)}</dd>
        <dt style="color: #9BA3AF">Of drive</dt><dd style="margin: 0; text-align: right; font-family: 'Geist Mono', monospace">${fmtPct(size, capacity)}</dd>
        <dt style="color: #9BA3AF">Of folder</dt><dd style="margin: 0; text-align: right; font-family: 'Geist Mono', monospace">${node === 0 ? '—' : fmtPct(size, parentSize)}</dd>
        <dt style="color: #9BA3AF">Type</dt><dd style="margin: 0; text-align: right">${isDir ? `Folder · ${plural(tree.files[node], 'file')}` : ty.l}</dd>
        ${tree.mtime[node] > 0 && html`<dt style="color: #9BA3AF">Modified</dt><dd style="margin: 0; text-align: right">${fmtWhen(tree.mtime[node] * 1000)}</dd>`}
      </dl>
      <div style="display: flex; flex-direction: column; gap: 8px">
        <button type="button" class="hov-accent" disabled=${node === 0} onClick=${() => A.toggleCleanupNode(node)} style=${`height: 44px; border-radius: 10px; border: ${queued ? '1px solid var(--accent)' : '0'}; background: ${queued ? 'transparent' : 'var(--accent)'}; color: ${queued ? 'var(--accent)' : '#0E1014'}; font-weight: 600; cursor: pointer`}>${queued ? 'Remove from cleanup' : 'Add to cleanup'}</button>
        <button type="button" class="hov-ghost" onClick=${() => A.reveal(tree.path(node))} style="height: 44px; border-radius: 10px; border: 1px solid #333944; background: transparent; color: #E6E8EB; font-weight: 500; cursor: pointer">Show in ${FILE_MANAGER}</button>
        <button type="button" class="hov-danger" disabled=${node === 0} onClick=${() => A.confirmTrash(node)} style="height: 44px; border-radius: 10px; border: 1px solid #5A2A2E; background: transparent; color: #FF9AA2; font-weight: 500; cursor: pointer">Move to ${TRASH}</button>
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 12px; background: #14171C; border: 1px solid #22262D">
        <div style="display: flex; justify-content: space-between; align-items: baseline"><span style="font-weight: 600">Cleanup queue</span><span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: var(--accent)">${fmtBytes(queue.bytes)}</span></div>
        ${byCat.length === 0 && html`<span style="font-size: 13px; color: #9BA3AF">Nothing queued yet.</span>`}
        ${byCat.map((x) => html`<div style="display: flex; justify-content: space-between; font-size: 13px; color: #C9CED6"><span>${label(x.c)}</span><span style="font-family: 'Geist Mono', monospace; font-size: 12px">${fmtBytes(x.bytes)}</span></div>`)}
        <a href="#" onClick=${(e) => { e.preventDefault(); A.go('cleanup'); }} style="margin-top: 4px; font-weight: 500; text-decoration: none">Review queue →</a>
      </div>
    </aside>`;
}

// ───────────── view ─────────────

export function Explorer() {
  const st = useStore();
  const { tree, ex, settings, drives, cleanup, dupes, scan, partial } = st;
  const v = tree.version;
  const accent = settings.accent;
  const view = settings.view || 'treemap';
  const zoom = ex.zoom;
  const sel = ex.sel >= 0 && !tree.removed[ex.sel] ? ex.sel : zoom;
  const tableRef = useRef(null);

  const drive = A.driveOf(tree.names[0]);
  const isDriveScan = isWin ? /^[A-Za-z]:\\?$/.test(tree.names[0]) : !!drive && drive.root === trimSep(tree.names[0]);
  const queue = useMemo(() => selectionStats(tree, cleanup.items, cleanup.on), [tree, v, cleanup]);

  // Smart view data (whole scan).
  const smart = useMemo(() => ({ largest: largestFiles(tree), old: untouched(tree) }), [tree, v]);
  const dg = useMemo(() => dupeGroups(tree, dupes.groups), [tree, v, dupes.groups]);
  const catBytes = (cat) => cleanup.items.filter((i) => i.cat === cat).reduce((a, i) => a + i.v, 0);

  // What the table shows, and which nodes light up on the map.
  const panel = useMemo(() => {
    const p = ex.panel;
    const flatRows = (ids, sub) => ids.map((i) => ({ id: i, depth: 0, dir: tree.isDir(i), flat: true, sub: sub ? sub(i) : tree.rel(tree.parent[i]) }));
    if (p === 'search') {
      const r = runSearch(tree, zoom, parseQuery(ex.query));
      return { title: 'Search results', sub: `${plural(r.count, 'match', 'matches')} · ${fmtBytes(r.bytes)}${r.count > r.hits.length ? ` · showing ${r.hits.length}` : ''}`, rows: flatRows(r.hits), mark: r.hits };
    }
    if (p === 'largest') return { title: 'Largest files', sub: `Top ${smart.largest.length} in ${tree.names[0]}`, rows: flatRows(smart.largest), mark: smart.largest };
    if (p === 'old') return { title: 'Untouched for 1 year', sub: `${plural(smart.old.count, 'file')} · ${fmtBytes(smart.old.bytes)} not modified in a year`, rows: flatRows(smart.old.ids), mark: smart.old.ids };
    if (p === 'dupes') {
      const rows = [];
      const mark = [];
      for (const g of dg.slice(0, 200)) {
        g.ids.forEach((i, k) => { rows.push({ id: i, depth: 0, dir: false, flat: true, sub: `${k === 0 ? 'Oldest copy' : 'Copy'} · ${tree.rel(tree.parent[i])}` }); mark.push(i); });
      }
      const sub = dupes.status === 'running' ? `Comparing file contents… ${Math.floor(dupes.pct * 100)}%` : dupes.status === 'error' ? 'Duplicate search failed' : `${plural(dg.length, 'group')} · ${fmtBytes(dg.reduce((a, g) => a + g.wasted, 0))} in extra copies`;
      return { title: 'Duplicates', sub, rows, mark };
    }
    if (p === 'caches' || p === 'dev') {
      const items = cleanup.items.filter((i) => i.cat === (p === 'caches' ? 'cache' : 'dev'));
      const rows = [];
      const mark = [];
      for (const it of items) for (const i of it.nodes) { rows.push({ id: i, depth: 0, dir: tree.isDir(i), flat: true, label: it.nodes.length > 1 ? `${tree.name(i)}` : it.name, sub: tree.rel(i) }); mark.push(i); }
      rows.sort((a, b) => tree.size[b.id] - tree.size[a.id]);
      return { title: p === 'caches' ? 'Caches & temp' : 'Dev artifacts', sub: `${plural(items.length, 'suggestion')} · ${fmtBytes(catBytes(p === 'caches' ? 'cache' : 'dev'))}`, rows, mark };
    }
    return { title: 'Folders', sub: `${tree.path(zoom)} · sorted by size`, rows: treeRows(tree, zoom, ex.open, ex.more), mark: null };
  }, [tree, v, ex.panel, ex.query, zoom, ex.open, ex.more, smart, dg, dupes.status, Math.floor(dupes.pct * 20), cleanup.items]);

  const markArr = useMemo(() => {
    if (!panel.mark) return null;
    const m = new Uint8Array(tree.n);
    for (const i of panel.mark) m[i] = 1;
    return m;
  }, [panel]);
  const markKey = panel.mark ? `${ex.panel}|${ex.query}|${v}|${panel.mark.length}` : 'none';

  const total = tree.size[zoom];
  const maxV = panel.mark ? Math.max(1, ...panel.rows.slice(0, 1).map((r) => tree.size[r.id])) : Math.max(1, ...tree.kids(zoom).slice(0, 1).map((c) => tree.size[c]));

  // Legend: bytes per type under the zoomed folder.
  const legend = useMemo(() => {
    const tb = tree.typesUnder(zoom);
    const list = [...tb.keys()].filter((t) => tb[t] > 0).sort((a, b) => tb[b] - tb[a]);
    return { list, tb, max: list.length ? tb[list[0]] : 1, sum: tb.reduce((a, x) => a + x, 0) };
  }, [tree, v, zoom]);

  // Keep the selected row visible.
  useEffect(() => {
    const el = tableRef.current && tableRef.current.querySelector(`[data-id="${sel}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [sel, panel]);

  const h = tree.header;
  const used = drive ? drive.total - drive.free : h.total - h.free;
  const free = drive ? drive.free : h.free;
  const dupeValue = dupes.status === 'running' ? `${Math.floor(dupes.pct * 100)}%` : dupes.status === 'pending' ? '…' : dupes.status === 'error' ? '—' : compact(dg.reduce((a, g) => a + g.wasted, 0));
  const viewInfo = VIEWS.find((x) => x.id === view) || VIEWS[0];

  return html`
  <div style="min-height: 100vh; background: #0E1014; color: #E6E8EB; font-family: 'Geist', system-ui, sans-serif; font-size: 14px; display: flex; flex-direction: column">

    <header style="display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid #22262D; background: #12151A">
      <a href="#" onClick=${(e) => { e.preventDefault(); A.go('start'); }} title="Back to start" style="display: flex; align-items: center; gap: 10px; text-decoration: none; color: #E6E8EB">
        <${Logo} accent=${accent} />
        <span style="font-weight: 700; font-size: 17px; letter-spacing: -0.02em">Strata</span>
      </a>
      <${Breadcrumb} tree=${tree} zoom=${zoom} />
      <div style="flex: 1 1 40px"></div>
      <${SearchBox} query=${ex.query} />
      <button type="button" class="hov-ghost" onClick=${A.rescan} style="display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border-radius: 8px; border: 1px solid #333944; background: transparent; color: #E6E8EB; font-weight: 500; cursor: pointer">
        ${Icon.rescan()} Rescan
      </button>
      <button type="button" class="hov-accent" onClick=${() => A.go('cleanup')} style="display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 16px; border-radius: 8px; border: 0; background: var(--accent); color: #0E1014; font-weight: 600; cursor: pointer">
        ${Icon.trash()} Clean up · ${fmtBytes(queue.bytes)}
      </button>
    </header>

    <div style="display: flex; flex-wrap: wrap; flex: 1">

      <aside style="flex: 1 1 232px; max-width: 100%; padding: 20px 16px; border-right: 1px solid #22262D; display: flex; flex-direction: column; gap: 24px; box-sizing: border-box; background: #101317">
        <section style="display: flex; flex-direction: column; gap: 8px">
          <h2 style="margin: 0 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0">Drives</h2>
          ${(drives || []).map((d) => {
            const cur = drive && d.root === drive.root;
            const u = d.total - d.free;
            const pct = d.total ? u / d.total : 0;
            const low = d.total && d.free / d.total < 0.1;
            return html`
              <button type="button" key=${d.root} class=${cur ? '' : 'hov-ghost'} title=${cur && isDriveScan ? 'Show the whole drive' : `Scan ${d.root}`} onClick=${() => (cur && isDriveScan ? A.zoomTo(0) : A.requestScan(d.root))}
                style=${`display: flex; flex-direction: column; gap: 8px; text-align: left; padding: 12px; border-radius: 10px; border: 1px solid ${cur ? '#2E343D' : 'transparent'}; background: ${cur ? '#181C22' : 'transparent'}; color: #E6E8EB; cursor: pointer`}>
                <span style="display: flex; justify-content: space-between; width: 100%"><span style=${`font-weight: ${cur ? 600 : 500}`}>${driveName(d)}</span><span style=${`font-family: 'Geist Mono', monospace; font-size: 12px; color: ${low ? '#F59E0B' : '#9BA3AF'}`}>${Math.round(pct * 100)}%</span></span>
                <span style="display: block; width: 100%; height: 6px; border-radius: 3px; background: #262B33; overflow: hidden"><span style=${`display: block; width: ${pct * 100}%; height: 100%; background: ${cur ? 'var(--accent)' : low ? '#F59E0B' : '#8C94A0'}`}></span></span>
                <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF">${fmtPair(u, d.total)}</span>
              </button>`;
          })}
        </section>
        <section style="display: flex; flex-direction: column; gap: 2px">
          <h2 style="margin: 0 8px 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0">Smart views</h2>
          <${SmartButton} id="largest" label="Largest files" value=${smart.largest.length} active=${ex.panel === 'largest'} />
          <${SmartButton} id="dupes" label="Duplicates" value=${dupeValue} active=${ex.panel === 'dupes'} />
          <${SmartButton} id="old" label="Untouched for 1 year" value=${compact(smart.old.bytes)} active=${ex.panel === 'old'} />
          <${SmartButton} id="caches" label="Caches & temp" value=${compact(catBytes('cache'))} active=${ex.panel === 'caches'} />
          <${SmartButton} id="dev" label="Dev artifacts" value=${compact(catBytes('dev'))} active=${ex.panel === 'dev'} />
        </section>
        <section style="display: flex; flex-direction: column; gap: 6px; margin-top: auto; padding: 12px; border-radius: 10px; border: 1px dashed #333944">
          <span style="font-size: 12px; color: #9BA3AF">Last scan</span>
          <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #E6E8EB">${fmtWhen(h.scannedAt)} · ${h.duration < 60 ? `${Math.max(1, Math.round(h.duration))} s` : fmtDur(h.duration)} · ${h.method}${h.partial ? ' · partial' : ''}</span>
        </section>
      </aside>

      <main style="flex: 999 1 560px; min-width: 0; padding: 20px; display: flex; flex-direction: column; gap: 16px; box-sizing: border-box">

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px">
          ${isDriveScan ? html`<${Stat} label="Used" value=${used} />` : html`<${Stat} label="This folder" value=${tree.total} />`}
          <${Stat} label=${isDriveScan ? 'Free' : 'Drive free'} value=${free} />
          <div style="padding: 14px 16px; border-radius: 12px; background: #14171C; border: 1px solid #22262D; display: flex; flex-direction: column; gap: 4px">
            <span style="font-size: 12px; color: #9BA3AF">Files · Folders</span>
            <span style="font-size: 24px; font-weight: 600; letter-spacing: -0.02em">${fmtShort(tree.files[0])} <span style="font-size: 14px; color: #9BA3AF; font-weight: 500">· ${fmtShort(h.dirs)}</span></span>
          </div>
          <${Stat} label="Reclaimable" value=${queue.bytes} accent />
        </div>

        <section style="border-radius: 14px; background: #14171C; border: 1px solid #22262D; padding: 14px; display: flex; flex-direction: column; gap: 12px">
          <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px">
            <h2 style="margin: 0; font-size: 15px; font-weight: 600">Space map</h2>
            <span style="font-size: 12px; color: #9BA3AF">${panel.mark ? `Highlighting ${panel.title.toLowerCase()}` : ex.typeFilter >= 0 ? `Highlighting ${TYPES[ex.typeFilter].l.toLowerCase()}` : viewInfo.hint}</span>
            <div style="flex: 1 1 20px"></div>
            <div role="group" aria-label="View" style="display: flex; padding: 3px; border-radius: 8px; background: #0E1014; border: 1px solid #262B33">
              ${VIEWS.map((x) => html`<button type="button" aria-pressed=${view === x.id ? 'true' : 'false'} onClick=${() => A.setView(x.id)} style=${`height: 30px; padding: 0 12px; border: 0; border-radius: 6px; background: ${view === x.id ? '#262B33' : 'transparent'}; color: ${view === x.id ? '#E6E8EB' : '#9BA3AF'}; cursor: pointer`}>${x.label}</button>`)}
            </div>
            <button type="button" class="hov-ghost" aria-label="Zoom out to parent" title="Zoom out to parent (Backspace)" disabled=${zoom === 0} onClick=${A.zoomOut} style="width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid #333944; background: transparent; color: #E6E8EB; cursor: pointer">${Icon.up()}</button>
          </div>
          <${SpaceMap} tree=${tree} version=${v} root=${zoom} view=${view} mark=${markArr} markKey=${markKey} typeFilter=${ex.typeFilter} shading=${settings.shading} sel=${sel}
            onSelect=${(i) => A.select(i)} onZoom=${A.zoomToward} onUp=${A.zoomOut} onMenu=${A.nodeMenu} />
        </section>

        <div style="display: flex; flex-wrap: wrap; gap: 16px">
          <section style="flex: 999 1 460px; min-width: 0; border-radius: 14px; background: #14171C; border: 1px solid #22262D; padding: 14px 6px 8px">
            <div style="display: flex; align-items: center; gap: 12px; padding: 0 8px 10px">
              <h2 style="margin: 0; font-size: 15px; font-weight: 600">${panel.title}</h2>
              <span style="font-size: 12px; color: #9BA3AF; min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${panel.sub}</span>
              ${ex.panel !== 'folders' && html`<button type="button" class="hov-ghost" onClick=${() => A.setPanel('folders')} style="display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid #333944; background: transparent; color: #C9CED6; cursor: pointer; font-size: 12px">${Icon.close()} Back to folders</button>`}
            </div>
            <div ref=${tableRef} style="overflow: auto; max-height: 520px">
              <div style="min-width: 480px">
                <div style="display: grid; grid-template-columns: minmax(0, 1fr) 140px 84px 56px; gap: 12px; padding: 6px 12px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #8C94A0; border-bottom: 1px solid #22262D; position: sticky; top: 0; background: #14171C; z-index: 1">
                  <span>Name</span><span>Share</span><span style="text-align: right">Size</span><span style="text-align: right">%</span>
                </div>
                ${panel.rows.length === 0 && html`<div style="padding: 16px 12px; color: #9BA3AF">${ex.panel === 'search' ? 'No matches. Try *.mkv, >1 GB or type:video.' : ex.panel === 'dupes' && dupes.status === 'running' ? 'Comparing file contents…' : 'Nothing here.'}</div>`}
                ${panel.rows.map((r) => r.more !== undefined
                  ? html`<div key=${`more${r.more}`} style=${`padding: 8px 12px 8px ${12 + r.depth * 22 + 22}px; border-bottom: 1px solid #1B1F25`}><button type="button" class="crumb" onClick=${() => A.showMore(r.more)} style="color: var(--accent); font-size: 13px">Show ${plural(r.count, 'more item')}…</button></div>`
                  : html`<${Row} key=${r.id} tree=${tree} r=${r} sel=${sel} accent=${accent} maxV=${maxV} total=${panel.mark ? tree.total : total} flat=${!!r.flat} />`)}
              </div>
            </div>
          </section>

          <section style="flex: 1 1 280px; min-width: 0; border-radius: 14px; background: #14171C; border: 1px solid #22262D; padding: 14px; display: flex; flex-direction: column; gap: 10px">
            <div style="display: flex; align-items: center; justify-content: space-between; margin: 0 0 4px">
              <h2 style="margin: 0; font-size: 15px; font-weight: 600">By file type</h2>
              ${ex.typeFilter >= 0 && html`<button type="button" class="crumb" onClick=${() => A.setTypeFilter(ex.typeFilter)} style="font-size: 12px; color: var(--accent)">Show all</button>`}
            </div>
            ${legend.list.map((t) => html`
              <div key=${t} class=${`hov-legend${ex.typeFilter >= 0 && ex.typeFilter !== t ? ' off' : ''}`} role="button" tabindex="0" aria-pressed=${ex.typeFilter === t ? 'true' : 'false'} title=${`Highlight ${TYPES[t].l.toLowerCase()} on the map`}
                onClick=${() => A.setTypeFilter(t)} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); A.setTypeFilter(t); } }}
                style="display: flex; flex-direction: column; gap: 6px">
                <div style="display: flex; align-items: center; gap: 8px">
                  <span style=${`width: 10px; height: 10px; border-radius: 3px; background: ${TYPES[t].c}`}></span>
                  <span style="flex: 1; color: #C9CED6">${TYPES[t].l}</span>
                  <span style="font-family: 'Geist Mono', monospace; font-size: 12px">${fmtBytes(legend.tb[t])}</span>
                  <span style="width: 44px; text-align: right; font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF">${fmtPct(legend.tb[t], legend.sum, 0)}</span>
                </div>
                <span style="display: block; height: 4px; border-radius: 2px; background: #22262D; overflow: hidden"><span style=${`display: block; height: 100%; width: ${legend.tb[t] / legend.max * 100}%; background: ${TYPES[t].c}`}></span></span>
              </div>`)}
          </section>
        </div>
      </main>

      <${Details} tree=${tree} node=${sel} ex=${ex} settings=${settings} cleanup=${cleanup} drive=${drive} queue=${queue} />
    </div>

    <${Footer} tree=${tree} scan=${scan} partial=${partial} />
  </div>`;
}
