const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  GET_SETTINGS: 'settings:get',
  SAVE_SETTINGS: 'settings:save',
  SEND_MESSAGE: 'chat:send',
  AGENT_EVENT: 'agent:event',
});

function createBridge({ contextBridge: bridge, ipcRenderer: ipc }) {
  const api = Object.freeze({
    getSettings: () => ipc.invoke(CHANNELS.GET_SETTINGS),
    saveSettings: (settings) => ipc.invoke(CHANNELS.SAVE_SETTINGS, settings),
    sendMessage: (text) => ipc.invoke(CHANNELS.SEND_MESSAGE, text),
    onAgentEvent(callback) {
      if (typeof callback !== 'function') throw new TypeError('Event callback must be a function.');
      const listener = (_event, payload) => callback(payload);
      ipc.on(CHANNELS.AGENT_EVENT, listener);
      return () => ipc.removeListener(CHANNELS.AGENT_EVENT, listener);
    },
  });

  bridge.exposeInMainWorld('easelClient', api);
  return api;
}

createBridge({ contextBridge, ipcRenderer });

module.exports = { createBridge };
