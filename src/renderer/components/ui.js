// Icons, logo, dialogs and toast.
import { useState, useEffect, useLayoutEffect } from 'preact/hooks';
import { html } from '../lib/html.js';
import { store, useStore, toast } from '../lib/store.js';
import { fmtBytes, fmtWhen, plural, middleEllipsis } from '../lib/format.js';
import { isWin, TRASH } from '../lib/platform.js';
import { Notes } from '../lib/markdown.js';
import { parseNotes } from '../lib/changelog.js';
import * as A from '../actions.js';

const api = window.strata;

export const Logo = ({ accent = 'var(--accent)' }) => html`
  <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="14" height="24" rx="3" fill=${accent}></rect><rect x="17" y="1" width="8" height="11" rx="2.5" fill="#3B82F6"></rect><rect x="17" y="14" width="8" height="11" rx="2.5" fill="#F59E0B"></rect></svg>`;

const svg = (size, sw, children, extra = {}) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${sw} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ...${extra}>${children}</svg>`;

export const Icon = {
  gear: () => svg(18, 1.8, html`<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>`),
  drive: (color) => html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke=${color} stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2.5"></rect><path d="M7 14h.01M11 14h6"></path></svg>`,
  folderPlus: () => html`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M12 11v5M9.5 13.5h5"></path></svg>`,
  search: () => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9BA3AF" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>`,
  rescan: () => svg(16, 2, html`<path d="M20 12a8 8 0 1 1-2.3-5.7"></path><path d="M20 4v5h-5"></path>`),
  trash: () => svg(16, 2.2, html`<path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="M6 7l1 13h10l1-13"></path>`),
  up: () => svg(16, 2, html`<path d="M12 19V5"></path><path d="M5 12l7-7 7 7"></path>`),
  back: () => svg(16, 2, html`<path d="M15 18l-6-6 6-6"></path>`),
  close: () => svg(16, 2, html`<path d="M6 6l12 12M18 6L6 18"></path>`),
  chevron: (style) => html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9BA3AF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style=${style}><path d="M9 6l6 6-6 6"></path></svg>`,
  folder: () => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C9CED6" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true" style="flex: none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`,
  shield: () => svg(18, 1.8, html`<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"></path>`),
};

export const ACCENTS = ['#C6F432', '#7C9CFF', '#FF8A4C', '#2DD4BF'];

// ───────────── dialogs ─────────────

function Dialog({ title, children, onClose, wide }) {
  useLayoutEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && onClose) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return html`
    <div class="backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div class="dialog" role="dialog" aria-modal="true" aria-label=${title} style=${wide ? 'max-width: 640px' : ''}>
        <h2>${title}</h2>
        ${children}
      </div>
    </div>`;
}

function AdminDialog({ m }) {
  return html`<${Dialog} title="Fast scan needs administrator rights" onClose=${A.closeModal}>
    <p>Reading the drive's file table directly is 10–20× faster on NTFS, but Windows only allows it for administrators. Strata can restart itself with admin rights and pick up this scan, or scan the normal way now.</p>
    <div style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #C9CED6; padding: 10px 12px; border-radius: 8px; background: #0E1014; border: 1px solid #22262D">${m.root}</div>
    <div class="actions">
      <button class="btn quiet" onClick=${A.closeModal}>Cancel</button>
      <button class="btn" onClick=${() => A.requestScan(m.root, 'normal')}>Scan normally</button>
      <button class="btn primary" onClick=${() => A.relaunchAsAdmin({ root: m.root, options: m.options })}>Restart as administrator</button>
    </div>
  <//>`;
}

