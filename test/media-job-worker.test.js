const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createMediaJobWorkerRuntime } = require('../src/media-job-worker');
const { createMediaJobWorkerClient } = require('../src/media-job-worker-client');
const { createMediaJobMonitor } = require('../src/media-job-monitor');
const { createMediaJobStore } = require('../src/media-job-store');
const { createCanvasMediaStore } = require('../src/canvas-media-store');

const connectionId = 'c'.repeat(32);
const projectId = 'b'.repeat(32);
const modelId = connectionId + ':video';
const baseUrl = 'http://gpu.example/v1';
const entry = { id: 'd'.repeat(32), remoteId: 'video_test', modelId, mediaType: 'video', assets: [] };
const pendingResult = { content: [], structuredContent: { job: { id: entry.remoteId, status: 'in_progress', estimatedWaitSeconds: 18 } } };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-job-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('worker reuses its MCP process and returns compact asset references after acknowledged saves', async () => {
  let launches = 0;
  let closes = 0;
  let completed = false;
  const checkpoints = [];
  const runtime = createMediaJobWorkerRuntime({ mediaAssetStore: { async save() { return 'a'.repeat(32); } },
    checkpoint: async (asset) => checkpoints.push(asset),
    mcpFactory: async () => {
      launches++;
      return { async close() { closes++; }, async callTool(name, args) {
        assert.equal(name, 'get_video');
        assert.equal(args.videoId, entry.remoteId);
        return completed ? { structuredContent: { job: { id: entry.remoteId, status: 'completed', seconds: 12 } }, content: [{ type: 'resource', resource: { mimeType: 'video/mp4', blob: 'YWJj' } }] } : pendingResult;
      } };
    },
  });
  const options = { command: 'node' };
  assert.equal((await runtime.poll(entry, options)).structuredContent.job.estimatedWaitSeconds, 18);
  completed = true;
  const result = await runtime.poll(entry, options);
  assert.equal(launches, 1);
  assert.equal(result.structuredContent.assets[0].duration, 12);
  assert.equal(checkpoints[0].assetId, 'a'.repeat(32));
  assert.equal(JSON.stringify(result).includes('YWJj'), false);
  await runtime.close();
  assert.equal(closes, 1);
});

test('worker rejects mismatched IDs before saving and reconnects after transport failure', async () => {
  let launches = 0;
  let closes = 0;
  let response = 'transport';
  const runtime = createMediaJobWorkerRuntime({ mediaAssetStore: { save: () => assert.fail('Must not save invalid output.') },
    checkpoint: () => assert.fail('Must not checkpoint invalid output.'),
    mcpFactory: async () => { launches++; return { async close() { closes++; }, async callTool() {
      if (response === 'transport') throw new Error('Connection lost');
      if (response === 'mismatch') return { structuredContent: { job: { id: 'video_other', status: 'completed' } } };
      return pendingResult;
    } }; },
  });
  await assert.rejects(runtime.poll(entry, {}), /Connection lost/);
  response = 'mismatch';
  await assert.rejects(runtime.poll(entry, {}), /does not match/);
  response = 'pending';
  await runtime.poll(entry, {});
  assert.equal(launches, 2);
  assert.equal(closes, 1);
  await runtime.close();
});

test('forgetting a job during worker retrieval prevents saving its late output', async () => {
  let removed = false;
  let resolveResult;
  const response = new Promise((resolve) => { resolveResult = resolve; });
  const runtime = createMediaJobWorkerRuntime({
    isRemoved: () => removed,
    mediaAssetStore: { save: () => assert.fail('A removed job must not save late output.') },
    checkpoint: () => assert.fail('A removed job must not checkpoint late output.'),
    mcpFactory: async () => ({ async close() {}, async callTool() { return response; } }),
  });
  const polling = runtime.poll(entry, {});
  await new Promise((resolve) => setImmediate(resolve));
  removed = true;
  resolveResult({ structuredContent: { job: { id: entry.remoteId, status: 'completed' } }, content: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }] });
  await assert.rejects(polling, /job was removed/);
  await runtime.close();
});

