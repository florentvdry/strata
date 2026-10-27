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

// "or drop one anywhere"
function useDrop() {
  useEffect(() => {
    let depth = 0;
    const can = () => store.state.screen !== 'scanning' && !store.state.modal;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e) => { if (!hasFiles(e) || !can()) return; e.preventDefault(); depth++; store.set({ dragging: true }); };
    const over = (e) => { if (hasFiles(e) && can()) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) store.set({ dragging: false }); };
    const drop = async (e) => {
      e.preventDefault();
      depth = 0;
      store.set({ dragging: false });
      if (!can()) return;
      const file = e.dataTransfer.files[0];
      if (!file) return;
      let p = api.pathForFile(file);
      if (!p) return;
      const st = await api.stat(p);
      if (st && !st.isDir) p = parentPath(p);
      A.requestScan(isWin && p.length === 2 ? p + '\\' : p);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
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