function TrashDialog({ m }) {
  return html`<${Dialog} title=${`Move to ${TRASH}?`} onClose=${A.closeModal}>
    <p>${m.isDir ? `The folder and its ${plural(m.files, 'file')} will be moved to the ${TRASH}.` : `The file will be moved to the ${TRASH}.`} You can restore it from there or from Strata › History.</p>
    <div style="display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 10px; background: #0E1014; border: 1px solid #22262D">
      <span style="font-weight: 600; word-break: break-all">${m.name}</span>
      <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; word-break: break-all">${m.path}</span>
      <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #C9CED6">${fmtBytes(m.size)}</span>
    </div>
    <div class="actions">
      <button class="btn quiet" onClick=${A.closeModal}>Cancel</button>
      <button class="btn danger" onClick=${() => A.trashNode(m.node)}>Move to ${TRASH}</button>
    </div>
  <//>`;
}

function ConfirmCleanupDialog({ m }) {
  const shown = m.items.slice(0, 6);
  return html`<${Dialog} title=${m.permanent ? `Delete ${plural(m.items.length, 'item')} permanently?` : `Move ${plural(m.items.length, 'item')} to the ${TRASH}?`} onClose=${A.closeModal}>
    <p>${m.permanent ? html`This frees <b style="color:#E6E8EB">${fmtBytes(m.bytes)}</b> right away. <b style="color:#FF9AA2">It can't be undone.</b>` : html`This frees up to <b style="color:#E6E8EB">${fmtBytes(m.bytes)}</b> once you empty the ${TRASH}. Files in use are skipped.`}</p>
    <div style="display: flex; flex-direction: column; border-radius: 10px; border: 1px solid #22262D; background: #0E1014">
      ${shown.map((it, k) => html`
        <div style=${`display: flex; gap: 12px; align-items: center; padding: 9px 12px; ${k < shown.length - 1 || m.items.length > 6 ? 'border-bottom: 1px solid #1B1F25' : ''}`}>
          <span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${it.name}</span>
          <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF">${fmtBytes(it.v)}</span>
        </div>`)}
      ${m.items.length > 6 && html`<div style="padding: 9px 12px; color: #9BA3AF; font-size: 13px">and ${plural(m.items.length - 6, 'more item')}</div>`}
    </div>
    <div class="actions">
      <button class="btn quiet" onClick=${A.closeModal}>Cancel</button>
      <button class=${m.permanent ? 'btn danger' : 'btn primary'} onClick=${() => A.runCleanup()}>${m.permanent ? 'Delete permanently' : `Move to ${TRASH}`}</button>
    </div>
  <//>`;
}

function BusyDialog({ m }) {
  const pct = m.total ? Math.min(1, m.done / m.total) : 0;
  return html`<${Dialog} title=${m.title}>
    <span style="display: block; height: 8px; border-radius: 4px; background: #22262D; overflow: hidden"><span style=${`display: block; height: 100%; width: ${Math.max(4, pct * 100)}%; background: var(--accent); transition: width .2s`}></span></span>
    <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${middleEllipsis(m.current || 'Starting…', 80)}</span>
  <//>`;
}

function ResultDialog({ m }) {
  return html`<${Dialog} title=${m.title} onClose=${A.closeModal}>
    ${m.lines.map((l) => html`<p>${l}</p>`)}
    ${m.failures.length > 0 && html`
      <div style="display: flex; flex-direction: column; max-height: 220px; overflow: auto; border-radius: 10px; border: 1px solid #22262D; background: #0E1014">
        ${m.failures.slice(0, 50).map((f) => html`
          <div style="display: flex; flex-direction: column; gap: 2px; padding: 9px 12px; border-bottom: 1px solid #1B1F25">
            <span style="font-family: 'Geist Mono', monospace; font-size: 12px; word-break: break-all">${f.path}</span>
            <span style="font-size: 12px; color: #F5B54A">${f.error || 'Not removed'}${f.remaining > 0 ? ` · ${fmtBytes(f.remaining)} left` : ''}</span>
          </div>`)}
      </div>`}
    <div class="actions">
      <button class="btn" onClick=${() => A.openModal({ kind: 'history' })}>Open history</button>
      <button class="btn primary" onClick=${A.closeModal}>Done</button>
    </div>
  <//>`;
}

