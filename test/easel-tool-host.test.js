const test = require('node:test');
const assert = require('node:assert/strict');
const { createEaselToolHost } = require('../src/easel-tool-host');

const projectId = 'a'.repeat(32);
const assetId = 'b'.repeat(32);
const tools = ['generate_image', 'generate_video', 'get_video', 'list_models'].map((name) => ({ name, inputSchema: { type: 'object', additionalProperties: false, properties: { prompt: { type: 'string' }, model: { type: 'string' }, videoId: { type: 'string' } } } }));

function fixture(overrides = {}) {
  const receipts = [];
  const saved = [];
  const attached = [];
  const events = [];
  const calls = [];
  let response = { content: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }] };
  const mediaClient = {
    async listTools() { return tools; },
    async callTool(name, args, options) { calls.push({ name, args, options }); return response; },
    async close() {},
  };
  const canvasController = { getCurrentCanvasId: () => projectId, async attachGeneratedAssets(args) { attached.push(args); return { projectId: args.projectId }; } };
  const host = createEaselToolHost({ canvasController,
    assetStore: { async save(asset) { saved.push(asset); return assetId; } },
    createMediaClient: async () => mediaClient, getKits: () => ['canvas-2d', 'tone'],
    getOrigin: () => ({ chatId: 'chat', origin: { backend: 'external', chatId: 'chat' }, turnOptions: { option: 'retained' } }),
    registerMediaJob: async (input) => { receipts.push(input); return { id: 'local-job', ...input }; },
    workspace: { list: async () => ({ projects: [] }) }, onEvent: (event) => events.push(event), ...overrides,
  });
  return { host, mediaClient, canvasController, receipts, saved, attached, events, calls, setResponse(value) { response = value; } };
}

test('shares the tool allowlist and validates requests before dispatch', async () => {
  const f = fixture();
  const descriptors = await f.host.listTools();
  assert.ok(descriptors.some((tool) => tool.name === 'open_project'));
  assert.ok(descriptors.some((tool) => tool.name === 'request_canvas_input'));
  const invalid = await f.host.callTool('generate_image', { prompt: 'test', unexpected: true });
  assert.equal(invalid.isError, true);
  assert.equal(f.calls.length, 0);
  assert.match(invalid.content[0].text, /unsupported|unexpected|not allowed/i);
});

test('saves and attaches synchronous images once and returns one image observation', async () => {
  const f = fixture();
  const result = await f.host.callTool('generate_image', { prompt: 'light study' });
  assert.equal(f.saved.length, 1);
  assert.equal(f.attached.length, 1);
  assert.equal(f.events.filter((event) => event.type === 'image').length, 1);
  assert.equal(result.content.filter((item) => item.type === 'image').length, 1);
  assert.equal(result.structuredContent.assets.length, 1);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.host.isBusy(), false);
  assert.ok(f.events.some((event) => event.type === 'control-settled'));
});

test('registers queued video once with the accepted project and origin', async () => {
  const f = fixture();
  f.setResponse({ content: [], structuredContent: { job: { id: 'remote-video', status: 'queued', modelId: 'video-model' } } });
  const result = await f.host.callTool('generate_video', { prompt: 'moving light', model: 'video-model' });
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].mediaType, 'video');
  assert.equal(f.receipts[0].projectId, projectId);
  assert.equal(f.receipts[0].origin.backend, 'external');
  assert.equal(f.receipts[0].turnOptions.option, 'retained');
  assert.deepEqual(f.receipts[0].turnOptions.kits, ['canvas-2d', 'tone']);
  assert.equal(result.structuredContent.monitoredJob.id, 'local-job');
});

test('queued jobs return compact host monitoring guidance without nested standalone polling prose', async () => {
  const f = fixture();
  const job = { id: 'remote-video', status: 'queued', modelId: 'video-model' };
  f.setResponse({ content: [{ type: 'text', text: JSON.stringify({ job, guidance: 'Retrieve with get_video later.' }) }], structuredContent: { job } });
  const result = await f.host.callTool('generate_video', { prompt: 'moving light', model: 'video-model' });
  assert.deepEqual(result.structuredContent.job, job);
  assert.deepEqual(result.structuredContent.text, []);
  assert.equal(result.structuredContent.monitoredJob.id, 'local-job');
  assert.equal(result.structuredContent.monitoredJob.origin, undefined);
  assert.equal(result.structuredContent.monitoredJob.turnOptions, undefined);
  assert.match(result.structuredContent.guidance, /End the turn; do not poll, retrieve, or resubmit/);
  assert.doesNotMatch(JSON.stringify(result), /Retrieve with get_video later/);
  assert.ok(JSON.stringify(result).length < 1500);
});

test('synchronous generation preserves provider notes once without serializing them inside more JSON', async () => {
  const f = fixture();
  f.setResponse({ content: [{ type: 'text', text: 'Provider note.' }, { type: 'image', data: 'YWJj', mimeType: 'image/png' }] });
  const result = await f.host.callTool('generate_image', { prompt: 'light study' });
  assert.deepEqual(result.structuredContent.text, ['Provider note.']);
  assert.equal(f.saved.length, 1);
  assert.equal(f.attached.length, 1);
});

