const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCanvasView } = require("../src/canvas-view");
function fake() {
  let attached = false;
  const state = { events: {} };
  const debuggerApi = { isAttached: () => attached, attach() {
    attached = true;
  }, detach() {
    attached = false;
  }, async sendCommand(method) {
    return method === "Runtime.evaluate" ? { result: { value: '{"ok":true}' } } : {};
  } };
  const webContents = { debugger: debuggerApi, setWindowOpenHandler() {
  }, on(name, fn) {
    state.events[name] = fn;
  }, async loadURL(url) {
    state.events["did-start-navigation"]?.({}, url, false, true);
  }, isDestroyed: () => false, close() {
  } };
  class WebContentsView {
    constructor() {
      this.webContents = webContents;
    }
    setVisible() {
    }
    setBounds() {
    }
  }
  ;
  const session = { protocol: { handle() {
  } }, webRequest: { onBeforeRequest() {
  } }, setPermissionRequestHandler() {
  }, setPermissionCheckHandler() {
  } };
  return { state, WebContentsView, session };
}
test("runtime_lifecycle_invalidates_exports_before_cleanup_and_pending_source", async () => {
  const f = fake(), reasons = [];
  const id = "a".repeat(32);
  const canvas = await createCanvasView({ WebContentsView: f.WebContentsView, sessionFactory: async () => ({ session: f.session }), onRuntimeInvalidated: (reason) => {
    reasons.push(reason);
  }, canvasStore: { save: () => ({ id, title: "Sound" }), get: () => ({ id, title: "Sound", html: "<main>Sound</main>" }) } });
  await canvas.present({ title: "Sound", html: "<main>Sound</main>", assets: [] });
  assert.ok(reasons.length > 0, "document replacement immediately invalidates an isolated export");
  let count = reasons.length;
  canvas.markSourcePendingReload();
  assert.ok(reasons.length > count);
  assert.equal(canvas.getContract().sourcePendingReload, true);
  count = reasons.length;
  await canvas.hide();
  assert.ok(reasons.length > count);
  count = reasons.length;
  f.state.events["render-process-gone"]({}, {});
  assert.ok(reasons.length > count);
  count = reasons.length;
  canvas.destroy();
  assert.ok(reasons.length > count);
});
test("main_preload_and_media_ui_wire_a_narrow_save_only_export_route", () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, "../src", name), "utf8");
  const main = read("main.js"), preload = read("canvas-preload.js"), ui = read("renderer.js");
  assert.match(preload, /strudelExport:.*canvas:strudel-export/);
  assert.match(preload, /onStrudelExportContext/);
  assert.match(main, /ipcMain\.handle\('canvas:strudel-export'/);
  assert.match(main, /requireCanvasSender\(event\);\s*return STRUDEL_EXPORT_BRIDGE\.handle/);
  assert.match(main, /onRuntimeInvalidated:.*STRUDEL_EXPORT_CONTROLLER\.invalidate/);
  assert.match(main, /strudel-exported/);
  assert.match(ui, /event\.type === 'strudel-exported'/);
  assert.match(main, /const STRUDEL_EXPORT_READY = true/);
  assert.match(main, /strudelReady: true/);
});

