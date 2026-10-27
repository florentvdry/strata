// Everything the UI can do. Views call these; these talk to the main process and the store.
import { store, toast } from './lib/store.js';
import { parseScan } from './lib/tree.js';
import { buildSuggestions, userItem, dupeCandidates } from './lib/cleanup.js';
import { fmtBytes } from './lib/format.js';
import { setLocale, t } from './lib/i18n.js';
import { isWin, fold, isUnderPath, trash, fileManager } from './lib/platform.js';
import CHANGELOG from './lib/changelog-data.js';
import { between } from './lib/changelog.js';

const api = window.strata;
const s = () => store.state;

// ───────────── startup & settings ─────────────

export async function init() {
  api.onScan(onScanEvent);
  api.onDupes(({ id, done, total }) => {
    if (s().treeId === id && s().dupes.status === 'running') store.set({ dupes: { ...s().dupes, pct: total ? done / total : 0 } });
  });
  api.onDeleteProgress((p) => { if (s().modal && s().modal.kind === 'busy') store.set({ modal: { ...s().modal, ...p } }); });
  const [info, settings, recent] = await Promise.all([api.appInfo(), api.settings(), api.recent()]);
  applyAccent(settings.accent);
  const locale = await setLocale(settings.language);
  store.set({ info, settings, recent, locale, ready: true });
  await refreshDrives();
  const pending = await api.pendingScan();
  if (pending) { startScan(pending.root, pending.options); return; }
  initUpdates(info.version, settings);
}

export function applyAccent(c) {
  document.documentElement.style.setProperty('--accent', c);
}

export async function saveSettings(patch) {
  const settings = await api.saveSettings(patch);
  if (patch.accent) applyAccent(settings.accent);
  const locale = patch.language ? await setLocale(settings.language) : s().locale;
  store.set({ settings, locale });
}

export function setScanOption(key, value) {
  saveSettings({ scan: { ...s().settings.scan, [key]: value } });
}

export async function refreshDrives(force = true) {
  try { store.set({ drives: await api.drives(force) }); } catch (e) { toast(t("Couldn't list drives: {error}", { error: e.message })); }
}

export async function refreshRecent() {
  store.set({ recent: await api.recent() });
}

export function go(screen) {
  store.set({ screen, modal: null });
}

export function openModal(modal) { store.set({ modal }); }
export function closeModal() { store.set({ modal: null }); }

export async function relaunchAsAdmin(pending) {
  const ok = await api.relaunchAdmin(pending || null);
  if (!ok) toast(t('Administrator rights were not granted.'));
}

// ───────────── right-click menu ─────────────

// Where the last right-click happened, so the menu opens under the pointer.
let pointer = { x: 0, y: 0 };
window.addEventListener('contextmenu', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, true);

/** Shows a menu; resolves with the chosen item's id, or null when it was dismissed. */
export function showMenu(items) {
  closeMenu();
  return new Promise((resolve) => store.set({ menu: { ...pointer, items, resolve } }));
}

export function closeMenu(id = null) {
  const m = s().menu;
  if (!m) return;
  store.set({ menu: null });
  m.resolve(id);
}

// ───────────── what's new & updates ─────────────

export function openReleaseNotes(all = true) {
  const entries = all ? CHANGELOG : CHANGELOG.slice(0, 1);
  openModal({ kind: 'whatsnew', entries, title: all ? t('Release notes') : t("What's new in Strata {version}", { version: s().info.version }) });
}

// After an update, once: what changed since the version the person last ran.
function initUpdates(version, settings) {
  api.onUpdate((u) => store.set({ update: u }));
  api.updateState().then((u) => store.set({ update: u }));
  const seen = settings.lastSeenVersion;
  if (seen !== version) saveSettings({ lastSeenVersion: version });
  const news = seen ? between(CHANGELOG, seen, version) : [];
  if (news.length) openModal({ kind: 'whatsnew', entries: news, title: t('Strata {version} is installed', { version }) });
  else if (settings.updates.check === null) openModal({ kind: 'updatesAsk' });
}

export async function setUpdateOptions(patch) {
  await saveSettings({ updates: { ...s().settings.updates, ...patch } });
}

