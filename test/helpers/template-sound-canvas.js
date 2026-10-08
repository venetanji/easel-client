const vm = require('node:vm');
const { createCanvasView } = require('../../src/canvas-view');

// Inert platform adapters exercise the real source patch/reload and editable
// starter. No Electron window, debugger connection or audio device is created.
async function soundCanvas(canvases, projectId, instanceId) {
  let app, currentUrl, attached = false, loads = 0, starts = 0, resumes = 0;
  const elements = new Map(), listeners = new Map();
  const context = { state: 'suspended', currentTime: 0, async resume() { resumes++; this.state = 'running'; }, async close() { this.state = 'closed'; } };
  const gain = { value: 0, cancelScheduledValues() {} }, output = { destinationGain: { gain }, disconnect() {} };
  const audioController = { output, reset() {} };
  const repl = { scheduler: { started: false }, setCps() {}, async setPattern(_pattern, autoplay) { if (autoplay) starts++; }, async start() { starts++; this.scheduler.started = true; }, stop() { this.scheduler.started = false; } };
  const strudel = { getAudioContext: () => context, getSuperdoughAudioController: () => audioController,
    initStrudel: async () => repl, initAudio: async () => {}, hush: () => repl.stop(),
    stack: (...patterns) => patterns[0], note: () => { const pattern = { s() { return this; }, gain() { return this; }, attack() { return this; }, release() { return this; }, lpf() { return this; }, room() { return this; } }; return pattern; } };
  async function initialize() {
    const html = canvases.getDocumentSource(projectId, 'index.html').html;
    elements.clear(); context.state = 'suspended'; gain.value = 0;
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, { value: '', textContent: '', disabled: false, hidden: false,
      setAttribute() {}, addEventListener(type, callback) { this[type] = callback; }, removeEventListener(type) { delete this[type]; } });
    const window = { strudel, EaselCanvas: { registerApp(value) { app = value; value.restoreState({ bpm: 150, volume: 0.2, playing: true }); } }, addEventListener() {}, removeEventListener() {} };
    const sandbox = { window, navigator: { userActivation: { isActive: true } }, document: { getElementById: (id) => elements.get(id),
      addEventListener(type, callback) { listeners.set(type, callback); }, removeEventListener(type) { listeners.delete(type); } }, console };
    vm.createContext(sandbox);
    for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) if (script.includes('function createPattern(') || script.includes('function queryStrudelSnapshot(')) vm.runInContext(script, sandbox);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  const debuggerApi = { isAttached: () => attached, attach() { attached = true; }, detach() {}, async sendCommand(method, params) {
    if (method !== 'Runtime.evaluate') return {};
    let value = { ok: true };
    if (params.expression.includes('captureState()')) value = { [app.id]: app.getState() };
    if (params.expression.includes('EaselCanvas.cleanup()')) { await app.dispose(); value = { managed: true }; }
    return { result: { value: JSON.stringify(value) } };
  } };
  const webContents = { debugger: debuggerApi, setWindowOpenHandler() {}, on() {}, isDestroyed: () => false, close() {},
    async loadURL(url) { currentUrl = url; loads++; await initialize(); } };
  const session = { protocol: { handle() {} }, webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  class WebContentsView { constructor() { this.webContents = webContents; } setVisible() {} setBounds() {} }
  const view = await createCanvasView({ WebContentsView, sessionFactory: async () => ({ session }), canvasStore: canvases });
  await view.openSaved(projectId, 'index.html');
  return { view, app: () => app, loads: () => loads, starts: () => starts, resumes: () => resumes, currentUrl: () => currentUrl,
    play: () => elements.get(`strudel-${instanceId}-play`).click({ isTrusted: true }), gain };
}
module.exports = { soundCanvas };
