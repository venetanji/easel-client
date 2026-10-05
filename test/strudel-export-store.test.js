const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createCanvasMediaStore } = require("../src/canvas-media-store");
const { createCanvasStore } = require("../src/canvas-store");
const { encodePCM16Wav } = require("../src/strudel-export-renderer");
const { snapshotTiming } = require("../src/strudel-export-policy");
const { createStrudelExportController } = require("../src/strudel-export-controller");
const scope = { projectId: "a".repeat(32), instanceId: "b".repeat(32), documentPath: "index.html", runtimeGeneration: 1, sourceRevision: "c".repeat(64) };
const snapshot = { bpm: 240, cycles: 1, tailSeconds: 0.5, parameterDigest: "d".repeat(64), events: [] };
const frames = snapshotTiming(snapshot).frames;
const bytes = Buffer.from(encodePCM16Wav({ sampleRate: 48e3, numberOfChannels: 2, length: frames, getChannelData: () => new Float32Array(frames) }));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easel-strudel-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createCanvasMediaStore({ userDataPath: root }) };
}
function provenance(exportId = "old-export") {
  return { kind: "strudel-export", exportId, projectId: scope.projectId, instanceId: scope.instanceId, documentPath: scope.documentPath, sourceRevision: scope.sourceRevision, contentDigest: "e".repeat(64), kitDigest: "f".repeat(64), bpm: 240, cycles: 1 };
}
async function save(store, p = provenance()) {
  return store.save({ data: bytes.toString("base64"), mimeType: "audio/wav", duration: frames / 48e3, scope: p });
}
test("durable_lookup_finds_receipts_older_than_public_200_limit", async (t) => {
  const f = fixture(t);
  assert.equal(typeof f.store.findExport, "function", "host receipt lookup must exist");
  const id = await save(f.store);
  for (let i = 0; i < 201; i++) await f.store.save({ data: "SUQz", mimeType: "audio/mpeg" });
  assert.equal((await f.store.list()).length, 200);
  const fresh = createCanvasMediaStore({ userDataPath: f.root });
  const saved = await fresh.findExport({ projectId: scope.projectId, instanceId: scope.instanceId, exportId: "old-export" });
  assert.equal(saved.id, id);
  assert.deepEqual(saved.wavBytes, bytes);
  assert.equal(await fresh.findExport({ projectId: scope.projectId, instanceId: scope.instanceId, exportId: "none" }), null);
});
test("durable_lookup_rejects_ambiguous_corrupt_and_malformed_receipts", async (t) => {
  const f = fixture(t);
  assert.equal(typeof f.store.findExport, "function");
  const query = { projectId: scope.projectId, instanceId: scope.instanceId, exportId: "old-export" };
  const id = await save(f.store);
  await save(f.store);
  await assert.rejects(f.store.findExport(query), /ambiguous/i);
  const dirs = fs.readdirSync(path.join(f.root, "canvas-media"));
  fs.rmSync(path.join(f.root, "canvas-media", dirs.find((x) => x !== id)), { recursive: true });
  fs.writeFileSync(path.join(f.root, "canvas-media", id, "media.wav"), Buffer.alloc(bytes.length));
  await assert.rejects(f.store.findExport(query), /corrupt/i);
  fs.writeFileSync(path.join(f.root, "canvas-media", id, "media.wav"), bytes);
  const meta = path.join(f.root, "canvas-media", id, "metadata.json");
  const data = JSON.parse(fs.readFileSync(meta));
  data.scope.contentDigest = "invalid";
  fs.writeFileSync(meta, JSON.stringify(data));
  await assert.rejects(f.store.findExport(query), /receipt/i);
});
test("restart_recovers_success_without_rendering_resaving_or_reattaching", async (t) => {
  const f = fixture(t);
  let renders = 0, saves = 0, attaches = 0;
  const make = () => createStrudelExportController({ render: async () => {
    renders++;
    return { wavBytes: bytes, duration: frames / 48e3, channels: 2, sampleRate: 48e3 };
  }, saveMedia: async (payload) => {
    saves++;
    return f.store.save(payload);
  }, findExport: (query) => createCanvasMediaStore({ userDataPath: f.root }).findExport(query), isAttached: async () => false, attach: async () => {
    attaches++;
    throw new Error("attach failure");
  }, assertScope: () => {
  }, captureDependency: () => ({ source: "A", digest: "f".repeat(64) }) });
  const req = { exportId: "restart-export", expectedSourceRevision: scope.sourceRevision, snapshot };
  const a = await make().start(scope, req);
  const b = await make().start({ ...scope, runtimeGeneration: 5 }, req);
  assert.equal(a.assetId, b.assetId);
  assert.equal(renders, 1);
  assert.equal(saves, 1);
  assert.equal(attaches, 1);
  assert.equal(b.attachmentStatus, "saved-only");
  const changed = { ...req, snapshot: { ...snapshot, bpm: 120 } };
  await assert.rejects(make().start(scope, changed), /different content/i);
  assert.equal(saves, 1);
});
test("project_pin_is_checked_and_never_falls_back_to_installed_bundle", (t) => {
  const f = fixture(t);
  let store = createCanvasStore({ userDataPath: f.root, kitBundles: { strudel: 'window.strudel = {version:"A"};' } });
  const project = store.createProject({ title: "Sound", kits: ["strudel"] });
  assert.equal(typeof store.getProjectKitSource, "function", "host exact-pin accessor exists");
  const a = store.getProjectKitSource(project.id, "strudel");
  store = createCanvasStore({ userDataPath: f.root, kitBundles: { strudel: 'window.strudel = {version:"B"};' } });
  assert.equal(store.getProjectKitSource(project.id, "strudel").source, a.source);
  assert.equal(a.digest, crypto.createHash("sha256").update(a.source).digest("hex"));
  const cache = path.join(f.root, "canvases", ".dependencies", a.digest + ".js");
  fs.writeFileSync(cache, "B");
  assert.throws(() => store.getProjectKitSource(project.id, "strudel"), /corrupt|missing/i);
  fs.rmSync(cache);
  assert.throws(() => store.getProjectKitSource(project.id, "strudel"), /missing|unavailable/i);
  fs.writeFileSync(cache, "x".repeat(8 * 1048576 + 1));
  assert.throws(() => store.getProjectKitSource(project.id, "strudel"), /oversized|limit/i);
});
test("attachment_rechecks_runtime_at_actual_commit_after_async_media_lookup", async (t) => {
  const f = fixture(t);
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const store = createCanvasStore({ userDataPath: f.root, assetStore: { async get(id) {
    await gate;
    return { id, mimeType: "audio/wav", data: bytes.toString("base64"), name: "Loop.wav", duration: frames / 48e3 };
  } } });
  const project = store.createProject({ title: "Sound" });
  let valid = true;
  const attaching = store.attachAssets(project.id, { assetIds: ["1".repeat(32)] }, { beforeCommit() {
    if (!valid) throw new Error("Runtime switched");
  } });
  valid = false;
  resume();
  await assert.rejects(attaching, /Runtime switched/);
  assert.equal(store.getProject(project.id).manifest.assets.length, 0);
});

test('completed_memory_receipt_never_hides_deleted_or_corrupt_durable_asset', async t => {
  const f = fixture(t); let renders = 0;
  const controller = createStrudelExportController({ render: async () => { renders++; return { wavBytes: bytes, duration: frames / 48000, channels: 2, sampleRate: 48000 }; }, saveMedia: f.store.save,
    findExport: f.store.findExport, isAttached: async () => false, attach: async () => {}, assertScope: () => {}, captureDependency: () => ({ source: 'A', digest: 'f'.repeat(64) }) });
  const req = { exportId: 'cached-receipt', expectedSourceRevision: scope.sourceRevision, snapshot }; const receipt = await controller.start(scope, req);
  fs.writeFileSync(path.join(f.root, 'canvas-media', receipt.assetId, 'media.wav'), Buffer.alloc(bytes.length));
  await assert.rejects(controller.start(scope, req), /corrupt/i); assert.equal(renders, 1);
  await f.store.remove(receipt.assetId); await assert.rejects(controller.start(scope, req), /missing|removed|found/i); assert.equal(renders, 1);
});