export async function answerUpdatesAsk(check) {
  await setUpdateOptions({ check });
  closeModal();
  if (check) checkForUpdates(false);
}

/** Looks for an update now. `show` opens the update dialog when there is one. */
export async function checkForUpdates(show = true) {
  try {
    const u = await api.updateCheck();
    store.set({ update: u });
    if (show && u.phase === 'available') openModal({ kind: 'update' });
    else if (show && u.phase === 'uptodate') toast(t('Strata {version} is up to date.', { version: s().info.version }));
  } catch (e) { toast(e.message); }
}

export async function downloadUpdate() {
  try { store.set({ update: await api.updateDownload() }); } catch (e) { toast(e.message); }
}

export async function installUpdate() {
  try { await api.updateInstall(); } catch (e) { toast(e.message, 6000); }
}

export function skipUpdate() {
  const u = s().update;
  if (!u || !u.version) return;
  setUpdateOptions({ skipped: u.version });
  store.set({ update: { ...u, phase: 'uptodate', version: null, notes: null } });
  closeModal();
}

// ───────────── scanning ─────────────

export function driveOf(path) {
  const drives = s().drives || [];
  if (isWin) return drives.find((d) => path.toUpperCase().startsWith(d.root.toUpperCase()));
  // Linux mount points nest ("/" holds everything): the deepest one containing the path.
  let best = null;
  for (const d of drives) if (isUnderPath(path, d.root) && (!best || d.root.length > best.root.length)) best = d;
  return best || undefined;
}

// Starts a scan, first asking about admin rights when fast scan needs them.
export function requestScan(root, mode) {
  const { settings, info } = s();
  const options = { ...settings.scan };
  const d = driveOf(root);
  const ntfs = isWin && d && d.fs === 'NTFS';
  if (mode === 'normal' || !isWin) options.mft = false; // the file-table fast scan is Windows only
  else if (options.mft && !options.links && ntfs && !info.admin) {
    openModal({ kind: 'admin', root, options });
    return;
  }
  startScan(root, options);
}

export async function startScan(root, options) {
  store.set({
    screen: 'scanning',
    modal: null,
    scan: {
      id: null, root, options, phase: options.mft && !options.links ? 'mft' : 'walk', pct: 0, files: 0, dirs: 0, bytes: 0,
      current: '', tops: [], biggest: [], notice: null, error: null, paused: false, done: false,
      startedAt: Date.now(), pausedAt: 0, pausedTotal: 0,
    },
  });
  try {
    const { id } = await api.startScan({ root, options });
    if (s().scan && s().scan.root === root) setScan({ id });
  } catch (e) {
    setScan({ error: e.message });
  }
}

function setScan(patch) {
  if (s().scan) store.set({ scan: { ...s().scan, ...patch } });
}

function onScanEvent(msg) {
  const sc = s().scan;
  if (!sc || (sc.id && msg.id !== sc.id)) return;
  switch (msg.type) {
    case 'progress':
      setScan({
        phase: msg.phase === 'paused' ? sc.phase : msg.phase,
        pct: Math.max(sc.pct, msg.pct), files: msg.files, dirs: msg.dirs, bytes: msg.bytes,
        current: msg.current || sc.current, tops: msg.tops, biggest: msg.biggest,
      });
      break;
    case 'notice':
      setScan({ notice: msg.message, pct: 0, phase: 'walk', tops: [] });
      break;
    case 'done':
      onScanDone(msg);
      break;
    case 'error':
      setScan({ error: msg.message });
      break;
  }
}

async function onScanDone(msg) {
  setScan({ phase: 'build', pct: 1, done: true });
  await refreshRecent();
  let bytes;
  try { bytes = await api.loadScan(msg.id); } catch (e) { setScan({ error: e.message }); return; }
  if (!s().scan || s().scan.id !== msg.id) return; // cancelled while finishing
  const viewing = s().partial && (s().screen === 'explorer' || s().screen === 'cleanup');
  try { loadTree(bytes, msg.id, { keep: viewing }); } catch (e) { setScan({ error: e.message }); return; }
  store.set({ scan: null, screen: viewing ? s().screen : 'explorer' });
  if (viewing) toast(t('Scan finished — the map now shows everything.'));
  refreshDrives();
}

