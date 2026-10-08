const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCanvasInputStore, validateApprovedMediaModel } = require('../src/canvas-input-store');
const { canvasInputSummary } = require('../src/canvas-input');

const canvasId = 'a'.repeat(32);
const chatId = 'b'.repeat(32);
const origin = { backend: 'codex', chatId, threadId: 'thread_123-abcd', model: 'gpt-6.1-sol' };
const choice = { canvasId, chatId, question: 'Which color?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] };
const media = { canvasId, chatId, attachments: [{ assetId: 'c'.repeat(32), type: 'image', name: 'Capture.png', mimeType: 'image/png' }] };

function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'easel-canvas-input-store-'));
  t.after(() => { if (path.dirname(path.resolve(root)) !== tempRoot) throw new Error('Unexpected fixture directory.'); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store: createCanvasInputStore({ userDataPath: root }) };
}

test('canvas choice origin survives restart, summary and submission', (t) => {
  const { root, store } = fixture(t);
  const saved = store.create({ ...choice, origin });
  const restored = createCanvasInputStore({ userDataPath: root });
  assert.deepEqual(restored.get(saved.id).origin, origin);
  assert.deepEqual(restored.list()[0].origin, origin);
  const submitted = restored.submit({ requestId: saved.id, canvasId, value: 'blue' });
  assert.deepEqual(canvasInputSummary(submitted).origin, origin);
});

test('old builtin choices remain compatible without adding origin metadata', (t) => {
  const { store } = fixture(t);
  const saved = store.create(choice);
  assert.equal(Object.hasOwn(store.get(saved.id), 'origin'), false);
  assert.equal(Object.hasOwn(store.list()[0], 'origin'), false);
});

test('media captures persist honest Codex and external approved destinations', (t) => {
  const { store } = fixture(t);
  const codex = store.createMedia({ ...media, origin, approvedModel: { backend: 'codex', model: origin.model } });
  assert.deepEqual(store.get(codex.id).approvedModel, { backend: 'codex', model: origin.model });
  assert.deepEqual(store.list()[0].origin, origin);
  assert.equal(canvasInputSummary(codex).approvedModel, undefined);
  const external = store.createMedia({ ...media, origin: { backend: 'external', chatId }, approvedModel: { backend: 'external' } });
  assert.deepEqual(store.get(external.id).approvedModel, { backend: 'external' });
});

test('builtin approved media destinations retain endpoint validation and defaults', () => {
  const approved = { connectionId: 'd'.repeat(32), model: 'agent', baseUrl: 'https://models.example/v1/' };
  assert.deepEqual(validateApprovedMediaModel(approved), { ...approved, baseUrl: 'https://models.example/v1' });
  assert.equal(validateApprovedMediaModel({ ...approved, backend: 'builtin' }).backend, 'builtin');
  for (const changes of [{ connectionId: 'not-an-id' }, { baseUrl: 'https://key@models.example/v1' }, { baseUrl: 'file:///private' }, { baseUrl: 'https://models.example/v1?key=secret' }, { apiKey: 'secret' }]) assert.throws(() => validateApprovedMediaModel({ ...approved, ...changes }));
});

test('canvas origins and approved destinations reject secrets, extras and invalid bounds', (t) => {
  const { store } = fixture(t);
  for (const invalid of [{ ...origin, token: 'private' }, { ...origin, baseUrl: 'https://models.example' }, { ...origin, backend: 'unknown' }, { ...origin, chatId: 'bad' }, { ...origin, threadId: 'a'.repeat(161) }, { ...origin, threadId: 'thread/escape' }, { ...origin, model: 'a'.repeat(257) }, { ...origin, model: 'agent\nsecret' }, null]) assert.throws(() => store.create({ ...choice, origin: invalid }));
  assert.throws(() => validateApprovedMediaModel({ backend: 'codex', model: 'agent', apiKey: 'secret' }));
  assert.throws(() => validateApprovedMediaModel({ backend: 'codex' }));
  assert.throws(() => validateApprovedMediaModel({ backend: 'external', model: 'unknown' }));
  assert.throws(() => store.create({ ...choice, origin, chatId: '' }), /Chat ID/);
});

test('instance-bound choices validate identity, restore and reject stale answers', (t) => {
  const { root, store } = fixture(t), instanceId = 'e'.repeat(32), documentPath = 'sketches/music/index.html';
  const saved = store.create({ ...choice, documentPath, instanceId });
  const restarted = createCanvasInputStore({ userDataPath: root });
  assert.equal(restarted.get(saved.id).instanceId, instanceId);
  assert.equal(restarted.list()[0].instanceId, instanceId);
  for (const wrong of [undefined, 'f'.repeat(32)]) assert.throws(() => restarted.submit({ requestId: saved.id, canvasId, documentPath, value: 'red', ...(wrong ? { instanceId: wrong } : {}) }), /instance|another canvas/i);
  assert.equal(restarted.submit({ requestId: saved.id, canvasId, documentPath, instanceId, value: 'blue' }).status, 'answered');
  assert.throws(() => store.create({ ...choice, documentPath: 'other.html', instanceId: 'bad' }), /Instance ID/i);
});

test('a rebound document can receive a fresh question without reusing the stale one', (t) => {
  const { store } = fixture(t), documentPath = 'music.html';
  const old = store.create({ ...choice, documentPath, instanceId: 'e'.repeat(32) });
  const fresh = store.create({ ...choice, documentPath, instanceId: 'f'.repeat(32) });
  assert.notEqual(fresh.id, old.id);
  assert.equal(store.get(old.id).status, 'pending');
  assert.throws(() => store.create({ ...choice, documentPath, instanceId: fresh.instanceId }), /unanswered/i);
});
