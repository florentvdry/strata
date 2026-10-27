// Cleanup review.
import { useMemo } from 'preact/hooks';
import { html } from '../lib/html.js';
import { useStore } from '../lib/store.js';
import { Icon } from '../components/ui.js';
import { CATS, selectionStats } from '../lib/cleanup.js';
import { bytesParts, fmtBytes } from '../lib/format.js';
import { isWin, trash } from '../lib/platform.js';
import { t } from '../lib/i18n.js';
import * as A from '../actions.js';

export function Cleanup() {
  const { tree, cleanup, dupes } = useStore(); // useStore also re-renders this view when the language changes
  const { items, on, cat, permanent } = cleanup;
  const v = tree.version;

  const cats = CATS.filter((c) => c.id !== 'user' || items.some((i) => i.cat === 'user'));
  const active = cats.find((c) => c.id === cat) || cats[0];
  const view = useMemo(() => items
    .filter((i) => active.id === 'all' || i.cat === active.id)
    .sort((a, b) => (a.risk === b.risk ? b.v - a.v : a.risk === 'safe' ? -1 : 1)), [items, active.id, v]);

  const stats = useMemo(() => selectionStats(tree, items, on), [tree, v, items, on]);
  const drive = A.driveOf(tree.names[0]);
  const disk = drive ? drive.total : tree.header.total;
  const used = drive ? drive.total - drive.free : tree.header.total - tree.header.free;
  const after = Math.max(0, used - stats.bytes);
  const big = stats.bytes > 0 ? bytesParts(stats.bytes, 1) : { num: '0', unit: 'GB' };
  const count = stats.chosen.length;
  const driveLabel = drive ? (isWin ? `${drive.letter}:` : drive.label || (drive.system ? t('System drive') : drive.root)) : t('Drive');
  const dupesBusy = dupes.status === 'running' || dupes.status === 'pending';

  function go() {
    if (!count) return;
    A.openModal({ kind: 'confirmCleanup', items: stats.chosen, bytes: stats.bytes, permanent });
  }

  return html`
  <div style="min-height: 100vh; background: #0E1014; color: #E6E8EB; font-family: 'Geist', system-ui, sans-serif; font-size: 14px; display: flex; flex-direction: column">
    <header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid #22262D; background: #12151A">
      <button type="button" class="hov-ghost" onClick=${() => A.go('explorer')} style="display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 8px; border: 1px solid #333944; background: transparent; color: #E6E8EB; text-decoration: none; font-weight: 500; cursor: pointer">
        ${Icon.back()} ${t('Back to map')}
      </button>
      <h1 style="margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em">${t('Review cleanup')}</h1>
      <span style="font-family: 'Geist Mono', monospace; font-size: 13px; color: #9BA3AF">${tree.names[0]}</span>
    </header>

    <div style="display: flex; flex-wrap: wrap; flex: 1">
      <nav aria-label=${t('Categories')} style="flex: 1 1 240px; max-width: 100%; padding: 20px 14px; border-right: 1px solid #22262D; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; background: #101317">
        ${cats.map((c) => {
          const s = items.filter((i) => c.id === 'all' || i.cat === c.id).reduce((a, i) => a + i.v, 0);
          const cur = c.id === active.id;
          const busy = c.id === 'dupe' && dupesBusy;
          return html`
            <button type="button" key=${c.id} class=${cur ? '' : 'hov-quiet'} onClick=${() => A.setCat(c.id)} aria-current=${cur ? 'page' : 'false'}
              style=${`display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 10px; border: 0; cursor: pointer; text-align: left; ${cur ? 'background:#1E232A;color:#E6E8EB;font-weight:600' : 'background:transparent;color:#C9CED6'}`}>
              <span style=${`width: 10px; height: 10px; border-radius: 3px; background: ${c.dot}`}></span>
              <span style="flex: 1">${c.label}</span>
              ${busy ? html`<span class="spinner" style="width: 12px; height: 12px" title=${t('Looking for duplicates')}></span>` : html`<span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; font-weight: 400">${fmtBytes(s)}</span>`}
            </button>`;
        })}
        <div style="margin-top: 16px; padding: 14px; border-radius: 12px; border: 1px solid #22262D; background: #14171C; display: flex; flex-direction: column; gap: 6px">
          <span style="font-weight: 600">${t('How deletion works')}</span>
          <span style="font-size: 13px; color: #9BA3AF; line-height: 1.5">${t('Files go to the {trash} by default. Caches and temp folders are emptied, not removed, and files in use are skipped.', { trash: trash() })}</span>
        </div>
      </nav>

      <main style="flex: 999 1 560px; min-width: 0; padding: 20px; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px">
        <div style="display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px">
          <div style="display: flex; flex-direction: column; gap: 4px">
            <h2 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em">${active.label}</h2>
            <span style="color: #9BA3AF">${active.hint}</span>
          </div>
          <div style="flex: 1"></div>
          ${view.length > 0 && view.every((i) => on[i.id])
            ? html`<button type="button" class="hov-ghost" onClick=${() => A.setItems(view.map((i) => i.id), false)} style="height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid #333944; background: transparent; color: #E6E8EB; cursor: pointer">${t('Clear all in view')}</button>`
            : html`<button type="button" class="hov-ghost" disabled=${!view.length} onClick=${() => A.setItems(view.map((i) => i.id), true)} style="height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid #333944; background: transparent; color: #E6E8EB; cursor: pointer">${t('Select all in view')}</button>`}
        </div>

        <div style="border-radius: 14px; border: 1px solid #22262D; background: #14171C; overflow-x: auto">
          <div style="min-width: 560px">
            <div style="display: grid; grid-template-columns: 44px minmax(0, 1fr) 96px 90px; gap: 12px; align-items: center; padding: 10px 16px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #8C94A0; border-bottom: 1px solid #22262D">
              <span></span><span>${t('Item')}</span><span>${t('Safety')}</span><span style="text-align: right">${t('Size')}</span>
            </div>
            ${view.length === 0 && html`
              <div style="padding: 18px 16px; color: #9BA3AF; display: flex; gap: 10px; align-items: center">
                ${active.id === 'dupe' && dupesBusy ? html`<span class="spinner"></span> ${t('Comparing file contents… {pct}%', { pct: Math.floor(dupes.pct * 100) })}` : active.id === 'user' ? t('Use “Add to cleanup” on the map to put things here.') : t('Nothing to suggest here — this part of the disk looks tidy.')}
              </div>`}
            ${view.map((it) => html`
              <label key=${it.id} class="hov-row" style="display: grid; grid-template-columns: 44px minmax(0, 1fr) 96px 90px; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid #1B1F25; cursor: pointer">
                <input type="checkbox" checked=${!!on[it.id]} onChange=${(e) => A.setItem(it.id, e.currentTarget.checked)} style="width: 18px; height: 18px; margin: 0" />
                <span style="display: flex; flex-direction: column; gap: 3px; min-width: 0">
                  <span style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${it.name}</span>
                  <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; white-space: nowrap; overflow: hidden; text-overflow: ellipsis" title=${it.targets.map((t) => t.path).join('\n')}>${it.path}</span>
                  <span style="font-size: 12px; color: #C9CED6">${it.reason}</span>
                </span>
                <span style=${`justify-self: start; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px; ${it.risk === 'safe' ? 'background:#1D2B12;color:#C6F432' : 'background:#33240C;color:#F5B54A'}`}>${it.risk === 'safe' ? t('Safe') : t('Review')}</span>
                <span style="text-align: right; font-family: 'Geist Mono', monospace; font-size: 13px">${fmtBytes(it.v, 1)}</span>
              </label>`)}
          </div>
        </div>
      </main>

      <aside aria-label=${t('Summary')} style="flex: 1 1 300px; max-width: 100%; padding: 20px; border-left: 1px solid #22262D; box-sizing: border-box; display: flex; flex-direction: column; gap: 18px; background: #101317">
        <span style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0">${t('You\'ll free')}</span>
        <span style="font-size: 52px; font-weight: 700; letter-spacing: -0.04em; line-height: 1; color: var(--accent)">${big.num}<span style="font-size: 22px; color: #9BA3AF; font-weight: 500"> ${big.unit}</span></span>
        <div style="display: flex; flex-direction: column; gap: 8px">
          <div style="display: flex; justify-content: space-between; font-size: 12px; color: #9BA3AF"><span>${t('{drive} after cleanup', { drive: driveLabel })}</span><span style="font-family: 'Geist Mono', monospace">${t('{pct}% used', { pct: disk ? Math.round(after / disk * 100) : 0 })}</span></div>
          <span style="display: flex; height: 10px; border-radius: 5px; background: #22262D; overflow: hidden">
            <span style=${`display: block; height: 100%; background: #8C94A0; width: ${disk ? after / disk * 100 : 0}%; transition: width .2s`}></span>
            <span style=${`display: block; height: 100%; background: var(--accent); width: ${disk ? stats.bytes / disk * 100 : 0}%; transition: width .2s`}></span>
          </span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; font-size: 13px">
          <div style="display: flex; justify-content: space-between"><span style="color: #9BA3AF">${t('Items selected')}</span><span style="font-family: 'Geist Mono', monospace">${count}</span></div>
          <div style="display: flex; justify-content: space-between"><span style="color: #9BA3AF">${t('Needs review')}</span><span style="font-family: 'Geist Mono', monospace; color: #F5B54A">${stats.review}</span></div>
        </div>
        <label style="display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: #C9CED6; cursor: pointer">
          <input type="checkbox" checked=${permanent} onChange=${(e) => A.setPermanent(e.currentTarget.checked)} style="width: 18px; height: 18px; accent-color: #FF9AA2; margin: 0" />
          <span>${t('Delete permanently (skip {trash})', { trash: trash() })}</span>
        </label>
        <button type="button" class="hov-accent" disabled=${!count} onClick=${go}
          style=${`height: 48px; border-radius: 12px; border: 0; font-weight: 600; font-size: 15px; cursor: pointer; ${permanent ? 'background:#FF9AA2;color:#2A0A0E' : 'background:var(--accent);color:#0E1014'}`}>
          ${permanent ? t('Delete {n, plural, one {# item} other {# items}} permanently', { n: count }) : t('Move {n, plural, one {# item} other {# items}} to {trash}', { n: count, trash: trash() })}
        </button>
        <span style="font-size: 12px; color: #9BA3AF; line-height: 1.5">${t('A restore point list is kept for 7 days in {link}.', { link: '\u0001' }).split('\u0001').flatMap((part, k) => (k ? [html`<a href="#" onClick=${(e) => { e.preventDefault(); A.openModal({ kind: 'history' }); }}>${t('Strata › History')}</a>`, part] : [part]))}</span>
      </aside>
    </div>
  </div>`;
}
