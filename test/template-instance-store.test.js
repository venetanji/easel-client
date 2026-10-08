const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVideoTimelineStore } = require('../src/video-timeline-store');
const projectId = 'a'.repeat(32);
const instanceId = 'b'.repeat(32);
const timelineId = 'c'.repeat(32);
function fixture(t, options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-instances-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createVideoTimelineStore({ userDataPath, idFactory: () => 'old-timeline' });
  let documents = [{ path: 'video-editor/index.html' }];
  // Assert the missing feature directly, rather than failing at module loading.
  assert.ok(fs.existsSync(path.join(__dirname, '../src/template-instance-store.js')), 'The host-owned template instance store must exist');
  const { createTemplateInstanceStore } = require('../src/template-instance-store');
  const args = { userDataPath, timelineStore: store, projectStore: { listDocuments: () => ({ documents }), getProject: () => ({ files: {} }) }, idFactory: () => instanceId, ...options };
  return { userDataPath, store, instances: createTemplateInstanceStore(args), restart: () => createTemplateInstanceStore(args), setDocuments: (value) => { documents = value; }, legacy: path.join(userDataPath, 'video-timelines', `${projectId}.json`) };
}
function legacy(f) {
  f.store.create(projectId);
  f.store.apply(projectId, { expectedRevision: 0, operations: [{ type: 'add-track', track: { id: 'extra', type: 'audio', name: 'Extra' } }] });
  f.store.undo(projectId, { expectedRevision: 1 });
  return fs.readFileSync(f.legacy, 'utf8');
}
test('legacy_migration_is_idempotent', (t) => {
  const f = fixture(t); const before = legacy(f);
  const first = f.instances.migrateLegacy(projectId);
  assert.equal(first.status, 'migrated');
  assert.equal(first.instance.timelineId, 'old-timeline');
  assert.equal(first.instance.documentPath, 'video-editor/index.html');
  assert.equal(first.instance.instanceId, instanceId);
  assert.deepEqual(f.restart().migrateLegacy(projectId), { status: 'already-migrated', instance: first.instance });
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), before);
  const envelope = JSON.parse(before);
  assert.deepEqual(f.store.read(projectId, 'old-timeline'), envelope.document);
  const migratedPath = path.join(f.userDataPath, 'video-timelines', projectId, 'old-timeline.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(migratedPath, 'utf8')), envelope);
  assert.equal(f.store.redo(projectId, 'old-timeline', { expectedRevision: 2 }).revision, 3);
});
test('ambiguous_legacy_copy_requires_choice', (t) => {
  const f = fixture(t); const before = legacy(f);
  f.setDocuments([{ path: 'video-editor/index.html' }, { path: 'video-editor/copy.html', templateId: 'video-editor' }]);
  assert.throws(() => f.instances.migrateLegacy(projectId), { code: 'TIMELINE_AMBIGUOUS' });
  assert.deepEqual(f.instances.list(projectId), []);
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), before);
});
test('failed_registry_migration_preserves_original_and_recovers', (t) => {
  let fail = true;
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => { if (fail) throw new Error('Registry disk failure'); return fs.renameSync(from, to); };
  const f = fixture(t, { fileSystem }); const before = legacy(f);
  assert.throws(() => f.instances.migrateLegacy(projectId), /disk failure/i);
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), before);
  assert.deepEqual(f.instances.list(projectId), []);
  fail = false;
  assert.equal(f.restart().migrateLegacy(projectId).status, 'migrated');
  assert.deepEqual(f.store.read(projectId, 'old-timeline'), JSON.parse(before).document);
});
test('corrupt_legacy_never_creates_a_binding_or_resets_original', (t) => {
  const f = fixture(t); legacy(f); fs.writeFileSync(f.legacy, '{partial');
  assert.throws(() => f.instances.migrateLegacy(projectId), { code: 'TIMELINE_CORRUPT' });
  assert.deepEqual(f.instances.list(projectId), []);
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), '{partial');
});
test('registry_validates_unique_host_bindings_and_removes_only_the_target', (t) => {
  const f = fixture(t);
  const record = { projectId, instanceId, documentPath: `sketches/${instanceId}/index.html`, templateId: 'video-editor', templateVersion: 1, timelineId };
  assert.deepEqual(f.instances.create(record), record);
  assert.deepEqual(f.restart().resolveDocument(projectId, record.documentPath), record);
  assert.equal(f.instances.resolveDocument(projectId, 'other.html'), null);
  assert.throws(() => f.instances.create({ ...record, instanceId: 'd'.repeat(32) }), /already|unique|bound/i);
  for (const input of [{ ...record, instanceId: '../escape' }, { ...record, documentPath: '../escape.html' }, { ...record, unknown: true }]) assert.throws(() => f.instances.create(input));
  const other = { projectId, instanceId: 'e'.repeat(32), documentPath: 'sound/index.html', templateId: 'strudel-sound', templateVersion: 1 };
  f.instances.create(other);
  assert.equal(f.instances.remove(projectId, instanceId), true);
  assert.equal(f.instances.remove(projectId, instanceId), false);
  assert.deepEqual(f.instances.list(projectId), [other]);
});

test('instance_removal_is_transactional_and_never_resurrects_legacy', (t) => {
  const f = fixture(t); legacy(f); const { instance } = f.instances.migrateLegacy(projectId);
  f.instances.remove(projectId, instance.instanceId);
  assert.deepEqual(f.instances.list(projectId), []);
  assert.deepEqual(f.store.list(projectId), []);
  assert.equal(f.instances.migrateLegacy(projectId).status, 'none');
});

