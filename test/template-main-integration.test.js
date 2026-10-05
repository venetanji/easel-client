const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const { createCanvasStore } = require('../src/canvas-store');
const { createVideoTimelineStore } = require('../src/video-timeline-store');
const { createTemplateInstanceStore } = require('../src/template-instance-store');
const { createTemplateService } = require('../src/template-service');
const { createCanvasHistory, restoreCanvasHistory } = require('../src/canvas-history');
const { IPC_CHANNELS, assertTrustedSender, validateOpaqueId } = require('../src/ipc-contract');

// Run the actual main-process adapters against real durable stores, without
// importing Electron or launching a renderer. Only the runtime/view is inert.
function mainFixture(t, { failPreview = false } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-main-template-history-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const timelines = createVideoTimelineStore({ userDataPath });
  let instances;
  const canvases = createCanvasStore({ userDataPath, listTimelines: (id) => timelines.list(id), listInstances: (id) => instances.list(id) });
  instances = createTemplateInstanceStore({ userDataPath, projectStore: canvases, timelineStore: timelines });
  const history = createCanvasHistory();
  const projectId = canvases.createProject({ title: 'Main history integration', kits: ['canvas-2d'] }).id;
  let documentPath = 'index.html';
  const controller = {
    getCurrentCanvasId: () => projectId, getCurrentDocumentPath: () => documentPath,
    getContract: () => ({ canvasId: projectId, documentPath }), markSourcePendingReload() {},
    saveCurrent: async () => canvases.getDocument(projectId, documentPath),
    openSaved: async (id, selected) => { if (failPreview) throw new Error('Preview failed'); documentPath = selected; return canvases.getDocument(id, selected); },
  };
  const events = [];
  const mainWindow = { isDestroyed: () => false, webContents: { mainFrame: {}, send: (_channel, event) => events.push(event) } };
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const tree = acorn.parse(source, { ecmaVersion: 'latest' });
  const text = (node) => source.slice(node.start, node.end);
  const declaration = (name) => tree.body.flatMap((node) => node.declarations || []).find((node) => node.id.name === name);
  const context = vm.createContext({ CANVASES: canvases, TEMPLATE_INSTANCES: instances, TIMELINES: timelines, CANVAS_KIT_BUNDLES: {}, CANVAS_HISTORY: history,
    canvasView: controller, requireCanvasView: () => controller, CHAT: { isBusy: () => false }, AGENT_CONTROL: { isToolBusy: () => false },
    createTemplateService: (options) => createTemplateService({ ...options, videoFactory: () => '<main id="video-editor">Video</main>' }),
    withCanvas: (action) => action(controller), mainWindow, IPC_CHANNELS, assertTrustedSender, validateOpaqueId, restoreCanvasHistory,
    recordControlChange() {},
    TIMELINE_CONTROLLER: { openEditor: (_id, open) => open() },
  });
  for (const name of ['saveCanvasBeforeSwitch', 'emitCanvasSaved', 'openVideoEditorProject']) vm.runInContext(text(tree.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === name)), context);
  vm.runInContext(`const TEMPLATES = ${text(declaration('TEMPLATES').init)};`, context);
  const controllerProperties = declaration('CANVAS_CONTROLLER').init.properties;
  const tool = (name) => vm.runInContext(`(${text(controllerProperties.find((property) => property.key?.name === name).value)})`, context);
  let undoNode;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.name === 'canvasHandle' && node.arguments[0]?.property?.name === 'UNDO_CANVAS') undoNode = node.arguments[1];
    for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value); }
  }
  visit(tree);
  const undo = vm.runInContext(`(${text(undoNode)})`, context);
  return { projectId, canvases, history, instances, timelines, events,
    create: tool('createTemplateInstance'), launch: tool('createTimeline'),
    undo: () => undo({ sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame }, projectId),
    edit(name, content) { const before = canvases.get(projectId).html; canvases.writeFile(projectId, { path: name, content }); history.record(projectId, before); },
  };
}
for (const route of ['add', 'launcher']) test(`main_${route}_shares_history_and_surfaces_disabled_boundary_after_later_undo`, async (t) => {
  const f = mainFixture(t);
  f.edit('before.txt', 'Existing source work');
  const created = route === 'add'
    ? await f.create({ templateId: 'video-editor', target: 'current-project' })
    : await f.launch({ projectId: f.projectId });
  assert.equal(created.undoAvailable, false);
  assert.match(created.undoBlockedReason, /Undo stops.*template/);
  assert.equal(f.events.at(-1).undoBlockedReason, created.undoBlockedReason);
  const timeline = f.timelines.snapshot(f.projectId, created.timelineId);
  f.edit('later.txt', 'Later source edit');
  const undone = await f.undo();
  assert.equal(undone.undone, true); assert.equal(undone.undoAvailable, false);
  assert.equal(undone.undoBlockedReason, created.undoBlockedReason);
  assert.equal(f.events.at(-1).undoBlockedReason, created.undoBlockedReason);
  await assert.rejects(f.undo(), /Undo stops.*template/);
  assert.equal(f.canvases.readFile(f.projectId, { path: 'before.txt' }).text, 'Existing source work');
  assert.equal(f.canvases.listDocuments(f.projectId).documents.some((entry) => entry.path === created.documentPath), true);
  assert.deepEqual(f.timelines.snapshot(f.projectId, created.timelineId), timeline);
  assert.equal(f.history.getUndoState(f.projectId).undoHistoryEntries, 1);
});


test('main_preview_failure_still_publishes_the_current_project_history_boundary', async (t) => {
  const f = mainFixture(t, { failPreview: true });
  f.edit('before.txt', 'Existing source work');
  const created = await f.create({ templateId: 'video-editor', target: 'current-project' });
  assert.equal(created.opened, false);
  assert.equal(f.events.at(-1)?.undoAvailable, false);
  assert.equal(f.events.at(-1)?.undoBlockedReason, created.undoBlockedReason);
  assert.equal(f.events.at(-1)?.documentPath, 'index.html');
  assert.equal(f.history.getUndoState(f.projectId).undoHistoryEntries, 1);
});
