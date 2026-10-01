const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCanvasMediaStore } = require('../src/canvas-media-store');
const { createVideoMetadataService, localMediaResponse } = require('../src/video-metadata');
const { generatedMediaName } = require('../src/media-names');

const id = 'a'.repeat(32);
const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const thumbnail = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-video-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createCanvasMediaStore({ userDataPath: root, idFactory: () => id }) };
}

test('generated media names use the prompt and correct suffix with safe bounded filenames', () => {
  assert.equal(generatedMediaName('A cat: chasing / fireflies?', 'video/mp4'), 'A cat chasing fireflies.mp4');
  assert.equal(generatedMediaName('Aurora.webm', 'video/mp4'), 'Aurora.mp4');
  assert.equal(generatedMediaName('CON', 'video/webm'), 'CON media.webm');
  assert.ok(generatedMediaName('Long prompt '.repeat(100), 'video/mp4').length < 160);
  assert.equal(generatedMediaName('An image', 'image/png'), undefined);
});

test('metadata updates preserve the asset ID, media bytes, user names and library ordering', async (t) => {
  const { root, store } = fixture(t);
  await store.save({ data: bytes.toString('base64'), mimeType: 'video/webm', name: 'Generated video.webm' });
  const previous = await store.getMetadata(id);
  const source = await store.getPlaybackSource(id);
  assert.equal(source.filename, path.join(root, 'canvas-media', id, 'media.webm'));
  const updated = await store.updateMetadata(id, { name: 'Fireflies.webm', thumbnail, width: 640, height: 360, duration: 2 }, { onlyGenericName: true, expectedDigest: source.digest });
  assert.equal(updated.id, id);
  assert.equal(updated.name, 'Fireflies.webm');
  assert.equal(updated.updatedAt, previous.updatedAt);
  assert.equal(updated.thumbnail, thumbnail);
  assert.equal((await store.get(id)).data, bytes.toString('base64'));
  const renamed = await store.updateMetadata(id, { name: 'Replacement.webm', width: 800 }, { onlyGenericName: true });
  assert.equal(renamed.name, 'Fireflies.webm');
  assert.equal(renamed.width, 800);
});

test('metadata updates reject corrupt media, changed digests, links and unsupported fields', async (t) => {
  const { root, store } = fixture(t);
  await store.save({ data: bytes.toString('base64'), mimeType: 'video/webm' });
  await assert.rejects(store.updateMetadata(id, { path: '../escape' }), /unsupported fields/);
  await assert.rejects(store.updateMetadata(id, { duration: 0 }), /duration/);
  await assert.rejects(store.updateMetadata(id, { thumbnail: 'data:image/jpeg;base64,' + 'A'.repeat(70_000) }), /poster/);
  await assert.rejects(store.updateMetadata(id, { width: 10 }, { expectedDigest: '0'.repeat(64) }), /changed/);
  const filename = path.join(root, 'canvas-media', id, 'media.webm');
  fs.writeFileSync(filename, Buffer.from([0x1a, 0x45, 0xdf, 0xa4]));
  await assert.rejects(store.getPlaybackSource(id), /corrupted/);
  const otherId = 'b'.repeat(32);
  fs.symlinkSync(path.join(root, 'canvas-media', id), path.join(root, 'canvas-media', otherId), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.getPlaybackSource(otherId), /directory is invalid/);
});

test('legacy video metadata migration keeps the same ID and playable bytes', async (t) => {
  const { root, store } = fixture(t);
  const directory = path.join(root, 'canvas-media');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, id + '.webm'), bytes);
  await store.updateMetadata(id, { thumbnail, width: 320, height: 180, duration: 1 });
  assert.equal((await store.get(id)).data, bytes.toString('base64'));
  assert.equal((await store.getMetadata(id)).thumbnail, thumbnail);
  assert.equal(fs.existsSync(path.join(directory, id + '.webm')), false);
  assert.equal(fs.existsSync(path.join(directory, id, 'metadata.json')), true);
});

