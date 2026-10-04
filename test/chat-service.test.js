const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createChatStore } = require('../src/chat-store');
const { createChatService, defaultMcpLaunchOptions } = require('../src/chat-service');

function reply(text) {
  return { choices: [{ message: { role: 'assistant', content: text } }] };
}

function settingsStore(model = 'design-model') {
  return {
    loadPublic: () => ({
      easelBaseUrl: 'https://easel.ait4x.org',
      litellmBaseUrl: 'http://127.0.0.1:4000/v1',
      litellmModel: model,
    }),
    loadSecrets: () => ({ easelApiKey: 'easel-key', litellmApiKey: 'llm-key' }),
  };
}

test('uses a physical working directory for the packaged MCP process', () => {
  const resourcesPath = path.resolve('test-resources');
  const options = defaultMcpLaunchOptions(
    { easelBaseUrl: 'https://easel.ait4x.org' },
    { easelApiKey: 'easel-key' },
    { isPackaged: true, resourcesPath },
  );

  assert.equal(options.cwd, resourcesPath);
  assert.equal(options.args[0], path.join(resourcesPath, 'app.asar.unpacked', 'packages', 'media-mcp', 'dist', 'cli.js'));
  assert.equal(options.env.NODE_PATH, path.join(resourcesPath, 'app.asar.unpacked', 'node_modules'));
});

test('polling model configurations include a name without a discovered catalog entry', () => {
  const connectionId = 'c'.repeat(32);
  const launch = defaultMcpLaunchOptions({
    connections: [{ id: connectionId, name: 'Local GPU', baseUrl: 'http://localhost:8000/v1' }],
    models: [{ connectionId, model: 'ltx-2.5', enabled: true, roles: ['media'], mediaTypes: ['video'] }],
  }, { connectionKeys: { [connectionId]: '' } });
  const [model] = JSON.parse(launch.env.EASEL_MEDIA_MODELS);
  assert.equal(model.name, 'ltx-2.5');
  assert.equal(model.id, connectionId + ':ltx-2.5');
});

test('loads secrets only in main, keeps session history, and closes the MCP process', async () => {
  const completions = [];
  const mcpOptions = [];
  let closeCount = 0;
  const service = createChatService({
    settingsStore: settingsStore(),
    assetStore: {},
    llmFactory: (config) => {
      assert.equal(config.apiKey, 'llm-key');
      return { async createCompletion({ messages }) { completions.push(messages); return reply(`turn-${completions.length}`); } };
    },
    mcpFactory: async (options) => {
      mcpOptions.push(options);
      return { async listTools() { return []; }, async close() { closeCount += 1; } };
    },
    mcpLaunchOptions: (_publicSettings, secrets) => ({
      command: 'node',
      args: ['dist/cli.js'],
      env: { EASEL_BASE_URL: 'https://easel.ait4x.org', EASEL_API_KEY: secrets.easelApiKey },
    }),
    presentCanvas: async () => {},
  });

  assert.equal((await service.sendMessage('first')).text, 'turn-1');
  assert.equal((await service.sendMessage('second')).text, 'turn-2');
  assert.equal(completions[1].some((message) => message.role === 'assistant' && message.content === 'turn-1'), true);
  assert.equal(mcpOptions[0].env.EASEL_API_KEY, 'easel-key');
  assert.equal(closeCount, 2);
});

test('requires a configured LiteLLM model and still closes MCP on agent errors', async () => {
  const missingModel = createChatService({ settingsStore: settingsStore('') });
  await assert.rejects(missingModel.sendMessage('hello'), /Choose a model in chat before sending/i);

  let closed = false;
  const service = createChatService({
    settingsStore: settingsStore(),
    llmFactory: () => ({ async createCompletion() { throw new Error('proxy failed'); } }),
    mcpFactory: async () => ({ async listTools() { return []; }, async close() { closed = true; } }),
    mcpLaunchOptions: () => ({ command: 'node', args: [], env: {} }),
  });
  await assert.rejects(service.sendMessage('hello'), /proxy failed/);
  assert.equal(closed, true);
});

