const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCanvasView } = require('../src/canvas-view');
const { createCanvasStore } = require('../src/canvas-store');

function createFakeViewDependencies() {
  const state = { options: null, commands: [], visible: false, bounds: null, url: '', events: {}, detached: false, evaluateValue: '{"ok":true}' };
  let attached = false;
  const debuggerApi = {
    isAttached: () => attached,
    attach() { attached = true; },
    detach() { attached = false; state.detached = true; },
    async sendCommand(method, params) {
      state.commands.push({ method, params });
      if (state.commandHandler) {
        const overridden = state.commandHandler(method, params);
        if (overridden !== undefined) return overridden;
      }
      if (method === 'Runtime.evaluate' && params.expression.includes('return clone.outerHTML')) {
        return { result: { value: '<html><head><title>Saved</title></head><body><h1>snapshot</h1></body></html>' } };
      }
      return method === 'Runtime.evaluate' ? { result: { value: state.evaluateValue } } : {};
    },
  };
  const webContents = {
    debugger: debuggerApi,
    setWindowOpenHandler(handler) { state.windowOpenHandler = handler; },
    on(name, handler) { state.events[name] = handler; },
    async loadURL(url) { state.url = url; },
    isDestroyed: () => false,
    close() {},
  };
  class WebContentsView {
    constructor(options) { state.options = options; this.webContents = webContents; }
    setVisible(value) { state.visible = value; }
    setBounds(value) { state.bounds = value; }
  }
  const session = {
    protocol: { handle(scheme, handler) { state.protocolScheme = scheme; state.protocolHandler = handler; } },
    webRequest: { onBeforeRequest(_filter, handler) { state.requestHandler = handler; } },
    setPermissionRequestHandler(handler) { state.permissionHandler = handler; },
    setPermissionCheckHandler(handler) { state.permissionCheckHandler = handler; },
  };
  return { state, WebContentsView, session };
}

test('routine source queries have compact runtime identity and omit media unless requested', async () => {
  const fake = createFakeViewDependencies();
  let requestedAssets;
  const id = 'c'.repeat(32);
  const canvas = await createCanvasView({
    WebContentsView: fake.WebContentsView, sessionFactory: async () => ({ session: fake.session }),
    canvasStore: {
      save: () => ({ id, title: 'Compact queries' }),
      get: () => ({ id, title: 'Compact queries', html: '<main>Test</main>' }),
      listFiles: (_id, args) => { requestedAssets = args.includeAssets; return { files: [], contract: { source: 'Long source contract' } }; },
      readFile: () => ({ path: 'app.js', text: '', revision: 'a'.repeat(64) }),
    },
  });
  await canvas.present({ title: 'Compact queries', html: '<main>Test</main>', assets: [] });
  const listed = canvas.listCanvasFiles({});
  assert.equal(requestedAssets, false);
  assert.equal(listed.contract.projectId, id);
  assert.equal(listed.contract.sandbox, undefined);
  assert.equal(listed.contract.project, undefined);
  canvas.listCanvasFiles({ includeAssets: true });
  assert.equal(requestedAssets, true);
  const read = canvas.readCanvasFile({ path: 'app.js' });
  assert.ok(JSON.stringify(read).length < 500);
  assert.equal(read.contract.sourcePendingReload, false);
  assert.equal(canvas.getContract().sandbox.network, false);
});

test('closes a deleted project without trying to save its removed source', async () => {
  const fake = createFakeViewDependencies();
  let deleted = false;
  const canvas = await createCanvasView({
    WebContentsView: fake.WebContentsView,
    sessionFactory: async () => ({ session: fake.session }),
    canvasStore: {
      save: () => ({ id: 'c'.repeat(32), title: 'Disposable project' }),
      get: () => { if (deleted) throw new Error('Project removed'); return { id: 'c'.repeat(32), title: 'Disposable project', html: '<main>Test</main>' }; },
    },
  });
  await canvas.present({ title: 'Disposable project', html: '<main>Test</main>', assets: [] });
  deleted = true;
  assert.deepEqual(await canvas.closeCurrent({ save: false }), { closed: true });
  assert.equal(canvas.getCurrentCanvasId(), '');
  assert.equal(canvas.getCurrentDocumentPath(), '');
  assert.equal(fake.state.url, 'about:blank');
  assert.equal(fake.state.visible, false);
  canvas.destroy();
});