export function pauseScan() {
  const sc = s().scan;
  if (!sc || sc.done) return;
  if (sc.paused) {
    api.resumeScan();
    setScan({ paused: false, pausedTotal: sc.pausedTotal + (Date.now() - sc.pausedAt), pausedAt: 0 });
  } else {
    api.pauseScan();
    setScan({ paused: true, pausedAt: Date.now() });
  }
}

export async function cancelScan() {
  await api.cancelScan();
  const hadPartial = s().partial;
  store.set({ scan: null, screen: 'start', ...(hadPartial ? { tree: null, treeId: null, partial: false, ex: null } : {}) });
  refreshRecent();
}

export async function explorePartial() {
  const sc = s().scan;
  if (!sc) return;
  setScan({ snapshotting: true });
  try {
    const bytes = await api.snapshot();
    if (!bytes) throw new Error(t('The scan already finished.'));
    loadTree(bytes, `${sc.id}-partial`, { partial: true });
    store.set({ screen: 'explorer' });
  } catch (e) {
    toast(t("Couldn't open partial results: {error}", { error: e.message }));
  } finally {
    setScan({ snapshotting: false });
  }
}

export async function openRecent(id) {
  try {
    const bytes = await api.loadScan(id);
    loadTree(bytes, id);
    store.set({ screen: 'explorer' });
  } catch (e) {
    toast(e.message);
    refreshRecent();
  }
}

// ───────────── loaded results ─────────────

function biggestFile(tree, from) {
  let i = from;
  while (tree.isDir(i)) {
    const k = tree.kids(i);
    if (!k.length) break;
    i = k[0];
  }
  return i;
}

export function loadTree(bytes, id, { partial = false, keep = false } = {}) {
  const tree = parseScan(bytes);
  const prevTree = s().tree, prev = s().ex;
  const sameRoot = prevTree && fold(prevTree.names[0]) === fold(tree.names[0]);
  let ex = {
    zoom: 0, sel: -1, open: new Set([0]), more: {}, panel: 'folders', query: '', typeFilter: -1,
  };
  if ((keep || sameRoot) && prev && prevTree) {
    const map = (i) => (i >= 0 ? tree.lookup(prevTree.path(i)) : -1);
    const zoom = map(prev.zoom);
    ex = { ...ex, zoom: zoom >= 0 && tree.isDir(zoom) ? zoom : 0, sel: map(prev.sel), panel: prev.panel, query: prev.query, typeFilter: prev.typeFilter };
    for (const o of prev.open) { const j = map(o); if (j >= 0) ex.open.add(j); }
  }
  if (ex.sel < 0) ex.sel = biggestFile(tree, ex.zoom);
  const cleanup = sameRoot ? { ...s().cleanup, items: [] } : { items: [], on: {}, user: [], cat: 'all', permanent: s().cleanup.permanent };
  const sameScan = s().treeId === id && s().dupes.status === 'done';
  store.set({ tree, treeId: id, partial, ex, cleanup, dupes: sameScan ? s().dupes : { status: partial ? 'idle' : 'pending', pct: 0, groups: [] } });
  rebuildCleanup();
  if (!partial && !sameScan) findDupes();
}

export function rebuildCleanup() {
  const { tree, cleanup, dupes, info } = s();
  if (!tree) return;
  const items = buildSuggestions(tree, info, dupes.groups);
  const seen = new Set(items.map((it) => it.id));
  for (const p of cleanup.user) {
    const i = tree.lookup(p);
    if (i > 0 && !tree.removed[i]) {
      const it = userItem(tree, i);
      if (!seen.has(it.id)) items.push(it);
    }
  }
  const on = {};
  for (const it of items) on[it.id] = it.id in cleanup.on ? cleanup.on[it.id] : it.defaultOn;
  store.set({ cleanup: { ...cleanup, items, on } });
}

async function findDupes() {
  const { tree, treeId } = s();
  const groups = dupeCandidates(tree);
  if (!groups.length) { store.set({ dupes: { status: 'done', pct: 1, groups: [] } }); return; }
  store.set({ dupes: { status: 'running', pct: 0, groups: [] } });
  try {
    const found = await api.findDupes({ id: treeId, groups });
    if (s().treeId !== treeId) return;
    store.set({ dupes: { status: 'done', pct: 1, groups: found } });
    rebuildCleanup();
  } catch (e) {
    if (s().treeId === treeId) store.set({ dupes: { status: 'error', pct: 0, groups: [], error: e.message } });
  }
}

