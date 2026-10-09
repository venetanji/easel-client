const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaJobStore } = require('../src/media-job-store');
const { createMediaJobMonitor } = require('../src/media-job-monitor');
const { createChatStore } = require('../src/chat-store');
const { createChatService } = require('../src/chat-service');

const connectionId = 'c'.repeat(32);
const projectId = 'b'.repeat(32);
const modelId = connectionId + ':video';
const baseUrl = 'http://gpu.example/v1';
const input = { job: { id: 'video_test', status: 'queued' }, modelId, baseUrl, mediaType: 'video', projectId, prompt: 'A cat' };
const settings = { activeConnectionId: connectionId, litellmModel: 'agent', litellmBaseUrl: baseUrl,
  connections: [{ id: connectionId, baseUrl, name: 'GPU' }], models: [{ connectionId, model: 'agent', enabled: true, roles: ['agent'] }] };
const settingsStore = { loadPublic: () => settings, loadSecrets: () => ({ litellmApiKey: 'private-key' }) };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-jobs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMediaJobStore({ userDataPath: root, now: () => 1000 });
  return { root, store };
}

test('accepted job IDs survive restart, deduplicate receipts, and exclude credentials from summaries', (t) => {
  const { root, store } = fixture(t);
  const job = store.track({ ...input, approvedAgent: { connectionId, baseUrl, model: 'agent' } });
  assert.equal(store.track(input).id, job.id);
  const restored = createMediaJobStore({ userDataPath: root });
  assert.equal(restored.get(job.id).remoteId, 'video_test');
  assert.equal(restored.list()[0].approvedAgent, undefined);
  assert.equal(restored.list()[0].baseUrl, undefined);
  assert.equal(JSON.stringify(restored.get(job.id)).includes('private-key'), false);
  assert.throws(() => store.get('../escape'), /invalid/);
});

test('media job origins survive restart and public summaries without changing original receipt ownership', (t) => {
  const { root, store } = fixture(t);
  const origin = { backend: 'codex', chatId: 'd'.repeat(32), threadId: 'thread_123-abcd', model: 'gpt-6.1-sol' };
  const saved = store.track({ ...input, origin });
  const restored = createMediaJobStore({ userDataPath: root });
  assert.deepEqual(restored.get(saved.id).origin, origin);
  assert.deepEqual(restored.list()[0].origin, origin);
  const duplicate = restored.track({ ...input, origin: { backend: 'external' } });
  assert.equal(duplicate.id, saved.id);
  assert.deepEqual(duplicate.origin, origin);
  assert.throws(() => restored.track({ ...input, origin: { ...origin, bearerToken: 'secret' } }));
});

test('media jobs reject invalid origin metadata while legacy records stay unchanged', (t) => {
  const { store } = fixture(t);
  const saved = store.track(input);
  assert.equal(Object.hasOwn(store.get(saved.id), 'origin'), false);
  assert.equal(Object.hasOwn(store.list()[0], 'origin'), false);
  for (const origin of [{ backend: 'unknown' }, { backend: 'codex', chatId: '../escape' }, { backend: 'codex', threadId: 'a'.repeat(161) }, { backend: 'external', threadId: 'a/b' }, { backend: 'builtin', model: 'a'.repeat(257) }, { backend: 'external', apiKey: 'private' }, null]) assert.throws(() => store.track({ ...input, origin }));
});

test('polling saves queue estimates, then downloads and attaches output exactly once', async (t) => {
  const { store } = fixture(t);
  let completed = false;
  let calls = 0;
  let saves = 0;
  let attaches = 0;
  const ready = [];
  const monitor = createMediaJobMonitor({ store, settingsStore, now: () => 1000, onReady: (job) => ready.push(job),
    mediaAssetStore: { async save() { saves++; return 'a'.repeat(32); }, async get() {} },
    async attachAssets(owner, ids) { attaches++; assert.equal(owner, projectId); assert.deepEqual(ids, ['a'.repeat(32)]); },
    mcpFactory: async (options) => {
      assert.equal(JSON.parse(options.env.EASEL_MEDIA_MODELS)[0].apiKey, 'private-key');
      return { async close() {}, async callTool(name, args) {
        calls++;
        assert.equal(name, 'get_video');
        assert.equal(args.includeQueue, true);
        return { structuredContent: { job: { id: input.job.id, modelId, status: completed ? 'completed' : 'in_progress', queuePosition: 1, estimatedWaitSeconds: 24 } },
          content: completed ? [{ type: 'resource', resource: { mimeType: 'video/mp4', blob: 'YWJj' } }] : [] };
      } };
    },
  });
  const job = monitor.track(input);
  monitor.start();
  await monitor.stop();
  assert.equal(store.get(job.id).estimatedWaitSeconds, 24);
  completed = true;
  monitor.retry(job.id);
  monitor.start();
  await monitor.stop();
  assert.equal(store.get(job.id).status, 'ready');
  assert.equal(calls, 2);
  assert.equal(saves, 1);
  assert.equal(attaches, 1);
  assert.equal(ready.length, 1);
  monitor.start();
  await monitor.stop();
  assert.equal(calls, 2);
});

