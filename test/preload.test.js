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

test('preload exposes a narrow frozen API with an explicit MCP connection action', async () => {
  const { exposed, calls, listeners, ipcRenderer } = runPreload();
  const api = exposed.easelClient;

  assert.deepEqual(Object.keys(api).sort(), [
    'acknowledgeChat', 'addAssetToCanvas', 'attachProjectAsset', 'checkModelCapabilities', 'clearChat', 'closeCanvas', 'codexCancelLogin', 'codexLogin', 'codexLogout', 'createCanvas', 'createProject', 'createProjectDocument',
    'deleteLibraryAsset', 'deleteMediaJob', 'deleteProject', 'deleteProjectAsset', 'deleteProjectFile', 'exportCanvas', 'exportProject', 'getAgentControl', 'getAvailableKits', 'getCurrentChat', 'getLibraryAsset', 'getMcpConnection', 'getModelCatalog', 'getProjectAsset', 'getProjectAssets', 'getProjectKits', 'getSettings', 'hideCanvasPreview',
    'listAssets', 'listCanvasFiles', 'listCanvasInputs', 'listCanvases', 'listChats', 'listInstalledSkills', 'listLiteLLMModels', 'listMediaJobs', 'listProjectDocuments', 'manageCanvasDevices',
    'onAgentEvent', 'openCanvas', 'openChat', 'openExternal', 'openProjectDocument', 'readCanvasFile', 'removeConnection', 'renameProject', 'retryCanvasInput', 'retryMediaJob',
    'saveCanvas', 'saveConnection', 'saveLibraryAsset', 'saveProjectAsset', 'saveSettings', 'selectCodexModel', 'selectModel', 'sendMessage', 'setAgentBackend', 'setCanvasBounds', 'stopAgent',
    'testLiteLLMChat', 'testLiteLLMImage', 'undoCanvas', 'updateModel', 'updateProjectKits',
  ]);
  assert.equal(Object.isFrozen(api), true);
  await api.getSettings();
  await api.listLiteLLMModels();
  await api.testLiteLLMChat('model-a');
  await api.testLiteLLMImage('model-a');
  await api.undoCanvas('c'.repeat(32));
  await api.saveSettings({ easelApiKey: 'entered-once' });
  await api.sendMessage('generate a still life');
  await api.stopAgent();
  await api.clearChat();
  await api.listAssets();
  await api.listCanvases();
  await api.createCanvas('New board', ['canvas-2d', 'tone', 'p5']);
  await api.openCanvas('a'.repeat(32));
  await api.saveCanvas('a'.repeat(32));
  await api.exportCanvas('a'.repeat(32));
  await api.addAssetToCanvas('b'.repeat(32));
  api.setCanvasBounds({ x: 0, y: 0, width: 640, height: 480 });
  assert.deepEqual(calls.map((call) => call.channel), [
    'settings:get', 'litellm:models:list', 'litellm:probe:chat', 'litellm:probe:image', 'canvas:undo', 'settings:save', 'chat:send', 'chat:stop', 'chat:clear', 'assets:list', 'canvases:list', 'canvases:create',
    'canvases:open', 'canvases:save', 'canvases:export', 'canvas:add-asset', 'canvas:set-bounds',
  ]);
  assert.deepEqual(calls.slice(1, 5).map((call) => call.args), [[], ['model-a'], ['model-a'], ['c'.repeat(32)]]);
  assert.deepEqual(calls.find((call) => call.channel === 'canvases:create').args, ['New board', ['canvas-2d', 'tone', 'p5']]);
  const unsubscribe = api.onAgentEvent(() => {});
  assert.equal(listeners.size, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
  assert.equal(typeof ipcRenderer.invoke, 'function');
});

test('agent controls invoke only their declared trusted IPC channels', async () => {
  const { exposed, calls } = runPreload();
  const client = exposed.easelClient;
  await client.getAgentControl();
  await client.setAgentBackend('external');
  await client.getMcpConnection();
  await client.codexLogin({ type: 'chatgptDeviceCode' });
  await client.codexCancelLogin('pending-login');
  await client.codexLogout();
  await client.selectCodexModel('model-a');
  assert.deepEqual(calls, [
    { channel: 'agent:control:get', args: [] }, { channel: 'agent:control:select', args: ['external'] },
    { channel: 'agent:mcp:connection', args: [] }, { channel: 'agent:codex:login', args: [{ type: 'chatgptDeviceCode' }] },
    { channel: 'agent:codex:login:cancel', args: ['pending-login'] }, { channel: 'agent:codex:logout', args: [] },
    { channel: 'agent:codex:model', args: ['model-a'] },
  ]);
});
