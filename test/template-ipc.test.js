const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/ipc-contract');
const projectId = 'a'.repeat(32), instanceId = 'b'.repeat(32);
test('template IPC accepts only narrow host-derived create and open identities', () => {
  assert.equal(typeof contract.validateTemplateCreate, 'function', 'Template create validation must exist');
  assert.equal(typeof contract.validateTemplateOpen, 'function', 'Template open validation must exist');
  assert.deepEqual(contract.validateTemplateCreate({ templateId: 'video-editor', target: 'current-project', projectId, title: ' Film ' }), { templateId: 'video-editor', target: 'current-project', projectId, title: 'Film' });
  assert.deepEqual(contract.validateTemplateOpen({ projectId, instanceId }), { projectId, instanceId });
  for (const input of [null, [], {}, { templateId: 'video-editor', target: 'filesystem' }, { templateId: 'video-editor', target: 'new-project', projectId }, { templateId: 'video-editor', target: 'current-project', path: '../index.html' }, { templateId: 'video-editor', target: 'current-project', instanceId }, { templateId: 'video-editor', target: 'current-project', html: '<p>injected</p>' }]) assert.throws(() => contract.validateTemplateCreate(input));
  for (const input of [null, {}, { projectId, instanceId: 4 }, { projectId, instanceId, timelineId: instanceId }, { projectId, instanceId, documentPath: 'index.html' }]) assert.throws(() => contract.validateTemplateOpen(input));
  assert.equal(contract.assertKnownChannel(contract.IPC_CHANNELS.LIST_TEMPLATES), 'templates:list');
  assert.equal(contract.assertKnownChannel(contract.IPC_CHANNELS.CREATE_TEMPLATE_INSTANCE), 'templates:create');
  assert.equal(contract.assertKnownChannel(contract.IPC_CHANNELS.OPEN_TEMPLATE_INSTANCE), 'templates:open');
});

function ipcModule() {
  const fs = require('node:fs'), path = require('node:path');
  assert.ok(fs.existsSync(path.join(__dirname, '../src/template-ipc.js')), 'Narrow template IPC registration must exist');
  return require('../src/template-ipc');
}
test('template IPC rejects canvas or subframe callers before touching the service', async () => {
  const { registerTemplateIpc } = ipcModule();
  const handlers = new Map(), calls = [];
  const mainWindow = { webContents: { mainFrame: {} } };
  registerTemplateIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    assertSender: (event) => contract.assertTrustedSender(event, mainWindow),
    withCanvas: (fn) => fn(),
    service: { listTemplates: (input) => calls.push(['list', input]), createTemplateInstance: (input) => calls.push(['create', input]), openTemplateInstance: (input) => calls.push(['open', input]) },
  });
  const trusted = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
  for (const fn of handlers.values()) for (const event of [{ sender: {}, senderFrame: {} }, { ...trusted, senderFrame: {} }]) await assert.rejects(async () => fn(event, {}), /Untrusted/);
  assert.deepEqual(calls, []);
  const create = { templateId: 'video-editor', target: 'current-project' };
  await handlers.get('templates:create')(trusted, create);
  await handlers.get('templates:open')(trusted, { projectId, instanceId });
  await handlers.get('templates:list')(trusted, { includePlanned: false });
  assert.deepEqual(calls, [['create', create], ['open', { projectId, instanceId }], ['list', { includePlanned: false }]]);
});
test('native choice supports every legacy candidate and cancellation without choosing silently', async () => {
  const { chooseTemplateInstance } = ipcModule();
  const choice = { status: 'choice-required', kind: 'legacy', projectId, message: 'Choose the owner.', choices: Array.from({ length: 12 }, (_, i) => ({ documentPath: `copies/${i}/index.html`, title: `Copy ${i}` })) };
  const dialogs = [], responses = [9, 2];
  const result = await chooseTemplateInstance(choice, async (options) => { dialogs.push(options); return { response: responses.shift() }; });
  assert.deepEqual(result, { projectId, legacyDocumentPath: 'copies/9/index.html' });
  assert.equal(dialogs.length, 2); assert.equal(dialogs[0].defaultId, 0); assert.equal(dialogs[0].cancelId, 0);
  assert.match(dialogs[1].detail, /copies\/9\/index.html/);
  assert.equal(await chooseTemplateInstance(choice, async () => ({ response: 0 })), null);
  assert.equal(await chooseTemplateInstance(choice, async () => ({ response: 99 })), null);
});
