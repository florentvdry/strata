// Start — pick a drive.
import { html } from '../lib/html.js';
import { useStore } from '../lib/store.js';
import { Logo, Icon } from '../components/ui.js';
import { fmtBytes, fmtWhen } from '../lib/format.js';
import { isWin } from '../lib/platform.js';
import * as A from '../actions.js';

const api = window.strata;

export function driveName(d) {
  if (!isWin) {
    // Linux: the mount point says where it is; the label (or "System" for /) says what it is.
    const name = d.label || (d.system ? 'System' : null);
    return name ? `${name} (${d.root})` : d.root;
  }
  return `${d.letter}: ${d.label || (d.system ? 'System' : d.kind === 'Network' ? 'Network' : 'Local Disk')}`;
}

export function driveKind(d) {
  const parts = [d.bus, d.media].filter(Boolean);
  const kind = parts.length ? parts.join(' ') : d.kind === 'Removable' ? 'Removable' : d.kind === 'Network' ? 'Network drive' : 'Local disk';
  return d.fs ? `${kind} · ${d.fs}` : kind;
}

function DriveCard({ d, primary, accent }) {
  const used = d.total - d.free;
  const pct = d.total ? used / d.total : 0;
  const low = d.total && d.free / d.total < 0.1;
  const color = primary ? accent : low ? '#F59E0B' : '#8C94A0';
  const icon = primary ? accent : low ? '#F59E0B' : '#C9CED6';
  return html`
    <button type="button" class=${primary ? 'hov-card-accent' : 'hov-card'} onClick=${() => A.requestScan(d.root)}
      style=${`display: flex; flex-direction: column; gap: 14px; padding: 18px; border-radius: 14px; background: ${primary ? '#161A20' : '#14171C'}; border: 1px solid ${primary ? accent : '#262B33'}; text-decoration: none; color: #E6E8EB; text-align: left; cursor: pointer`}>
      <div style="display: flex; align-items: center; gap: 12px">
        <span style="width: 40px; height: 40px; border-radius: 10px; background: #22262D; display: flex; align-items: center; justify-content: center">${Icon.drive(icon)}</span>
        <div style="display: flex; flex-direction: column"><span style="font-weight: 600; font-size: 16px">${driveName(d)}</span><span style="font-size: 12px; color: #9BA3AF">${driveKind(d)}</span></div>
      </div>
      <span style="display: block; width: 100%; height: 8px; border-radius: 4px; background: #262B33; overflow: hidden"><span style=${`display: block; width: ${(pct * 100).toFixed(1)}%; height: 100%; background: ${color}`}></span></span>
      <div style="display: flex; width: 100%; justify-content: space-between; gap: 10px; font-family: 'Geist Mono', monospace; font-size: 12px; color: #9BA3AF"><span>${fmtBytes(used)} used</span><span style=${low ? 'color: #F5B54A' : ''}>${fmtBytes(d.free)} free${low ? ' · low' : ''}</span></div>
      <span style=${`font-size: 13px; font-weight: ${primary ? 600 : 500}; color: ${primary ? accent : '#C9CED6'}`}>${primary ? 'Scan now →' : 'Scan →'}</span>
    </button>`;
}

function Placeholder() {
  return html`<div style="min-height: 180px; border-radius: 14px; background: #14171C; border: 1px solid #22262D; animation: strata-pulse 1.6s ease-in-out infinite"></div>`;
}

function Option({ checked, onChange, title, hint, last }) {
  return html`
    <label style=${`display: flex; align-items: center; gap: 14px; padding: 14px 16px; ${last ? '' : 'border-bottom: 1px solid #1E2228;'} cursor: pointer`}>
      <input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.currentTarget.checked)} style="width: 18px; height: 18px; flex: none; margin: 0" />
      <span style="display: flex; flex-direction: column; gap: 2px"><span style="font-weight: 500">${title}</span><span style="font-size: 12px; color: #9BA3AF">${hint}</span></span>
    </label>`;
}

export function Start() {
  const { drives, settings, recent, info } = useStore();
  const accent = settings.accent;
  const opts = settings.scan;
  const primary = drives && (drives.find((d) => d.system) || drives[0]);
  const fastHint = opts.links ? 'Not used while following links' : info.admin ? 'Running as administrator · 10–20× faster on NTFS' : 'Needs admin rights · 10–20× faster on NTFS';

  async function pick() {
    const p = await api.pickFolder();
    if (p) A.requestScan(p);
  }

  return html`
  <div style="min-height: 100vh; background: #0E1014; color: #E6E8EB; font-family: 'Geist', system-ui, sans-serif; font-size: 14px; display: flex; flex-direction: column">
    <header style="display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-bottom: 1px solid #22262D; background: #12151A">
      <${Logo} accent=${accent} />
      <span style="font-weight: 700; font-size: 17px; letter-spacing: -0.02em">Strata</span>
      <div style="flex: 1"></div>
      <button type="button" class="hov-ghost" aria-label="Settings" title="Settings" onClick=${() => A.openModal({ kind: 'settings' })} style="width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid #333944; background: transparent; color: #E6E8EB; cursor: pointer">${Icon.gear()}</button>
    </header>

    <main style="flex: 1; width: 100%; max-width: 1080px; margin: 0 auto; padding: 56px 20px 40px; box-sizing: border-box; display: flex; flex-direction: column; gap: 40px">
      <div style="display: flex; flex-direction: column; gap: 10px">
        <h1 style="margin: 0; font-size: 44px; font-weight: 700; letter-spacing: -0.035em; line-height: 1.05">What should we map?</h1>
        <p style="margin: 0; font-size: 16px; color: #9BA3AF; max-width: 560px; line-height: 1.5">${isWin
          ? 'Pick a drive or a folder. Strata reads the file table directly, so a full system drive usually takes under a minute.'
          : 'Pick a drive or a folder. Strata reads many folders at once, so a full system drive usually takes under a minute.'}</p>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px">
        ${drives ? drives.map((d) => html`<${DriveCard} key=${d.root} d=${d} primary=${d === primary} accent=${accent} />`) : html`<${Placeholder} /><${Placeholder} /><${Placeholder} />`}
        <button type="button" class="hov-card" onClick=${pick} style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 18px; min-height: 180px; border-radius: 14px; background: transparent; border: 1.5px dashed #3A404A; color: #C9CED6; cursor: pointer">
          ${Icon.folderPlus()}
          <span style="font-weight: 600">Choose a folder…</span>
          <span style="font-size: 12px; color: #9BA3AF">or drop one anywhere</span>
        </button>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 24px">
        <section style="flex: 1 1 380px; min-width: 0; display: flex; flex-direction: column; gap: 12px">
          <h2 style="margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #8C94A0">Scan options</h2>
          <div style="display: flex; flex-direction: column; border-radius: 12px; border: 1px solid #22262D; background: #14171C">
            ${isWin && html`<${Option} checked=${opts.mft} onChange=${(v) => A.setScanOption('mft', v)} title="Fast scan (read the MFT)" hint=${fastHint} />`}
            <${Option} checked=${opts.hidden} onChange=${(v) => A.setScanOption('hidden', v)} title=${isWin ? 'Include hidden & system files' : 'Include hidden files'} hint=${isWin ? 'pagefile, hiberfil, WinSxS…' : 'Dot-folders such as .cache, .local and .config'} />
            <${Option} checked=${opts.links} onChange=${(v) => A.setScanOption('links', v)} title=${isWin ? 'Follow junctions & symlinks' : 'Follow symlinks'} hint="Off avoids counting the same bytes twice" last />
          </div>
        </section>
        <section style="flex: 1 1 380px; min-width: 0; display: flex; flex-direction: column; gap: 12px">
          <h2 style="margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #8C94A0">Recent scans</h2>
          <div style="display: flex; flex-direction: column; border-radius: 12px; border: 1px solid #22262D; background: #14171C; overflow: hidden">
            ${recent.length === 0 && html`<div style="padding: 14px 16px; color: #9BA3AF">Nothing yet — your scans will show up here.</div>`}
            ${recent.slice(0, 5).map((r, k, arr) => html`
              <button type="button" class="hov-ghost" key=${r.id} onClick=${() => A.openRecent(r.id)} title=${`Open the ${r.method === 'MFT' ? 'fast' : 'normal'} scan of ${r.root}`}
                style=${`display: flex; align-items: center; gap: 14px; padding: 14px 16px; ${k < arr.length - 1 ? 'border-bottom: 1px solid #1E2228;' : ''} border-top: 0; border-left: 0; border-right: 0; ${k === arr.length - 1 ? 'border-bottom: 0;' : ''} background: transparent; text-decoration: none; color: #E6E8EB; cursor: pointer; text-align: left`}>
                <span style="font-family: 'Geist Mono', monospace; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${r.root}</span>
                <span style="font-size: 12px; color: #9BA3AF">${fmtWhen(r.scannedAt)}${r.partial ? ' · partial' : ''}</span>
                <span style="font-family: 'Geist Mono', monospace; font-size: 12px; width: 72px; text-align: right">${fmtBytes(r.bytes)}</span>
              </button>`)}
          </div>
        </section>
      </div>
    </main>
  </div>`;
}