test('embeds the canvas in an isolated web contents and scopes CDP to it', async () => {
  const fake = createFakeViewDependencies();
  const largeHtml = `<html><body><img src="data:image/png;base64,${'A'.repeat(2_100_000)}"></body></html>`;
  const canvas = await createCanvasView({
    WebContentsView: fake.WebContentsView,
    sessionFactory: async (partition) => ({ partition, session: fake.session }),
    canvasStore: {
      save: () => ({ id: 'c'.repeat(32), title: 'Test canvas' }),
      get: () => ({ id: 'c'.repeat(32), title: 'Test canvas', html: largeHtml }),
      update: (id, html) => { fake.state.savedCanvas = { id, html }; return { id, title: 'Test canvas' }; },
      async insertImage(id, input) {
        fake.state.insertedImage = { id, ...input };
        return { target: 'body' };
      },
      async getAsset(id, assetId) { return { id: assetId, projectId: id, data: 'YWJj', mimeType: 'image/png' }; },
    },
    assetStore: { async get(id) { return { id, data: 'YWJj', mimeType: 'image/png' }; } },
  });

  assert.equal(fake.state.options.webPreferences.sandbox, true);
  assert.equal(fake.state.options.webPreferences.contextIsolation, true);
  assert.equal(fake.state.options.webPreferences.nodeIntegration, false);
  assert.equal(fake.state.visible, false);
  assert.deepEqual(fake.state.windowOpenHandler(), { action: 'deny' });
  canvas.setBounds({ x: 20, y: 30, width: 700, height: 500 });
  await canvas.present({ title: 'Test canvas', html: '<h1>safe</h1>', assets: [] });
  assert.equal(fake.state.visible, true);
  assert.equal(fake.state.protocolScheme, 'easel-canvas');
  assert.equal(fake.state.url, `easel-canvas://document/${'c'.repeat(32)}?generation=1`);
  assert.equal(fake.state.protocolHandler({ url: fake.state.url }).status, 200);
  assert.equal(fake.state.protocolHandler({ url: 'easel-canvas://document/other' }).status, 404);
  assert.equal(fake.state.commands[0].method, 'Runtime.enable');
  assert.ok(fake.state.commands.some((command) => command.method === 'Runtime.evaluate' && command.params.expression.includes('A'.repeat(2_100_000))));
  const inspected = JSON.parse(await canvas.inspect());
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.consoleErrors, []);
  assert.equal(inspected.contract.url, fake.state.url);
  assert.equal(inspected.contract.sandbox.network, false);
  assert.equal((await canvas.saveCurrent()).id, 'c'.repeat(32));
  assert.equal(fake.state.savedCanvas, undefined, 'Save must preserve authored source without adopting runtime DOM');
  assert.equal(await canvas.addImage({ assetId: 'a'.repeat(32), alt: 'preview' }), '{"ok":true}');
  assert.equal(fake.state.insertedImage.id, 'c'.repeat(32));
  assert.equal(fake.state.insertedImage.assetId, 'a'.repeat(32));
  assert.match(fake.state.commands.at(-1).params.expression, /data:image\/png;base64,YWJj/);
  assert.equal(await canvas.openSaved('c'.repeat(32)).then((result) => result.id), 'c'.repeat(32));
  canvas.setBounds({ x: 20, y: 30, width: 700, height: 500 });
  assert.deepEqual(fake.state.bounds, { x: 20, y: 30, width: 700, height: 500 });
  let request;
  fake.state.requestHandler({ url: 'https://example.com/image.png' }, (result) => { request = result; });
  assert.deepEqual(request, { cancel: true });
  canvas.destroy();
  assert.equal(fake.state.detached, true);
});

test('bounds CDP script size and rejects operating without an open canvas', async () => {
  const fake = createFakeViewDependencies();
  const canvas = await createCanvasView({
    WebContentsView: fake.WebContentsView,
    sessionFactory: async () => ({ session: fake.session }),
    canvasStore: {
      save: () => ({ id: 'd'.repeat(32), title: 'Test canvas' }),
      get: () => ({ id: 'd'.repeat(32), title: 'Test canvas', html: '<p>safe</p>' }),
    },
  });
  await assert.rejects(canvas.execute('document.title'), /open a canvas/i);
  await canvas.present({ html: '<p>safe</p>', assets: [] });
  await assert.rejects(canvas.execute('x'.repeat(17_000)), /16 KiB/i);
  canvas.destroy();
});

