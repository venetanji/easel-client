const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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
