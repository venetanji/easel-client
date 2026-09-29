const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasWindow } = require('../src/canvas-window');

function createFakeElectron() {
  const state = { options: null, loadedUrl: null, requestHandler: null, permissionHandler: null, events: {}, destroyed: false };
  const session = {
    webRequest: {
      onBeforeRequest(_filter, handler) { state.requestHandler = handler; },
    },
    setPermissionRequestHandler(handler) { state.permissionHandler = handler; },
    setPermissionCheckHandler(handler) { state.permissionCheckHandler = handler; },
  };
  class BrowserWindow {
    constructor(options) {
      state.options = options;
      this.webContents = {
        setWindowOpenHandler(handler) { state.openHandler = handler; },
        on(name, handler) { state.events[name] = handler; },
      };
    }
    async loadURL(url) { state.loadedUrl = url; }
    isDestroyed() { return state.destroyed; }
    destroy() { state.destroyed = true; }
  }
  return { state, session, BrowserWindow };
}

test('runs canvas scripts in a separate sandboxed window and blocks browser capabilities', async () => {
  const { state, session, BrowserWindow } = createFakeElectron();
  const canvas = await createCanvasWindow({
    BrowserWindow,
    sessionFactory: async () => ({ partition: 'canvas-session', session }),
    artifact: { html: '<h1>canvas</h1>', assets: [] },
  });
  assert.equal(state.options.webPreferences.partition, 'canvas-session');
  assert.equal(state.options.webPreferences.sandbox, true);
  assert.equal(state.options.webPreferences.contextIsolation, true);
  assert.equal(state.options.webPreferences.nodeIntegration, false);
  assert.equal(Object.hasOwn(state.options.webPreferences, 'preload'), false);
  assert.deepEqual(state.openHandler(), { action: 'deny' });
  let permissionGranted;
  state.permissionHandler({}, 'clipboard-read', (value) => { permissionGranted = value; });
  assert.equal(permissionGranted, false);
  assert.equal(state.permissionCheckHandler(), false);
  let requestResult;
  state.requestHandler({ url: 'https://example.com/pixel' }, (result) => { requestResult = result; });
  assert.deepEqual(requestResult, { cancel: true });
  state.requestHandler({ url: 'data:image/png;base64,YWJj' }, (result) => { requestResult = result; });
  assert.deepEqual(requestResult, { cancel: false });
  canvas.reset();
  assert.equal(state.destroyed, true);
});
