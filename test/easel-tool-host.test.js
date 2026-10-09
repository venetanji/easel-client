const test = require('node:test');
const assert = require('node:assert/strict');
const { createEaselToolHost } = require('../src/easel-tool-host');

const projectId = 'a'.repeat(32);
const assetId = 'b'.repeat(32);
const tools = ['generate_image', 'generate_video', 'get_video', 'list_models', 'generate_music', 'get_audio_generation_status', 'get_audio_track', 'download_audio'].map((name) => ({ name, inputSchema: { type: 'object', additionalProperties: false, properties: { prompt: { type: 'string' }, model: { type: 'string' }, videoId: { type: 'string' }, trackId: { type: 'string' } } } }));

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
    assetStore: { async save(asset) { saved.push(asset); return assetId; }, async get() { return { id: assetId }; } },
    createMediaClient: async () => mediaClient, getKits: () => ['canvas-2d', 'tone'],
    getOrigin: () => ({ chatId: 'chat', origin: { backend: 'external', chatId: 'chat' }, turnOptions: { option: 'retained' } }),
    registerMediaJob: async (input) => { receipts.push(input); return { id: 'local-job', status: 'queued', remoteId: input.job.id, ...input }; },
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

test('external canvas failures return targeted path and offline-kit guidance', async () => {
  const f = fixture({
    presentCanvas: async () => { throw new Error('This document path already exists. Choose a new path.'); },
    canvasController: { async writeCanvasFile() { throw new Error('Only relative local project references are supported: https://cdn.example/p5.min.js'); } },
  });
  const collision = await f.host.callTool('present_canvas', { html: '<!doctype html><html><head></head><body></body></html>' });
  assert.equal(collision.isError, true);
  assert.match(collision.structuredContent.guidance, /write_canvas_file/);
  assert.doesNotMatch(collision.structuredContent.guidance, /assets:\[/);
  const offline = await f.host.callTool('write_canvas_file', { path: 'index.html', content: '<script src="https://cdn.example/p5.min.js"></script>' });
  assert.equal(offline.isError, true);
  assert.match(offline.structuredContent.guidance, /Project files > Canvas kits/);
  assert.match(offline.structuredContent.guidance, /wait for confirmation/);
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

test('Suno CAPTCHA receipts retain their status without entering the image/video monitor', async () => {
  const f = fixture();
  const audio = { attempt_id: '11111111-1111-4111-8111-111111111111', status: 'captcha_required', songs: [] };
  f.setResponse({ content: [{ type: 'text', text: JSON.stringify(audio) }], structuredContent: audio });
  const result = await f.host.callTool('generate_music', { model: 'studio:suno-music', prompt: 'chiptune shoegaze' });
  assert.equal(result.structuredContent.audio.attempt_id, audio.attempt_id);
  assert.equal(result.structuredContent.audio.status, 'captcha_required');
  assert.equal(f.receipts.length, 0);
  assert.equal(f.saved.length, 0);
  assert.equal(f.calls.length, 1);
  const receipt = f.events.find(event => event.type === 'audio-generation');
  assert.equal(receipt.attemptId, audio.attempt_id);
  assert.equal(receipt.chatId, 'chat');
  assert.equal(receipt.projectId, projectId);
});

test('captured Suno tracks are monitored once and keep the original receipt through both result passes', async () => {
  const f = fixture();
  const trackId = '22222222-2222-4222-8222-222222222222';
  const attemptId = '11111111-1111-4111-8111-111111111111';
  f.setResponse({ content: [], structuredContent: { attempt_id: attemptId, status: 'submitted', songs: [{ id: trackId }] } });
  const result = await f.host.callTool('generate_music', { model: 'studio:suno-music', prompt: 'chiptune' });
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].job.id, trackId);
  assert.equal(f.receipts[0].mediaType, 'audio');
  assert.equal(f.receipts[0].projectId, projectId);
  assert.equal(result.structuredContent.audio.attempt_id, attemptId);
  assert.equal(result.structuredContent.audio.monitored, true);
  assert.equal(result.structuredContent.monitoredAudioJobs.length, 1);
  assert.match(result.structuredContent.guidance, /host monitors/);
  assert.equal(f.events.filter(event => event.type === 'audio-generation').length, 1);
});

test('external downloads reuse managed audio receipts and completed assets without a second provider call', async () => {
  const f = fixture();
  const trackId = '22222222-2222-4222-8222-222222222222';
  const job = { id: 'f'.repeat(32), remoteId: trackId, modelId: 'studio:suno-music', mediaType: 'audio', projectId, status: 'generating' };
  f.canvasController.listMediaJobs = async () => ({ jobs: [job] });
  const pending = await f.host.callTool('download_audio', { model: job.modelId, trackId });
  assert.equal(pending.structuredContent.audio.monitored, true);
  assert.equal(f.calls.length, 0);
  job.status = 'ready'; job.attached = true;
  job.assets = [{ assetId, mimeType: 'audio/mp4', name: 'Pixel Haze.m4a' }];
  const ready = await f.host.callTool('download_audio', { model: job.modelId, trackId });
  assert.equal(ready.structuredContent.cached, true);
  assert.equal(ready.structuredContent.assets[0].assetId, assetId);
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved.length, 0);
  assert.equal(f.attached.length, 0);
});