test('registry_remove_failure_preserves_timeline_and_binding', (t) => {
  let fail = false;
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (...args) => { if (fail) throw new Error('Registry disk failure'); return fs.renameSync(...args); };
  const f = fixture(t, { fileSystem }); legacy(f); const { instance } = f.instances.migrateLegacy(projectId);
  fail = true;
  assert.throws(() => f.instances.remove(projectId, instance.instanceId), /disk failure/i);
  assert.deepEqual(f.instances.list(projectId), [instance]);
  assert.equal(f.store.read(projectId, instance.timelineId).revision, 2);
});

test('partial_migration_copy_recovers_from_original_without_touching_source', (t) => {
  const f = fixture(t); const before = legacy(f);
  const directory = path.join(f.userDataPath, 'video-timelines', projectId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'old-timeline.json'), '{partial');
  assert.equal(f.instances.migrateLegacy(projectId).status, 'migrated');
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), before);
  assert.deepEqual(f.store.read(projectId, 'old-timeline'), JSON.parse(before).document);
  const recovery = fs.readdirSync(directory).find((name) => name.endsWith('.corrupt'));
  assert.ok(recovery); assert.equal(fs.readFileSync(path.join(directory, recovery), 'utf8'), '{partial');
});

function realFixture(t) {
  const { createCanvasStore } = require('../src/canvas-store');
  const { createTemplateInstanceStore } = require('../src/template-instance-store');
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-real-migration-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const timelines = createVideoTimelineStore({ userDataPath, idFactory: () => 'legacy-id' });
  const canvases = createCanvasStore({ userDataPath, listTimelines: (id) => timelines.list(id) });
  const projectId = canvases.createProject({ title: 'Legacy project' }).id;
  const instances = createTemplateInstanceStore({ userDataPath, timelineStore: timelines, projectStore: canvases });
  return { userDataPath, timelines, canvases, projectId, instances };
}
function authored(f) {
  return Object.fromEntries(f.canvases.listFiles(f.projectId).files.filter((file) => /html|js|css/.test(file.kind)).map((file) => [file.path, f.canvases.readFile(f.projectId, { path: file.path }).text]));
}
test('legacy_editor_with_unrelated_documents_migrates_once', (t) => {
  const f = realFixture(t);
  f.canvases.createDocument(f.projectId, { path: 'video-editor/index.html', html: '<main>Video</main><script>window.EaselHost.timeline({action:"read"});</script>' });
  f.canvases.createDocument(f.projectId, { path: 'unrelated.html', html: '<h1>Unrelated</h1>' });
  f.timelines.create(f.projectId);
  f.timelines.apply(f.projectId, { expectedRevision: 0, operations: [{ type: 'add-track', track: { id: 'extra', name: 'Extra', type: 'audio' } }] });
  const original = fs.readFileSync(path.join(f.userDataPath, 'video-timelines', `${f.projectId}.json`), 'utf8');
  const source = authored(f);
  assert.equal(f.instances.migrateLegacy(f.projectId).status, 'migrated');
  assert.equal(f.instances.migrateLegacy(f.projectId).status, 'already-migrated');
  assert.deepEqual(authored(f), source);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.userDataPath, 'video-timelines', f.projectId, 'legacy-id.json'), 'utf8')), JSON.parse(original));
});
test('real_legacy_copies_with_shared_scripts_remain_ambiguous', (t) => {
  const f = realFixture(t);
  f.canvases.writeFile(f.projectId, { path: 'shared.js', content: 'window.EaselHost.timeline({action:"read"});' });
  for (const documentPath of ['video-editor/index.html', 'copy.html']) f.canvases.createDocument(f.projectId, { path: documentPath, html: `<main>Video</main><script src="${documentPath.includes('/') ? '../' : ''}shared.js"></script>` });
  f.timelines.create(f.projectId); const before = authored(f);
  assert.throws(() => f.instances.migrateLegacy(f.projectId), { code: 'TIMELINE_AMBIGUOUS' });
  assert.deepEqual(f.instances.list(f.projectId), []); assert.deepEqual(authored(f), before);
});
test('unused_editor_code_cannot_bind_an_unrelated_document', (t) => {
  const f = realFixture(t);
  f.canvases.writeFile(f.projectId, { path: 'unused.js', content: 'window.EaselVideoEditor = window.EaselHost.timeline;' });
  f.timelines.create(f.projectId);
  assert.deepEqual(f.instances.migrateLegacy(f.projectId), { status: 'document-missing' });
  assert.deepEqual(f.instances.list(f.projectId), []);
});

test('migration_inspects_only_reachable_module_sources', (t) => {
  const f = realFixture(t);
  f.canvases.writeFile(f.projectId, { path: 'shared.js', content: 'window.EaselHost.timeline({action:"read"});' });
  f.canvases.writeFile(f.projectId, { path: 'unrelated.js', content: 'export const value = 1;' });
  f.canvases.createDocument(f.projectId, { path: 'module-video.html', html: '<h1>Video</h1><script type="module" src="shared.js"></script>' });
  f.canvases.createDocument(f.projectId, { path: 'module-other.html', html: '<h1>Other</h1><script type="module" src="unrelated.js"></script>' });
  f.timelines.create(f.projectId);
  assert.equal(f.instances.migrateLegacy(f.projectId).instance.documentPath, 'module-video.html');
});