function SettingsDialog() {
  const st = useStore();
  const { settings, info, recent } = st;
  return html`<${Dialog} title="Settings" onClose=${A.closeModal}>
    <section style="display: flex; flex-direction: column; gap: 10px">
      <span style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0">Appearance</span>
      <div style="display: flex; align-items: center; gap: 12px">
        <span style="flex: 1">Accent color</span>
        <div role="group" aria-label="Accent color" style="display: flex; gap: 8px">
          ${ACCENTS.map((c) => html`<button type="button" aria-label=${c} aria-pressed=${settings.accent === c ? 'true' : 'false'} onClick=${() => A.saveSettings({ accent: c })}
            style=${`width: 28px; height: 28px; border-radius: 8px; cursor: pointer; background: ${c}; border: 2px solid ${settings.accent === c ? '#FFFFFF' : 'transparent'}; box-shadow: inset 0 0 0 1px rgba(0,0,0,.25)`}></button>`)}
        </div>
      </div>
      <label style="display: flex; align-items: center; gap: 12px; cursor: pointer">
        <span style="flex: 1; display: flex; flex-direction: column; gap: 2px"><span>Cushion shading</span><span style="font-size: 12px; color: #9BA3AF">Gives map blocks a raised look so nesting is easier to read</span></span>
        <input type="checkbox" checked=${settings.shading} onChange=${(e) => A.saveSettings({ shading: e.currentTarget.checked })} style="width: 18px; height: 18px; margin: 0" />
      </label>
    </section>
    ${isWin && html`<section style="display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid #22262D">
      <span style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0">Permissions</span>
      <div style="display: flex; align-items: center; gap: 12px">
        <span style="flex: 1; display: flex; flex-direction: column; gap: 2px">
          <span>${info.admin ? 'Running as administrator' : 'Running without admin rights'}</span>
          <span style="font-size: 12px; color: #9BA3AF">${info.admin ? 'Fast scan can read the file table directly.' : 'Fast scan and protected folders need administrator rights.'}</span>
        </span>
        ${!info.admin && html`<button class="btn" onClick=${() => A.relaunchAsAdmin(null)}>Restart as admin</button>`}
      </div>
    </section>`}
    <${UpdatesSection} />
    <section style="display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid #22262D">
      <span style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0">Data</span>
      <div style="display: flex; align-items: center; gap: 12px">
        <span style="flex: 1; display: flex; flex-direction: column; gap: 2px"><span>Cleanup history</span><span style="font-size: 12px; color: #9BA3AF">Everything Strata removed in the last 7 days</span></span>
        <button class="btn" onClick=${() => A.openModal({ kind: 'history' })}>Open history</button>
      </div>
      <div style="display: flex; align-items: center; gap: 12px">
        <span style="flex: 1; display: flex; flex-direction: column; gap: 2px"><span>Recent scans</span><span style="font-size: 12px; color: #9BA3AF">${plural(recent.length, 'saved scan')}</span></span>
        <button class="btn" disabled=${!recent.length} onClick=${async () => { await api.clearRecent(); await A.refreshRecent(); toast('Recent scans cleared'); }}>Clear</button>
      </div>
    </section>
    <div class="actions" style="justify-content: space-between; align-items: center">
      <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #7B8390">Strata v${info.version}</span>
      <button class="btn primary" onClick=${A.closeModal}>Done</button>
    </div>
  <//>`;
}