test('restores saved chat context and reopens archived chats after starting a new chat', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-chat-service-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const requests = [];
  const createService = () => createChatService({
    chatStore: createChatStore({ userDataPath }), settingsStore: settingsStore(), assetStore: {},
    llmFactory: () => ({ async createCompletion({ messages }) { requests.push(messages); return reply('Instrument ready.'); } }),
    mcpFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    mcpLaunchOptions: () => ({ command: 'node' }),
  });
  const first = createService();
  const sent = await first.sendMessage('Build an instrument');
  const second = createService();
  assert.equal((await second.getCurrentChat()).id, sent.chatId);
  await second.sendMessage('Add bass');
  assert.ok(requests[1].some((m) => m.role === 'assistant' && m.content === 'Instrument ready.'));
  second.clearHistory();
  assert.equal((await second.getCurrentChat()).history.length, 0);
  assert.equal(second.listChats().length, 1);
  assert.equal((await second.openChat(sent.chatId)).history.length, 4);
});

test('keeps unsaved chat context and prevents losing it when disk writes fail', async () => {
  const service = createChatService({
    chatStore: { getActive: () => null, save() { throw new Error('Disk full'); } },
    settingsStore: settingsStore(), assetStore: {},
    llmFactory: () => ({ async createCompletion() { return reply('Ready.'); } }),
    mcpFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    mcpLaunchOptions: () => ({ command: 'node' }),
  });
  const result = await service.sendMessage('Build a canvas');
  assert.match(result.saveWarning, /could not be saved/);
  assert.throws(() => service.clearHistory(), /Disk full/);
  assert.equal((await service.getCurrentChat()).history.length, 2);
});

test('completed video notifications expose compact previews and reopen chats without loading video bytes', async () => {
  const assetId = 'a'.repeat(32);
  const chatId = 'b'.repeat(32);
  const projectId = 'c'.repeat(32);
  const poster = 'data:image/jpeg;base64,cG9zdGVy';
  const events = [];
  const job = { id: 'd'.repeat(32), chatId, projectId, name: 'A cat in the rain', mediaType: 'video', assets: [{ assetId, mimeType: 'video/mp4' }] };
  const service = createChatService({
    settingsStore: settingsStore(),
    chatStore: { getActive: () => ({ id: chatId, title: 'Cat', history: [
      { role: 'user', content: 'Make a cat video' },
      { role: 'user', content: 'Completed', mediaJobId: job.id, mediaJobResult: { projectId, assets: job.assets } },
    ] }) },
    mediaAssetStore: {
      getMetadata: async (id) => ({ id, mimeType: 'video/mp4', name: 'Cat in the rain.mp4', thumbnail: poster, duration: 3 }),
      get() { throw new Error('Video bytes should remain lazy.'); },
    },
    onEvent: (event) => events.push(event),
  });
  await service.notifyMediaJob(job);
  assert.equal(events[0].assets[0].thumbnail, poster);
  assert.equal(events[0].projectId, projectId);
  assert.equal(events[0].jobId, job.id);
  assert.equal(events[0].assets[0].data, undefined);
  const restored = await service.getCurrentChat();
  assert.equal(restored.history[0].content, 'Make a cat video');
  assert.equal(restored.media[0].thumbnail, poster);
  assert.equal(restored.media[0].generated, true);
  assert.equal(restored.media[0].projectId, projectId);
  assert.equal(restored.media[0].data, undefined);
});

test('host timeline context is attached to one submitted user turn and not automatic later turns', async () => {
  const requests = [];
  const service = createChatService({ settingsStore: settingsStore(), assetStore: {},
    llmFactory: () => ({ async createCompletion({ messages }) { requests.push(messages); return reply('Timeline inspected.'); } }),
    mcpFactory: async () => ({ async listTools() { return []; }, async close() {} }), mcpLaunchOptions: () => ({ command: 'node' }),
  });
  await service.sendMessage('Trim this selection', { timelineContext: { selection: { projectId: 'a'.repeat(32), startFrame: 5, endFrame: 12 }, items: [] } });
  assert.match(requests[0].find((message) => message.role === 'user').content, /"startFrame":5/);
  await service.sendMessage('What next?');
  assert.equal(requests[1].filter((message) => message.role === 'user').at(-1).content, 'What next?');
});
