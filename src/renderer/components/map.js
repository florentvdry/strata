// The interactive space map: a base canvas (layout) plus an overlay canvas (hover + selection).
import { useRef, useState, useEffect, useMemo, useLayoutEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { LAYOUTS, layoutTreemap } from './layouts.js';
import { hover } from '../lib/store.js';
import { fmtBytes } from '../lib/format.js';
import { t } from '../lib/i18n.js';

function useSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((s) => (Math.round(r.width) === s.w && Math.round(r.height) === s.h ? s : { w: Math.round(r.width), h: Math.round(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return size;
}

function prep(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, dpr };
}

let fontsReady = false;
document.fonts && document.fonts.ready.then(() => { fontsReady = true; });

export function SpaceMap({ tree, version, root, view, mark, markKey, typeFilter, shading, sel, onSelect, onZoom, onUp, onMenu }) {
  const wrap = useRef(null), base = useRef(null), over = useRef(null);
  const size = useSize(wrap);
  const hov = useRef(-1);
  const [tip, setTip] = useState(null);
  const [fontTick, setFontTick] = useState(fontsReady ? 1 : 0);

  useEffect(() => { if (!fontsReady && document.fonts) document.fonts.ready.then(() => setFontTick(1)); }, []);

  const layout = useMemo(() => {
    if (!size.w || !size.h || !tree) return null;
    return (LAYOUTS[view] || layoutTreemap)(tree, root, size.w, size.h, mark);
  }, [tree, version, root, view, markKey, size.w, size.h]);

  useEffect(() => {
    if (!layout) return;
    const { ctx, dpr } = prep(base.current, size.w, size.h);
    layout.paint(ctx, { shading, typeFilter, mark, dpr });
    drawOverlay();
  }, [layout, shading, typeFilter, fontTick]);

  useEffect(() => { drawOverlay(); }, [sel]);

  function drawOverlay() {
    if (!layout || !over.current) return;
    const { ctx } = prep(over.current, size.w, size.h);
    ctx.clearRect(0, 0, size.w, size.h);
    if (hov.current >= 0 && hov.current !== sel) layout.outline(ctx, hov.current, 'hover');
    if (sel >= 0) layout.outline(ctx, sel, 'select');
  }

  function pos(e) {
    const r = over.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onMove(e) {
    if (!layout) return;
    const [x, y] = pos(e);
    const id = layout.hit(x, y);
    if (id !== hov.current) {
      hov.current = id;
      hover.set({ id: id >= 0 ? id : -1 });
      drawOverlay();
    }
    if (id >= 0 && view !== 'treemap') {
      setTip({ x: Math.min(x + 14, size.w - 220), y: Math.min(y + 16, size.h - 30), text: `${tree.name(id)} · ${fmtBytes(tree.size[id])}` });
    } else if (tip) setTip(null);
    over.current.style.cursor = id === -2 && root !== 0 ? 'zoom-out' : id >= 0 ? 'pointer' : 'default';
  }

  function onLeave() {
    hov.current = -1;
    hover.set({ id: -1 });
    setTip(null);
    drawOverlay();
  }

  function onClick(e) {
    if (!layout) return;
    const id = layout.hit(...pos(e));
    if (id === -2) onUp();
    else if (id >= 0) onSelect(id);
  }

  function onDbl(e) {
    if (!layout) return;
    const id = layout.hit(...pos(e));
    if (id >= 0) onZoom(id);
  }

  function onCtx(e) {
    e.preventDefault();
    if (!layout) return;
    const id = layout.hit(...pos(e));
    if (id >= 0) { onSelect(id); onMenu(id); }
  }

  return html`
    <div ref=${wrap} onMouseLeave=${onLeave} style="position: relative; width: 100%; height: 520px; border-radius: 8px; overflow: hidden; background: #0B0D10">
      <canvas ref=${base} class="map-canvas" aria-hidden="true"></canvas>
      <canvas ref=${over} class="map-canvas" role="img" aria-label=${t('Space map')} onMouseMove=${onMove} onClick=${onClick} onDblClick=${onDbl} onContextMenu=${onCtx}></canvas>
      ${tip && html`<div class="map-tip" style=${`left:${tip.x}px;top:${tip.y}px`}>${tip.text}</div>`}
    </div>`;
}

// Small static treemap used as the folder swatch in the details panel.
export function MiniMap({ tree, version, node, shading, height = 96 }) {
  const ref = useRef(null);
  const size = useSize(ref);
  useEffect(() => {
    if (!size.w || !tree) return;
    const cv = ref.current.querySelector('canvas');
    const { ctx, dpr } = prep(cv, size.w, height);
    layoutTreemap(tree, node, size.w, height, null, { labels: false }).paint(ctx, { shading, typeFilter: -1, mark: null, dpr });
  }, [tree, version, node, size.w, shading]);
  return html`<div ref=${ref} style=${`position: relative; height: ${height}px; border-radius: 12px; overflow: hidden; background: #0B0D10`}><canvas class="map-canvas"></canvas></div>`;
}