test('same_url_new_document_aborts_export_and_invalidates_loaded_context_but_not_fragments', async () => {
  const f = fake(); const { createStrudelExportController } = require('../src/strudel-export-controller');
  const id = 'a'.repeat(32); let controller, signal, saves = 0, resolve;
  const gate = new Promise(done => { resolve = done; });
  const store = { createDocument: () => ({ id, title: 'Reloaded' }), save: () => ({ id, title: 'Sound' }), get: () => ({ id, title: 'Sound', html: '<main>Sound</main>' }),
    listDocuments: () => ({ documents: [{ path: 'index.html' }] }), getDocumentSource: () => ({ html: '<main>Sound</main>' }), getProject: () => ({ manifest: { kits: [{ name: 'strudel', digest: 'e'.repeat(64) }] } }), getProjectKitSource: () => ({ source: 'A', digest: 'e'.repeat(64) }) };
  const canvas = await createCanvasView({ WebContentsView: f.WebContentsView, sessionFactory: async () => ({ session: f.session }), canvasStore: store,
    onRuntimeInvalidated: reason => controller?.invalidate(reason) });
  await canvas.present({ title: 'Sound', html: '<main>Sound</main>', assets: [] });
  // The fixture's initial present has no documentPath; use the public contract
  // for lifecycle admission, while asserting its loaded-source flags directly.
  const scope = { projectId: id, instanceId: 'b'.repeat(32), documentPath: '', runtimeGeneration: canvas.getContract().runtimeGeneration, sourceRevision: 'c'.repeat(64) };
  controller = createStrudelExportController({ assertScope: s => { const c = canvas.getContract(); if (!c.loadedSourceValid || c.sourcePendingReload || c.runtimeGeneration !== s.runtimeGeneration) throw new Error('loaded document was replaced'); },
    captureDependency: () => ({ source: 'A', digest: 'e'.repeat(64) }), findExport: async () => null,
    render: async (_snapshot, options) => { signal = options.signal; await gate; return {}; }, saveMedia: async () => { saves++; } });
  assert.equal(typeof f.state.events['did-start-navigation'], 'function', 'top-level navigation must invalidate loaded-source identity');
  const p = controller.start(scope, { exportId: 'reload', expectedSourceRevision: scope.sourceRevision, snapshot: { bpm:120,cycles:1,tailSeconds:0.5,parameterDigest:'d'.repeat(64),events:[] } });
  for (let i=0;i<10;i++) await Promise.resolve();
  const url = canvas.getContract().url;
  f.state.events['did-start-navigation']({}, url + '#section', true, true); assert.equal(signal.aborted, false);
  f.state.events['did-start-navigation']({}, url, false, false); assert.equal(signal.aborted, false);
  f.state.events['did-start-navigation']({ url, isSameDocument: false, isMainFrame: true }); assert.equal(signal.aborted, true); assert.equal(canvas.getContract().loadedSourceValid, false); assert.equal(canvas.getContract().sourcePendingReload, true);
  resolve(); await assert.rejects(p, /replaced|cancel/i); assert.equal(saves,0);
  await assert.rejects(controller.start({ ...scope, runtimeGeneration: canvas.getContract().runtimeGeneration }, { exportId:'new',expectedSourceRevision:scope.sourceRevision,snapshot:{bpm:120,cycles:1,tailSeconds:0.5,parameterDigest:'d'.repeat(64),events:[]} }), /replaced/i);
  await canvas.present({ title:'Reloaded',html:'<main>Sound</main>',assets:[] }); assert.equal(canvas.getContract().loadedSourceValid,true); assert.equal(canvas.getContract().sourcePendingReload,false);
  canvas.destroy();
});

test('same_document_fragment_keeps_verified_canvas_sender_without_accepting_other_urls', () => {
  const source = fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
  const body = source.match(/function requireCanvasSender\(event\) \{([\s\S]*?)\n  \}/)[1];
  const url = 'easel-canvas://document/' + 'a'.repeat(32) + '?generation=1';
  const frame = { url: url + '#section' }, webContents = {mainFrame:frame};
  const canvas = {view:{webContents},getCurrentCanvasId:()=> 'a'.repeat(32),getContract:()=>({url,loading:false,previewHidden:false})};
  const guard = require('node:vm').runInNewContext('(event) => {' + body + '}', {requireCanvasView:()=>canvas});
  assert.equal(guard({sender:webContents,senderFrame:frame}),canvas);
  for (const other of ['easel-canvas://document/other?generation=1#section', url.replace('generation=1','generation=2'), 'https://example.com/#'+url]) {
    frame.url=other;assert.throws(()=>guard({sender:webContents,senderFrame:frame}),/rejected/);
  }
});
