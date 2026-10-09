const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const m4a = fs.readFileSync(path.join(__dirname, 'fixtures/strudel-samples/snare.m4a'));

test('bundled drum bank has reproducible nonempty PCM kick, snare and hats', () => {
  const { generateDrumBank } = require('../scripts/generate-strudel-drums.cjs');
  const bank = require('../assets/strudel-drums/bank.json');
  assert.deepEqual(generateDrumBank(), bank);
  assert.deepEqual(bank.samples.map(sample => sample.name), ['bd', 'sd', 'hh', 'oh', 'cp', 'tom', 'rim']);
  for (const sample of bank.samples) {
    const bytes = Buffer.from(sample.data, 'base64');
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(bytes.readUInt32LE(24), 48000);
    assert.equal(bytes.readUInt32LE(40) / 96000, sample.durationSeconds);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sample.digest);
    assert.ok(bytes.subarray(44).some(value => value !== 0));
  }
});

test('sample registry loads attached audio and prevents overriding built-in sounds', async () => {
  const { createStrudelSamples } = require('../src/strudel-samples');
  const bank = require('../assets/strudel-drums/bank.json');
  const native = { samples: async () => {}, loadBuffer: async url => {
    const sample = bank.samples.find(sample => url.endsWith(sample.data));
    return { duration: sample?.durationSeconds ?? 0.2, numberOfChannels: 1, sampleRate: 48000 };
  }, getAudioContext: () => ({}) };
  const id = 'a'.repeat(32), bytes = Buffer.from('attached mp3 bytes');
  const assets = { getUrl: () => 'data:audio/mpeg;base64,' + bytes.toString('base64'), ready: Promise.resolve() };
  const registry = createStrudelSamples(native, bank, () => assets);
  await registry.prepare();
  assert.equal(registry.get('bd').assetId, null);
  assert.equal(registry.list().length, 7);
  await registry.add('suno_snare', id);
  const sample = registry.get('suno_snare');
  assert.equal(sample.assetId, id);
  assert.equal(sample.digest, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(sample.durationSeconds, 0.2);
  await assert.rejects(registry.add('bd', id), /reserved/i);
  await assert.rejects(registry.add('sine', id), /reserved/i);
  await assert.rejects(registry.add('../snare', id), /name/i);
  assert.equal(registry.list().length, 8);
});

test('host captures only attached, bounded sample bytes with the frozen content hash', () => {
  const { captureStrudelSamples } = require('../src/strudel-sample-assets');
  const id = 'a'.repeat(32), bytes = Buffer.from('attached mp3 bytes');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const snapshot = { events: [{ waveform: 'suno_snare', sample: { assetId: id, digest, durationSeconds: 0.2 } }] };
  const store = { getAsset: (_project, assetId) => { assert.equal(assetId, id); return { mimeType: 'audio/mpeg', data: bytes.toString('base64') }; } };
  const captured = captureStrudelSamples(store, 'project', snapshot);
  assert.equal(captured[id].url, 'data:audio/mpeg;base64,' + bytes.toString('base64'));
  assert.throws(() => captureStrudelSamples({ getAsset: () => ({ mimeType: 'audio/mpeg', data: Buffer.from('changed').toString('base64') }) }, 'project', snapshot), /changed|digest/i);
  assert.throws(() => captureStrudelSamples({ getAsset: () => { throw new Error('not attached'); } }, 'project', snapshot), /not attached/);
});

test('sample registry accepts Suno M4A MIME types and retains the original content identity', async () => {
  const { createStrudelSamples } = require('../src/strudel-samples');
  const id = 'b'.repeat(32);
  for (const mimeType of ['audio/mp4', 'audio/x-m4a']) {
    const url = `data:${mimeType};base64,${m4a.toString('base64')}`;
    const registrations = [];
    const native = { getAudioContext: () => ({}), loadBuffer: async () => ({ duration: 0.25, numberOfChannels: 1, sampleRate: 48000 }),
      samples: async mapping => registrations.push(mapping) };
    const registry = createStrudelSamples(native, { samples: [] }, () => ({ ready: Promise.resolve(), getUrl: () => url }));
    const sample = await registry.add('suno_hat', id);
    assert.equal(sample.assetId, id);
    assert.equal(sample.digest, crypto.createHash('sha256').update(m4a).digest('hex'));
    assert.equal(sample.durationSeconds, 0.25);
    assert.deepEqual(registrations, [{ suno_hat: [url] }]);
    assert.ok(registry.supportedFormats.includes('m4a'));
    assert.ok(Object.isFrozen(registry.supportedFormats));
    await registry.add('suno_hat', id);
    assert.equal(registrations.length, 1, 'repeating registration must preserve the existing sound');
  }
});

test('M4A registration retains decoded duration and channel bounds without replacing a good sound', async () => {
  const { createStrudelSamples } = require('../src/strudel-samples');
  const id = 'b'.repeat(32), url = `data:audio/mp4;base64,${m4a.toString('base64')}`;
  let buffer = { duration: 0.25, numberOfChannels: 1, sampleRate: 48000 }, registrations = 0;
  const native = { getAudioContext: () => ({}), loadBuffer: async () => buffer, samples: async () => registrations++ };
  let currentUrl = url;
  const registry = createStrudelSamples(native, { samples: [] }, () => ({ getUrl: () => currentUrl }));
  await registry.add('suno_hat', id);
  const original = registry.get('suno_hat');
  // A new attachment forces decoding instead of taking the identity cache.
  for (const invalid of [{ duration: 10.0135, numberOfChannels: 2 }, { duration: 0.25, numberOfChannels: 3 }]) {
    buffer = { ...invalid, sampleRate: 48000 };
    await assert.rejects(registry.add('suno_hat', 'c'.repeat(32)), /mono or stereo audio up to 10 seconds/);
    assert.deepEqual(registry.get('suno_hat'), original);
  }
  currentUrl = 'data:audio/mp4;base64,' + Buffer.alloc(4 * 1048576 + 1).toString('base64');
  await assert.rejects(registry.add('suno_hat', id), /4 MiB/);
  assert.equal(registrations, 1);
});

test('host captures attached M4A for WAV export without converting or relabeling its bytes', () => {
  const { captureStrudelSamples } = require('../src/strudel-sample-assets');
  const id = 'b'.repeat(32), digest = crypto.createHash('sha256').update(m4a).digest('hex');
  const snapshot = { events: [{ waveform: 'suno_hat', sample: { assetId: id, digest, durationSeconds: 0.25 } }] };
  for (const mimeType of ['audio/mp4', 'audio/x-m4a']) {
    const captured = captureStrudelSamples({ getAsset: () => ({ mimeType, data: m4a.toString('base64') }) }, 'project', snapshot);
    assert.equal(captured[id].url, `data:${mimeType};base64,${m4a.toString('base64')}`);
    assert.equal(captured[id].digest, digest);
    assert.throws(() => captureStrudelSamples({ getAsset: () => ({ mimeType, data: Buffer.from('changed').toString('base64') }) }, 'project', snapshot), /changed|digest/i);
  }
});
