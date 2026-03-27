const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('advisor', {
  checkApiKey: () => ipcRenderer.invoke('check-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),
  getAutoSave: () => ipcRenderer.invoke('get-auto-save'),
  selectSaveFolder: () => ipcRenderer.invoke('select-save-folder'),
  onSaveUpdated: (cb) => ipcRenderer.on('auto-save-updated', (_, data) => cb(data)),
  openSaveFile: () => ipcRenderer.invoke('open-save-file'),
  chat: (payload) => ipcRenderer.invoke('chat', payload),
});