// ───────────── explorer ─────────────

function setEx(patch) {
  store.set({ ex: { ...s().ex, ...patch } });
}

export function zoomTo(i) {
  const { tree } = s();
  if (i < 0 || !tree || !tree.isDir(i)) return;
  const open = new Set(s().ex.open);
  open.add(i);
  const sel = tree.isUnder(s().ex.sel, i) && s().ex.sel !== i ? s().ex.sel : biggestFile(tree, i);
  setEx({ zoom: i, open, sel });
}

export function zoomOut() {
  const { tree, ex } = s();
  if (!tree || ex.zoom === 0) return;
  setEx({ zoom: tree.parent[ex.zoom] });
}

// Double-click on the map: go one level down toward the clicked item.
export function zoomToward(i) {
  const { tree, ex } = s();
  if (i < 0) return;
  let c = i;
  while (c !== 0 && tree.parent[c] !== ex.zoom) c = tree.parent[c];
  if (c !== 0 && tree.isDir(c)) zoomTo(c);
}

export function select(i, { reveal = true } = {}) {
  const { tree, ex } = s();
  if (i < 0 || !tree) return;
  const patch = { sel: i };
  if (!tree.isUnder(i, ex.zoom)) patch.zoom = 0;
  if (reveal) {
    const open = new Set(ex.open);
    for (let p = tree.parent[i]; p >= 0; p = p === 0 ? -1 : tree.parent[p]) open.add(p);
    patch.open = open;
  }
  setEx(patch);
}

export function toggleOpen(i) {
  const open = new Set(s().ex.open);
  if (open.has(i)) open.delete(i); else open.add(i);
  setEx({ open });
}

export function showMore(i) {
  const more = { ...s().ex.more, [i]: (s().ex.more[i] || 200) + 500 };
  setEx({ more });
}

export function setPanel(panel) { setEx({ panel, ...(panel !== 'search' ? { query: '' } : {}) }); }
export function setQuery(query) { setEx({ query, panel: query.trim() ? 'search' : 'folders' }); }
export function setTypeFilter(ty) { setEx({ typeFilter: s().ex.typeFilter === ty ? -1 : ty }); }
export function setView(view) { saveSettings({ view }); }

export function reveal(path) { api.show(path); }

export async function copyPath(path) {
  await api.copy(path);
  toast(t('Path copied'));
}

export async function nodeMenu(i) {
  const { tree, ex } = s();
  const it = itemForNode(i);
  const isDir = tree.isDir(i);
  const inCleanup = !!(it && s().cleanup.on[it.id]);
  const action = await showMenu([
    isDir ? { id: 'zoom', label: t('Zoom in'), enabled: i !== ex.zoom } : { id: 'open', label: t('Open') },
    { id: 'show', label: isWin ? t('Show in Explorer') : t('Show in {fileManager}', { fileManager: fileManager() }) },
    { id: 'copy', label: t('Copy path') },
    { separator: true },
    { id: 'cleanup', label: inCleanup ? t('Remove from cleanup') : t('Add to cleanup'), enabled: i !== 0 },
    { id: 'trash', label: t('Move to {trash}', { trash: trash() }), enabled: i !== 0 },
  ]);
  const p = tree.path(i);
  if (action === 'zoom') zoomTo(i);
  else if (action === 'open') api.open(p);
  else if (action === 'show') reveal(p);
  else if (action === 'copy') copyPath(p);
  else if (action === 'cleanup') toggleCleanupNode(i);
  else if (action === 'trash') confirmTrash(i);
}

export function rescan() {
  const { tree } = s();
  if (tree) requestScan(tree.names[0]);
}

// ───────────── cleanup ─────────────

export function itemForNode(i) {
  return s().cleanup.items.find((it) => it.nodes.length === 1 && it.nodes[0] === i) || null;
}

