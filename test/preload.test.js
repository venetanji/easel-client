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

  assert.deepEqual(Object.keys(api).sort(), ['getSettings', 'onAgentEvent', 'saveSettings', 'sendMessage']);
  assert.equal(Object.isFrozen(api), true);
  await api.getSettings();
  await api.saveSettings({ easelApiKey: 'entered-once' });
  await api.sendMessage('generate a still life');
  assert.deepEqual(calls.map((call) => call.channel), [
    'settings:get', 'settings:save', 'chat:send',
  ]);
  const unsubscribe = api.onAgentEvent(() => {});
  assert.equal(listeners.size, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
  assert.equal(typeof ipcRenderer.invoke, 'function');
});
