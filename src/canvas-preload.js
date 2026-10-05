const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('EaselHost', Object.freeze({
  strudelExport: (input) => ipcRenderer.invoke('canvas:strudel-export', input),
  onStrudelExportContext(callback) {
    if (typeof callback !== 'function') throw new TypeError('Strudel export context listener must be a function.');
    const listener = (_event, input) => callback(input);
    ipcRenderer.on('canvas:strudel-export-context', listener);
    return () => ipcRenderer.removeListener('canvas:strudel-export-context', listener);
  },
  timeline: (input) => ipcRenderer.invoke('canvas:timeline', input),
  onTimelineChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('Timeline listener must be a function.');
    const listener = (_event, input) => callback(input);
    ipcRenderer.on('canvas:timeline-changed', listener);
    return () => ipcRenderer.removeListener('canvas:timeline-changed', listener);
  },
  submitInput: (input) => ipcRenderer.invoke('canvas:submit-input', input),
  cancelInput: (input) => ipcRenderer.invoke('canvas:cancel-input', input),
  submitMedia: (input) => ipcRenderer.invoke('canvas:submit-media', input),
}));
