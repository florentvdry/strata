// Scanning — progress, live map building up, biggest files so far.
import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { useStore } from '../lib/store.js';
import { Logo } from '../components/ui.js';
import { TYPES, SHADE } from '../lib/types.js';
import { squarify } from '../lib/squarify.js';
import { fmtBytes, fmtCount, fmtDur, fmtEta, middleEllipsis } from '../lib/format.js';
import * as A from '../actions.js';

const PHASES = { mft: 'Reading file table', walk: 'Walking folders', build: 'Building the map' };

function useBox(ref) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => {
      const r = ref.current.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return box;
}

// The top-level folders as they fill in: done ones in colour, pending ones as pulsing placeholders.
function LiveMap({ scan, shading }) {
  const ref = useRef(null);
  const box = useBox(ref);
  const drive = A.driveOf(scan.root);
  const isDriveRoot = drive && drive.root.toLowerCase() === scan.root.toLowerCase().replace(/\\?$/, '\\');
  const known = scan.tops.filter((t) => t.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 28);
  const pending = scan.tops.filter((t) => t.dir && t.state === 0 && t.bytes === 0).slice(0, 10);
  let tiles = [];
  if (!scan.tops.length) {
    tiles = [5, 3, 2.2, 1.6, 1.2, 1].map((v, k) => ({ v, pending: true, key: `p${k}` }));
  } else {
    const sumKnown = known.reduce((a, t) => a + t.bytes, 0);
    const used = drive ? drive.total - drive.free : 0;
    const rest = isDriveRoot ? Math.max(0, used - scan.bytes) : sumKnown * 0.15;
    const each = pending.length ? Math.max(sumKnown * 0.01, rest / pending.length) : 0;
    tiles = [
      ...known.map((t) => ({ v: t.bytes, t, key: t.name })),
      ...pending.map((t) => ({ v: each || 1, t, pending: true, key: t.name })),
    ].sort((a, b) => b.v - a.v);
  }
  const rects = box.w ? squarify(tiles.map((t) => t.v), 0, 0, box.w, box.h) : [];
  let delay = 0;
  return html`
    <div ref=${ref} style="position: relative; height: 380px; border-radius: 14px; overflow: hidden; background: #0B0D10; border: 1px solid #22262D">
      ${rects.map(([x, y, w, h], k) => {
        const tile = tiles[k];
        if (w < 2 || h < 2) return null;
        const pos = `position: absolute; left: ${x + 1.5}px; top: ${y + 1.5}px; width: ${Math.max(0, w - 3)}px; height: ${Math.max(0, h - 3)}px; border-radius: 3px;`;
        const label = tile.t ? `${tile.t.name}${tile.pending ? ' · waiting' : ` · ${fmtBytes(tile.t.bytes)}`}` : '';
        if (tile.pending) {
          const d = (delay += 0.3) % 1.6;
          return html`<div key=${tile.key} title=${label} style=${`${pos} background: #262B33; animation: strata-pulse 1.6s ease-in-out ${d.toFixed(1)}s infinite; transition: all .35s ease`}></div>`;
        }
        const ty = TYPES[tile.t.type] || TYPES[0];
        const live = tile.t.state === 1 && !scan.done;
        return html`<div key=${tile.key} title=${label} style=${`${pos} background: ${ty.c}; ${shading ? `background-image: ${SHADE};` : ''} transition: all .35s ease; ${live ? 'animation: strata-live 1.6s ease-in-out infinite;' : ''}`}></div>`;
      })}
    </div>`;
}

