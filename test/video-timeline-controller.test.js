const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVideoTimelineStore } = require('../src/video-timeline-store');
const { createVideoTimelineController, validateTimelineRequest, validateTimelineSelectionInput } = require('../src/video-timeline-controller');
const projectId = 'a'.repeat(32);
const assetId = 'b'.repeat(32);
const clip = { id: 'clip-1', trackId: 'video-1', assetId, startFrame: 0, endFrame: 24, sourceStartSeconds: 0, sourceEndSeconds: 1 };
function fixture(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-timeline-controller-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let active = projectId;
  let assets = [{ id: assetId, mimeType: 'video/mp4', duration: 2, name: 'Shot' }];
  const events = [];
  const store = createVideoTimelineStore({ userDataPath });
  const controller = createVideoTimelineController({ store,
    projectStore: { getProject(id) { assert.equal(id, projectId); return {}; }, listAssets() { return { assets }; } },
    getActiveProjectId: () => active, onChanged: (event) => events.push(event),
  });
  return { controller, store, events, setActive: (id) => { active = id; }, setAssets: (next) => { assets = next; } };
}
test('timeline IPC accepts only bounded typed requests and selections', () => {
  assert.deepEqual(validateTimelineRequest('apply', { expectedRevision: 0, operations: [{ type: 'remove', itemId: 'clip' }] }), { expectedRevision: 0, operations: [{ type: 'remove', itemId: 'clip' }] });
  assert.throws(() => validateTimelineRequest('apply', { expectedRevision: 0, operations: [], shell: 'exec' }), /unsupported/i);
  assert.throws(() => validateTimelineRequest('undo', { expectedRevision: -1 }), /revision/i);
  assert.throws(() => validateTimelineRequest('create', { items: [clip] }), /unsupported/i);
  assert.throws(() => validateTimelineSelectionInput({ projectId, timelineId: 'tl', timelineRevision: 0, trackIds: [], itemIds: [], startFrame: 0, endFrame: 0 }), /range/i);
});
test('timeline controller persists edits for the active project and emits compact changes', (t) => {
  const { controller, events } = fixture(t);
  const created = controller.create(projectId, {});
  assert.equal(created.revision, 0);
  const edited = controller.apply(projectId, { expectedRevision: 0, operations: [{ type: 'insert', item: clip }] });
  assert.equal(edited.items[0].assetId, assetId);
  assert.equal(edited.revision, 1);
  assert.deepEqual(events.at(-1), { type: 'timeline-changed', projectId, timelineId: created.id, revision: 1 });
  assert.equal(controller.history(projectId).undoAvailable, true);
  assert.throws(() => controller.apply(projectId, { expectedRevision: 0, operations: [{ type: 'remove', itemId: clip.id }] }), { code: 'TIMELINE_REVISION_CONFLICT' });
});
test('timeline edits reject unattached assets, mismatched media and source overruns atomically', (t) => {
  const f = fixture(t);
  f.controller.create(projectId, {});
  for (const item of [{ ...clip, assetId: 'c'.repeat(32) }, { ...clip, trackId: 'audio-1' }, { ...clip, sourceEndSeconds: 3, endFrame: 72 }]) {
    assert.throws(() => f.controller.apply(projectId, { expectedRevision: 0, operations: [{ type: 'insert', item }] }));
    assert.equal(f.store.read(projectId).revision, 0);
  }
  f.setActive('c'.repeat(32));
  assert.throws(() => f.controller.apply(projectId, { expectedRevision: 0, operations: [{ type: 'insert', item: clip }] }), /active project/i);
});
test('chat timeline context binds revision and exact selection without media bytes', (t) => {
  const { controller } = fixture(t);
  controller.create(projectId, {});
  const doc = controller.apply(projectId, { expectedRevision: 0, operations: [{ type: 'insert', item: clip }] });
  const selection = { projectId, timelineId: doc.id, timelineRevision: 1, trackIds: ['video-1'], itemIds: ['clip-1'], startFrame: 3, endFrame: 12 };
  const context = controller.resolveSelection(selection);
  assert.deepEqual(context.selection, selection);
  assert.equal(context.items[0].assetId, assetId);
  assert.deepEqual(context.frameRate, { numerator: 24, denominator: 1 });
  assert.equal(JSON.stringify(context).includes('data:'), false);
  controller.undo(projectId, { expectedRevision: 1 });
  assert.throws(() => controller.resolveSelection(selection), /revision|stale/i);
});
test('timeline media cannot be detached while referenced', (t) => {
  const { controller } = fixture(t);
  controller.create(projectId, {});
  controller.apply(projectId, { expectedRevision: 0, operations: [{ type: 'insert', item: clip }] });
  assert.throws(() => controller.assertAssetUnused(projectId, assetId), /timeline/i);
});

test('undo refuses missing restored media without committing or consuming history', (t) => {
  const f = fixture(t);
  f.controller.create(projectId, {});
  f.controller.apply(projectId, { expectedRevision: 0, operations: [{ type: 'insert', item: clip }] });
  f.controller.apply(projectId, { expectedRevision: 1, operations: [{ type: 'remove', itemId: clip.id }] });
  f.setAssets([]);
  assert.throws(() => f.controller.undo(projectId, { expectedRevision: 2 }), /not attached/i);
  assert.equal(f.store.read(projectId).revision, 2);
  assert.equal(f.store.read(projectId).items.length, 0);
  assert.equal(f.store.status(projectId).undoAvailable, true);
});

