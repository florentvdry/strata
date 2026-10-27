// Tiny global store with a Preact hook. Hover lives in its own store so mouse moves stay cheap.
import { useState, useEffect } from 'preact/hooks';

function createStore(initial) {
  const state = initial;
  const listeners = new Set();
  let queued = false;
  return {
    state,
    set(patch) {
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; listeners.forEach((l) => l()); });
    },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}

export const store = createStore({
  ready: false,
  screen: 'start',
  info: { admin: false, version: '0.1.0', home: '', temp: '' },
  settings: { accent: '#C6F432', shading: true, scan: { mft: true, hidden: true, links: false }, view: 'treemap' },
  drives: null, // null until the first listing arrives
  recent: [],
  scan: null,
  tree: null,
  treeId: null,
  partial: false,
  ex: null,
  dupes: { status: 'idle', pct: 0, groups: [] },
  cleanup: { items: [], on: {}, user: [], cat: 'all', permanent: false },
  modal: null,
  toast: null,
  dragging: false,
});

export const hover = createStore({ id: -1 });

export function useStore(s = store) {
  const [, force] = useState(0);
  useEffect(() => s.subscribe(() => force((x) => x + 1)), [s]);
  return s.state;
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  store.set({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.set({ toast: null }), ms);
}