test('trusted local media responses support bounded ranges without base64 serialization', async (t) => {
  const { store } = fixture(t);
  await store.save({ data: bytes.toString('base64'), mimeType: 'video/webm' });
  const source = await store.getPlaybackSource(id);
  const response = await localMediaResponse(new Request('easel-canvas://video-metadata/media', { headers: { range: 'bytes=1-2' } }), source);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 1-2/4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(1, 3));
  const rejected = await localMediaResponse(new Request('easel-canvas://video-metadata/media', { headers: { range: 'bytes=5-' } }), source);
  assert.equal(rejected.status, 416);
});

function fakeDecoder({ result, decode = async () => result } = {}) {
  const windows = [];
  const guards = {};
  const session = {
    setPermissionCheckHandler(callback) { guards.checkPermission = callback; },
    setPermissionRequestHandler(callback) { guards.requestPermission = callback; },
    webRequest: { onBeforeRequest(filter, callback) { guards.request = callback; } },
    protocol: { async handle(scheme, callback) { guards.resource = callback; }, async unhandle() {} },
  };
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setAudioMuted = (value) => { this.muted = value; };
      this.webContents.setWindowOpenHandler = (callback) => { this.openWindow = callback; };
      this.webContents.executeJavaScript = decode;
      windows.push(this);
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; }
  }
  return { BrowserWindow, sessionFactory: async (partition) => ({ partition, session }), windows, guards };
}

test('sandboxed poster enrichment persists metadata and blocks network, windows and devices', async (t) => {
  const { store } = fixture(t);
  await store.save({ data: bytes.toString('base64'), mimeType: 'video/webm', name: 'Generated video.webm' });
  const decoder = fakeDecoder({ result: { thumbnail, width: 640, height: 360, duration: 3 } });
  const events = [];
  const service = createVideoMetadataService({ ...decoder, mediaStore: store, onChanged: (refs) => events.push(refs) });
  t.after(() => service.close());
  const refs = await service.enrichAssets([{ assetId: id, mimeType: 'video/webm' }], { prompt: 'Fireflies over a lake' });
  assert.equal(refs[0].name, 'Fireflies over a lake.webm');
  assert.equal(refs[0].duration, 3);
  assert.equal(refs[0].thumbnail, undefined);
  assert.equal(refs[0].filename, undefined);
  assert.equal((await store.getMetadata(id)).thumbnail, thumbnail);
  assert.equal(events.length, 1);
  const window = decoder.windows[0];
  assert.equal(window.options.show, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.muted, true);
  assert.equal(window.destroyed, true);
  assert.deepEqual(window.openWindow(), { action: 'deny' });
  assert.equal(decoder.guards.checkPermission(), false);
  decoder.guards.request({ url: 'https://untrusted.example/video' }, (answer) => assert.equal(answer.cancel, true));
});

test('poster failures still provide usable references and a meaningful generic-name backfill', async (t) => {
  const { store } = fixture(t);
  await store.save({ data: bytes.toString('base64'), mimeType: 'video/webm', name: 'Generated video.webm' });
  const decoder = fakeDecoder({ decode: async () => { throw new Error('Unsupported codec'); } });
  const service = createVideoMetadataService({ ...decoder, mediaStore: store });
  t.after(() => service.close());
  await service.backfill({ jobs: [{ prompt: 'Aurora above the sea', assets: [{ assetId: id }] }] });
  assert.equal((await store.getMetadata(id)).name, 'Aurora above the sea.webm');
  assert.equal((await store.getMetadata(id)).thumbnail, '');
});

test('poster decoding times out, closes its window and can resume after service shutdown', async (t) => {
  const { store } = fixture(t);
  await store.save({ data: bytes.toString('base64'), mimeType: 'video/webm' });
  const decoder = fakeDecoder({ decode: () => new Promise(() => {}) });
  const service = createVideoMetadataService({ ...decoder, mediaStore: store, timeoutMs: 10 });
  t.after(() => service.close());
  const refs = [{ assetId: id, mimeType: 'video/webm' }];
  assert.equal((await service.enrichAssets(refs))[0].assetId, id);
  assert.equal(decoder.windows[0].destroyed, true);
  await service.close();
  await service.enrichAssets(refs);
  assert.equal(decoder.windows.length, 2);
  assert.equal(decoder.windows[1].destroyed, true);
});