test('managed tracks retain full provider inspection metadata', async () => {
  const f = fixture();
  const trackId = '22222222-2222-4222-8222-222222222222';
  f.canvasController.listMediaJobs = () => assert.fail('Read-only track inspection must reach the provider.');
  f.setResponse({ content: [], structuredContent: { id: trackId, title: 'Pixel Haze', duration: 120, metadata: { lyrics: 'Original lyrics' } } });
  const result = await f.host.callTool('get_audio_track', { model: 'studio:suno-music', trackId });
  assert.equal(result.structuredContent.audio.title, 'Pixel Haze');
  assert.equal(result.structuredContent.audio.duration, 120);
  assert.equal(result.structuredContent.audio.metadata.lyrics, 'Original lyrics');
  assert.equal(f.calls.length, 1);
});

test('an explicitly requested download restores deleted audio and refreshes its receipt for later reuse', async () => {
  const trackId = '22222222-2222-4222-8222-222222222222';
  const stored = new Set();
  const f = fixture({ assetStore: {
    async get(id) { if (!stored.has(id)) throw new Error('File deleted'); return { id }; },
    async save() { stored.add(assetId); return assetId; },
  } });
  const job = { id: 'f'.repeat(32), remoteId: trackId, modelId: 'studio:suno-music', mediaType: 'audio', projectId, status: 'ready', assets: [{ assetId: 'c'.repeat(32), mimeType: 'audio/mp4' }] };
  f.canvasController.listMediaJobs = async () => ({ jobs: [job] });
  f.canvasController.updateMediaJobAssets = async (id, assets) => { assert.equal(id, job.id); job.assets = assets; };
  f.setResponse({ structuredContent: { track: { song_id: trackId, title: 'Pixel Haze' } }, content: [{ type: 'resource', resource: { mimeType: 'audio/mp4', blob: 'YWJj' } }] });
  const restored = await f.host.callTool('download_audio', { model: job.modelId, trackId });
  assert.equal(restored.structuredContent.assets[0].assetId, assetId);
  assert.equal(job.assets[0].assetId, assetId);
  assert.equal(f.calls.length, 1);
  const reused = await f.host.callTool('download_audio', { model: job.modelId, trackId });
  assert.equal(reused.structuredContent.cached, true);
  assert.equal(f.calls.length, 1);
});

test('disconnecting during Suno submission preserves its eventual receipt and original project', async () => {
  const f = fixture(); await f.host.listTools();
  let respond;
  f.mediaClient.callTool = () => new Promise(resolve => { respond = resolve; });
  const abort = new AbortController();
  const call = f.host.callTool('generate_music', { model: 'studio:suno-music', prompt: 'chiptune' }, { signal: abort.signal });
  const canceled = assert.rejects(call, { name: 'AbortError' });
  await new Promise(setImmediate); abort.abort(); await canceled;
  assert.equal(f.host.isBusy(), true);
  f.canvasController.getCurrentCanvasId = () => 'c'.repeat(32);
  const attemptId = '11111111-1111-4111-8111-111111111111';
  respond({ content: [], structuredContent: { attempt_id: attemptId, status: 'submitted', songs: [] } });
  await f.host.shutdown();
  const receipt = f.events.find(event => event.type === 'audio-generation');
  assert.equal(receipt.attemptId, attemptId);
  assert.equal(receipt.projectId, projectId);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.host.isBusy(), false);
});

test('external audio download saves and attaches once, returns metadata and emits one preview', async () => {
  const f = fixture();
  const trackId = '22222222-2222-4222-8222-222222222222';
  f.setResponse({ content: [{ type: 'resource', resource: { mimeType: 'audio/mp4', blob: 'YWJj' } }],
    structuredContent: { track: { id: trackId, title: 'Pixel Haze' }, mimeType: 'audio/mp4' } });
  const result = await f.host.callTool('download_audio', { model: 'studio:suno-music', trackId });
  assert.equal(result.structuredContent.audio.trackId, trackId);
  assert.equal(result.structuredContent.assets[0].mimeType, 'audio/mp4');
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].name, 'Pixel Haze.m4a');
  assert.equal(f.attached.length, 1);
  assert.equal(f.events.filter(event => event.type === 'media').length, 1);
  assert.equal(JSON.stringify(result).includes('YWJj'), false);
});

test('failed audio storage preserves the track receipt and reports failed delivery', async () => {
  const f = fixture({ assetStore: { async save() { throw new Error('Disk full'); } } });
  const trackId = '22222222-2222-4222-8222-222222222222';
  f.setResponse({ content: [{ type: 'resource', resource: { mimeType: 'audio/mp4', blob: 'YWJj' } }],
    structuredContent: { track: { id: trackId }, mimeType: 'audio/mp4' } });
  const result = await f.host.callTool('download_audio', { model: 'studio:suno-music', trackId });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.audio.trackId, trackId);
  assert.deepEqual(result.structuredContent.assets, []);
  assert.match(result.structuredContent.saveErrors[0], /Disk full/);
  assert.equal(f.attached.length, 0);
  assert.equal(f.events.filter(event => event.type === 'media').length, 0);
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

test('shared_host_rejects_a_selected_turn_after_runtime_replacement', async (t) => {
  const { templateFixture } = require('./helpers/template-lifecycle');
  const f = templateFixture(t), [a, b] = f.records;
  f.controller.resolveSelection(f.selection); const before = [f.bytes(a), f.bytes(b)];
  const host = createEaselToolHost({ canvasController: f.hostController,
    createMediaClient: async () => ({ listTools: async () => [], close: async () => {} }),
    getOrigin: () => ({ turnOptions: { timelineSelection: f.selection } }),
  });
  f.setActive({ runtimeGeneration: 2 });
  const result = await host.callTool('apply_timeline_edit', { projectId: f.projectId, expectedRevision: 0, operations: [{ type: 'insert', item: f.clip }] });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /stale|runtime|document/i);
  assert.deepEqual([f.bytes(a), f.bytes(b)], before);
});
