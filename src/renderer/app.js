import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { html } from './lib/html.js';
import { store, useStore } from './lib/store.js';
import { isWin, parentPath } from './lib/platform.js';
import { Modals } from './components/ui.js';
import { Start } from './views/start.js';
import { Scanning } from './views/scanning.js';
import { Explorer } from './views/explorer.js';
import { Cleanup } from './views/cleanup.js';
import * as A from './actions.js';

const api = window.strata;

function typing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e) => {
      const s = store.state;
      if (s.modal) return;
      if (s.screen === 'explorer' && s.tree && !typing(e)) {
        if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); A.zoomOut(); }
        else if (e.key === 'Enter' && s.ex.sel >= 0 && s.tree.isDir(s.ex.sel)) A.zoomTo(s.ex.sel);
        else if (e.key === 'Delete' && s.ex.sel > 0) A.confirmTrash(s.ex.sel);
        else if (e.key === 'Escape') { if (s.ex.panel !== 'folders') A.setPanel('folders'); else if (s.ex.typeFilter >= 0) A.setTypeFilter(s.ex.typeFilter); }
      }
      if (s.screen === 'cleanup' && e.key === 'Escape') A.go('explorer');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// "or drop one anywhere": the app reports the dropped paths itself (the web view can't see them).
function useDrop() {
  useEffect(() => {
    if (!api.onFileDrop) return undefined;
    const can = () => store.state.screen !== 'scanning' && !store.state.modal;
    return api.onFileDrop(async ({ type, paths }) => {
      if (type === 'enter' || type === 'over') {
        if (can() && !store.state.dragging) store.set({ dragging: true });
        return;
      }
      store.set({ dragging: false });
      if (type !== 'drop' || !can() || !paths.length) return;
      let p = paths[0];
      const st = await api.stat(p);
      if (st && !st.isDir) p = parentPath(p);
      A.requestScan(isWin && p.length === 2 ? p + '\\' : p);
    });
  }, []);
}

function App() {
  const s = useStore();
  useGlobalKeys();
  useDrop();
  useEffect(() => {
    const titles = { start: 'Strata', scanning: 'Strata — Scanning', explorer: 'Strata — Explorer', cleanup: 'Strata — Review cleanup' };
    document.title = titles[s.screen] || 'Strata';
  }, [s.screen]);
  if (!s.ready) return html`<div style="min-height: 100vh; background: #0E1014"></div>`;
  let screen = s.screen;
  if ((screen === 'explorer' || screen === 'cleanup') && !s.tree) screen = 'start';
  if (screen === 'scanning' && !s.scan) screen = s.tree ? 'explorer' : 'start';
  const View = { start: Start, scanning: Scanning, explorer: Explorer, cleanup: Cleanup }[screen];
  return html`<${View} /><${Modals} />`;
}

render(html`<${App} />`, document.getElementById('app'));
A.init().catch((e) => {
  console.error(e);
  store.set({ ready: true, toast: `Startup problem: ${e.message}` });
});
