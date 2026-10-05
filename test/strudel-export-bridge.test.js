const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCanvasStore } = require("../src/canvas-store");
function fixture(t) {
  assert.ok(fs.existsSync(path.join(__dirname, "../src/strudel-export-bridge.js")), "narrow host-owned Strudel bridge exists");
  const { createStrudelExportBridge, currentStrudelScope, assertStrudelScope } = require("../src/strudel-export-bridge");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easel-strudel-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath: root, kitBundles: { strudel: 'window.strudel={version:"A"};', tone: "window.Tone={};" } });
  const p = store.createProject({ title: "Sound", kits: ["strudel", "tone"] });
  store.writeFile(p.id, { path: "app.js", content: 'const melody="c4";' });
  store.writeFile(p.id, { path: "index.html", content: '<html><head></head><body><script src="app.js"><\/script></body></html>' });
  const contract = { runtimeGeneration: 1, loading: false, previewHidden: false, sourcePendingReload: false };
  let active = p.id;
  const view = { getCurrentCanvasId: () => active, getCurrentDocumentPath: () => "index.html", getContract: () => contract };
  const instances = { resolveDocument: (projectId) => ({ projectId, documentPath: "index.html", templateId: "strudel-sound", instanceId: "b".repeat(32) }) };
  const options = { view, projectStore: store, instances };
  const starts = [], cancels = [];
  const bridge = createStrudelExportBridge({ ...options, controller: { start(scope, input) {
    starts.push({ scope, input });
    return Promise.resolve({ assetId: "f".repeat(32) });
  }, cancel(scope, id) {
    cancels.push({ scope, id });
    return { cancelled: true };
  } }, exportReady: true });
  return { bridge, store, p, root, contract, options, current: () => currentStrudelScope(options), assert: (scope) => assertStrudelScope(scope, options), starts, cancels, switch: () => {
    active = "d".repeat(32);
  } };
}
test("bridge_derives_scope_and_exposes_only_context_export_cancel", async (t) => {
  const f = fixture(t);
  const context = await f.bridge.handle({ action: "context" });
  assert.match(context.sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal(context.exportReady, true);
  assert.equal(context.kitSource, void 0);
  await f.bridge.handle({ action: "export", input: { exportId: "one", expectedSourceRevision: context.sourceRevision, snapshot: {} } });
  assert.equal(f.starts[0].scope.projectId, f.p.id);
  assert.equal(f.starts[0].scope.instanceId, "b".repeat(32));
  await f.bridge.handle({ action: "cancel", input: { exportId: "one" } });
  assert.equal(f.cancels.length, 1);
  for (const request of [{ action: "read" }, { action: "context", input: { projectId: f.p.id } }, { action: "cancel", input: { exportId: "one", projectId: f.p.id } }, { action: "export", scope: { projectId: f.p.id } }]) await assert.rejects(f.bridge.handle(request), /unsupported|invalid/i);
});
test("source_identity_binds_reachable_app_source_and_ordered_kit_descriptors", (t) => {
  const f = fixture(t);
  const first = f.current();
  f.store.renameProject(f.p.id, { title: "A new title" });
  f.store.writeFile(f.p.id, { path: "unrelated.html", content: "<main>Unrelated</main>" });
  assert.equal(f.current().sourceRevision, first.sourceRevision);
  f.store.writeFile(f.p.id, { path: "app.js", content: 'const melody="d4";' });
  assert.notEqual(f.current().sourceRevision, first.sourceRevision);
  assert.throws(() => f.assert(first), /source|runtime/i);
  const second = f.current();
  f.store.updateManifest(f.p.id, { kits: ["tone", "strudel"] });
  assert.notEqual(f.current().sourceRevision, second.sourceRevision);
});
test("pending_reload_and_runtime_replacement_reject_context_and_old_scope", async (t) => {
  const f = fixture(t);
  const scope = f.current();
  f.contract.sourcePendingReload = true;
  await assert.rejects(f.bridge.handle({ action: "context" }), /reload/i);
  assert.throws(() => f.assert(scope), /reload/i);
  f.contract.sourcePendingReload = false;
  f.contract.runtimeGeneration++;
  assert.throws(() => f.assert(scope), /runtime/i);
});
test("missing_or_corrupt_pin_rejects_before_render_without_global_fallback", async (t) => {
  const f = fixture(t);
  const scope = f.current();
  const pin = f.store.getProjectKitSource(f.p.id, "strudel");
  fs.writeFileSync(path.join(f.root, "canvases", ".dependencies", pin.digest + ".js"), "B");
  assert.throws(() => f.assert(scope), /corrupt/i);
  await assert.rejects(f.bridge.handle({ action: "context" }), /corrupt/i);
  assert.equal(f.starts.length, 0);
});
test("export_readiness_remains_truthful_until_actual_runtime_gate", async (t) => {
  const f = fixture(t);
  const { createStrudelExportBridge } = require("../src/strudel-export-bridge");
  const bridge = createStrudelExportBridge({ ...f.options, controller: { start() {
    throw new Error("must not render");
  } } });
  assert.equal((await bridge.handle({ action: "context" })).exportReady, false);
  await assert.rejects(bridge.handle({ action: "export", input: {} }), /runtime.*gate|compatibility/i);
});
