const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatStore } = require('../src/chat-store');

test('saves chats across restarts and keeps them when a new chat starts', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-chat-store-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createChatStore({ userDataPath });
  const history = [{ role: 'user', content: 'Build an instrument' }, { role: 'assistant', content: 'Added Play and Stop.' }];
  const saved = store.save({ title: 'Instrument', history });
  const restarted = createChatStore({ userDataPath });
  assert.deepEqual(restarted.getActive().history, history);
  restarted.activate('');
  assert.equal(restarted.getActive(), null);
  assert.equal(restarted.list()[0].id, saved.id);
  restarted.activate(saved.id);
  assert.deepEqual(restarted.getActive().history, history);
  assert.throws(() => restarted.get('../settings'), /Chat ID is invalid/);
  restarted.save({ id: saved.id, title: 'Instrument', history: [...history, { role: 'user', content: 'Add bass' }] });
  assert.equal(restarted.list().length, 1);
  assert.equal(createChatStore({ userDataPath }).getActive().history.length, 3);
});

test('backend histories retain their own active conversations and reject cross-backend opens', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-chat-scoped-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createChatStore({ userDataPath });
  const legacy = store.save({ title: 'Legacy', history: [{ role: 'user', content: 'First prompt' }] });
  const builtin = store.forBackend('builtin');
  const codex = store.forBackend('codex');
  assert.equal(builtin.getActive().id, legacy.id);
  assert.equal(codex.getActive(), null);
  const thread = codex.save({ title: 'Codex', history: [{ role: 'user', content: 'Other first prompt' }], codexThreadId: 'thread-1', origin: { model: 'model-a' } });
  assert.equal(builtin.getActive().id, legacy.id);
  assert.equal(codex.getActive().id, thread.id);
  assert.throws(() => builtin.get(thread.id), /another agent backend/);
  assert.throws(() => codex.activate(legacy.id), /another agent backend/);
  builtin.activate('');
  assert.equal(builtin.getActive(), null);
  const restarted = createChatStore({ userDataPath });
  assert.equal(restarted.forBackend('codex').getActive().codexThreadId, 'thread-1');
  assert.deepEqual(restarted.forBackend('codex').getActive().origin, { model: 'model-a' });
  assert.deepEqual(restarted.forBackend('codex').list().map((entry) => entry.id), [thread.id]);
  assert.throws(() => codex.save({ title: 'Invalid thread', history: [], codexThreadId: '../secrets' }), /thread ID/);
});
