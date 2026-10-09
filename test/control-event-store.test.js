const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createControlEventStore } = require('../src/control-event-store');

function directory(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-event-test-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return userDataPath;
}

test('Suno receipts retain attempt and track UUIDs across restarts without browser data', (t) => {
  const userDataPath = directory(t);
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const trackId = '22222222-2222-4222-8222-222222222222';
  createControlEventStore({ userDataPath }).append({ type: 'audio-generation', modelId: 'studio:suno-music',
    attemptId, status: 'submitted', trackIds: [trackId, 'invalid'], browser: { cookie: 'private' } });
  const receipt = createControlEventStore({ userDataPath }).read().events[0];
  assert.equal(receipt.attemptId, attemptId);
  assert.equal(receipt.modelId, 'studio:suno-music');
  assert.deepEqual(receipt.trackIds, [trackId]);
  assert.equal(receipt.browser, undefined);
});

test('chat receipt lookup merges status tracks into the original owner and ignores unrelated shared attempts', (t) => {
  const userDataPath = directory(t);
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const trackId = '22222222-2222-4222-8222-222222222222';
  const store = createControlEventStore({ userDataPath });
  store.append({ type: 'audio-generation', toolName: 'generate_music', chatId: 'original', modelId: 'studio:suno-music', attemptId, status: 'submitted', trackIds: [] });
  store.append({ type: 'audio-generation', toolName: 'get_audio_generation_status', chatId: 'other', modelId: 'studio:suno-music', attemptId, status: 'complete', trackIds: [trackId] });
  store.append({ type: 'audio-generation', toolName: 'get_audio_generation_status', chatId: 'original', modelId: 'studio:suno-music', attemptId: trackId, status: 'submitted', trackIds: [] });
  const restored = createControlEventStore({ userDataPath });
  const { generations } = restored.listAudioGenerations({ chatId: 'original' });
  assert.equal(generations.length, 1);
  assert.equal(generations[0].attemptId, attemptId);
  assert.equal(generations[0].status, 'complete');
  assert.deepEqual(generations[0].trackIds, [trackId]);
  assert.deepEqual(restored.listAudioGenerations({ chatId: 'other' }).generations, []);
});

test('persists bounded cursor notifications across restarts and reports gaps', (t) => {
  const userDataPath = directory(t);
  const store = createControlEventStore({ userDataPath, maxEvents: 2 });
  for (let index = 0; index < 4; index++) store.append({ type: 'project-created', projectId: 'a'.repeat(32), title: `Project ${index}` });
  const restored = createControlEventStore({ userDataPath, maxEvents: 2 });
  assert.equal(restored.getCursor(), 4);
  const first = restored.read({ after: 1, limit: 1 });
  assert.equal(first.gap, true); assert.equal(first.nextCursor, 3); assert.equal(first.hasMore, true);
  assert.equal(first.events[0].title, 'Project 2');
  assert.equal(restored.read({ after: first.nextCursor }).events[0].eventId, 4);
  assert.equal(restored.read({ after: 4 }).events.length, 0);
  assert.throws(() => restored.read({ limit: 51 }), /limit/);
  assert.throws(() => createControlEventStore({ userDataPath, maxEvents: 0 }), /capacity/);
});

test('retains canvas answers and job origins while dropping credentials and binary/runtime payloads', (t) => {
  const userDataPath = directory(t);
  const store = createControlEventStore({ userDataPath });
  store.append({ type: 'canvas-input-answer', request: { id: 'input', question: 'Warm or cool?', value: 'warm', options: [{ value: 'warm', label: 'Warm' }, { value: 'cool', label: 'Cool' }], attachments: [{ assetId: 'a'.repeat(32), type: 'audio', name: 'Microphone capture.wav', mimeType: 'audio/wav', data: 'hidden-audio' }], origin: { backend: 'codex', chatId: 'chat', threadId: 'thread', model: 'model', api_key: 'hidden-key' }, data: 'hidden-bytes', authorization: 'hidden-auth' }, apiKey: 'hidden-api-key', accessToken: 'hidden-access', headers: { Authorization: 'hidden-header' } });
  store.append({ type: 'media-job-ready', job: { id: 'job', remoteId: 'remote', status: 'ready', origin: { backend: 'external', chatId: 'chat' }, assets: [{ assetId: 'a'.repeat(32), mimeType: 'image/png', width: 500, data: 'hidden-image-data', thumbnail: 'hidden-thumbnail' }], turnOptions: { credential: 'hidden-credentials' } }, text: 'Bearer secret-auth api_key=secret-key sk-abcdefghijklmnop' });
  const text = fs.readFileSync(path.join(userDataPath, 'control-events.json'), 'utf8');
  assert.doesNotMatch(text, /hidden-|secret-auth|secret-key|sk-abcdefghijklmnop/);
  const events = store.read().events;
  assert.equal(events[0].request.value, 'warm');
  assert.equal(events[0].request.options[0].label, 'Warm');
  assert.equal(events[0].request.origin.threadId, 'thread');
  assert.equal(events[0].request.attachments[0].assetId, 'a'.repeat(32));
  assert.equal(events[0].request.attachments[0].type, 'audio');
  assert.equal(events[1].job.assets[0].width, 500);
  assert.match(events[1].text, /redacted/);
});

test('isolates returned objects and leaves the cursor unchanged when persistence fails', (t) => {
  const userDataPath = directory(t);
  let fail = false;
  const fileSystem = { ...fs, renameSync(...args) { if (fail) throw new Error('Disk full'); return fs.renameSync(...args); } };
  const store = createControlEventStore({ userDataPath, fileSystem });
  const entry = store.append({ type: 'project-created', title: 'Saved title' });
  entry.title = 'Mutated';
  const response = store.read(); response.events[0].title = 'Mutated again';
  assert.equal(store.read().events[0].title, 'Saved title');
  fail = true;
  assert.throws(() => store.append({ type: 'project-created', title: 'Not saved' }), /Disk full/);
  assert.equal(store.read().events.length, 1);
  fail = false;
  assert.equal(store.append({ type: 'project-created' }).eventId, 2);
});

test('sanitizes restored events, rejects malformed cursors, and bounds large answers', (t) => {
  const userDataPath = directory(t);
  const filename = path.join(userDataPath, 'control-events.json');
  fs.writeFileSync(filename, JSON.stringify({ nextId: 2, events: [{ type: 'canvas-input-answer', eventId: 1, timestamp: 1, request: { value: 'warm', accessToken: 'legacy-secret' } }] }));
  const store = createControlEventStore({ userDataPath });
  assert.doesNotMatch(JSON.stringify(store.read()), /legacy-secret/);
  const event = store.append({ type: 'canvas-input-answer', request: { question: 'q'.repeat(9000), options: Array.from({ length: 100 }, (_, index) => ({ value: String(index), label: 'l'.repeat(1000) })) } });
  assert.equal(event.request.question.length, 4000);
  assert.equal(event.request.options.length, 12);
  assert.equal(event.request.options[0].label.length, 400);
  fs.writeFileSync(filename, JSON.stringify({ nextId: 1, events: [{ type: 'project-created', eventId: 1, timestamp: 1 }] }));
  assert.throws(() => createControlEventStore({ userDataPath }), /identity/);
  assert.throws(() => store.append({ type: 'arbitrary-runtime-dump' }), /type/);
});
