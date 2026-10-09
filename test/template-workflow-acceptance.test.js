const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const acorn = require('acorn');
const { createCanvasStore } = require('../src/canvas-store');
const { createCanvasMediaStore } = require('../src/canvas-media-store');
const { createVideoTimelineStore } = require('../src/video-timeline-store');
const { createVideoTimelineController } = require('../src/video-timeline-controller');
const { createTemplateInstanceStore } = require('../src/template-instance-store');
const { createTemplateService } = require('../src/template-service');
const { createVideoTimelineTemplate } = require('../src/video-timeline-template');
const { createCanvasHistory, restoreCanvasHistory } = require('../src/canvas-history');
const { createCanvasInputStore } = require('../src/canvas-input-store');
const { createChatStore } = require('../src/chat-store');
const { createChatService } = require('../src/chat-service');
const { renderCanvasInputScript, dismissCanvasInputScript } = require('../src/canvas-input-runtime');
const { createStrudelExportController } = require('../src/strudel-export-controller');
const { createStrudelExportBridge, assertStrudelScope } = require('../src/strudel-export-bridge');
const { encodePCM16Wav } = require('../src/strudel-export-renderer');
const { snapshotTiming, validateStrudelWav } = require('../src/strudel-export-policy');
const { createDeletionService } = require('../src/deletion-service');
const { createSourceArchiveFixture } = require('./helpers/canvas-kit-source');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function zipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18);
    const length = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + length);
    const start = offset + 30 + length + extra, bytes = buffer.subarray(start, start + size);
    entries.set(name, method === 8 ? zlib.inflateRawSync(bytes) : bytes);
    offset = start + size;
  }
  return entries;
}

// Run the production question adapters with an inert view, not an Electron app.
// The real stores, trusted registry resolution and existing chat continuation run.
function questionAdapters({ canvases, instances, inputs, view }) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const tree = acorn.parse(source, { ecmaVersion: 'latest' });
  const declaration = tree.body.flatMap((node) => node.declarations || []).find((node) => node.id.name === 'CANVAS_CONTROLLER');
  const context = vm.createContext({ withCanvas: (action) => action(view), requireCanvasView: () => view,
    CANVASES: canvases, TEMPLATE_INSTANCES: instances, CANVAS_INPUTS: inputs,
    renderCanvasInputScript, dismissCanvasInputScript, mainWindow: null, IPC_CHANNELS: {},
    ...require('../src/canvas-input') });
  for (const name of ['currentCanvasInputScope', 'canvasInputContextNote']) {
    const node = tree.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === name);
    vm.runInContext(source.slice(node.start, node.end), context);
  }
  return Object.fromEntries(['requestCanvasInput', 'completeCanvasInput', 'getCanvasInputScope'].map((name) => {
    const node = declaration.init.properties.find((property) => property.key.name === name).value;
    return [name, vm.runInContext(`(${source.slice(node.start, node.end)})`, context)];
  }));
}

async function waitForInput(inputs, id) {
  const deadline = Date.now() + 2000;
  do {
    await new Promise(setImmediate);
    const entry = inputs.get(id);
    assert.notEqual(entry.status, 'failed', entry.error);
    if (entry.status === 'completed') return entry;
  } while (Date.now() < deadline);
  assert.fail('The instance-scoped answer did not complete its host continuation.');
}

