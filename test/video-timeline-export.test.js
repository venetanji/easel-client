const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const filename = require('node:path').join(__dirname, '../src/video-timeline-export.js');
const exporter = fs.existsSync(filename) ? require(filename) : {};
const assetId = 'a'.repeat(64);
function timeline(changes = {}) {
  return { schemaVersion: 1, id: 'demo', revision: 0, frameRate: { numerator: 24, denominator: 1 }, width: 1280, height: 720,
    tracks: [{ id: 'v', type: 'video', name: 'Video' }, { id: 'a', type: 'audio', name: 'Audio' }, { id: 'o', type: 'overlay', name: 'Overlay' }],
    items: [{ id: 'clip', trackId: 'v', assetId, startFrame: 0, endFrame: 24, sourceStartSeconds: 0, sourceEndSeconds: 1 }], transitions: [], ...changes };
}
test('export plan snapshots the timeline and preserves rational frame timing', () => {
  assert.equal(typeof exporter.planVideoExport, 'function');
  const source = timeline({ frameRate: { numerator: 30000, denominator: 1001 } });
  source.items[0].endFrame = 30; source.items[0].sourceEndSeconds = 1.001;
  const plan = exporter.planVideoExport(source);
  assert.equal(plan.duration, 1.001); assert.equal(plan.fps, 30000 / 1001);
  source.items[0].assetId = 'b'.repeat(64);
  assert.equal(plan.items[0].assetId, assetId);
});
test('bounded export rejects empty, oversized, high frame rate, long, and effect timelines', () => {
  for (const [changes, pattern] of [[{ items: [] }, /empty/i], [{ width: 8192 }, /resolution/i],
    [{ frameRate: { numerator: 120, denominator: 1 } }, /frame rate/i], [{ transitions: [{}] }, /transition/i]]) {
    assert.throws(() => exporter.planVideoExport(timeline(changes)), pattern);
  }
  const long = timeline(); long.items[0].endFrame = 24 * 61; long.items[0].sourceEndSeconds = 61;
  assert.throws(() => exporter.planVideoExport(long), /60 seconds/i);
});
test('invalid tracks, repeated items, overlaps and nonfinite numbers fail before browser work', () => {
  const missing = timeline(); missing.items[0].trackId = 'gone';
  assert.throws(() => exporter.planVideoExport(missing), /track/i);
  const duplicate = timeline(); duplicate.items.push({ ...duplicate.items[0] });
  assert.throws(() => exporter.planVideoExport(duplicate), /unique|overlap/i);
  const invalid = timeline(); invalid.items[0].gain = NaN;
  assert.throws(() => exporter.planVideoExport(invalid), /gain/i);
});
test('source retiming is rejected instead of silently changing trim semantics', () => {
  const value = timeline(); value.items[0].sourceEndSeconds = 2;
  assert.throws(() => exporter.planVideoExport(value), /retiming/i);
});
test('overlay items cannot silently accept audio controls', () => {
  const value = timeline(); value.items[0].trackId = 'o'; value.items[0].gain = 0.5;
  assert.throws(() => exporter.planVideoExport(value), /overlay/i);
});
test('feature detection checks WebM encoders at the actual requested size', async () => {
  const plan = { width: 1280, height: 720, fps: 24 };
  assert.equal(await exporter.chooseWebMVideoCodec({ canEncodeVideo: async (codec, options) => codec === 'vp9' && options.width === 1280 }, plan), 'vp9');
  await assert.rejects(() => exporter.chooseWebMVideoCodec({ canEncodeVideo: async () => false }, plan), /WebM/i);
});
test('fitting portrait media preserves aspect ratio and centers letterboxing', () => {
  assert.deepEqual(exporter.containRect(200, 400, 1280, 720), { x: 460, y: 0, width: 360, height: 720 });
});
test('managed asset validation disallows URLs, malformed data, unsupported media and excessive bytes', () => {
  assert.throws(() => exporter.validateExportAsset({ url: 'https://example.com/test.mp4', mimeType: 'video/mp4' }), /base64/i);
  assert.throws(() => exporter.validateExportAsset({ data: 'bad%%%data', mimeType: 'video/mp4' }), /base64/i);
  assert.throws(() => exporter.validateExportAsset({ data: 'AAAA', mimeType: 'image/svg+xml' }), /media type/i);
  assert.equal(exporter.validateExportAsset({ data: 'AAAA', mimeType: 'video/mp4' }).bytes, 3);
});
test('aborting before export does not fetch media or require a browser', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(() => exporter.exportVideoTimeline({ timeline: timeline(), signal: controller.signal, getAsset: () => { calls++; } }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
test('missing browser capability returns a clear failure instead of a placeholder file', async () => {
  await assert.rejects(() => exporter.exportVideoTimeline({ timeline: timeline(), getAsset: async () => ({ data: 'AAAA', mimeType: 'video/webm' }) }), /browser|Mediabunny/i);
});
test('browser script registers the same API without Node integration', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  assert.equal(typeof context.EaselVideoExport.exportVideoTimeline, 'function');
  assert.equal(context.EaselVideoExport.EXPORT_LIMITS.maxDurationSeconds, 60);
});

test('PCM mixing respects source trim, timeline placement, mono duplication, gain and fades', () => {
  const left = new Float32Array(12), right = new Float32Array(12);
  const output = { sampleRate: 4, length: 12, numberOfChannels: 2, getChannelData: n => [left,right][n] };
  const input = { sampleRate: 4, length: 8, numberOfChannels: 1, duration: 2, getChannelData: () => new Float32Array(8).fill(1) };
  exporter.mixAudioBuffer(output, { buffer: input, timestamp: 0 }, { startFrame: 4, endFrame: 8, sourceStartSeconds: 1, sourceEndSeconds: 2, gain: 0.5, fadeInFrames: 2, fadeOutFrames: 0 }, 4, 0);
  assert.deepEqual([...left], [0,0,0,0,0,0.25,0.5,0.5,0,0,0,0]);
  assert.deepEqual([...right], [...left]);
});
test('even small source-speed differences are rejected rather than exported at a different speed', () => {
  const value = timeline(); value.items[0].sourceEndSeconds = 1.01;
  assert.throws(() => exporter.planVideoExport(value), /retiming/i);
});
test('PCM mixing preserves stereo channels while resampling and sums independent layers', () => {
  const channels = [new Float32Array(4), new Float32Array(4)];
  const output = { sampleRate: 4, length: 4, numberOfChannels: 2, getChannelData: n => channels[n] };
  const sourceChannels = [new Float32Array([0, 1]), new Float32Array([1, 0])];
  const source = { sampleRate: 2, length: 2, numberOfChannels: 2, getChannelData: n => sourceChannels[n] };
  const item = { startFrame: 0, endFrame: 4, sourceStartSeconds: 0, sourceEndSeconds: 1, gain: 0.5 };
  exporter.mixAudioBuffer(output, { buffer: source, timestamp: 0 }, item, 4);
  exporter.mixAudioBuffer(output, { buffer: source, timestamp: 0 }, item, 4);
  assert.deepEqual([...channels[0]], [0, 0.5, 1, 1]);
  assert.deepEqual([...channels[1]], [1, 0.5, 0, 0]);
});
test('surround audio is rejected instead of silently losing channels', () => {
  assert.throws(() => exporter.mixAudioBuffer({}, { buffer: { numberOfChannels: 6 } }, {}, 24), /mono and stereo/i);
});
function pngHeader(width, height) {
  const bytes = Buffer.from(fs.readFileSync(require('node:path').join(__dirname, 'fixtures/video-export/overlay.png')));
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
test('image allocation budget is checked from headers before decoding any oversized bitmap', async () => {
  let decodes = 0;
  const context = vm.createContext({ EaselMediabunny: { canEncodeVideo: async () => true }, document: {}, VideoEncoder: function () {},
    createImageBitmap: async () => { decodes++; throw new Error('Oversized image reached the decoder'); },
    Blob, Uint8Array, atob, btoa, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  await assert.rejects(() => context.EaselVideoExport.exportVideoTimeline({ timeline: timeline(),
    getAsset: async () => ({ data: pngHeader(10000, 10000).toString('base64'), mimeType: 'image/png' }) }), /decoded image.*budget|image.*memory/i);
  assert.equal(decodes, 0);
});
test('cumulative decoded-image budget rejects before allocating the next image and closes prior bitmaps', async () => {
  let decodes = 0, closes = 0;
  const context = vm.createContext({ EaselMediabunny: { canEncodeVideo: async () => true }, document: {}, VideoEncoder: function () {},
    createImageBitmap: async () => { decodes++; return { width: 4000, height: 2000, close() { closes++; } }; },
    Blob, Uint8Array, atob, btoa, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  const value = timeline();
  value.items = ['a', 'b', 'c'].map((letter, index) => ({ ...value.items[0], id: letter, assetId: letter.repeat(64), startFrame: index * 24, endFrame: (index + 1) * 24 }));
  await assert.rejects(() => context.EaselVideoExport.exportVideoTimeline({ timeline: value,
    getAsset: async () => ({ data: pngHeader(4000, 2000).toString('base64'), mimeType: 'image/png' }) }), /decoded image.*budget|image.*memory/i);
  assert.equal(decodes, 2); assert.equal(closes, 2);
});
test('durable smoke never starts an unauthenticated display listener', () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/smoke-video-export.cjs'), 'utf8');
  assert.doesNotMatch(source, /spawn\(['"]\/usr\/lib\/xorg\/Xorg/);
  assert.doesNotMatch(source, /['"]-ac['"]|['"]-listen['"],\s*['"]tcp['"]/);
  assert.match(source, /xvfb-run -a npm run test:video-export/);
});
