const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('EaselHost', Object.freeze({
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