test('worker client acknowledges saved assets only after host persistence', async () => {
  const worker = new EventEmitter();
  const sent = [];
  worker.postMessage = (message) => sent.push(message);
  worker.terminate = async () => {};
  const client = createMediaJobWorkerClient({ userDataPath: '/unused', workerFactory: () => worker });
  let resolveCheckpoint;
  const checkpoint = new Promise((resolve) => { resolveCheckpoint = resolve; });
  const polling = client.poll(entry, {}, async () => checkpoint);
  worker.emit('message', { type: 'checkpoint', id: 1, checkpointId: 1, asset: { assetId: 'a'.repeat(32) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  resolveCheckpoint();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent[1], { type: 'checkpoint-result', checkpointId: 1, ok: true });
  worker.emit('message', { type: 'result', id: 1, result: pendingResult });
  assert.deepEqual(await polling, pendingResult);
  const closing = client.close();
  worker.emit('message', { type: 'result', id: 2 });
  await closing;
});

test('an unexpected idle worker exit rejects subsequent polls instead of hanging', async () => {
  const worker = new EventEmitter();
  worker.postMessage = () => assert.fail('An exited worker cannot receive more polls.');
  worker.terminate = async () => {};
  const client = createMediaJobWorkerClient({ userDataPath: '/unused', workerFactory: () => worker });
  worker.emit('exit', 1);
  await assert.rejects(client.poll(entry, {}), /worker stopped/);
  assert.ok(client.failed);
  await assert.rejects(client.close(), /worker stopped/);
});

test('partial multi-image saves resume after restart without losing outputs or duplicating the prefix', async (t) => {
  const root = fixture(t);
  const store = createMediaJobStore({ userDataPath: root, now: () => 1000 });
  let saveCalls = 0;
  let retrievals = 0;
  let failSave = true;
  const savedIds = [];
  const monitor = createMediaJobMonitor({ store, runtime: { userDataPath: root }, now: () => 1000, mediaAssetStore: {},
    settingsStore: { loadPublic: () => ({ connections: [{ id: connectionId, baseUrl }] }), loadSecrets: () => ({}) },
    workerFactory: () => ({ async poll(saved, options, onSaved) {
      const runtime = createMediaJobWorkerRuntime({ checkpoint: onSaved,
        mediaAssetStore: {
          async get(id) { assert.ok(savedIds.includes(id)); },
          async save() {
            saveCalls++;
            if (failSave && saveCalls === 2) throw new Error('Disk full');
            const id = String(saveCalls).repeat(32);
            savedIds.push(id);
            return id;
          },
        },
        mcpFactory: async () => ({ async close() {}, async callTool() {
          retrievals++;
          return { structuredContent: { job: { id: entry.remoteId, status: 'completed' } }, content: Array.from({ length: 3 }, () => ({ type: 'image', mimeType: 'image/png', data: 'YWJj' })) };
        } }),
      });
      try { return await runtime.poll(saved, options); }
      finally { await runtime.close(); }
    }, async close() {} }),
    async attachAssets(owner, ids) { assert.deepEqual(ids, savedIds); },
  });
  const job = monitor.track({ job: { id: entry.remoteId, status: 'queued' }, modelId, baseUrl, mediaType: 'image', projectId });
  monitor.start();
  await monitor.stop();
  assert.equal(saveCalls, 2);
  assert.equal(store.get(job.id).assets.length, 1);
  assert.equal(store.get(job.id).downloadComplete, false);
  assert.match(store.get(job.id).error, /Disk full/);
  failSave = false;
  monitor.retry(job.id);
  monitor.start();
  await monitor.stop();
  assert.equal(retrievals, 2);
  assert.equal(saveCalls, 4);
  assert.equal(store.get(job.id).status, 'ready');
  assert.equal(store.get(job.id).assets.length, 3);
  assert.equal(store.get(job.id).downloadComplete, true);
});

test('isolated monitor waits for its poll and worker shutdown, then reuses checkpoints on restart', async (t) => {
  const root = fixture(t);
  const store = createMediaJobStore({ userDataPath: root, now: () => 1000 });
  const settingsStore = { loadPublic: () => ({ connections: [{ id: connectionId, baseUrl }], models: [] }), loadSecrets: () => ({ litellmApiKey: '' }) };
  let finishPoll;
  let finishClose;
  let polls = 0;
  let attached = 0;
  const polling = new Promise((resolve) => { finishPoll = resolve; });
  const closing = new Promise((resolve) => { finishClose = resolve; });
  const monitor = createMediaJobMonitor({ store, settingsStore, runtime: { userDataPath: root }, now: () => 1000,
    mediaAssetStore: {},
    async attachAssets(owner, ids) { attached++; assert.equal(owner, projectId); assert.deepEqual(ids, ['a'.repeat(32)]); },
    workerFactory: () => ({ async poll(saved, options, onSaved) {
      polls++;
      await polling;
      await onSaved({ assetId: 'a'.repeat(32), mimeType: 'video/mp4' });
      return { content: [], structuredContent: { job: { id: saved.remoteId, status: 'completed' }, assets: [{ assetId: 'a'.repeat(32), mimeType: 'video/mp4' }] } };
    }, async close() { await closing; } }),
  });
  const job = monitor.track({ job: { id: entry.remoteId, status: 'queued' }, modelId, baseUrl, mediaType: 'video', projectId });
  monitor.start();
  let stopped = false;
  const stoppedPromise = monitor.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finishPoll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(job.id).status, 'ready');
  assert.equal(stopped, false);
  finishClose();
  await stoppedPromise;
  monitor.start();
  await monitor.stop();
  assert.equal(polls, 1);
  assert.equal(attached, 1);
});

test('a project deleted during download leaves completed output in the media library', async (t) => {
  const root = fixture(t);
  const store = createMediaJobStore({ userDataPath: root, now: () => 1000 });
  const monitor = createMediaJobMonitor({ store,
    settingsStore: { loadPublic: () => ({ connections: [{ id: connectionId, baseUrl }] }), loadSecrets: () => ({}) },
    runtime: { userDataPath: root }, now: () => 1000, mediaAssetStore: {},
    workerFactory: () => ({ async poll(saved, options, onSaved) {
      await onSaved({ assetId: 'a'.repeat(32), mimeType: 'video/mp4' });
      return { content: [], structuredContent: { job: { id: saved.remoteId, status: 'completed' }, assets: [{ assetId: 'a'.repeat(32), mimeType: 'video/mp4' }] } };
    }, async close() {} }),
    attachAssets: async () => ({ projectDeleted: true }),
  });
  const job = monitor.track({ job: { id: entry.remoteId, status: 'queued' }, modelId, baseUrl, mediaType: 'video', projectId });
  monitor.start();
  await monitor.stop();
  assert.equal(store.get(job.id).status, 'ready');
  assert.equal(store.get(job.id).projectId, '');
  assert.equal(store.get(job.id).notification, 'interrupted');
});

test('real worker downloads through MCP while the host event loop remains available', async (t) => {
  const root = fixture(t);
  const script = path.join(root, 'mcp-fixture.cjs');
  fs.writeFileSync(script, `
    const { McpServer } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'))});
    const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
    const { z } = require(${JSON.stringify(require.resolve('zod'))});
    const server = new McpServer({ name: 'worker-fixture', version: '1.0.0' });
    server.registerTool('get_video', { inputSchema: { model: z.string(), videoId: z.string(), includeQueue: z.boolean() } }, async (args) => {
      const bytes = Buffer.alloc(8 * 1024 * 1024);
      bytes.write('ftyp', 4, 'ascii');
      return { structuredContent: { job: { id: args.videoId, status: 'completed', seconds: 12 } }, content: [{ type: 'resource', resource: { uri: 'easel-media://test', mimeType: 'video/mp4', blob: bytes.toString('base64') } }] };
    });
    server.connect(new StdioServerTransport());
  `);
  const client = createMediaJobWorkerClient({ userDataPath: root });
  t.after(() => client.close());
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats++; }, 5);
  t.after(() => clearInterval(timer));
  const checkpoints = [];
  const result = await client.poll(entry, { command: process.execPath, args: [script], env: {} }, async (asset) => checkpoints.push(asset));
  assert.ok(heartbeats > 0);
  assert.equal(checkpoints.length, 1);
  assert.ok(JSON.stringify(result).length < 1000);
  const stored = await createCanvasMediaStore({ userDataPath: root }).getMetadata(checkpoints[0].assetId);
  assert.equal(stored.bytes, 8 * 1024 * 1024);
  assert.equal(stored.duration, 12);
});