test('canceled queued video submission retains its detached receipt and remains busy until saved', async () => {
  const f = fixture(); await f.host.listTools();
  let respond;
  f.mediaClient.callTool = async (...args) => { f.calls.push(args); return new Promise((resolve) => { respond = resolve; }); };
  const abort = new AbortController();
  const call = f.host.callTool('generate_video', { prompt: 'moving light', model: 'video-model' }, { signal: abort.signal });
  const canceled = assert.rejects(call, { name: 'AbortError' });
  await new Promise(setImmediate);
  abort.abort(); await canceled;
  assert.equal(f.host.isBusy(), true);
  assert.equal(f.calls[0][2], undefined);
  f.canvasController.getCurrentCanvasId = () => 'c'.repeat(32);
  respond({ content: [], structuredContent: { job: { id: 'remote-video', status: 'queued' } } });
  await f.host.shutdown();
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].projectId, projectId);
  assert.equal(f.receipts[0].origin.backend, 'external');
  assert.equal(f.host.isBusy(), false);
});

test('canceled synchronous images still save once, and completed video output is not monitored again', async () => {
  const f = fixture(); await f.host.listTools();
  let respond;
  f.mediaClient.callTool = () => new Promise((resolve) => { respond = resolve; });
  const abort = new AbortController();
  const call = f.host.callTool('generate_image', { prompt: 'light' }, { signal: abort.signal });
  const canceled = assert.rejects(call, { name: 'AbortError' });
  await new Promise(setImmediate); abort.abort(); await canceled;
  respond({ content: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }] });
  await f.host.shutdown();
  assert.equal(f.saved.length, 1); assert.equal(f.attached.length, 1);
  const video = fixture();
  video.setResponse({ content: [{ type: 'resource', resource: { blob: 'YWJj', mimeType: 'video/mp4' } }], structuredContent: { job: { id: 'video', status: 'completed', modelId: 'model' } } });
  const result = await video.host.callTool('get_video', { videoId: 'video', model: 'model' });
  assert.equal(video.receipts.length, 0);
  assert.equal(video.saved.length, 1); assert.equal(video.attached.length, 1);
  assert.equal(result.structuredContent.assets[0].mimeType, 'video/mp4');
});

test('failed terminal jobs are not registered and close failures retain successful receipts', async () => {
  const f = fixture();
  f.setResponse({ content: [], structuredContent: { job: { id: 'bad', status: 'failed', error: 'Service failed' } } });
  const failed = await f.host.callTool('generate_video', { model: 'model' });
  assert.equal(failed.isError, true); assert.equal(f.receipts.length, 0);
  f.setResponse({ content: [], structuredContent: { job: { id: 'good', status: 'queued' } } });
  f.mediaClient.close = async () => { throw new Error('close failed'); };
  const accepted = await f.host.callTool('generate_video', { model: 'model' });
  assert.equal(accepted.isError, undefined);
  assert.equal(f.receipts.length, 1);
  assert.equal(accepted.structuredContent.monitoredJob.id, 'local-job');
});

test('a failed local receipt save preserves the accepted remote ID and forbids resubmission', async () => {
  const f = fixture({ registerMediaJob: async () => { throw new Error('Disk full'); } });
  f.setResponse({ content: [], structuredContent: { job: { id: 'accepted-remote', status: 'queued' } } });
  const result = await f.host.callTool('generate_video', { model: 'video-model' });
  assert.equal(result.isError, true);
  const error = JSON.parse(result.content[0].text);
  assert.equal(error.code, 'MEDIA_RECEIPT_SAVE_FAILED');
  assert.equal(error.acceptedJob.remoteId, 'accepted-remote');
  assert.match(error.error, /Do not resubmit/);
  assert.ok(f.events.some((event) => event.type === 'error' && event.message.includes('accepted-remote')));
  assert.equal(f.calls.length, 1);
  assert.equal(f.host.isBusy(), false);
});

test('caches tool discovery across calls, shares the first request, and invalidates on configuration and restart', async () => {
  let discoveries = 0;
  let clients = 0;
  let finish;
  const f = fixture({ createMediaClient: async () => {
    clients += 1;
    return { listTools: async () => { discoveries += 1; return new Promise((resolve) => { finish = resolve; }); }, callTool: async () => ({ content: [] }), close: async () => {} };
  } });
  const first = f.host.listTools(); const concurrent = f.host.listTools();
  await new Promise(setImmediate);
  assert.equal(discoveries, 1); assert.equal(clients, 1);
  finish(tools); await first; await concurrent;
  await f.host.listTools(); await f.host.callTool('list_models'); await f.host.listTools();
  assert.equal(discoveries, 1);
  assert.equal(clients, 2);
  f.host.invalidateTools();
  const refreshed = f.host.listTools(); await new Promise(setImmediate); finish(tools); await refreshed;
  assert.equal(discoveries, 2);
  await f.host.shutdown(); f.host.cancelShutdown();
  const restarted = f.host.listTools(); await new Promise(setImmediate); finish(tools); await restarted;
  assert.equal(discoveries, 3);
});
