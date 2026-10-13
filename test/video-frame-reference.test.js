const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCanvasMediaStore } = require('../src/canvas-media-store');
const { createAssetStore } = require('../src/asset-store');
const { createVideoMetadataService, localMediaResponse } = require('../src/video-metadata');
const { createManagedVideoSourceResolver } = require('../src/video-frame-reference');
const { executeEaselTool, runAgentTurn } = require('../src/agent');
const { createEaselToolHost } = require('../src/easel-tool-host');
const { producedMediaAssets } = require('../src/media-tool-results');

const videoId = 'a'.repeat(32), imageId = 'b'.repeat(32);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const decoded = { data: jpeg, mimeType: 'image/jpeg', width: 640, height: 360, sourceWidth: 640, sourceHeight: 360, timestampSeconds: 1.96, duration: 2 };

function fixture(t, { decode = async () => decoded, readVideoSource, timeoutMs, initializeSession, loadURL = async () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-frame-reference-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaStore = createCanvasMediaStore({ userDataPath: root, idFactory: () => videoId });
  const imageStore = createAssetStore({ userDataPath: root, idFactory: () => imageId });
  const windows = [];
  class BrowserWindow {
    constructor() {
      this.webContents = new EventEmitter();
      this.webContents.setAudioMuted = value => { this.muted = value; };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = decode;
      windows.push(this);
    }
    loadURL = loadURL;
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; }
  }
  const session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
    webRequest: { onBeforeRequest() {} }, protocol: { async handle() {}, async unhandle() {} } };
  const service = createVideoMetadataService({ BrowserWindow, sessionFactory: async partition => {
    await initializeSession?.();
    return { partition, session };
  }, mediaStore, imageStore, readVideoSource, timeoutMs });
  t.after(() => service.close());
  return { service, imageStore, mediaStore, windows };
}

