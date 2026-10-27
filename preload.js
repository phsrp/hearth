// Bridge between the window and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, v) => fn(v));
contextBridge.exposeInMainWorld('hub', {
  get: call('library:get'),
  refresh: call('library:refresh'),
  history: call('library:history'),
  launch: call('game:launch'),
  add: call('game:add'),
  addMany: call('game:addMany'),
  update: call('game:update'),
  setPlaytime: call('game:setPlaytime'),
  remove: call('game:remove'),
  icon: call('game:icon'),
  icons: call('game:icons'),
  discordStatus: call('discord:status'),
  pathOf: (file) => webUtils.getPathForFile(file),
  inspect: call('path:inspect'),
  pickExe: call('pick:exe'),
  pickImage: call('pick:image'),
  pickFolder: call('pick:folder'),
  scanFolder: call('folder:scan'),
  show: call('shell:show'),
  url: call('shell:url'),
  setSettings: call('settings:set'),
  testApi: call('steam:testApi'),
  titlebar: call('theme:titlebar'),
  onChange: on('library:changed'),
  onTick: on('library:tick'),
  update: { get: call('update:get'), check: call('update:check'), install: call('update:install'), open: call('update:open'), onState: on('update:state') },
});