test('executes agent function bodies with return and await support', async () => {
  const fake = createFakeViewDependencies();
  const canvas = await createCanvasView({
    WebContentsView: fake.WebContentsView,
    sessionFactory: async () => ({ session: fake.session }),
    canvasStore: {
      createProject: () => ({ id: 'd'.repeat(32), title: 'Test canvas' }),
      get: () => ({ id: 'd'.repeat(32), title: 'Test canvas', html: '<main></main>' }),
    },
  });
  await canvas.createEmpty('Test canvas');
  const sendCommand = canvas.view.webContents.debugger.sendCommand;
  canvas.view.webContents.debugger.sendCommand = async (_method, { expression }) => ({
    result: { value: await vm.runInNewContext(expression, { document: { title: 'Test canvas' } }) },
  });
  assert.equal(await canvas.execute('return await Promise.resolve(document.title);'), 'Test canvas');
  canvas.view.webContents.debugger.sendCommand = sendCommand;
  fake.state.events['console-message']({ level: 'error', message: 'Synth failed', lineNumber: 7, sourceId: 'easel-source:///app.js' });
  const inspected = JSON.parse(await canvas.inspect());
  assert.equal(inspected.consoleErrors.length, 1);
  const [{ timestamp, ...reportedError }] = inspected.consoleErrors;
  assert.deepEqual(reportedError, { level: 'error', message: 'Synth failed', line: 7, provenance: 'app', sourceFile: 'app.js', sourceLine: 7, sequence: 1, generation: 1 });
  assert.equal(Number.isFinite(timestamp), true);
  assert.equal(inspected.contract.errorCursor, 1);
  canvas.destroy();
});

test('truncates large JavaScript return values instead of failing the edit', async () => {
  const fake = createFakeViewDependencies();
  const canvas = await createCanvasView({
    WebContentsView: fake.WebContentsView,
    sessionFactory: async () => ({ session: fake.session }),
    canvasStore: {
      createProject: () => ({ id: 'd'.repeat(32), title: 'Large result' }),
      get: () => ({ id: 'd'.repeat(32), title: 'Large result', html: '<main data-easel-canvas></main>' }),
    },
  });
  await canvas.createEmpty('Large result');
  fake.state.evaluateValue = 'x'.repeat(20_000);

  const summary = JSON.parse(await canvas.execute('document.body.innerText'));
  assert.equal(summary.truncated, true);
  assert.equal(summary.byteLength, 20_000);
  assert.equal(summary.preview.length, 2_000);
  canvas.destroy();
});

test('migrates legacy asset-scheme images to embedded data URLs when opening saved canvases', async () => {
  const fake = createFakeViewDependencies();
  const assetId = 'a'.repeat(32);
  let savedHtml = `<html><head><title>Old canvas</title></head><body><img src="asset://${assetId}" alt="dog"><script>texture.src = "asset://${assetId}";</script></body></html>`;
  let updateCount = 0;
  const canvas = await createCanvasView({
    WebContentsView: fake.WebContentsView,
    sessionFactory: async () => ({ session: fake.session }),
    canvasStore: {
      get: () => ({ id: 'c'.repeat(32), title: 'Old canvas', html: savedHtml }),
      update(_id, html) { updateCount += 1; savedHtml = html; },
    },
    assetStore: { async get(id) { return { id, data: 'YWJj', mimeType: 'image/png' }; } },
  });

  await canvas.openSaved('c'.repeat(32));
  assert.equal(updateCount, 1);
  assert.match(savedHtml, /src="data:image\/png;base64,YWJj"/);
  assert.match(savedHtml, /texture\.src = "data:image\/png;base64,YWJj"/);
  assert.doesNotMatch(savedHtml, /asset:\/\//);
  canvas.destroy();
});

async function projectKitViewFixture(t) {
  const fake = createFakeViewDependencies();
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-project-kit-view-'));
  const store = createCanvasStore({ userDataPath, kitBundles: { tone: 'window.Tone = {};', three: 'window.THREE = {};' } });
  const project = store.createProject({ title: 'Kit selection' });
  const second = store.createDocument(project.id, { title: 'Second', html: '<main>Second canvas</main>' });
  const canvas = await createCanvasView({ WebContentsView: fake.WebContentsView, sessionFactory: async () => ({ session: fake.session }), canvasStore: store });
  t.after(() => { canvas.destroy(); fs.rmSync(userDataPath, { recursive: true, force: true }); });
  return { fake, store, project, second, canvas };
}

test('project kit changes reload the current HTML once with managed cleanup and preserved state', async (t) => {
  const { fake, store, project, second, canvas } = await projectKitViewFixture(t);
  await canvas.openSaved(project.id, second.documentPath);
  fake.state.commandHandler = (method, params) => method === 'Runtime.evaluate' && params.expression.includes('captureState()')
    ? { result: { value: '{"apps":[{"id":"scene","state":{"rotation":5}}],"controls":[]}' } } : undefined;
  const writesBefore = fake.state.commands.filter((command) => command.params?.expression?.includes('document.open()')).length;
  const generationBefore = canvas.getContract().runtimeGeneration;
  const result = await canvas.updateProjectKits(project.id, { kits: ['canvas-2d', 'three'], expectedProjectRevision: store.getProjectKits(project.id).projectRevision });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.preservedState, true);
  assert.equal(result.sourcePendingReload, false);
  assert.equal(result.documentPath, second.documentPath);
  assert.equal(canvas.getCurrentDocumentPath(), second.documentPath);
  assert.equal(canvas.getContract().runtimeGeneration, generationBefore + 1);
  const writes = fake.state.commands.filter((command) => command.params?.expression?.includes('document.open()'));
  assert.equal(writes.length, writesBefore + 1);
  assert.match(writes.at(-1).params.expression, /__easelPreservedState/);
  assert.match(writes.at(-1).params.expression, /rotation/);
  assert.equal(fake.state.commands.filter((command) => command.params?.expression?.includes('window.EaselCanvas.cleanup()')).length, 1);
  assert.deepEqual(store.getProjectKits(project.id).kits, ['canvas-2d', 'three']);
});

