const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('EaselHost', Object.freeze({
  submitInput: (input) => ipcRenderer.invoke('canvas:submit-input', input),
  cancelInput: (input) => ipcRenderer.invoke('canvas:cancel-input', input),
  submitMedia: (input) => ipcRenderer.invoke('canvas:submit-media', input),
}));
