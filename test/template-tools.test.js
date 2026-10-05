const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const { toOpenAITools, executeEaselTool, runAgentTurn, validateToolArguments } = require('../src/agent');
const { createEaselToolHost } = require('../src/easel-tool-host');
const { createTemplateService } = require('../src/template-service');
const { createCanvasStore } = require('../src/canvas-store');
const { createCanvasInputStore } = require('../src/canvas-input-store');
const { createTemplateInstanceStore } = require('../src/template-instance-store');
const { createVideoTimelineStore } = require('../src/video-timeline-store');
const { createCanvasHistory } = require('../src/canvas-history');
const { renderCanvasInputScript, dismissCanvasInputScript } = require('../src/canvas-input-runtime');
const { canvasInputSummary, formatCanvasInputMessage } = require('../src/canvas-input');
const projectId = 'a'.repeat(32), instanceId = 'b'.repeat(32), chatId = 'c'.repeat(32);
const question = { question: 'Begin with rhythm or melody?', options: [{ value: 'rhythm', label: 'Rhythm' }, { value: 'melody', label: 'Melody' }], afterSubmit: 'restorePreviousView' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-template-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const timelines = createVideoTimelineStore({ userDataPath: root });
  const canvases = createCanvasStore({ userDataPath: root });
  const instances = createTemplateInstanceStore({ userDataPath: root, timelineStore: timelines, projectStore: canvases });
  const active = canvases.createProject({ title: 'Original project', kits: ['canvas-2d'] }).id;
  const service = createTemplateService({ projectStore: canvases, instanceStore: instances, timelineStore: timelines,
    getCurrentProjectId: () => active, history: createCanvasHistory(), kitBundles: {}, openDocument: async () => ({}) });
  const controller = { listTemplates: service.listTemplates, createTemplateInstance: service.createTemplateInstance, getCurrentCanvasId: () => active };
  const host = createEaselToolHost({ canvasController: controller, getOrigin: () => ({ chatId, origin: { backend: 'codex', chatId, threadId: 'saved-thread' } }),
    createMediaClient: async () => ({ listTools: async () => [], close: async () => {} }) });
  return { root, canvases, instances, service, controller, host };
}

test('both_backends_discover_same_catalog', async (t) => {
  const f = fixture(t);
  const builtin = toOpenAITools([]).filter(({ function: tool }) => ['list_templates', 'create_template_instance'].includes(tool.name));
  const codex = (await f.host.listTools()).filter((tool) => ['list_templates', 'create_template_instance'].includes(tool.name));
  assert.equal(builtin.length, 2, 'Both shared template tools must be registered');
  assert.deepEqual(codex, builtin.map(({ function: tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })));
  const direct = JSON.parse((await executeEaselTool('list_templates', {}, { canvasController: f.controller })).content);
  const hosted = await f.host.callTool('list_templates', {});
  assert.deepEqual(hosted.structuredContent, direct);
  assert.deepEqual(direct.templates.map((entry) => entry.id), f.service.listTemplates().map((entry) => entry.id));
  assert.deepEqual(direct.templates, f.service.listTemplates());
  assert.ok(Buffer.byteLength(JSON.stringify(direct)) <= 12_000);
  assert.ok(direct.templates.filter((entry) => entry.status === 'planned').every((entry) => !entry.availability.available));
  assert.deepEqual((await f.host.callTool('list_templates', { includePlanned: false })).structuredContent.templates.map((entry) => entry.id), ['video-editor', 'strudel-sound']);
  assert.equal((await f.host.callTool('list_templates', { includePlanned: 'yes' })).isError, true);
});

