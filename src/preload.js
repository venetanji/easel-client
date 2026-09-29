const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  GET_SETTINGS: 'settings:get',
  SAVE_SETTINGS: 'settings:save',
  SEND_MESSAGE: 'chat:send',
  CLEAR_CHAT: 'chat:clear',
  AGENT_EVENT: 'agent:event',
  LIST_ASSETS: 'assets:list',
  LIST_CANVASES: 'canvases:list',
  CREATE_CANVAS: 'canvases:create',
  OPEN_CANVAS: 'canvases:open',
  SAVE_CANVAS: 'canvases:save',
  EXPORT_CANVAS: 'canvases:export',
  ADD_ASSET_TO_CANVAS: 'canvas:add-asset',
  SET_CANVAS_BOUNDS: 'canvas:set-bounds',
});

function createBridge({ contextBridge: bridge, ipcRenderer: ipc }) {
  const api = Object.freeze({
    getSettings: () => ipc.invoke(CHANNELS.GET_SETTINGS),
    saveSettings: (settings) => ipc.invoke(CHANNELS.SAVE_SETTINGS, settings),
    sendMessage: (text, options) => ipc.invoke(CHANNELS.SEND_MESSAGE, text, options),
    clearChat: () => ipc.invoke(CHANNELS.CLEAR_CHAT),
    listAssets: () => ipc.invoke(CHANNELS.LIST_ASSETS),
    listCanvases: () => ipc.invoke(CHANNELS.LIST_CANVASES),
    createCanvas: (title) => ipc.invoke(CHANNELS.CREATE_CANVAS, title),
    openCanvas: (id) => ipc.invoke(CHANNELS.OPEN_CANVAS, id),
    saveCanvas: (id) => ipc.invoke(CHANNELS.SAVE_CANVAS, id),
    exportCanvas: (id) => ipc.invoke(CHANNELS.EXPORT_CANVAS, id),
    addAssetToCanvas: (id) => ipc.invoke(CHANNELS.ADD_ASSET_TO_CANVAS, id),
    setCanvasBounds: (bounds) => ipc.send(CHANNELS.SET_CANVAS_BOUNDS, bounds),
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