export function Scanning() {
  const { scan, settings, tree, partial } = useStore();
  const [now, setNow] = useState(Date.now());
  const eta = useRef(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!scan) return null;

  const elapsed = Math.max(0, ((scan.paused ? scan.pausedAt : now) - scan.startedAt - scan.pausedTotal) / 1000);
  const pct = Math.min(1, scan.pct || 0);
  let etaText;
  if (scan.paused) etaText = 'Paused — nothing is being read';
  else if (scan.phase === 'build' || scan.done) etaText = 'Putting the map together…';
  else if (pct > 0.02 && elapsed > 1.5) {
    const raw = elapsed * (1 - pct) / pct;
    eta.current = eta.current == null ? raw : eta.current * 0.85 + raw * 0.15;
    etaText = fmtEta(eta.current);
  } else etaText = 'Estimating time left…';
  const label = scan.paused ? 'Paused' : PHASES[scan.phase] || 'Scanning';
  const accent = settings.accent;

  if (scan.error) {
    return html`
    <div style="min-height: 100vh; background: #0E1014; color: #E6E8EB; font-size: 14px; display: flex; flex-direction: column">
      <${Header} root=${scan.root} accent=${accent} />
      <main style="flex: 1; width: 100%; max-width: 720px; margin: 0 auto; padding: 72px 20px; box-sizing: border-box; display: flex; flex-direction: column; gap: 18px">
        <span style="font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #FF9AA2">Scan stopped</span>
        <h1 style="margin: 0; font-size: 36px; font-weight: 700; letter-spacing: -0.03em">Strata couldn't finish this scan</h1>
        <p style="margin: 0; color: #9BA3AF; font-size: 15px; line-height: 1.5">${scan.error}</p>
        <div style="display: flex; gap: 10px">
          <button type="button" class="hov-accent" onClick=${() => A.requestScan(scan.root)} style="height: 44px; padding: 0 18px; border-radius: 10px; border: 0; background: var(--accent); color: #0E1014; font-weight: 600; cursor: pointer">Try again</button>
          <button type="button" class="hov-ghost" onClick=${() => A.go('start')} style="height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid #333944; background: transparent; color: #E6E8EB; font-weight: 500; cursor: pointer">Back</button>
        </div>
      </main>
    </div>`;
  }

  const biggest = scan.biggest.slice(0, 3);
  return html`
  <div style="min-height: 100vh; background: #0E1014; color: #E6E8EB; font-family: 'Geist', system-ui, sans-serif; font-size: 14px; display: flex; flex-direction: column">
    <${Header} root=${scan.root} accent=${accent} />

    <main style="flex: 1; width: 100%; max-width: 1180px; margin: 0 auto; padding: 48px 20px; box-sizing: border-box; display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start">
      <section style="flex: 1 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 28px">
        <div style="display: flex; flex-direction: column; gap: 8px">
          <span style=${`font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: ${scan.paused ? '#F5B54A' : 'var(--accent)'}`}>${label}</span>
          <h1 style="margin: 0; font-size: 72px; font-weight: 700; letter-spacing: -0.045em; line-height: 1">${Math.floor(pct * 100)}<span style="font-size: 36px; color: #9BA3AF">%</span></h1>
          <p style="margin: 0; color: #9BA3AF; font-size: 15px">${etaText}</p>
          ${scan.notice && html`<p style="margin: 4px 0 0; color: #F5B54A; font-size: 13px">${scan.notice}</p>`}
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px">
          <span style="display: block; height: 10px; border-radius: 5px; background: #22262D; overflow: hidden"><span style=${`display: block; width: ${(pct * 100).toFixed(1)}%; height: 100%; border-radius: 5px; background: ${scan.paused ? '#F59E0B' : 'var(--accent)'}; transition: width .25s ease`}></span></span>
          <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; white-space: nowrap; overflow: hidden; text-overflow: ellipsis" title=${scan.current}>${middleEllipsis(scan.current || scan.root, 92)}</span>
        </div>

        <dl style="margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px">
          <div style="padding: 14px 16px; border-radius: 12px; background: #14171C; border: 1px solid #22262D"><dt style="font-size: 12px; color: #9BA3AF">Files</dt><dd style="margin: 4px 0 0; font-size: 22px; font-weight: 600; font-family: 'Geist Mono', monospace">${fmtCount(scan.files)}</dd></div>
          <div style="padding: 14px 16px; border-radius: 12px; background: #14171C; border: 1px solid #22262D"><dt style="font-size: 12px; color: #9BA3AF">Folders</dt><dd style="margin: 4px 0 0; font-size: 22px; font-weight: 600; font-family: 'Geist Mono', monospace">${fmtCount(scan.dirs)}</dd></div>
          <div style="padding: 14px 16px; border-radius: 12px; background: #14171C; border: 1px solid #22262D"><dt style="font-size: 12px; color: #9BA3AF">Counted</dt><dd style="margin: 4px 0 0; font-size: 22px; font-weight: 600; font-family: 'Geist Mono', monospace">${fmtBytes(scan.bytes)}</dd></div>
          <div style="padding: 14px 16px; border-radius: 12px; background: #14171C; border: 1px solid #22262D"><dt style="font-size: 12px; color: #9BA3AF">Elapsed</dt><dd style="margin: 4px 0 0; font-size: 22px; font-weight: 600; font-family: 'Geist Mono', monospace">${fmtDur(elapsed)}</dd></div>
        </dl>

        <div style="display: flex; flex-wrap: wrap; gap: 10px">
          <button type="button" class="hov-accent" disabled=${scan.snapshotting || scan.done || !scan.id} onClick=${A.explorePartial} style="display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 18px; border-radius: 10px; border: 0; background: var(--accent); color: #0E1014; font-weight: 600; cursor: pointer">
            ${scan.snapshotting && html`<span class="spinner" style="border-color: rgba(14,16,20,.3); border-top-color: #0E1014"></span>`}
            ${partial && tree ? 'Back to partial results' : 'Explore partial results'}
          </button>
          <button type="button" class="hov-ghost" disabled=${scan.done || !scan.id} onClick=${A.pauseScan} style="height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid #333944; background: transparent; color: #E6E8EB; font-weight: 500; cursor: pointer">${scan.paused ? 'Resume' : 'Pause'}</button>
          <button type="button" class="hov-link" onClick=${A.cancelScan} style="display: flex; align-items: center; height: 44px; padding: 0 18px; border-radius: 10px; border: 0; background: transparent; color: #C9CED6; text-decoration: none; font-weight: 500; cursor: pointer">Cancel</button>
        </div>
      </section>

      <section aria-label="Map building up" style="flex: 1 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 14px">
        <${LiveMap} scan=${scan} shading=${settings.shading} />
        <div style="display: flex; flex-direction: column; border-radius: 12px; border: 1px solid #22262D; background: #14171C">
          <div style=${`display: flex; justify-content: space-between; padding: 12px 16px; ${biggest.length ? 'border-bottom: 1px solid #1E2228' : ''}`}><span style="font-weight: 600">Biggest so far</span><span style="font-size: 12px; color: #9BA3AF">updates live</span></div>
          ${!biggest.length && html`<div style="padding: 10px 16px 12px; color: #9BA3AF; font-size: 12px">Looking for big files…</div>`}
          ${biggest.map((b, k) => html`
            <div key=${b.path} style=${`display: flex; gap: 12px; align-items: center; padding: 10px 16px; ${k < biggest.length - 1 ? 'border-bottom: 1px solid #1E2228' : ''}`}>
              <span style=${`width: 10px; height: 10px; border-radius: 3px; flex: none; background: ${(TYPES[b.type] || TYPES[0]).c}`}></span>
              <span style="flex: 1; min-width: 0; font-family: 'Geist Mono', monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" title=${b.path}>${b.path}</span>
              <span style="font-family: 'Geist Mono', monospace; font-size: 12px">${fmtBytes(b.size)}</span>
            </div>`)}
        </div>
      </section>
    </main>
  </div>`;
}

function Header({ root, accent }) {
  return html`
    <header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #22262D; background: #12151A">
      <${Logo} accent=${accent} />
      <span style="font-weight: 700; font-size: 17px; letter-spacing: -0.02em">Strata</span>
      <span style="font-family: 'Geist Mono', monospace; font-size: 13px; color: #9BA3AF; padding: 6px 10px; background: #181C22; border: 1px solid #262B33; border-radius: 8px; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">Scanning ${root}</span>
    </header>`;
}
