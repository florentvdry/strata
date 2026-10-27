// Bridge between the sandboxed UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const listen = (ch) => (fn) => {
  const h = (e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('strata', {
  appInfo: invoke('app:info'),
  relaunchAdmin: invoke('app:relaunchAdmin'),
  pendingScan: invoke('app:pendingScan'),
  drives: invoke('drives:list'),
  settings: invoke('settings:get'),
  saveSettings: invoke('settings:set'),

  startScan: invoke('scan:start'),
  pauseScan: invoke('scan:pause'),
  resumeScan: invoke('scan:resume'),
  cancelScan: invoke('scan:cancel'),
  snapshot: invoke('scan:snapshot'),
  loadScan: invoke('scan:load'),
  recent: invoke('scan:recent'),
  clearRecent: invoke('scan:clearRecent'),
  onScan: listen('scan:event'),

  findDupes: invoke('dupes:find'),
  onDupes: listen('dupes:progress'),

  remove: invoke('fs:delete'),
  onDeleteProgress: listen('fs:progress'),
  stat: invoke('fs:stat'),
  exists: invoke('fs:exists'),
  show: invoke('shell:show'),
  open: invoke('shell:open'),
  copy: invoke('clipboard:write'),
  pickFolder: invoke('dialog:folder'),
  nodeMenu: invoke('menu:node'),

  history: invoke('history:list'),
  restore: invoke('history:restore'),
  clearHistory: invoke('history:clear'),

  pathForFile: (file) => webUtils.getPathForFile(file),
});
