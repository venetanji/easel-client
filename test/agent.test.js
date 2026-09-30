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
    llm: { async createCompletion({ messages, instructions }) {
      requests.push({ messages: messages.map((message) => ({ ...message })), instructions });
      return response({ role: 'assistant', content: 'Hello.' });
    } },
    mcp: { async listTools() { return mediaTools; } },
    assetStore: { async save() {}, async get() {} },
    presentCanvas: async () => {},
  });
  assert.equal(result.text, 'Hello.');
  assert.deepEqual(result.history.map((message) => message.role), ['user', 'assistant']);
  assert.equal(requests[0].messages.some((message) => message.role === 'system'), false);
  assert.match(requests[0].instructions, /^You are Easel, a creative canvas and media assistant\./);
  assert.equal(requests[0].messages[0].content, 'hello');
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
  assert.deepEqual(canvas.assets, [{ name: 'hero', assetId, data: 'YWJj', mimeType: 'image/png' }]);
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

test('returns structured errors for unknown tools and malformed arguments', async () => {
  const base = {
    userMessage: 'do it',
    history: [],
    mcp: { async listTools() { return mediaTools; }, async callTool() { assert.fail('invalid tool calls must not execute through MCP'); } },
    assetStore: { async save() {}, async get() {} },
    presentCanvas: async () => {},
  };
  for (const [invalidCall, expectedError] of [
    [toolCall('read_local_file', {}), /unknown or unavailable tool/i],
    [{ role: 'assistant', tool_calls: [{ id: 'bad', type: 'function', function: { name: 'list_models', arguments: '{' } }] }, /invalid tool arguments/i],
  ]) {
    let requests = 0;
    const result = await runAgentTurn({
      ...base,
      llm: { async createCompletion({ messages }) {
        requests += 1;
        if (requests === 1) return response(invalidCall);
        const failure = JSON.parse(messages.at(-1).content);
        assert.equal(failure.ok, false);
        assert.equal(failure.code, 'INVALID_TOOL_ARGUMENTS');
        assert.equal(failure.errorType, 'validation');
        assert.match(failure.error, expectedError);
        assert.equal(typeof failure.correction, 'string');
        assert.equal(typeof failure.example, 'object');
        return response({ role: 'assistant', content: 'I can continue with a corrected request.' });
      } },
    });
    assert.equal(requests, 2);
    assert.equal(result.text, 'I can continue with a corrected request.');
    assert.deepEqual(result.history.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(result.history[2].tool_call_id, invalidCall.tool_calls[0].id);
  }
});

test('finishes with tools disabled at the budget and preserves a resumable conversation', async () => {
  let executions = 0;
  let requests = 0;
  const result = await runAgentTurn({
    userMessage: 'Build a canvas', maxToolCalls: 2,
    llm: { async createCompletion({ messages, tools }) {
      requests += 1;
      if (!tools.length) {
        assert.match(messages.at(-1).content, /budget.*exhausted/);
        return response({ role: 'assistant', content: 'The layout is built. Continue to add audio.' });
      }
      return response({ role: 'assistant', content: null, tool_calls: [
        ...toolCall('list_models', {}, 'a').tool_calls,
        ...toolCall('list_models', {}, 'b').tool_calls,
        ...toolCall('list_models', {}, 'c').tool_calls,
      ] });
    } },
    mcp: { async listTools() { return mediaTools; }, async callTool() { executions += 1; return { content: [] }; } },
    assetStore: {},
  });
  assert.equal(executions, 2);
  assert.equal(requests, 2);
  assert.match(result.text, /Continue/);
  assert.equal(result.history.filter((m) => m.role === 'user').length, 1);
  const results = result.history.filter((m) => m.role === 'tool');
  assert.equal(results.length, 3);
  assert.match(results.at(-1).content, /not executed/);
});

test('returns JavaScript errors to the agent so it can repair the canvas in the same turn', async () => {
  let attempts = 0;
  const completions = [
    response(toolCall('execute_canvas_javascript', { code: 'broken()' }, 'a')),
    response(toolCall('execute_canvas_javascript', { code: 'return "fixed";' }, 'b')),
    response({ role: 'assistant', content: 'Canvas fixed.' }),
  ];
  const result = await runAgentTurn({
    userMessage: 'Fix the canvas',
    llm: { async createCompletion({ messages }) {
      if (attempts === 1) assert.match(messages.at(-1).content, /broken is not defined/);
      return completions.shift();
    } },
    mcp: { async listTools() { return mediaTools; } },
    canvasController: { async execute() {
      attempts += 1;
      if (attempts === 1) throw new Error('broken is not defined');
      return 'fixed';
    } },
  });
  assert.equal(attempts, 2);
  assert.equal(result.text, 'Canvas fixed.');
});

const videoTools = [
  { name: 'generate_video', inputSchema: {
    type: 'object', additionalProperties: false, required: ['model', 'prompt'], properties: {
      model: { type: 'string', enum: ['gpu:video'] }, prompt: { type: 'string' },
      seconds: { type: 'integer', minimum: 1, maximum: 60 }, inputReference: { type: 'object' },
    },
  } },
  { name: 'get_video', inputSchema: {
    type: 'object', additionalProperties: false, required: ['model', 'videoId'], properties: {
      model: { type: 'string', enum: ['gpu:video'] }, videoId: { type: 'string' },
    },
  } },
];

test('text-only video accepts omitted or null references without reading an asset', async () => {
  for (const optional of [{}, { inputReferenceAssetId: null, projectId: null }]) {
    let requests = 0;
    let calls = 0;
    await runAgentTurn({
      userMessage: 'Make a cat video',
      llm: { async createCompletion({ tools }) {
        if (requests++ === 0) {
          const schema = tools.find((tool) => tool.function.name === 'generate_video').function.parameters;
          assert.equal(schema.required.includes('inputReferenceAssetId'), false);
          return response(toolCall('generate_video', { model: 'gpu:video', prompt: 'A cat', ...optional }));
        }
        return response({ role: 'assistant', content: 'Video queued.' });
      } },
      mcp: { async listTools() { return videoTools; }, async callTool(name, args) {
        calls += 1;
        assert.equal(name, 'generate_video');
        assert.deepEqual(args, { model: 'gpu:video', prompt: 'A cat' });
        return { content: [], structuredContent: { job: { id: 'video_cat', modelId: args.model, status: 'queued' } } };
      } },
      assetStore: { async get() { assert.fail('Text-only video must not resolve a reference.'); } },
    });
    assert.equal(calls, 1);
  }
});

test('placeholder and missing video references fail locally and permit a corrected request', async () => {
  for (const [reference, expectedCode, expectedStage] of [
    ['0'.repeat(32), 'INVALID_TOOL_ARGUMENTS', 'argument_validation'],
    ['a'.repeat(32), 'INVALID_MEDIA_REFERENCE', 'reference_resolution'],
  ]) {
    let requests = 0;
    let calls = 0;
    const result = await runAgentTurn({
      userMessage: 'Make a cat video without a reference',
      llm: { async createCompletion({ messages }) {
        if (requests++ === 0) return response(toolCall('generate_video', { model: 'gpu:video', prompt: 'A cat', inputReferenceAssetId: reference }));
        if (requests === 2) {
          const failure = JSON.parse(messages.at(-1).content);
          assert.equal(calls, 0);
          assert.equal(failure.code, expectedCode);
          assert.equal(failure.errorType, 'validation');
          assert.equal(failure.requestSent, false);
          assert.equal(failure.stage, expectedStage);
          assert.match(failure.correction, /omit inputReferenceAssetId or set it to null/);
          return response(toolCall('generate_video', { model: 'gpu:video', prompt: 'A cat' }, 'corrected'));
        }
        return response({ role: 'assistant', content: 'Video queued.' });
      } },
      mcp: { async listTools() { return videoTools; }, async callTool(name, args) {
        calls += 1;
        assert.equal(name, 'generate_video');
        assert.equal(Object.hasOwn(args, 'inputReference'), false);
        return { content: [], structuredContent: { job: { id: 'video_cat', status: 'queued' } } };
      } },
      canvasController: { async readMediaAsset() { throw new Error('This media asset is not attached to the selected project.'); } },
    });
    assert.equal(calls, 1);
    assert.equal(result.text, 'Video queued.');
  }
});

test('remote video reference errors retain execution provenance', async () => {
  let requests = 0;
  await runAgentTurn({
    userMessage: 'Animate my reference',
    llm: { async createCompletion({ messages }) {
      if (requests++ === 0) return response(toolCall('generate_video', { model: 'gpu:video', prompt: 'A cat' }));
      const failure = JSON.parse(messages.at(-1).content);
      assert.equal(failure.errorType, 'execution');
      assert.notEqual(failure.requestSent, false);
      assert.doesNotMatch(failure.correction, /failed locally|API was not called/);
      assert.match(failure.error, /provider rejected/);
      return response({ role: 'assistant', content: 'The provider rejected the request.' });
    } },
    mcp: { async listTools() { return videoTools; }, async callTool() {
      return { isError: true, content: [{ type: 'text', text: 'The provider rejected the input reference.' }] };
    } },
  });
});

test('completed video is stored and attached once, then reused without binary history', async () => {
  let requests = 0;
  let calls = 0;
  let saves = 0;
  let attachments = 0;
  const events = [];
  const assetId = 'b'.repeat(32);
  const data = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]).toString('base64');
  const result = await runAgentTurn({
    userMessage: 'Retrieve my video',
    llm: { async createCompletion() {
      if (requests++ < 2) return response(toolCall('get_video', { model: 'gpu:video', videoId: 'video_cat' }, `get_${requests}`));
      return response({ role: 'assistant', content: 'Video ready.' });
    } },
    mcp: { async listTools() { return videoTools; }, async callTool() {
      calls += 1;
      return { content: [{ type: 'resource', resource: { uri: 'easel-media://videos/video_cat', mimeType: 'video/mp4', blob: data } }],
        structuredContent: { job: { id: 'video_cat', modelId: 'gpu:video', status: 'completed', seconds: 4 } } };
    } },
    mediaAssetStore: { async save(media) {
      saves += 1;
      assert.equal(media.data, data);
      assert.equal(media.duration, 4);
      return assetId;
    }, async get(id) { assert.equal(id, assetId); return { data, mimeType: 'video/mp4' }; } },
    canvasController: { getCurrentCanvasId() { return 'c'.repeat(32); }, async attachGeneratedAssets(input) {
      attachments += 1;
      assert.deepEqual(input.assetIds, [assetId]);
      return { projectId: input.projectId };
    } },
    onEvent(event) { events.push(event); },
  });
  assert.equal(calls, 1);
  assert.equal(saves, 1);
  assert.equal(attachments, 1);
  assert.ok(events.some((event) => event.type === 'media' && event.assetId === assetId && event.attachedToProject));
  assert.equal(JSON.stringify(result.history).includes(data), false);
  const results = result.history.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
  assert.equal(results[1].cached, true);
  assert.deepEqual(results[1].assets, results[0].assets);
});