function HistoryDialog() {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = () => api.history().then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  async function restore(h) {
    setBusy(h.id);
    try {
      const n = await api.restore(h.id);
      toast(n ? `Restored ${h.name} — rescan to see it on the map` : 'Nothing to restore — the original location is taken.', 4000);
    } catch (e) { toast(e.message); }
    setBusy(null);
    load();
  }
  return html`<${Dialog} title="History" onClose=${A.closeModal} wide>
    <p>What Strata removed in the last 7 days. Items in the ${TRASH} can be put back where they were.</p>
    <div style="display: flex; flex-direction: column; max-height: 52vh; overflow: auto; border-radius: 10px; border: 1px solid #22262D; background: #0E1014">
      ${list === null && html`<div style="padding: 16px; color: #9BA3AF; display: flex; gap: 10px; align-items: center"><span class="spinner"></span> Loading…</div>`}
      ${list && !list.length && html`<div style="padding: 16px; color: #9BA3AF">Nothing removed yet.</div>`}
      ${list && list.map((h) => html`
        <div style="display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #1B1F25">
          <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px">
            <span style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${h.name}${h.contentsOnly ? ' (contents)' : ''}</span>
            <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${h.path}</span>
            <span style="font-size: 12px; color: #C9CED6">${fmtWhen(h.at)} · ${h.permanent ? 'Deleted permanently' : h.restored ? 'Restored' : TRASH}${h.ok ? '' : ' · partly'}</span>
          </span>
          <span style="font-family: 'Geist Mono', monospace; font-size: 12px">${fmtBytes(h.size)}</span>
          ${h.restorable ? html`<button class="btn" style="height: 32px; padding: 0 12px" disabled=${busy === h.id} onClick=${() => restore(h)}>${busy === h.id ? 'Restoring…' : 'Restore'}</button>` : html`<span style="width: 84px"></span>`}
        </div>`)}
    </div>
    <div class="actions">
      <button class="btn quiet" disabled=${!list || !list.length} onClick=${async () => { await api.clearHistory(); load(); }}>Clear history</button>
      <button class="btn primary" onClick=${A.closeModal}>Done</button>
    </div>
  <//>`;
}

const LABEL = 'font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0';
const HINT = 'font-size: 12px; color: #9BA3AF';

function updateStatus(u, version) {
  if (!u) return '';
  if (!u.configured) return 'Updates aren\'t set up in this build.';
  switch (u.phase) {
    case 'checking': return 'Checking…';
    case 'uptodate': return `Strata ${version} is up to date.`;
    case 'available': return `Strata ${u.version} is available.`;
    case 'downloading': return `Downloading Strata ${u.version}…`;
    case 'ready': return `Strata ${u.version} is ready to install.`;
    case 'installing': return 'Installing…';
    case 'error': return u.error || 'Couldn\'t check for updates.';
    default: return '';
  }
}

function UpdatesSection() {
  const { settings, info, update: u } = useStore();
  const opts = settings.updates;
  const busy = u && ['checking', 'downloading', 'installing'].includes(u.phase);
  const pending = u && ['available', 'downloading', 'ready'].includes(u.phase);
  return html`<section style="display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid #22262D">
    <span style=${LABEL}>Updates</span>
    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer">
      <span style="flex: 1; display: flex; flex-direction: column; gap: 2px"><span>Check for updates automatically</span><span style=${HINT}>Once a day, Strata asks github.com for the newest version. Nothing about you or your files is sent.</span></span>
      <input type="checkbox" checked=${opts.check === true} onChange=${(e) => A.setUpdateOptions({ check: e.currentTarget.checked })} style="width: 18px; height: 18px; margin: 0" />
    </label>
    <div style="display: flex; align-items: center; gap: 12px">
      <span style="flex: 1">Update channel</span>
      <select value=${opts.channel} onChange=${(e) => A.setUpdateOptions({ channel: e.currentTarget.value, skipped: '' })} aria-label="Update channel"
        style="height: 34px; padding: 0 10px; border-radius: 8px; border: 1px solid #333944; background: #0E1014; color: #E6E8EB; font: inherit">
        <option value="stable">Stable</option>
        <option value="beta">Beta (early builds)</option>
      </select>
    </div>
    <div style="display: flex; align-items: center; gap: 12px">
      <span style="flex: 1; display: flex; flex-direction: column; gap: 2px">
        <span style=${u && u.phase === 'error' ? 'color: #F5B54A' : ''}>${updateStatus(u, info.version) || `Strata ${info.version}`}</span>
        ${info.portable && html`<span style=${HINT}>Portable build: the update replaces this file in place.</span>`}
      </span>
      ${pending ? html`<button class="btn" onClick=${() => A.openModal({ kind: 'update' })}>View</button>` : html`<button class="btn" disabled=${busy || !(u && u.configured)} onClick=${() => A.checkForUpdates(true)}>${busy ? 'Checking…' : 'Check now'}</button>`}
    </div>
    <div style="display: flex; align-items: center; gap: 12px">
      <span style="flex: 1">Release notes</span>
      <button class="btn" onClick=${() => A.openReleaseNotes(true)}>What's new</button>
    </div>
  </section>`;
}