test('failed retrieval keeps the job pending with backoff and never resubmits', async (t) => {
  const { store } = fixture(t);
  const monitor = createMediaJobMonitor({ store, settingsStore, now: () => 1000, mediaAssetStore: {},
    mcpFactory: async () => ({ async close() {}, async callTool(name) { assert.equal(name, 'get_video'); throw new Error('Offline'); } }),
  });
  const job = monitor.track(input);
  monitor.start();
  await monitor.stop();
  const saved = store.get(job.id);
  assert.equal(saved.status, 'queued');
  assert.equal(saved.remoteId, input.job.id);
  assert.equal(saved.attempts, 1);
  assert.ok(saved.nextPollAt > 1000);
});

test('restart after download retries attachment without downloading or saving a second copy', async (t) => {
  const { root, store } = fixture(t);
  const job = store.track(input);
  store.update(job.id, { status: 'downloading', assets: [{ assetId: 'a'.repeat(32), mimeType: 'video/mp4' }] });
  let attached = 0;
  const monitor = createMediaJobMonitor({ store: createMediaJobStore({ userDataPath: root }), settingsStore,
    mediaAssetStore: { async get() {} }, mcpFactory: () => assert.fail('The downloaded output must be reused.'),
    async attachAssets() { attached++; },
  });
  monitor.start();
  await monitor.stop();
  assert.equal(store.get(job.id).status, 'ready');
  assert.equal(attached, 1);
});

test('forgetting an in-flight job prevents late attachment or completion notifications', async (t) => {
  const { store } = fixture(t);
  let resolve;
  const response = new Promise((finish) => { resolve = finish; });
  const monitor = createMediaJobMonitor({ store, settingsStore, now: () => 1000,
    mediaAssetStore: { save: () => assert.fail('A removed job must not save output.') },
    onReady: () => assert.fail('A removed job must not notify chat.'),
    mcpFactory: async () => ({ async callTool() { return response; }, async close() {} }),
  });
  const job = monitor.track(input);
  monitor.start();
  await new Promise((finish) => setImmediate(finish));
  monitor.forget(job.id);
  resolve({ structuredContent: { job: { id: input.job.id, status: 'completed' } }, content: [] });
  await monitor.stop();
  assert.equal(store.list().length, 0);
});

test('canceling an in-flight job keeps its receipt and blocks late output and restart polling', async (t) => {
  const { root, store } = fixture(t);
  let resolve;
  const response = new Promise(finish => { resolve = finish; });
  const events = [];
  const monitor = createMediaJobMonitor({ store, settingsStore, now: () => 1000,
    mediaAssetStore: { save: () => assert.fail('Canceled jobs must not save late output.') },
    attachAssets: () => assert.fail('Canceled jobs must not attach late output.'),
    onReady: () => assert.fail('Canceled jobs must not notify completion.'), onEvent: event => events.push(event),
    mcpFactory: async () => ({ async callTool() { return response; }, async close() {} }),
  });
  const job = monitor.track(input);
  monitor.start();
  await new Promise(finish => setImmediate(finish));
  assert.equal(monitor.cancel(job.id).status, 'cancelled');
  resolve({ structuredContent: { job: { id: input.job.id, status: 'completed' } },
    content: [{ type: 'resource', resource: { mimeType: 'video/mp4', blob: 'YWJj' } }] });
  await monitor.stop();
  assert.equal(store.get(job.id).remoteId, input.job.id);
  assert.equal(store.get(job.id).status, 'cancelled');
  assert.equal(store.list({ pending: true }).length, 0);
  assert.equal(events.at(-1).job.status, 'cancelled');
  assert.throws(() => monitor.retry(job.id), /pending job/);
  const restored = createMediaJobStore({ userDataPath: root });
  const restarted = createMediaJobMonitor({ store: restored, settingsStore,
    mcpFactory: () => assert.fail('Canceled jobs must not poll after restart.') });
  restarted.start(); await restarted.stop();
  assert.equal(restored.get(job.id).status, 'cancelled');
});

test('a terminal job cannot be canceled or lose its saved output', t => {
  const { store } = fixture(t);
  const job = store.track(input);
  store.update(job.id, { status: 'ready', assets: [{ assetId: 'a'.repeat(32), mimeType: 'video/mp4' }] });
  const monitor = createMediaJobMonitor({ store });
  assert.throws(() => monitor.cancel(job.id), /pending job/);
  assert.equal(store.get(job.id).status, 'ready');
});