test('last-frame extraction saves a reusable image from an imported video without recorder samples', async t => {
  const { service, mediaStore, imageStore, windows } = fixture(t);
  await mediaStore.save({ data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64'), mimeType: 'video/webm', name: 'Imported shot.webm' });
  const result = await service.extractFrame({ assetId: videoId });
  assert.equal(result.assetId, imageId);
  assert.equal(result.sourceAssetId, videoId);
  assert.equal(result.timestampSeconds, 1.96);
  assert.equal(result.position, 'last');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.filename, undefined);
  assert.equal((await imageStore.get(imageId)).data, jpeg);
  assert.match((await imageStore.get(imageId)).name, /Imported shot.*1\.960/);
  assert.equal((await imageStore.list())[0].id, imageId);
  assert.equal(windows[0].muted, true);
  assert.equal(windows[0].destroyed, true);
});

test('project digest videos pass the selected project to the managed resolver', async t => {
  const digestId = 'c'.repeat(64), projectId = 'd'.repeat(32);
  const { service } = fixture(t, { decode: async () => ({ ...decoded, timestampSeconds: 0.72 }), readVideoSource: async reference => {
    assert.deepEqual(reference, { assetId: digestId, projectId });
    return { id: digestId, mimeType: 'video/mp4', bytes: 4, buffer: Buffer.from([0, 0, 0, 0]) };
  } });
  const result = await service.extractFrame({ assetId: digestId, projectId, timestampSeconds: 0.75 });
  assert.equal(result.sourceAssetId, digestId);
  assert.equal(result.position, undefined);
  assert.equal(result.requestedTimestampSeconds, 0.75);
});

test('invalid extraction arguments and non-video sources never reach the decoder or create assets', async t => {
  let resolutions = 0;
  const { service, imageStore, windows } = fixture(t, { readVideoSource: async () => { resolutions++; return { mimeType: 'image/png', bytes: 4 }; } });
  for (const options of [{ assetId: '0'.repeat(32) }, { assetId: '../path' }, { assetId: videoId, timestampSeconds: -1 },
    { assetId: videoId, timestampSeconds: Infinity }, { assetId: videoId, position: 'last', timestampSeconds: 1 },
    { assetId: videoId, maxWidth: 3000 }, { assetId: videoId, url: 'https://example.test' }]) {
    await assert.rejects(service.extractFrame(options), /invalid|choose|between|only|cannot/i);
  }
  assert.equal(resolutions, 0);
  await assert.rejects(service.extractFrame({ assetId: videoId }), /video/);
  assert.equal(windows.length, 0);
  assert.equal((await imageStore.list()).length, 0);
});

test('a stopped or timed-out extraction closes its decoder and saves no image', async t => {
  const { service, imageStore, windows } = fixture(t, { decode: () => new Promise(() => {}), timeoutMs: 15,
    readVideoSource: async () => ({ mimeType: 'video/mp4', bytes: 4, buffer: Buffer.alloc(4) }) });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.extractFrame({ assetId: videoId }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(windows.length, 0);
  await assert.rejects(service.extractFrame({ assetId: videoId }), /timed out/);
  assert.equal(windows[0].destroyed, true);
  const running = new AbortController();
  const extraction = service.extractFrame({ assetId: videoId }, { signal: running.signal });
  await new Promise(setImmediate);
  running.abort();
  await assert.rejects(extraction, { name: 'AbortError' });
  assert.equal(windows[1].destroyed, true);
  assert.equal((await imageStore.list()).length, 0);
});

test('Stop during decoder initialization never starts a window or waits for decoding timeout', async t => {
  let finishSetup, setupStarted;
  const started = new Promise(resolve => { setupStarted = resolve; });
  const setup = new Promise(resolve => { finishSetup = resolve; });
  const { service, imageStore, windows } = fixture(t, {
    initializeSession: async () => { setupStarted(); await setup; },
    loadURL: () => new Promise(() => {}),
    timeoutMs: 30,
    readVideoSource: async () => ({ mimeType: 'video/mp4', bytes: 4, buffer: Buffer.alloc(4) }),
  });
  const controller = new AbortController();
  const extraction = service.extractFrame({ assetId: videoId }, { signal: controller.signal });
  await started;
  controller.abort();
  finishSetup();
  await assert.rejects(extraction, { name: 'AbortError' });
  assert.equal(windows.length, 0, 'Canceled initialization must not open a decoder whose load can stall.');
  assert.equal((await imageStore.list()).length, 0);
});

test('a queued extraction aborts before an earlier poster finishes without starting or saving', async t => {
  let finishPoster, posterStarted;
  const started = new Promise(resolve => { posterStarted = resolve; });
  const poster = new Promise(resolve => { finishPoster = resolve; });
  let decodes = 0;
  const { service, mediaStore, imageStore, windows } = fixture(t, { decode: () => {
    if (!decodes++) { posterStarted(); return poster; }
    return decoded;
  } });
  await mediaStore.save({ data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64'), mimeType: 'video/webm' });
  const earlier = service.enrichAssets([{ assetId: videoId, mimeType: 'video/webm' }]);
  await started;
  const controller = new AbortController();
  let settled = false;
  const queued = service.extractFrame({ assetId: videoId }, { signal: controller.signal }).then(
    result => { settled = true; return result; },
    error => { settled = true; return error; },
  );
  try {
    controller.abort();
    await new Promise(setImmediate);
    assert.equal(settled, true, 'Stop must settle queued extraction while the earlier decoder is still unresolved.');
    assert.equal((await queued).name, 'AbortError');
    assert.equal(windows.length, 1);
    assert.equal(windows[0].destroyed, undefined);
    assert.equal((await imageStore.list()).length, 0);
  } finally {
    finishPoster({ thumbnail: 'data:image/jpeg;base64,' + jpeg, width: 640, height: 360, duration: 2 });
    await earlier;
    await queued;
  }
  assert.equal(windows.length, 1, 'A canceled queue entry must not create a decoder after its predecessor finishes.');
  assert.equal((await imageStore.list()).length, 0);
  const next = await service.extractFrame({ assetId: videoId });
  assert.equal(next.assetId, imageId);
  assert.equal(windows.length, 2);
});

test('Stop waits for an extraction image save that has already started', async t => {
  let finishSave, saveStarted;
  const started = new Promise(resolve => { saveStarted = resolve; });
  const saving = new Promise(resolve => { finishSave = resolve; });
  const { service, imageStore } = fixture(t, { readVideoSource: async () => ({ mimeType: 'video/mp4', bytes: 4, buffer: Buffer.alloc(4) }) });
  const originalSave = imageStore.save;
  imageStore.save = async input => { saveStarted(); await saving; return originalSave(input); };
  const controller = new AbortController();
  let settled = false;
  const extraction = service.extractFrame({ assetId: videoId }, { signal: controller.signal }).then(
    result => { settled = true; return result; },
    error => { settled = true; return error; },
  );
  await started;
  try {
    controller.abort();
    await new Promise(setImmediate);
    assert.equal(settled, false, 'A local image write must settle before Stop returns.');
    assert.equal((await imageStore.list()).length, 0);
  } finally { finishSave(); }
  assert.equal((await extraction).assetId, imageId);
  assert.equal((await imageStore.get(imageId)).data, jpeg);
});

test('decoder output cannot persist oversized, malformed or implausible reference images', async t => {
  for (const invalid of [{ ...decoded, data: 'bad bytes' }, { ...decoded, data: Buffer.from('not jpeg').toString('base64') },
    { ...decoded, width: 3000 }, { ...decoded, timestampSeconds: 3 }, { ...decoded, data: 'A'.repeat(6 * 1024 * 1024) }]) {
    const { service, imageStore } = fixture(t, { decode: async () => invalid,
      readVideoSource: async () => ({ mimeType: 'video/mp4', bytes: 4, buffer: Buffer.alloc(4) }) });
    await assert.rejects(service.extractFrame({ assetId: videoId }), /invalid|limit|exceed/i);
    assert.equal((await imageStore.list()).length, 0);
  }
});

test('timestamped extraction rejects a decoder result beyond the requested source time', async t => {
  const { service, imageStore } = fixture(t, { readVideoSource: async () => ({ mimeType: 'video/mp4', bytes: 4, buffer: Buffer.alloc(4) }) });
  await assert.rejects(service.extractFrame({ assetId: videoId, timestampSeconds: 0.75 }), /invalid/);
  assert.equal((await imageStore.list()).length, 0);
});

test('managed source resolution streams library videos and does not bypass integrity failures', async t => {
  const { mediaStore } = fixture(t);
  await mediaStore.save({ data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64'), mimeType: 'video/webm' });
  const resolve = createManagedVideoSourceResolver({ mediaStore, readMediaReference: () => assert.fail('A saved library video must not fall back to a base64 read.') });
  const source = await resolve({ assetId: videoId });
  assert.equal(source.buffer, undefined);
  assert.equal(source.data, undefined);
  assert.equal(fs.existsSync(source.filename), true);
  fs.writeFileSync(source.filename, Buffer.from([0x1a, 0x45, 0xdf, 0xa4]));
  await assert.rejects(resolve({ assetId: videoId }), /corrupted/);
});

test('project video sources stay bounded and serve exact byte ranges without tool serialization', async t => {
  const digestId = 'c'.repeat(64), projectId = 'd'.repeat(32);
  let asset = { mimeType: 'video/webm', data: 'GkXfow==', bytes: 4, name: 'Project source' };
  const resolve = createManagedVideoSourceResolver({ mediaStore: { getPlaybackSource: () => assert.fail('Digest assets are project sources.') },
    readMediaReference: reference => { assert.deepEqual(reference, { assetId: digestId, projectId }); return asset; } });
  const source = await resolve({ assetId: digestId, projectId });
  const response = await localMediaResponse(new Request('easel-canvas://video-metadata/media', { headers: { range: 'bytes=1-2' } }), source);
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0x45, 0xdf]));
  for (const invalid of [{ mimeType: 'image/jpeg', data: jpeg }, { mimeType: 'video/mp4', data: 'invalid' },
    { mimeType: 'video/mp4', data: 'GkXfow==', bytes: 8 }, { mimeType: 'video/mp4', data: 'A'.repeat(45 * 1024 * 1024) }]) {
    asset = invalid;
    await assert.rejects(resolve({ assetId: digestId, projectId }), /video|bytes|32 MiB/);
  }
});

test('host extraction returns compact metadata plus one observation and exposes an uploadable saved ID', async () => {
  const saved = { ...decoded, assetId: imageId, sourceAssetId: videoId, position: 'last', name: 'Last frame.jpg', bytes: 4 };
  const events = [];
  const controller = { async extractVideoFrame() { return saved; }, async readMediaAsset({ assetId }) {
    assert.equal(assetId, imageId); return { data: jpeg, mimeType: 'image/jpeg' };
  } };
  const direct = await executeEaselTool('extract_video_frame', { assetId: videoId }, { canvasController: controller, onEvent: event => events.push(event) });
  const metadata = JSON.parse(direct.content);
  assert.equal(metadata.assetId, imageId);
  assert.equal(metadata.data, undefined);
  assert.equal(direct.captures.length, 1);
  assert.equal(events.filter(event => event.type === 'image').length, 1);
  assert.equal(producedMediaAssets(metadata, 'extract_video_frame')[0].assetId, imageId);
  const mediaCalls = [];
  const host = createEaselToolHost({ canvasController: controller, createMediaClient: async () => ({
    async listTools() { return [{ name: 'generate_video', inputSchema: { type: 'object', properties: { model: { type: 'string' }, prompt: { type: 'string' }, inputReference: { type: 'object' } } } }]; },
    async callTool(name, args) { mediaCalls.push({ name, args }); return { content: [], structuredContent: { ok: true } }; }, async close() {},
  }), onEvent: event => events.push(event) });
  const result = await host.callTool('extract_video_frame', { assetId: videoId });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.assetId, imageId);
  assert.equal(result.structuredContent.data, undefined);
  assert.equal(result.content.filter(block => block.type === 'image').length, 1);
  assert.equal(mediaCalls.length, 0);
  const generated = await host.callTool('generate_video', { model: 'video-model', prompt: 'Continue', inputReferenceAssetId: imageId });
  assert.equal(generated.isError, undefined);
  assert.deepEqual(mediaCalls[0].args.inputReference, { data: jpeg, mimeType: 'image/jpeg', name: imageId + '.jpg' });
});

test('built-in history retains the still ID while its pixels remain a transient visual message', async () => {
  let request = 0;
  const result = await runAgentTurn({ userMessage: 'Extract the last frame', listMcpTools: [],
    canvasController: { async extractVideoFrame() { return { ...decoded, assetId: imageId, sourceAssetId: videoId, name: 'Last frame.jpg' }; } },
    assetStore: {}, mcp: { async listTools() { return []; } }, llm: { createCompletion: async options => {
      if (!request++) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'extract', type: 'function', function: { name: 'extract_video_frame', arguments: JSON.stringify({ assetId: videoId }) } }] } }] };
      const observation = options.messages.find(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'));
      assert.equal(observation.content.find(block => block.type === 'image').data, jpeg);
      return { choices: [{ message: { role: 'assistant', content: 'Frame saved.' } }] };
    } } });
  assert.equal(result.text, 'Frame saved.');
  const metadata = JSON.parse(result.history.find(message => message.role === 'tool').content);
  assert.equal(metadata.assetId, imageId);
  assert.equal(JSON.stringify(result.history).includes(jpeg), false);
});