function UpdatesAskDialog() {
  return html`<${Dialog} title="Keep Strata up to date?" onClose=${() => A.answerUpdatesAsk(false)}>
    <p>Strata can look for a newer version once a day and tell you when there is one. It only asks github.com for a small file with the latest version number; nothing about you or your files is sent, and nothing is installed without your say.</p>
    <p>You can change this any time in Settings › Updates.</p>
    <div class="actions">
      <button class="btn quiet" onClick=${() => A.answerUpdatesAsk(false)}>No thanks</button>
      <button class="btn primary" onClick=${() => A.answerUpdatesAsk(true)}>Check automatically</button>
    </div>
  <//>`;
}

const MODE_HINT = {
  installer: 'Strata will close, install the update and start again.',
  portable: 'Strata will replace this file with the new version and start again. Your settings stay in "Strata Data" next to it.',
  appimage: 'Strata will replace this AppImage with the new version and start again.',
  package: 'Linux asks for your password to install the package. Strata starts again afterwards.',
  manual: 'This copy of Strata is updated by hand: download the new version from the release page.',
};

function UpdateDialog() {
  const { update: u, info } = useStore();
  if (!u || !u.version) return html`<${Dialog} title="No update" onClose=${A.closeModal}><p>${updateStatus(u, info.version)}</p><div class="actions"><button class="btn primary" onClick=${A.closeModal}>Done</button></div><//>`;
  const manual = u.mode === 'manual';
  const downloading = u.phase === 'downloading';
  const pct = u.total ? Math.min(1, u.downloaded / u.total) : 0;
  const entry = parseNotes(u.notes);
  const hasNotes = entry.summary || entry.sections.length;
  const page = `https://github.com/florentvdry/strata/releases/tag/v${u.version}`;
  return html`<${Dialog} title=${u.phase === 'ready' ? 'Ready to install' : `Strata ${u.version} is available`} onClose=${downloading ? null : A.closeModal} wide>
    <p>You have <b style="color: #E6E8EB">${info.version}</b>. ${MODE_HINT[u.mode] || ''}</p>
    ${hasNotes && html`<div style="max-height: 40vh; overflow: auto; padding: 14px; border-radius: 10px; border: 1px solid #22262D; background: #0E1014"><${Notes} entry=${entry} /></div>`}
    ${downloading && html`
      <span style="display: block; height: 8px; border-radius: 4px; background: #22262D; overflow: hidden"><span style=${`display: block; height: 100%; width: ${Math.max(4, pct * 100)}%; background: var(--accent); transition: width .2s`}></span></span>
      <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF">${fmtBytes(u.downloaded)}${u.total ? ` of ${fmtBytes(u.total)}` : ''}</span>`}
    ${u.error && html`<p style="color: #F5B54A">${u.error}</p>`}
    <div class="actions">
      ${u.phase === 'available' && html`<button class="btn quiet" onClick=${A.skipUpdate}>Skip this version</button>`}
      <button class="btn quiet" onClick=${A.closeModal}>${downloading ? 'Hide' : 'Later'}</button>
      ${manual && html`<button class="btn primary" onClick=${() => api.openUrl(page)}>Open download page</button>`}
      ${!manual && u.phase === 'available' && html`<button class="btn primary" onClick=${A.downloadUpdate}>Download update</button>`}
      ${!manual && u.phase === 'ready' && html`<button class="btn primary" onClick=${A.installUpdate}>Install and restart</button>`}
      ${u.phase === 'installing' && html`<span style="display: inline-flex; align-items: center; gap: 10px; color: #9BA3AF"><span class="spinner"></span> Installing…</span>`}
    </div>
  <//>`;
}

