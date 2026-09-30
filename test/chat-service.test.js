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
  await assert.rejects(missingModel.sendMessage('hello'), /LiteLLM model is required/i);

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
