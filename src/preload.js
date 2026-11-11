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
  setCar: on => ipcRenderer.invoke('car:set', on),
  ai: prompt => ipcRenderer.invoke('ai:ask', prompt),
  on: (channel, fn) => {
    if (['quick-add', 'distraction', 'focus-stop', 'car-changed'].includes(channel)) ipcRenderer.on(channel, (_e, ...a) => fn(...a));
  }
});