function WhatsNewDialog({ m }) {
  return html`<${Dialog} title=${m.title} onClose=${A.closeModal} wide>
    <div style="display: flex; flex-direction: column; gap: 22px; max-height: 58vh; overflow: auto">
      ${m.entries.map((e) => html`
        <div key=${e.version} style="display: flex; flex-direction: column; gap: 12px">
          <div style="display: flex; align-items: baseline; gap: 10px">
            <span style="font-size: 16px; font-weight: 600">${e.version}</span>
            ${e.prerelease && html`<span style="font-size: 11px; padding: 1px 7px; border-radius: 6px; border: 1px solid #333944; color: #F5B54A">beta</span>`}
            <span style="font-family: 'Geist Mono', monospace; font-size: 12px; color: #7B8390">${e.date}</span>
          </div>
          <${Notes} entry=${e} />
        </div>`)}
      ${!m.entries.length && html`<p>Nothing new to show.</p>`}
    </div>
    <div class="actions"><button class="btn primary" onClick=${A.closeModal}>Done</button></div>
  <//>`;
}

export function ContextMenu() {
  const { menu } = useStore();
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => setPos(null), [menu]);
  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); A.closeMenu(); } };
    const onBlur = () => A.closeMenu();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', onBlur); };
  }, [menu]);
  if (!menu) return null;
  // Keep the menu inside the window: measure it, then flip or slide it back.
  const place = (el) => {
    if (!el || pos) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(6, Math.min(menu.x, window.innerWidth - r.width - 6)), y: Math.max(6, Math.min(menu.y, window.innerHeight - r.height - 6)) });
  };
  return html`
    <div class="menu-shield" onMouseDown=${() => A.closeMenu()} onContextMenu=${(e) => { e.preventDefault(); A.closeMenu(); }}>
      <div class="menu" role="menu" ref=${place} style=${`left: ${(pos || menu).x}px; top: ${(pos || menu).y}px; ${pos ? '' : 'visibility: hidden'}`} onMouseDown=${(e) => e.stopPropagation()}>
        ${menu.items.map((it, k) => it.separator
          ? html`<div class="menu-sep" key=${k}></div>`
          : html`<button type="button" role="menuitem" key=${it.id} class="menu-item" disabled=${it.enabled === false} onClick=${() => A.closeMenu(it.id)}>${it.label}</button>`)}
      </div>
    </div>`;
}

const DIALOGS = { admin: AdminDialog, trash: TrashDialog, confirmCleanup: ConfirmCleanupDialog, busy: BusyDialog, result: ResultDialog, settings: SettingsDialog, history: HistoryDialog, update: UpdateDialog, updatesAsk: UpdatesAskDialog, whatsnew: WhatsNewDialog };

export function Modals() {
  const { modal, toast: t, dragging } = useStore();
  const D = modal && DIALOGS[modal.kind];
  return html`
    ${D && html`<${D} m=${modal} />`}
    <${ContextMenu} />
    ${t && html`<div class="toast" role="status">${t}</div>`}
    ${dragging && html`<div class="dropzone">${Icon.folderPlus()}<span>Drop a folder to map it</span></div>`}`;
}
