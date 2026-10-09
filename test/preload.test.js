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
    'acknowledgeChat', 'addAssetToCanvas', 'attachProjectAsset', 'cancelMediaJob', 'checkModelCapabilities', 'clearChat', 'closeCanvas', 'codexCancelLogin', 'codexLogin', 'codexLogout', 'createCanvas', 'createProject', 'createProjectDocument',
    'deleteLibraryAsset', 'deleteMediaJob', 'deleteProject', 'deleteProjectAsset', 'deleteProjectFile', 'exportCanvas', 'exportProject', 'getAgentControl', 'getAvailableKits', 'getCurrentChat', 'getLibraryAsset', 'getMcpConnection', 'getModelCatalog', 'getProjectAsset', 'getProjectAssets', 'getProjectKits', 'getSettings', 'hideCanvasPreview',
    'listAssets', 'listCanvasFiles', 'listCanvasInputs', 'listCanvases', 'listChats', 'listInstalledSkills', 'listLiteLLMModels', 'listMediaJobs', 'listProjectDocuments', 'manageCanvasDevices',
    'onAgentEvent', 'openCanvas', 'openChat', 'openExternal', 'openProjectDocument', 'readCanvasFile', 'removeConnection', 'renameProject', 'retryCanvasInput', 'retryMediaJob',
    'saveCanvas', 'saveConnection', 'saveLibraryAsset', 'saveProjectAsset', 'saveSettings', 'selectCodexModel', 'selectModel', 'sendMessage', 'setAgentBackend', 'setCanvasBounds', 'stopAgent',
    'testLiteLLMChat', 'testLiteLLMImage', 'undoCanvas', 'updateModel', 'updateProjectKits',
    'listTemplates', 'createTemplateInstance', 'openTemplateInstance',
    'importMedia', 'openVideoEditor', 'readTimeline', 'createTimeline', 'applyTimeline', 'undoTimeline', 'redoTimeline', 'getTimelineHistory',
  ].sort());
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

test('timeline bridge methods use only named channels', async () => {
  const { exposed, calls } = runPreload();
  const client = exposed.easelClient;
  const id = 'a'.repeat(32);
  await client.readTimeline(id);
  await client.createTimeline(id, {});
  await client.applyTimeline(id, { expectedRevision: 0, operations: [] });
  await client.undoTimeline(id, { expectedRevision: 1 });
  await client.redoTimeline(id, { expectedRevision: 2 });
  await client.getTimelineHistory(id);
  assert.deepEqual(calls.map((call) => call.channel), ['timeline:read', 'timeline:create', 'timeline:apply', 'timeline:undo', 'timeline:redo', 'timeline:history']);
});

test('timeline_bridge_carries_explicit_timeline_identity', async () => {
  const { exposed, calls } = runPreload();
  const projectId = 'a'.repeat(32), timelineId = 'b'.repeat(32), input = { expectedRevision: 0, operations: [] };
  await exposed.easelClient.readTimeline(projectId, timelineId);
  await exposed.easelClient.applyTimeline(projectId, timelineId, input);
  assert.deepEqual(calls[0], { channel: 'timeline:read', args: [projectId, timelineId] });
  assert.deepEqual(calls[1], { channel: 'timeline:apply', args: [projectId, timelineId, input] });
});

test('template bridge carries only narrow catalog create and open requests', async () => {
  const { exposed, calls } = runPreload();
  const client = exposed.easelClient;
  assert.equal(typeof client.listTemplates, 'function');
  assert.equal(typeof client.createTemplateInstance, 'function');
  assert.equal(typeof client.openTemplateInstance, 'function');
  const create = { templateId: 'video-editor', target: 'current-project' };
  const open = { projectId: 'a'.repeat(32), instanceId: 'b'.repeat(32) };
  await client.listTemplates({ includePlanned: false }); await client.createTemplateInstance(create); await client.openTemplateInstance(open);
  assert.deepEqual(calls, [
    { channel: 'templates:list', args: [{ includePlanned: false }] },
    { channel: 'templates:create', args: [create] },
    { channel: 'templates:open', args: [open] },
  ]);
});