test('retrieving a canceled job reports stopped tracking and never promises another notification', async t => {
  const { store } = fixture(t);
  const job = store.track(input); store.update(job.id, { status: 'cancelled' });
  let completion = 0;
  const service = createChatService({ settingsStore, mediaJobStore: store,
    canvasController: { getCurrentCanvasId: () => projectId },
    registerMediaJob: () => assert.fail('Canceled jobs must not be registered again.'),
    mcpLaunchOptions: () => ({ command: 'fake' }),
    mcpFactory: async () => ({ async close() {},
      listTools: async () => [{ name: 'get_video', inputSchema: { type: 'object', properties: { model: { type: 'string' }, videoId: { type: 'string' } } } }],
      callTool: () => assert.fail('Canceled job retrieval must use the retained receipt.'),
    }),
    llmFactory: () => ({ async createCompletion({ messages }) {
      if (completion++ === 0) return { choices: [{ message: { role: 'assistant', tool_calls: [
        { id: 'check', type: 'function', function: { name: 'get_video', arguments: JSON.stringify({ model: modelId, videoId: input.job.id }) } },
      ] } }] };
      const result = JSON.parse(messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(result.job.status, 'cancelled');
      assert.equal(result.monitoredJob, undefined);
      assert.ok(result.text.some(text => text.includes('no longer polls')));
      return { choices: [{ message: { role: 'assistant', content: 'Tracking is canceled.' } }] };
    } }),
  });
  assert.equal((await service.sendMessage('Check my canceled job')).text, 'Tracking is canceled.');
  await service.shutdown();
});

test('canceling during attachment prevents a late project commit while keeping saved files', async t => {
  const { store } = fixture(t);
  const saved = store.track(input);
  store.update(saved.id, { status: 'downloading', assets: [{ assetId: 'a'.repeat(32), mimeType: 'video/mp4' }] });
  let release;
  let started;
  let committed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const attaching = new Promise(resolve => { started = resolve; });
  const monitor = createMediaJobMonitor({ store, mediaAssetStore: {},
    attachAssets: async (_projectId, _assetIds, { beforeCommit } = {}) => {
      started(); await gate; beforeCommit?.(); committed = true;
    }, onReady: () => assert.fail('Canceled attachment must not announce completion.'),
  });
  monitor.start(); await attaching;
  monitor.cancel(saved.id); release(); await monitor.stop();
  assert.equal(committed, false);
  assert.equal(store.get(saved.id).status, 'cancelled');
  assert.equal(store.get(saved.id).assets.length, 1);
});

test('endpoint changes preserve IDs without sending them to a different endpoint', async (t) => {
  const { store } = fixture(t);
  const monitor = createMediaJobMonitor({ store, settingsStore: { ...settingsStore, loadPublic: () => ({ ...settings, connections: [] }) }, now: () => 1000,
    mcpFactory: () => assert.fail('Changed endpoints must not receive old jobs.'), mediaAssetStore: {},
  });
  const job = monitor.track(input);
  monitor.start();
  await monitor.stop();
  assert.match(store.get(job.id).error, /endpoint is missing or changed/);
});

function chatFixture(t, { currentProject = projectId, getMetadata, currentKits } = {}) {
  const state = fixture(t);
  const chatStore = createChatStore({ userDataPath: state.root });
  const chatId = 'd'.repeat(32);
  chatStore.save({ id: chatId, title: 'Cat', history: [{ role: 'user', content: 'Make a cat video' }, { role: 'assistant', content: 'Queued.' }] });
  const requests = [];
  const instructions = [];
  const events = [];
  const service = createChatService({ settingsStore, chatStore, mediaJobStore: state.store,
    assetStore: {}, mediaAssetStore: { getMetadata, async get(id) { return { id, data: 'YWJj', mimeType: 'video/mp4' }; } },
    canvasController: { getCurrentCanvasId: () => currentProject, getCurrentKits: () => currentKits },
    llmFactory: () => ({ async createCompletion({ messages, instructions: guidance }) { instructions.push(guidance); requests.push(messages.map((message) => ({ ...message }))); return { choices: [{ message: { role: 'assistant', content: 'The cat video is ready.' } }] }; } }),
    mcpFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    mcpLaunchOptions: () => ({ command: 'node' }), onEvent: (event) => events.push(event),
  });
  const job = state.store.track({ ...input, chatId, approvedAgent: { connectionId, model: 'agent', baseUrl } });
  state.store.update(job.id, { status: 'ready', assets: [{ assetId: 'a'.repeat(32), mimeType: 'video/mp4' }] });
  return { ...state, service, job, requests, instructions, events, chatStore, chatId };
}

test('ready output resumes the original idle chat exactly once with saved asset references', async (t) => {
  const { service, store, job, requests, events } = chatFixture(t);
  service.notifyMediaJob(store.get(job.id));
  await new Promise((finish) => setImmediate(finish));
  assert.equal(requests.length, 1);
  assert.equal(store.get(job.id).notification, 'responded');
  assert.ok(requests[0].some((message) => message.mediaJobResult?.assets[0].assetId === 'a'.repeat(32)));
  assert.equal(JSON.stringify(requests).includes('YWJj'), false);
  service.notifyMediaJob(store.get(job.id));
  await new Promise((finish) => setImmediate(finish));
  assert.equal(requests.length, 1);
  assert.ok(events.some((event) => event.type === 'media-job-resume-end'));
});

test('chat restoration waits for renderer acknowledgement before a ready job continues', async (t) => {
  let release;
  const metadataWait = new Promise((resolve) => { release = resolve; });
  const { service, requests, events, chatId } = chatFixture(t, { getMetadata: async (id) => {
    await metadataWait;
    return { id, mimeType: 'video/mp4', name: 'Cat.mp4' };
  } });
  const restoration = service.getCurrentChat({ deferResume: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
  release();
  const snapshot = await restoration;
  assert.ok(snapshot.history.some((message) => message.mediaJobResult));
  assert.equal(events.some((event) => event.type === 'media-job-resume-start'), false);
  assert.deepEqual(service.acknowledgeChat('e'.repeat(32)), { ok: false, stale: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
  service.acknowledgeChat(chatId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.ok(events.some((event) => event.type === 'media-job-resume-end'));
});

test('background continuation resolves current project kits instead of stale submission options', async (t) => {
  const { service, store, job, instructions } = chatFixture(t, { currentKits: ['canvas-2d', 'p5'] });
  store.update(job.id, { turnOptions: { kits: ['tone', 'three'] } });
  await service.notifyMediaJob(store.get(job.id));
  await new Promise((resolve) => setImmediate(resolve));
  const kitGuidance = instructions[0].split('ACTIVE OFFLINE CANVAS KITS')[1];
  assert.match(kitGuidance, /p5/);
  assert.equal(kitGuidance.includes('- Tone.js'), false);
  assert.equal(kitGuidance.includes('- Three.js'), false);
});

test('a different project defers automatic resumption but the next message sees completion', async (t) => {
  const { service, store, job, requests } = chatFixture(t, { currentProject: 'e'.repeat(32) });
  service.notifyMediaJob(store.get(job.id));
  await new Promise((finish) => setImmediate(finish));
  assert.equal(requests.length, 0);
  await service.sendMessage('What happened to my video?');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].some((message) => message.mediaJobId === job.id));
  assert.equal(store.get(job.id).notification, 'responded');
});

test('an interrupted continuation does not replay tools on application restart', async (t) => {
  const { service, store, job, requests } = chatFixture(t);
  store.update(job.id, { notification: 'dispatching' });
  await service.getCurrentChat();
  await new Promise((finish) => setImmediate(finish));
  assert.equal(store.get(job.id).notification, 'interrupted');
  assert.equal(requests.length, 0);
});

test('Stop ends the agent while shutdown waits for an accepted receipt and preserves its original project', async (t) => {
  const { store } = fixture(t);
  let resolveReceipt;
  const receipt = new Promise((resolve) => { resolveReceipt = resolve; });
  let currentProject = projectId;
  const service = createChatService({ settingsStore, mediaJobStore: store,
    canvasController: { getCurrentCanvasId: () => currentProject },
    registerMediaJob: (entry) => store.track({ ...entry, baseUrl }),
    llmFactory: () => ({ async createCompletion() { return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'submit', type: 'function', function: { name: 'generate_video', arguments: JSON.stringify({ model: modelId, prompt: 'A cat' }) } }] } }] }; } }),
    mcpLaunchOptions: () => ({ command: 'node' }),
    mcpFactory: async () => ({ async listTools() { return [{ name: 'generate_video', inputSchema: { type: 'object', properties: { model: { type: 'string' }, prompt: { type: 'string' } } } }]; }, async callTool() { return receipt; }, async close() {} }),
  });
  const turn = service.sendMessage('Make a cat video');
  await new Promise((resolve) => setImmediate(resolve));
  service.stopAgent();
  assert.equal((await turn).cancelled, true);
  currentProject = 'e'.repeat(32);
  let closed = false;
  const closing = service.shutdown().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  resolveReceipt({ content: [], structuredContent: { job: { id: 'video_saved_after_stop', modelId, status: 'queued' } } });
  await closing;
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].projectId, projectId);
});
