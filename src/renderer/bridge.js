// Bridge between the UI and the app (src/app/): window.strata, one call per app command.
// Loaded before the UI's modules. When window.strata already exists (screenshots, tests) it stays as it is.
(function () {
  if (window.strata) return;
  const tauri = window.__TAURI__;
  if (!tauri) { console.error('Strata: the app bridge is missing (not running inside Strata).'); return; }
  const { invoke } = tauri.core;
  const { listen } = tauri.event;

  const fail = (e) => { throw e instanceof Error ? e : new Error(typeof e === 'string' ? e : (e && e.message) || String(e)); };
  const call = (cmd) => (args) => invoke(cmd, args).catch(fail);
  const bytes = (cmd) => (args) => invoke(cmd, args).then((b) => { const u8 = new Uint8Array(b); return u8.length ? u8 : null; }).catch(fail);
  const on = (event) => (fn) => {
    const off = listen(event, (e) => fn(e.payload));
    return () => off.then((f) => f());
  };

  window.strata = {
    platform: /windows/i.test(navigator.userAgent) ? 'win32' : 'linux',
    appInfo: call('app_info'),
    relaunchAdmin: (pending) => call('relaunch_admin')({ pending }),
    pendingScan: call('pending_scan'),
    drives: (force) => call('drives_list')({ force }),
    settings: call('settings_get'),
    saveSettings: (patch) => call('settings_set')({ patch }),

    startScan: ({ root, options }) => call('scan_start')({ root, options }),
    pauseScan: call('scan_pause'),
    resumeScan: call('scan_resume'),
    cancelScan: call('scan_cancel'),
    snapshot: bytes('scan_snapshot'),
    loadScan: (id) => bytes('scan_load')({ id }),
    recent: call('scan_recent'),
    clearRecent: call('scan_clear_recent'),
    onScan: on('scan:event'),

    findDupes: ({ id, groups }) => call('dupes_find')({ id, groups }),
    onDupes: on('dupes:progress'),

    remove: ({ targets, permanent }) => call('fs_delete')({ targets, permanent }),
    onDeleteProgress: on('fs:progress'),
    stat: (path) => call('fs_stat')({ path }),
    exists: (path) => call('fs_exists')({ path }),
    show: (path) => call('shell_show')({ path }),
    open: (path) => call('shell_open')({ path }),
    openUrl: (url) => call('shell_open_url')({ url }),
    copy: (text) => call('clipboard_write')({ text }),
    pickFolder: (title) => call('dialog_folder')({ title }),

    history: call('history_list'),
    restore: (id) => call('history_restore')({ id }),
    clearHistory: call('history_clear'),

    // Files dropped on the window: { type: 'enter' | 'over' | 'drop' | 'leave', paths }.
    onFileDrop: (fn) => {
      const off = tauri.webview.getCurrentWebview().onDragDropEvent((e) => fn({ type: e.payload.type, paths: e.payload.paths || [] }));
      return () => off.then((f) => f());
    },

    updateState: call('update_state'),
    updateCheck: call('update_check'),
    updateDownload: call('update_download'),
    updateInstall: call('update_install'),
    onUpdate: on('update:state'),
  };

  // No browser menu (Reload, Inspect…) over the app; the map and the folder tree have their own.
  window.addEventListener('contextmenu', (e) => { if (!e.defaultPrevented) e.preventDefault(); });
})();