test('creation_requires_specific_target', async (t) => {
  const f = fixture(t);
  const descriptor = toOpenAITools([]).find(({ function: tool }) => tool.name === 'create_template_instance');
  assert.ok(descriptor, 'Creation must be exposed through the shared descriptors');
  const schema = descriptor.function.parameters;
  assert.throws(() => validateToolArguments({ templateId: 'video-editor' }, schema), /target|required/i);
  assert.equal((await f.host.callTool('create_template_instance', { templateId: 'video-editor' })).isError, true);
  assert.equal((await f.host.callTool('create_template_instance', { templateId: 'games', target: 'new-project' })).isError, true);
  const foreign = await f.host.callTool('create_template_instance', { templateId: 'video-editor', target: 'current-project', projectId });
  assert.equal(foreign.isError, true);
  const created = await f.host.callTool('create_template_instance', { templateId: 'video-editor', target: 'new-project', title: 'My movie' });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.opened, true);
  assert.equal(created.structuredContent.templateId, 'video-editor');
  assert.equal(f.instances.list(created.structuredContent.projectId).length, 1);
});

function mainQuestionFixture(t, { bound = true } = {}) {
  const f = fixture(t), inputs = createCanvasInputStore({ userDataPath: f.root });
  const current = f.canvases.createProject({ title: 'Question', kits: ['canvas-2d'] }).id;
  if (bound) f.instances.create({ projectId: current, instanceId, documentPath: 'index.html', templateId: 'strudel-sound', templateVersion: 1 });
  let recoveries = 0;
  const calls = [], submitted = [], controller = { view: { webContents: { send() {} } }, getCurrentCanvasId: () => current, getCurrentDocumentPath: () => 'index.html',
    evaluate: async (script) => { calls.push(['evaluate', script]); }, reloadCanvas: async () => calls.push(['reload']) };
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), tree = acorn.parse(source, { ecmaVersion: 'latest' });
  const declaration = tree.body.flatMap((node) => node.declarations || []).find((node) => node.id.name === 'CANVAS_CONTROLLER');
  const context = vm.createContext({ withCanvas: (action) => action(controller), requireCanvasView: () => controller, canvasView: controller,
    CANVASES: f.canvases, TEMPLATE_INSTANCES: f.instances, CANVAS_INPUTS: inputs, renderCanvasInputScript, dismissCanvasInputScript,
    mainWindow: { webContents: { send() {} } }, IPC_CHANNELS: {}, requireCanvasSender: () => controller,
    currentTimelineScope: () => null, STRUDEL_EXPORT_BRIDGE: { handle: async () => ({ exportReady: true }) },
    CHAT: { getActiveChatId: () => chatId, recoverCanvasInputs() { recoveries++; }, submitCanvasInput: (input) => { submitted.push(input); return inputs.submit(input); } }, ...require('../src/canvas-input') });
  for (const name of ['currentCanvasInputScope', 'canvasInputContextNote']) {
    const node = tree.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === name);
    if (node) vm.runInContext(source.slice(node.start, node.end), context);
  }
  const tool = (name) => { const node = declaration.init.properties.find((property) => property.key.name === name).value; return vm.runInContext(`(${source.slice(node.start, node.end)})`, context); };
  let ready, submit;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Property' && node.key?.name === 'onCanvasReady') ready = node.value;
    if (node.type === 'CallExpression' && node.callee.property?.name === 'handle' && node.arguments[0]?.value === 'canvas:submit-input') submit = node.arguments[1];
    for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value); }
  }
  visit(tree);
  const adapter = (node) => vm.runInContext(`(${source.slice(node.start, node.end)})`, context);
  return { ...f, inputs, current, calls, submitted, tool, ready: adapter(ready), submit: adapter(submit), recoveries: () => recoveries };
}

test('question_restores_without_reset', async (t) => {
  const f = mainQuestionFixture(t);
  const source = f.canvases.readFile(f.current, { path: 'index.html' }).revision;
  const requested = await f.tool('requestCanvasInput')(question, { chatId });
  assert.equal(requested.instanceId, instanceId, 'Main binds the trusted registry identity');
  const submitted = f.inputs.submit({ requestId: requested.id, canvasId: f.current, documentPath: 'index.html', instanceId, value: 'rhythm' });
  await f.tool('completeCanvasInput')(submitted);
  assert.equal(f.canvases.readFile(f.current, { path: 'index.html' }).revision, source);
  assert.equal(f.calls.filter(([name]) => name === 'reload').length, 0);
  assert.match(f.calls.at(-1)[1], /dismissCanvasInput/);
  assert.match(formatCanvasInputMessage(submitted), new RegExp(instanceId));
});

