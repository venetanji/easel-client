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