export function toggleCleanupNode(i) {
  const { tree, cleanup } = s();
  if (i <= 0) return;
  const it = itemForNode(i);
  if (it) {
    setItem(it.id, !cleanup.on[it.id]);
    toast(cleanup.on[it.id] ? t('Removed from cleanup') : t('Added to cleanup'));
    return;
  }
  const path = tree.path(i);
  const ui = userItem(tree, i);
  store.set({ cleanup: { ...cleanup, user: [...cleanup.user, path], on: { ...cleanup.on, [ui.id]: true } } });
  rebuildCleanup();
  toast(t('Added {name} to cleanup', { name: tree.name(i) }));
}

export function setItem(id, value) {
  const c = s().cleanup;
  store.set({ cleanup: { ...c, on: { ...c.on, [id]: value } } });
}

export function setItems(ids, value) {
  const c = s().cleanup;
  const on = { ...c.on };
  for (const id of ids) on[id] = value;
  store.set({ cleanup: { ...c, on } });
}

export function setCat(cat) { store.set({ cleanup: { ...s().cleanup, cat } }); }
export function setPermanent(v) { store.set({ cleanup: { ...s().cleanup, permanent: v } }); }

export function confirmTrash(i) {
  const { tree } = s();
  if (i <= 0) return;
  openModal({ kind: 'trash', node: i, name: tree.name(i), path: tree.path(i), size: tree.size[i], isDir: tree.isDir(i), files: tree.files[i] });
}

export async function trashNode(i) {
  const { tree } = s();
  await runDeletion([{ path: tree.path(i), name: tree.name(i), size: tree.size[i], contentsOnly: false }], false);
}

export async function runCleanup() {
  const { cleanup } = s();
  const chosen = cleanup.items.filter((it) => cleanup.on[it.id]);
  const targets = [];
  for (const it of chosen) {
    it.targets.forEach((tg, k) => targets.push({ ...tg, name: it.name, size: s().tree.size[it.nodes[k]] || 0 }));
  }
  await runDeletion(targets, cleanup.permanent);
}

async function runDeletion(targets, permanent) {
  const total = targets.reduce((a, tg) => a + (tg.size || 0), 0);
  openModal({ kind: 'busy', title: permanent ? t('Deleting…') : t('Moving to {trash}…', { trash: trash() }), done: 0, total: 1, current: '' });
  let results;
  try {
    results = await api.remove({ targets, permanent });
  } catch (e) {
    openModal({ kind: 'result', title: t('Cleanup failed'), lines: [e.message], failures: [] });
    return;
  }
  const { tree } = s();
  let freed = 0;
  const failures = [];
  results.forEach((r, k) => {
    const tg = targets[k];
    const i = tree.lookup(tg.path);
    if (r.protected) { failures.push({ path: tg.path, error: r.error }); return; }
    const before = i >= 0 ? tree.size[i] : tg.size;
    const remaining = r.ok ? 0 : Math.min(before, r.remaining);
    freed += Math.max(0, before - remaining);
    if (!r.ok) failures.push({ path: tg.path, error: r.error, remaining });
    if (i < 0) return;
    if (tg.contentsOnly) tree.remove(i, remaining, true);
    else if (r.ok) tree.remove(i);
    else if (tree.isDir(i) && remaining < before) tree.remove(i, remaining, true);
  });
  const { ex } = s();
  const fix = (i) => (i >= 0 && !tree.removed[i] ? i : -1);
  let zoom = ex.zoom;
  while (zoom > 0 && tree.removed[zoom]) zoom = tree.parent[zoom];
  const sel = fix(ex.sel) >= 0 ? ex.sel : biggestFile(tree, zoom);
  store.set({ tree, ex: { ...ex, zoom, sel } });
  rebuildCleanup();
  refreshDrives();
  const ok = results.filter((r) => r.ok).length;
  const lines = [permanent
    ? t('{n, plural, one {# item} other {# items}} deleted permanently.', { n: ok })
    : t('{n, plural, one {# item} other {# items}} moved to the {trash}.', { n: ok, trash: trash() })];
  if (failures.length) lines.push(t("{n, plural, one {# item} other {# items}} couldn't be fully removed — usually because a program is using them.", { n: failures.length }));
  openModal({ kind: 'result', title: t('Freed {size}', { size: fmtBytes(freed) }), lines, failures, freed, total });
}