test('stale_instance_answer_rejected', async (t) => {
  const f = fixture(t), store = createCanvasInputStore({ userDataPath: f.root });
  const entry = store.create({ ...question, canvasId: projectId, documentPath: 'sketches/music/index.html', instanceId, chatId });
  const restored = createCanvasInputStore({ userDataPath: f.root });
  assert.equal(restored.get(entry.id).instanceId, instanceId);
  assert.equal(canvasInputSummary(restored.get(entry.id)).instanceId, instanceId);
  assert.throws(() => restored.submit({ requestId: entry.id, canvasId: projectId, documentPath: entry.documentPath, instanceId: 'd'.repeat(32), value: 'rhythm' }), /instance|another canvas/i);
  assert.equal(restored.get(entry.id).status, 'pending');
});

test('question_tool_ends_turn_without_polling_or_later_tool_effects', async () => {
  let completions = 0, patches = 0;
  const saved = { id: 'd'.repeat(32), canvasId: projectId, documentPath: 'sketches/music/index.html', instanceId, chatId, ...question, status: 'pending' };
  const result = await runAgentTurn({ userMessage: 'Explore this sound', llm: { createCompletion: async () => {
    completions++;
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { id: 'choice', type: 'function', function: { name: 'request_canvas_input', arguments: JSON.stringify(question) } },
      { id: 'patch', type: 'function', function: { name: 'execute_canvas_javascript', arguments: '{"code":"return 1"}' } },
    ] } }] };
  } }, mcp: { listTools: async () => [] }, canvasController: { requestCanvasInput: async () => saved, execute: async () => { patches++; } } });
  assert.equal(completions, 1);
  assert.equal(patches, 0);
  assert.equal(result.awaitingCanvasInput.instanceId, instanceId);
  assert.match(result.history.find((entry) => entry.role === 'tool').content, /instanceId/);
});

test('template questions explain latency, source reload and the existing Stop path', async (t) => {
  const f = mainQuestionFixture(t);
  await f.tool('requestCanvasInput')(question, { chatId });
  const script = f.calls[0][1];
  assert.match(script, /model round trip/);
  assert.match(script, /source patches may reload/);
  assert.match(script, /Escape.*Stop/);
});

test('main_does_not_complete_a_question_for_a_rebound_instance', async (t) => {
  const f = mainQuestionFixture(t);
  const request = await f.tool('requestCanvasInput')(question, { chatId });
  f.instances.remove(f.current, instanceId);
  f.instances.create({ projectId: f.current, instanceId: 'd'.repeat(32), documentPath: 'index.html', templateId: 'strudel-sound', templateVersion: 1 });
  const before = f.calls.length;
  await assert.rejects(f.tool('completeCanvasInput')(request), /original|instance/i);
  assert.equal(f.calls.length, before);
});

test('source_patch_does_not_autoplay', async (t) => {
  const f = fixture(t);
  const { createStrudelTemplate } = require('../src/strudel-template');
  const html = createStrudelTemplate({ instanceId }).files['index.html'];
  const saved = f.canvases.save({ title: 'Silent source reload', html, assets: [] });
  const h = await require('./helpers/template-sound-canvas').soundCanvas(f.canvases, saved.id, instanceId);
  t.after(() => h.view.destroy());
  await h.play();
  assert.equal(h.starts(), 1);
  const before = h.starts(), app = f.canvases.listFiles(saved.id).files.find((entry) => entry.path.endsWith('app.js'));
  assert.ok(app, 'The starter keeps the pattern in editable app.js');
  const result = await h.view.applyCanvasFilePatches({ edits: [{ path: app.path, find: "c4 e4 g4 b4", replace: "c4 g4 b4 e4", expectedRevision: app.revision }], reload: true, preserveState: true, validate: false });
  assert.equal(result.ok, true);
  assert.match(f.canvases.readFile(saved.id, { path: app.path }).text, /c4 g4 b4 e4/);
  assert.equal(h.loads(), 2);
  assert.equal(h.starts(), before);
  assert.equal(h.app().getState().playing, false);
  assert.equal(h.gain.value, 0);
});

