const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function runPreload() {
  const exposed = {};
  const calls = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke(channel, ...args) { calls.push({ channel, args }); return Promise.resolve({}); },
    send(channel, ...args) { calls.push({ channel, args }); },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel) { listeners.delete(channel); },
  };
  const contextBridge = {
    exposeInMainWorld(name, api) { exposed[name] = api; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, {
    require(id) {
      if (id === 'electron') return { contextBridge, ipcRenderer };
      if (id === './easel-api') return {};
      throw new Error(`unexpected require: ${id}`);
    },
    module,
    Object,
  });
  return { exposed, calls, listeners, ipcRenderer, contextBridge };
}

test('preload exposes a narrow frozen API without secret getters', async () => {
  const { exposed, calls, listeners, ipcRenderer } = runPreload();
  const api = exposed.easelClient;

  assert.deepEqual(Object.keys(api).sort(), [
    'addAssetToCanvas', 'clearChat', 'createCanvas', 'exportCanvas', 'getSettings', 'listAssets', 'listCanvases',
    'onAgentEvent', 'openCanvas', 'saveCanvas', 'saveSettings', 'sendMessage', 'setCanvasBounds',
  ]);
  assert.equal(Object.isFrozen(api), true);
  await api.getSettings();
  await api.saveSettings({ easelApiKey: 'entered-once' });
  await api.sendMessage('generate a still life');
  await api.clearChat();
  await api.listAssets();
  await api.listCanvases();
  await api.createCanvas('New board');
  await api.openCanvas('a'.repeat(32));
  await api.saveCanvas('a'.repeat(32));
  await api.exportCanvas('a'.repeat(32));
  await api.addAssetToCanvas('b'.repeat(32));
  api.setCanvasBounds({ x: 0, y: 0, width: 640, height: 480 });
  assert.deepEqual(calls.map((call) => call.channel), [
    'settings:get', 'settings:save', 'chat:send', 'chat:clear', 'assets:list', 'canvases:list', 'canvases:create',
    'canvases:open', 'canvases:save', 'canvases:export', 'canvas:add-asset', 'canvas:set-bounds',
  ]);
  const unsubscribe = api.onAgentEvent(() => {});
  assert.equal(listeners.size, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
  assert.equal(typeof ipcRenderer.invoke, 'function');
});
