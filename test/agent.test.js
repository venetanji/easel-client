const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentTurn, PRESENT_CANVAS_TOOL } = require('../src/agent');

function response(message) {
  return { choices: [{ message }] };
}

function toolCall(name, args, id = 'call_1') {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

const mediaTools = [
  { name: 'list_models', description: 'List models', inputSchema: { type: 'object', properties: {} } },
  { name: 'generate_image', description: 'Generate image', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } },
  { name: 'capture_canvas_screenshot', description: 'Render offline canvas', inputSchema: { type: 'object', properties: { html: { type: 'string' } } } },
  { name: 'read_local_file', description: 'Unsafe', inputSchema: { type: 'object', properties: {} } },
];

test('returns normal assistant replies and retains session history', async () => {
  const result = await runAgentTurn({
    userMessage: 'hello',
    history: [],
    llm: { async createCompletion() { return response({ role: 'assistant', content: 'Hello.' }); } },
    mcp: { async listTools() { return mediaTools; } },
    assetStore: { async save() {}, async get() {} },
    presentCanvas: async () => {},
  });
  assert.equal(result.text, 'Hello.');
  assert.deepEqual(result.history.map((message) => message.role), ['user', 'assistant']);
});

test('routes image calls through the MCP allowlist and stores local image content', async () => {
  const calls = [];
  const events = [];
  const completions = [
    response(toolCall('generate_image', { prompt: 'a red chair' })),
    response({ role: 'assistant', content: 'Here is the image.' }),
  ];
  const result = await runAgentTurn({
    userMessage: 'make a chair',
    history: [],
    llm: { async createCompletion(options) { calls.push(options); return completions.shift(); } },
    mcp: {
      async listTools() { return mediaTools; },
      async callTool(name, args) {
        calls.push([name, args]);
        return { content: [
          { type: 'text', text: 'Generated 1 image.' },
          { type: 'image', data: 'YWJj', mimeType: 'image/png' },
        ] };
      },
    },
    assetStore: {
      async save(image) { assert.equal(image.data, 'YWJj'); return 'asset-1'; },
      async get() { throw new Error('not used'); },
    },
    presentCanvas: async () => {},
    onEvent(event) { events.push(event); },
  });
  assert.equal(result.text, 'Here is the image.');
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'generate_image'));
  assert.equal(events.some((event) => event.type === 'image' && event.assetId === 'asset-1'), true);
  assert.equal(calls[0].tools.some((tool) => tool.function.name === 'read_local_file'), false);
});

test('renders an agent-authored canvas using only saved image asset IDs', async () => {
  let canvas;
  const completions = [
    response(toolCall('present_canvas', {
      title: 'Composition',
      html: '<h1>Local collage</h1><img src="{{asset:hero}}">',
      assets: [{ name: 'hero', assetId: 'asset-1' }],
    })),
    response({ role: 'assistant', content: 'I made a local composition.' }),
  ];
  await runAgentTurn({
    userMessage: 'make a canvas',
    history: [],
    llm: { async createCompletion() { return completions.shift(); } },
    mcp: { async listTools() { return mediaTools; } },
    assetStore: { async save() {}, async get(id) { return { id, data: 'YWJj', mimeType: 'image/png' }; } },
    presentCanvas: async (value) => { canvas = value; },
  });
  assert.equal(canvas.title, 'Composition');
  assert.deepEqual(canvas.assets, [{ name: 'hero', data: 'YWJj', mimeType: 'image/png' }]);
  assert.equal(PRESENT_CANVAS_TOOL.function.name, 'present_canvas');
});

test('rejects unknown tools, malformed arguments, and calls beyond the per-turn cap', async () => {
  const base = {
    userMessage: 'do it',
    history: [],
    mcp: { async listTools() { return mediaTools; }, async callTool() { return { content: [] }; } },
    assetStore: { async save() {}, async get() {} },
    presentCanvas: async () => {},
  };
  await assert.rejects(runAgentTurn({
    ...base,
    llm: { async createCompletion() { return response(toolCall('read_local_file', {})); } },
  }), /unknown or disallowed tool/i);
  await assert.rejects(runAgentTurn({
    ...base,
    llm: { async createCompletion() { return response({
      role: 'assistant',
      tool_calls: [{ id: 'bad', type: 'function', function: { name: 'list_models', arguments: '{' } }],
    }); } },
  }), /invalid tool arguments/i);
  let count = 0;
  await assert.rejects(runAgentTurn({
    ...base,
    maxToolCalls: 3,
    llm: { async createCompletion() { count += 1; return response(toolCall('list_models', {}, `call_${count}`)); } },
  }), /tool limit/i);
  assert.equal(count, 4);
});