test('starter_describes_verified_wav_without_claiming_a_pending_runtime_gate', () => {
  const html = require('../src/strudel-template').createStrudelTemplate({ instanceId }).files['index.html'];
  assert.doesNotMatch(html, /awaiting its runtime compatibility check|only after its end-to-end runtime check/);
  assert.match(html, /Stereo 48 kHz WAV saves to Media/);
  assert.match(html, /loaded runtime check|loaded source context/);
});

test('main_restores_pending_question_for_same_instance_but_never_a_rebound_path', async (t) => {
  const f = mainQuestionFixture(t), request = await f.tool('requestCanvasInput')(question, { chatId });
  f.calls.length = 0;
  await f.ready(f.current, 'index.html');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0][1], new RegExp(request.id));
  f.instances.remove(f.current, instanceId);
  f.instances.create({ projectId: f.current, instanceId: 'd'.repeat(32), documentPath: 'index.html', templateId: 'strudel-sound', templateVersion: 1 });
  f.calls.length = 0;
  await f.ready(f.current, 'index.html');
  assert.equal(f.calls.length, 0);
});

test('main_input_bridge_rejects_authored_identity_and_supplies_its_own_instance', async (t) => {
  const f = mainQuestionFixture(t), request = await f.tool('requestCanvasInput')(question, { chatId, instanceId: 'd'.repeat(32) });
  assert.equal(request.instanceId, instanceId);
  assert.throws(() => f.submit({}, { requestId: request.id, value: 'rhythm', instanceId }), /invalid/i);
  assert.equal(f.submitted.length, 0);
  f.submit({}, { requestId: request.id, value: 'rhythm' });
  assert.equal(f.submitted[0].instanceId, instanceId);
  assert.equal(f.inputs.get(request.id).status, 'answered');
});

for (const afterSubmit of ['clear', 'restorePreviousView']) test(`main_creates_ordinary_unbound_question_and_${afterSubmit}_without_reset`, async (t) => {
  const f = mainQuestionFixture(t, { bound: false });
  const sourceRevision = f.canvases.readFile(f.current, { path: 'index.html' }).revision;
  const request = await f.tool('requestCanvasInput')({ ...question, afterSubmit }, { chatId });
  assert.equal(request.instanceId, undefined);
  assert.equal(f.inputs.get(request.id).status, 'pending');
  assert.match(f.calls[0][1], new RegExp(request.id));
  const submitted = f.submit({}, { requestId: request.id, value: 'rhythm' });
  assert.equal(submitted.instanceId, undefined);
  await f.tool('completeCanvasInput')(submitted);
  assert.equal(f.calls.filter(([name]) => name === 'reload').length, 0);
  assert.equal(f.canvases.readFile(f.current, { path: 'index.html' }).revision, sourceRevision);
});

for (const bound of [false, true]) test(`main_restores_legacy_unbound_question_on_${bound ? 'registered' : 'ordinary'}_document`, async (t) => {
  const f = mainQuestionFixture(t, { bound });
  const request = f.inputs.create({ ...question, canvasId: f.current, documentPath: 'index.html', chatId });
  assert.equal(Object.hasOwn(request, 'instanceId'), false);
  await f.ready(f.current, 'index.html');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0][1], new RegExp(request.id));
  assert.equal(f.inputs.get(request.id).status, 'pending');
  assert.equal(f.recoveries(), 1, 'Startup reaches continuation recovery after restoring the legacy overlay');
});
