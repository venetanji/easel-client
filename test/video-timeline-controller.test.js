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
