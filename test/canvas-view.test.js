const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasView } = require('../src/canvas-view');

function createFakeViewDependencies() {
  const state = { options: null, commands: [], visible: false, bounds: null, url: '', events: {}, detached: false, evaluateValue: '{"ok":true}' };
  let attached = false;
  const debuggerApi = {
    isAttached: () => attached,
    attach() { attached = true; },
    detach() { attached = false; state.detached = true; },
    async sendCommand(method, params) {
      state.commands.push({ method, params });
      if (method === 'Runtime.evaluate' && params.expression === 'document.documentElement.outerHTML') {
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
    webRequest: { onBeforeRequest(_filter, handler) { state.requestHandler = handler; } },
    setPermissionRequestHandler(handler) { state.permissionHandler = handler; },
    setPermissionCheckHandler(handler) { state.permissionCheckHandler = handler; },
  };
  return { state, WebContentsView, session };
}

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
    },
    assetStore: { async get(id) { return { id, data: 'YWJj', mimeType: 'image/png' }; } },
  });

  assert.equal(fake.state.options.webPreferences.sandbox, true);
  assert.equal(fake.state.options.webPreferences.contextIsolation, true);
  assert.equal(fake.state.options.webPreferences.nodeIntegration, false);
  assert.equal(fake.state.visible, false);
  assert.deepEqual(fake.state.windowOpenHandler(), { action: 'deny' });
  await canvas.present({ title: 'Test canvas', html: '<h1>safe</h1>', assets: [] });
  assert.equal(fake.state.visible, true);
  assert.equal(fake.state.url, 'about:blank');
  assert.equal(fake.state.commands[0].method, 'Runtime.enable');
  assert.ok(fake.state.commands.some((command) => command.method === 'Runtime.evaluate' && command.params.expression.includes('A'.repeat(2_100_000))));
  assert.equal(await canvas.inspect(), '{"ok":true}');
  assert.equal((await canvas.saveCurrent()).id, 'c'.repeat(32));
  assert.match(fake.state.savedCanvas.html, /<h1>snapshot<\/h1>/);
  assert.equal(await canvas.addImage({ assetId: 'a'.repeat(32), alt: 'preview' }), '{"ok":true}');
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

test('truncates large JavaScript return values instead of failing the edit', async () => {
  const fake = createFakeViewDependencies();
  const canvas = await createCanvasView({
    WebContentsView: fake.WebContentsView,
    sessionFactory: async () => ({ session: fake.session }),
    canvasStore: {
      createEmpty: () => ({ id: 'd'.repeat(32), title: 'Large result' }),
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
