const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

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
