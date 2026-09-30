const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentControl } = require('../src/agent-control');

function directory(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-control-test-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return userDataPath;
}

test('persists backend, model, and external chat identity without credentials', (t) => {
  const userDataPath = directory(t);
  const control = createAgentControl({ userDataPath });
  assert.equal(control.getBackend(), 'builtin');
  assert.throws(() => control.authorizeConnection({ sessionId: 'a' }), { code: 'CONTROL_DISABLED' });
  control.setBackend('external');
  control.selectCodexModel(' studio/model ');
  const chatId = control.getExternalChatId();
  assert.match(chatId, /^[a-f0-9]{32}$/);
  const restored = createAgentControl({ userDataPath });
  assert.equal(restored.getBackend(), 'external');
  assert.equal(restored.getCodexModel(), 'studio/model');
  assert.equal(restored.getExternalChatId(), chatId);
  assert.throws(() => control.setBackend('unknown'), /Choose/);
  assert.throws(() => control.selectCodexModel('bad\nmodel'), /invalid/);
});

test('allows one controller and serializes tools while locking preference changes', async (t) => {
  const control = createAgentControl({ userDataPath: directory(t) });
  control.setBackend('external');
  control.authorizeConnection({ sessionId: 'a', name: 'Studio controller' });
  assert.throws(() => control.authorizeConnection({ sessionId: 'b' }), { code: 'CONTROL_BUSY' });
  let complete;
  const started = [];
  const first = control.runTool('a', async () => { started.push('first'); return new Promise((resolve) => { complete = resolve; }); });
  const second = control.runTool('a', async () => { started.push('second'); return 'two'; });
  await new Promise(setImmediate);
  assert.deepEqual(started, ['first']);
  assert.equal(control.getState().busy, true);
  assert.throws(() => control.setBackend('codex'), { code: 'CONTROL_BUSY' });
  assert.throws(() => control.selectCodexModel('new'), { code: 'CONTROL_BUSY' });
  complete('one');
  assert.equal(await first, 'one'); assert.equal(await second, 'two');
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(control.getState().busy, false);
  assert.equal(control.getState().controller.name, 'Studio controller');
  assert.equal('sessionId' in control.getState().controller, false);
});

test('rejects canceled and disconnected queued tools without breaking later tools', async (t) => {
  const control = createAgentControl({ userDataPath: directory(t) });
  control.setBackend('external'); control.authorizeConnection({ sessionId: 'a' });
  let complete;
  const first = control.runTool('a', () => new Promise((resolve) => { complete = resolve; }));
  const abort = new AbortController();
  const queued = control.runTool('a', () => assert.fail('canceled tool ran'), abort.signal);
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  await new Promise(setImmediate);
  abort.abort(); complete(); await first; await rejected;
  assert.equal(await control.runTool('a', () => 'recovered'), 'recovered');
  let release;
  const active = control.runTool('a', () => new Promise((resolve) => { release = resolve; }));
  const stale = control.runTool('a', () => assert.fail('disconnected tool ran'));
  const staleRejected = assert.rejects(stale, { code: 'CONTROL_DISABLED' });
  await new Promise(setImmediate);
  control.releaseConnection('a'); release(); await active; await staleRejected;
  assert.equal(control.isToolBusy(), false);
  control.authorizeConnection({ sessionId: 'b' });
  assert.equal(await control.runTool('b', () => 'new owner'), 'new owner');
});

test('keeps preferences unchanged after a failed durable write and respects background host work', (t) => {
  const userDataPath = directory(t);
  let fail = false;
  let background = false;
  const fileSystem = { ...fs, renameSync(...args) { if (fail) throw new Error('Disk full'); return fs.renameSync(...args); } };
  const control = createAgentControl({ userDataPath, fileSystem, isAgentBusy: () => background });
  control.setBackend('external'); fail = true;
  assert.throws(() => control.setBackend('codex'), /Disk full/);
  assert.equal(control.getBackend(), 'external');
  assert.throws(() => control.selectCodexModel('new-model'), /Disk full/);
  assert.equal(control.getCodexModel(), '');
  assert.equal(fs.readdirSync(userDataPath).some((name) => name.endsWith('.tmp')), false);
  fail = false; background = true;
  assert.throws(() => control.setBackend('builtin'), { code: 'CONTROL_BUSY' });
  assert.equal(control.getState().busy, true);
});
