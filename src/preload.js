const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: data => ipcRenderer.invoke('data:save', data),
  activityRange: keys => ipcRenderer.invoke('activity:range', keys),
  setFocus: on => ipcRenderer.invoke('focus:set', on),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  openExternal: url => ipcRenderer.invoke('open:external', url),
  github: (user, token) => ipcRenderer.invoke('github:fetch', user, token),
  warnAction: action => ipcRenderer.invoke('warn:action', action),
  repos: (user, token) => ipcRenderer.invoke('github:repos', user, token),
  checkSite: url => ipcRenderer.invoke('site:check', url),
  deploy: (full, token) => ipcRenderer.invoke('github:deploy', full, token),
  getLogin: () => ipcRenderer.invoke('login:get'),
  setLogin: on => ipcRenderer.invoke('login:set', on),
  backupRun: () => ipcRenderer.invoke('backup:run'),
  backupInfo: () => ipcRenderer.invoke('backup:info'),
  backupPick: () => ipcRenderer.invoke('backup:pick'),
  backupOpen: () => ipcRenderer.invoke('backup:open'),
  ai: prompt => ipcRenderer.invoke('ai:ask', prompt),
  on: (channel, fn) => {
    if (['quick-add', 'distraction', 'focus-stop'].includes(channel)) ipcRenderer.on(channel, (_e, ...a) => fn(...a));
  }
});