test('inactive project kit changes persist without touching the current runtime', async (t) => {
  const { fake, store, project, canvas } = await projectKitViewFixture(t);
  await canvas.openSaved(project.id);
  const inactive = store.createProject({ title: 'Inactive' });
  const commandsBefore = fake.state.commands.length;
  const result = await canvas.updateProjectKits(inactive.id, { kits: ['canvas-2d'] });
  assert.equal(result.applied, false);
  assert.equal(result.sourcePendingReload, false);
  assert.equal(fake.state.commands.length, commandsBefore);
  assert.equal(canvas.getCurrentCanvasId(), project.id);
  assert.deepEqual(store.getProjectKits(inactive.id).kits, ['canvas-2d']);
  assert.deepEqual(store.getProjectKits(project.id).kits, ['canvas-2d', 'tone']);
});

test('unchanged project kits avoid reload and stale revisions never change source or runtime', async (t) => {
  const { fake, store, project, canvas } = await projectKitViewFixture(t);
  await canvas.openSaved(project.id);
  const before = store.getProjectKits(project.id);
  const commandsBefore = fake.state.commands.length;
  const unchanged = await canvas.updateProjectKits(project.id, { kits: before.kits, expectedProjectRevision: before.projectRevision });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.applied, false);
  assert.equal(fake.state.commands.length, commandsBefore);
  store.writeFile(project.id, { path: 'notes.txt', content: 'Concurrent source edit' });
  await assert.rejects(canvas.updateProjectKits(project.id, { kits: [], expectedProjectRevision: before.projectRevision }), /project changed/);
  assert.deepEqual(store.getProjectKits(project.id).kits, before.kits);
  assert.equal(fake.state.commands.length, commandsBefore);
  await assert.rejects(canvas.updateProjectKits(project.id, {}), /must be an array/);
});

test('project kit reload failure reports saved selection and keeps the pending reload flag', async (t) => {
  const { fake, store, project, canvas } = await projectKitViewFixture(t);
  await canvas.openSaved(project.id);
  fake.state.commandHandler = (method, params) => {
    if (method === 'Runtime.evaluate' && params.expression.includes('document.open()')) throw new Error('Renderer failed to initialize');
  };
  const result = await canvas.updateProjectKits(project.id, { kits: ['canvas-2d'] });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.sourcePendingReload, true);
  assert.match(result.runtimeWarning, /saved.*Reopen.*Renderer failed/);
  assert.deepEqual(store.getProjectKits(project.id).kits, ['canvas-2d']);
  assert.equal(canvas.getContract().sourcePendingReload, true);
});

test('project kit reload keeps a hidden preview hidden and accepts legacy runtime without managed state', async (t) => {
  const { fake, project, canvas } = await projectKitViewFixture(t);
  await canvas.openSaved(project.id);
  await canvas.hide();
  fake.state.commandHandler = (method, params) => method === 'Runtime.evaluate' && params.expression.includes('captureState()') ? { result: { value: 'null' } } : undefined;
  const result = await canvas.updateProjectKits(project.id, { kits: ['canvas-2d'] });
  assert.equal(result.applied, true);
  assert.equal(result.preservedState, false);
  assert.equal(canvas.getContract().previewHidden, true);
  assert.equal(fake.state.visible, false);
});