test('agent editor creation cannot switch away from the active project', (t) => {
  const f = fixture(t);
  let opened = false;
  f.setActive('c'.repeat(32));
  assert.throws(() => f.controller.openEditor(projectId, () => { opened = true; }), /active project/i);
  assert.equal(opened, false);
});

test('still images can be timed on a video track as well as overlay tracks', (t) => {
  const f = fixture(t);
  f.setAssets([{ id: assetId, mimeType: 'image/png', name: 'Still.png' }]);
  f.controller.create(projectId, {});
  const doc = f.controller.apply(projectId, { expectedRevision: 0, operations: [{ type: 'insert', item: clip }] });
  assert.equal(doc.items[0].assetId, assetId);
});

test('stale_selection_rejected', (t) => {
  const f = fixture(t);
  const a = 'd'.repeat(32), b = 'e'.repeat(32), instanceId = 'f'.repeat(32);
  f.store.create(projectId, a, {}); f.store.create(projectId, b, {});
  let activeScope = { projectId, documentPath: 'a.html', instanceId, timelineId: a, runtimeGeneration: 2 };
  const instances = { list: () => [{ ...activeScope, templateId: 'video-editor' }], resolveDocument: (_id, documentPath) => documentPath === 'a.html' ? activeScope : null };
  const controller = createVideoTimelineController({ store: f.store, projectStore: { getProject: () => ({}) }, instances, getActiveProjectId: () => projectId, getActiveScope: () => activeScope });
  const selection = { projectId, instanceId, documentPath: 'a.html', runtimeGeneration: 2, timelineId: a, timelineRevision: 0, trackIds: ['video-1'], itemIds: [], startFrame: 0, endFrame: 12 };
  assert.equal(controller.resolveSelection(selection).selection.instanceId, instanceId);
  for (const change of [{ timelineId: b }, { instanceId: 'b'.repeat(32) }, { runtimeGeneration: 1 }, { documentPath: 'b.html' }]) assert.throws(() => controller.resolveSelection({ ...selection, ...change }), /instance|stale|document|runtime/i);
  activeScope = { ...activeScope, runtimeGeneration: 3 };
  assert.throws(() => controller.resolveSelection(selection), /stale|runtime/i);
});

test('controller_legacy_requests_never_choose_the_first_timeline', (t) => {
  const { store, controller } = fixture(t);
  store.create(projectId, 'd'.repeat(32), {}); store.create(projectId, 'e'.repeat(32), {});
  assert.throws(() => controller.resolveLegacy(projectId), { code: 'TIMELINE_AMBIGUOUS' });
  assert.throws(() => controller.inspect({ projectId }), { code: 'TIMELINE_AMBIGUOUS' });
});

test('selection_identity_rejects_coercible_non_string_ids', () => {
  const selection = { projectId, timelineId: 'a'.repeat(32), instanceId: 'b'.repeat(32), timelineRevision: 0, trackIds: ['video-1'], itemIds: [], startFrame: 0, endFrame: 1 };
  assert.throws(() => validateTimelineSelectionInput({ ...selection, instanceId: [selection.instanceId] }), /instance/i);
  assert.throws(() => validateTimelineSelectionInput({ ...selection, timelineId: [selection.timelineId] }), /timeline ID/i);
});

test('populated track deletion above 99 clips uses one operation and one undo without changing media', (t) => {
  const f = fixture(t); f.controller.create(projectId, {});
  const clips = Array.from({ length: 101 }, (_, i) => ({ ...clip, id: `clip-${i}`, startFrame: i * 24, endFrame: (i + 1) * 24 }));
  f.controller.apply(projectId, { expectedRevision: 0, operations: clips.slice(0, 100).map(item => ({ type: 'insert', item })) });
  const before = f.controller.apply(projectId, { expectedRevision: 1, operations: [{ type: 'insert', item: clips[100] }] });
  const removed = f.controller.apply(projectId, { expectedRevision: 2, operations: [{ type: 'remove-track', trackId: 'video-1', removeItems: true }] });
  assert.equal(removed.items.length, 0); assert.equal(removed.tracks.length, 2);
  assert.throws(() => f.controller.apply(projectId, { expectedRevision: 2, operations: [{ type: 'remove-track', trackId: 'audio-1' }] }), { code: 'TIMELINE_REVISION_CONFLICT' });
  const restored = f.controller.undo(projectId, { expectedRevision: 3 });
  assert.deepEqual(restored.items, before.items); assert.deepEqual(restored.tracks, before.tracks);
  assert.equal(restored.revision, 4);
  assert.equal(f.controller.redo(projectId, { expectedRevision: 4 }).items.length, 0);
  assert.throws(() => validateTimelineRequest('apply', { expectedRevision: 5, operations: clips.map(item => ({ type: 'remove', itemId: item.id })) }), /1–100/);
});
