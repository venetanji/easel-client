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
  const requests = [];
  const result = await runAgentTurn({
    userMessage: 'hello',
    history: [],
    llm: { async createCompletion({ messages }) {
      requests.push(messages.map((message) => ({ ...message })));
      return response({ role: 'assistant', content: 'Hello.' });
    } },
    mcp: { async listTools() { return mediaTools; } },
    assetStore: { async save() {}, async get() {} },
    presentCanvas: async () => {},
  });
  assert.equal(result.text, 'Hello.');
  assert.deepEqual(result.history.map((message) => message.role), ['user', 'assistant']);
  assert.equal(requests[0].some((message) => message.role === 'system'), false);
  assert.match(requests[0][0].content, /^You are Easel, a creative image assistant\./);
  assert.equal(result.history[0].content, 'hello');
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
  const assetId = 'a'.repeat(32);
  const completions = [
    response(toolCall('present_canvas', {
      title: 'Composition',
      html: `<h1>Local collage</h1><img src="asset://${assetId}">`,
      assets: [{ name: 'hero', assetId }],
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
  assert.equal(canvas.html, '<h1>Local collage</h1><img src="{{asset:hero}}">');
  assert.deepEqual(canvas.assets, [{ name: 'hero', data: 'YWJj', mimeType: 'image/png' }]);
  assert.equal(PRESENT_CANVAS_TOOL.function.name, 'present_canvas');
});

test('routes canvas inspection, JavaScript, and media insertion to canvas-scoped controls', async () => {
  const operations = [];
  const completions = [
    response(toolCall('inspect_canvas', {})),
    response(toolCall('add_image_to_canvas', { assetId: 'a'.repeat(32) }, 'call_2')),
    response(toolCall('execute_canvas_javascript', { code: 'document.title' }, 'call_3')),
    response({ role: 'assistant', content: 'Canvas updated.' }),
  ];
  const result = await runAgentTurn({
    userMessage: 'Add the media image, then check the canvas.',
    history: [],
    llm: { async createCompletion(options) {
      assert.ok(options.tools.some((tool) => tool.function.name === 'inspect_canvas'));
      assert.ok(options.tools.some((tool) => tool.function.name === 'execute_canvas_javascript'));
      assert.ok(options.tools.some((tool) => tool.function.name === 'add_image_to_canvas'));
      return completions.shift();
    } },
    mcp: { async listTools() { return mediaTools; }, async callTool() { assert.fail('canvas tools must not go to MCP'); } },
    canvasController: {
      async inspect() { operations.push(['inspect']); return '{"title":"Canvas"}'; },
      async addImage(input) { operations.push(['add-image', input.assetId]); return '{"assetId":"a"}'; },
      async execute(code) { operations.push(['execute', code]); return '"Canvas"'; },
    },
    assetStore: { async save() {}, async get() {} },
  });
  assert.equal(result.text, 'Canvas updated.');
  assert.deepEqual(operations, [
    ['inspect'],
    ['add-image', 'a'.repeat(32)],
    ['execute', 'document.title'],
  ]);
});

test('creates a named preset canvas through the host controller tool', async () => {
  let createdTitle;
  const events = [];
  const completions = [
    response(toolCall('create_canvas', { title: 'Image study' })),
    response({ role: 'assistant', content: 'Created the image study canvas.' }),
  ];
  const result = await runAgentTurn({
    userMessage: 'Create an empty canvas named Image study.',
    history: [],
    llm: { async createCompletion({ tools }) {
      assert.ok(tools.some((tool) => tool.function.name === 'create_canvas'));
      return completions.shift();
    } },
    mcp: { async listTools() { return mediaTools; } },
    canvasController: { async createEmpty(title) { createdTitle = title; return { id: 'd'.repeat(32), title }; } },
    assetStore: { async save() {}, async get() {} },
    onEvent(event) { events.push(event); },
  });
  assert.equal(result.text, 'Created the image study canvas.');
  assert.equal(createdTitle, 'Image study');
  assert.ok(events.some((event) => event.type === 'canvas' && event.canvasId === 'd'.repeat(32)));
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