// Host integration only: controlled kit bytes, view, model response and PCM rest.
// Native Strudel synthesis/signal is proven separately by the retained b3cb58a
// disposable runtime probe. No browser, device, model server or network is used.
test('mixed_template_host_workflow_preserves_instances_answers_media_and_distribution', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-template-workflow-'));
  let chat, exports;
  t.after(async () => {
    exports?.invalidate('Host fixture cleanup');
    await chat?.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(fs.existsSync(directory), false);
  });
  const kits = { tone: 'window.Tone = {fixture:"preserved"};', strudel: 'window.strudel = {fixture:"exact-pin"};' };
  const sourceArchive = createSourceArchiveFixture(kits.strudel);
  const media = createCanvasMediaStore({ userDataPath: directory });
  const timelines = createVideoTimelineStore({ userDataPath: directory });
  let instances;
  const canvases = createCanvasStore({ userDataPath: directory, kitBundles: kits, assetStore: media,
    readKitSourceArchive: (name) => name === 'strudel' ? sourceArchive : null,
    listTimelines: (id) => timelines.list(id), listInstances: (id) => instances?.list(id) || [] });
  instances = createTemplateInstanceStore({ userDataPath: directory, projectStore: canvases, timelineStore: timelines });
  const history = createCanvasHistory();
  const original = canvases.createProject({ title: 'Existing student work', kits: ['canvas-2d', 'tone'] });
  canvases.writeFile(original.id, { path: 'notes.txt', content: 'Keep this original project.' });
  const originalBytes = fs.readFileSync(path.join(directory, 'canvases', `${original.id}.project.json`));
  let activeProject = original.id, activeDocument = 'index.html', generation = 1;
  const viewCalls = [], completions = [], mcpClients = [];
  const open = async (projectId, documentPath) => {
    activeProject = projectId; activeDocument = documentPath; generation++;
    return canvases.getDocument(projectId, documentPath);
  };
  const view = {
    getCurrentCanvasId: () => activeProject, getCurrentDocumentPath: () => activeDocument,
    getContract: () => ({ runtimeGeneration: generation, loading: false, previewHidden: false, sourcePendingReload: false, loadedSourceValid: true }),
    evaluate: async (script) => { viewCalls.push(script); },
    reloadCanvas: async () => { assert.fail('Co-creation must not reset or reload source.'); },
    markSourcePendingReload: () => {}, openSaved: open,
  };
  const service = createTemplateService({ projectStore: canvases, instanceStore: instances, timelineStore: timelines,
    kitBundles: kits, history, strudelReady: true, getCurrentProjectId: () => activeProject,
    openDocument: open, saveBeforeSwitch: async () => {},
    // Real editable factory, controlled offline dependency; no native renderer.
    videoFactory: () => createVideoTimelineTemplate({ readSource: (name) => name.endsWith('mediabunny.js')
      ? 'const EaselMediabunny = {};' : fs.readFileSync(path.join(__dirname, '../src', name), 'utf8') }),
  });

  const firstVideo = await service.createTemplateInstance({ templateId: 'video-editor', target: 'new-project', title: 'Mixed project' });
  const projectId = firstVideo.projectId;
  assert.notEqual(projectId, original.id);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'canvases', `${original.id}.project.json`)), originalBytes);
  canvases.writeFile(projectId, { path: 'notes/brief.txt', content: 'Keep the student’s authored brief.' });
  canvases.updateManifest(projectId, { kits: ['canvas-2d', 'tone'] });
  const beforeAdd = canvases.getProject(projectId), beforeAddSource = canvases.readFile(projectId, { path: 'notes/brief.txt' });
  history.record(projectId, canvases.get(projectId).html);
  const records = [firstVideo];
  for (const templateId of ['video-editor', 'strudel-sound', 'strudel-sound']) {
    records.push(await service.createTemplateInstance({ templateId, target: 'current-project', projectId }));
  }
  const [videoA, videoB, soundA, soundB] = records;
  assert.equal(new Set(records.map((record) => record.instanceId)).size, 4);
  assert.equal(new Set(records.map((record) => record.documentPath)).size, 4);
  assert.ok(records.every((record) => record.projectId === projectId && record.opened));
  assert.notEqual(videoA.timelineId, videoB.timelineId);
  assert.equal(soundA.timelineId, undefined); assert.equal(soundB.timelineId, undefined);
  assert.equal(timelines.list(projectId).length, 2);
  assert.deepEqual(instances.list(projectId).map((record) => record.instanceId).sort(), records.map((record) => record.instanceId).sort());
  const afterAdd = canvases.getProject(projectId);
  assert.deepEqual(afterAdd.manifest.kits.slice(0, 2), beforeAdd.manifest.kits);
  assert.deepEqual(afterAdd.manifest.kits.map((kit) => kit.name), ['canvas-2d', 'tone', 'strudel']);
  assert.equal(canvases.readFile(projectId, { path: 'notes/brief.txt' }).revision, beforeAddSource.revision);
  for (const file of beforeAdd.files) assert.equal(canvases.readFile(projectId, { path: file.path }).revision, file.revision);
  for (const sound of [soundA, soundB]) {
    const app = canvases.readFile(projectId, { path: sound.documentPath.replace('index.html', 'app.js') }).text;
    assert.match(app, /const DEFAULT_LIVE_CODE =/);
    assert.ok(app.includes(JSON.stringify(sound.instanceId)), 'Factory binds each authored starter to its own identity');
    assert.match(app, /playing: false/); // Source default only; native silence has separate measured proof.
  }
  assert.equal(completions.length, 0, 'Creation and opening must not request a model response');

  const sourceMedia = Buffer.from(encodePCM16Wav({ sampleRate: 48000, numberOfChannels: 2, length: 48000, getChannelData: () => new Float32Array(48000) }));
  const sourceId = await media.save({ data: sourceMedia.toString('base64'), mimeType: 'audio/wav', name: 'Original.wav', duration: 1 });
  await canvases.attachAssets(projectId, { assetIds: [sourceId] });
  const timelineController = createVideoTimelineController({ store: timelines, projectStore: canvases, instances, getActiveProjectId: () => activeProject });
  const secondTimelineBytes = fs.readFileSync(path.join(directory, 'video-timelines', projectId, `${videoB.timelineId}.json`));
  const edited = timelineController.apply(projectId, videoA.timelineId, { expectedRevision: 0, operations: [{ type: 'insert', item: {
    id: 'original-audio', trackId: 'audio-1', assetId: sourceId, startFrame: 0, endFrame: 24, sourceStartSeconds: 0, sourceEndSeconds: 1,
  } }] });
  timelineController.undo(projectId, videoA.timelineId, { expectedRevision: edited.revision });
  timelineController.redo(projectId, videoA.timelineId, { expectedRevision: edited.revision + 1 });
  assert.deepEqual(fs.readFileSync(path.join(directory, 'video-timelines', projectId, `${videoB.timelineId}.json`)), secondTimelineBytes);
  assert.throws(() => canvases.detachAsset(projectId, { assetId: sourceId }), /timeline/i);

  await service.openTemplateInstance({ projectId, instanceId: soundA.instanceId });
  const inputs = createCanvasInputStore({ userDataPath: directory });
  const adapters = questionAdapters({ canvases, instances, inputs, view });
  const chatStore = createChatStore({ userDataPath: directory });
  const chatId = 'a'.repeat(32);
  chatStore.save({ id: chatId, title: 'Explore this sketch', history: [{ role: 'user', content: 'Explore this melody.' }] });
  chat = createChatService({ inputStore: inputs, chatStore, assetStore: media, canvasController: {
    ...adapters, getCurrentCanvasId: view.getCurrentCanvasId, getCurrentDocumentPath: view.getCurrentDocumentPath,
    getCurrentKits: () => canvases.getProjectKits(projectId).kits,
  }, settingsStore: { loadPublic: () => ({ activeConnectionId: 'f'.repeat(32), litellmBaseUrl: 'http://localhost:4000/v1', litellmModel: 'controlled-response' }), loadSecrets: () => ({}) },
    llmFactory: () => ({ createCompletion: async (request) => { completions.push(request); return { choices: [{ message: { role: 'assistant', content: 'A calm melody.' } }] }; } }),
    mcpFactory: async () => { const client = { closed: false, listTools: async () => [], close: async () => { client.closed = true; } }; mcpClients.push(client); return client; },
  });
  chat.acknowledgeChat(chatId);
  const sourceBeforeQuestion = canvases.getProject(projectId).projectRevision;
  const question = await adapters.requestCanvasInput({ question: 'Calm or energetic?', options: [{ value: 'calm', label: 'Calm' }, { value: 'energetic', label: 'Energetic' }], afterSubmit: 'restorePreviousView' }, { chatId });
  assert.equal(question.instanceId, soundA.instanceId); assert.equal(question.documentPath, soundA.documentPath);
  await chat.submitCanvasInput({ requestId: question.id, canvasId: projectId, documentPath: soundA.documentPath, instanceId: soundA.instanceId, value: 'calm' });
  const answered = await waitForInput(inputs, question.id);
  assert.equal(answered.actionApplied, true); assert.equal(answered.value, 'calm');
  await assert.rejects(chat.submitCanvasInput({ requestId: question.id, canvasId: projectId, documentPath: soundA.documentPath, instanceId: soundA.instanceId, value: 'calm' }), /already answered|no longer active/);
  chat.recoverCanvasInputs(); await new Promise(setImmediate);
  assert.equal(completions.length, 1);
  const continued = JSON.stringify(completions[0].messages);
  assert.ok(continued.includes(soundA.instanceId)); assert.ok(continued.includes(soundA.documentPath));
  assert.equal(canvases.getProject(projectId).projectRevision, sourceBeforeQuestion);
  assert.equal(viewCalls.length, 2); assert.match(viewCalls[1], /dismissCanvasInput/);

  const scopeOptions = { view, projectStore: canvases, instances };
  const snapshot = { bpm: 120, cycles: 1, tailSeconds: 0.5, parameterDigest: sha256('controlled-rest'), events: [] };
  const frames = snapshotTiming(snapshot).frames;
  const wavBytes = Buffer.from(encodePCM16Wav({ sampleRate: 48000, numberOfChannels: 2, length: frames, getChannelData: () => new Float32Array(frames) }));
  let renders = 0;
  exports = createStrudelExportController({ assertScope: (scope) => assertStrudelScope(scope, scopeOptions),
    captureDependency: (scope) => canvases.getProjectKitSource(scope.projectId, 'strudel'),
    render: async () => { renders++; return { wavBytes, duration: frames / 48000, sampleRate: 48000, channels: 2 }; },
    saveMedia: media.save, findExport: media.findExport,
    isAttached: async (id, assetId) => canvases.listAssets(id).assets.some((asset) => asset.id === assetId),
    attach: (id, ids, beforeCommit) => canvases.attachAssets(id, { assetIds: ids }, { beforeCommit }),
  });
  const bridge = createStrudelExportBridge({ ...scopeOptions, controller: exports, exportReady: true });
  const context = await bridge.handle({ action: 'context' });
  const request = { action: 'export', input: { exportId: 'mixed-host-rest', expectedSourceRevision: context.sourceRevision, snapshot } };
  const receipt = await bridge.handle(request);
  assert.equal(receipt.projectId, projectId); assert.equal(receipt.instanceId, soundA.instanceId); assert.equal(receipt.attachmentStatus, 'attached');
  assert.equal((await bridge.handle(request)).assetId, receipt.assetId); assert.equal(renders, 1);
  const reopened = await createCanvasMediaStore({ userDataPath: directory }).get(receipt.assetId);
  assert.deepEqual(Buffer.from(reopened.data, 'base64'), wavBytes);
  assert.equal(validateStrudelWav(wavBytes, snapshot).frames, 120000);
  assert.equal(canvases.listAssets(projectId).assets.filter((asset) => asset.id === receipt.assetId).length, 1);
  assert.equal(sha256(Buffer.from((await media.get(sourceId)).data, 'base64')), sha256(sourceMedia));

  const exported = canvases.exportProject(projectId), entries = zipEntries(exported.data);
  const manifest = JSON.parse(entries.get('manifest.json'));
  assert.equal(manifest.version, 2); assert.equal(manifest.instances.length, 4); assert.equal(manifest.timelines.length, 2);
  assert.deepEqual(manifest.instances, instances.list(projectId));
  for (const record of records) assert.ok(entries.has(record.documentPath));
  for (const timeline of timelines.list(projectId)) assert.deepEqual(JSON.parse(entries.get(`.easel/timelines/${timeline.id}.json`)), timeline);
  for (const file of canvases.getProject(projectId).files) assert.equal(sha256(entries.get(`.easel/source/${file.path}`)), file.revision);
  assert.equal(entries.get('.easel/source/notes/brief.txt').toString(), beforeAddSource.text);
  const exportedStrudel = manifest.kits.find((kit) => kit.name === 'strudel'), archiveIdentity = exportedStrudel.correspondingSource;
  assert.equal(archiveIdentity.runtimeSha256, sha256(kits.strudel));
  assert.equal(sha256(entries.get(exportedStrudel.path)), archiveIdentity.runtimeSha256);
  assert.equal(archiveIdentity.sha256, sha256(sourceArchive)); assert.equal(archiveIdentity.bytes, sourceArchive.length);
  assert.deepEqual(entries.get(archiveIdentity.path), sourceArchive);
  const exportedWav = manifest.media.find((asset) => asset.id === receipt.assetId);
  assert.deepEqual(entries.get(exportedWav.path), wavBytes);
  for (const record of records) {
    const html = entries.get(record.documentPath).toString();
    assert.match(html, /Strudel corresponding source/);
    assert.ok(html.includes(path.posix.relative(path.posix.dirname(record.documentPath), archiveIdentity.path)));
  }

  const beforeRemoval = timelines.list(projectId), survivingSource = canvases.getDocumentSource(projectId, soundB.documentPath).html;
  const deletion = createDeletionService({ canvasStore: canvases, instances, confirm: async () => true,
    canRecordUndo: (...args) => history.canRecord(...args), recordUndo: (...args) => history.record(...args),
  });
  const deleted = await deletion.deleteProjectFile(view, projectId, { path: videoA.documentPath });
  assert.equal(deleted.deleted, true); assert.equal(instances.list(projectId).length, 3);
  assert.equal(timelines.read(projectId, videoA.timelineId), null);
  restoreCanvasHistory({ history, canvasStore: canvases, instances }, projectId);
  assert.deepEqual(timelines.list(projectId), beforeRemoval);
  assert.equal(instances.list(projectId).length, 4);
  assert.equal(canvases.getDocumentSource(projectId, soundB.documentPath).html, survivingSource);
  assert.equal(sha256(Buffer.from((await media.get(sourceId)).data, 'base64')), sha256(sourceMedia));
  await chat.shutdown(); exports.invalidate('Mixed host workflow finished');
  assert.equal(chat.isBusy(), false); assert.ok(mcpClients.every((client) => client.closed));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'canvases', `${original.id}.project.json`)), originalBytes);
});
