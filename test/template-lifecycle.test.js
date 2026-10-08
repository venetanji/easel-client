const test = require('node:test');
const assert = require('node:assert/strict');
const { templateFixture } = require('./helpers/template-lifecycle');
const canvasHistory = require('../src/canvas-history');

test('undo_deleted_video_restores_instance_and_timeline_history', async (t) => {
  const f = templateFixture(t), [a, b] = f.records;
  f.timelines.apply(f.projectId, a.timelineId, { expectedRevision: 0, operations: [{ type: 'insert', item: f.clip }] });
  f.timelines.apply(f.projectId, a.timelineId, { expectedRevision: 1, operations: [{ type: 'move', itemId: 'clip', startFrame: 24 }] });
  f.timelines.undo(f.projectId, a.timelineId, { expectedRevision: 2 });
  const beforeA = f.bytes(a), beforeB = f.bytes(b), beforeProject = f.canvases.getProject(f.projectId);
  const beforeSource = f.canvases.listFiles(f.projectId).files.map((file) => [file.path, file.revision]);
  const result = await f.deletion.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath });
  assert.equal(result.deleted, true); assert.equal(f.timelines.read(f.projectId, a.timelineId), null);
  assert.equal(f.savedRecovery()?.instances?.length, 1, 'Deletion Undo must retain its trusted binding and complete timeline envelope');
  const restored = canvasHistory.restoreCanvasHistory({ history: f.history, canvasStore: f.canvases, instances: f.instances }, f.projectId);
  assert.ok(restored);
  assert.deepEqual(f.instances.resolveDocument(f.projectId, a.documentPath), a);
  assert.equal(f.bytes(a), beforeA); assert.equal(f.bytes(b), beforeB);
  assert.deepEqual(f.canvases.getProject(f.projectId).manifest, beforeProject.manifest);
  assert.deepEqual(f.canvases.listFiles(f.projectId).files.map((file) => [file.path, file.revision]), beforeSource);
  assert.equal(f.timelines.redo(f.projectId, a.timelineId, { expectedRevision: 3 }).items[0].startFrame, 24);
  assert.equal(f.timelines.undo(f.projectId, a.timelineId, { expectedRevision: 4 }).items[0].startFrame, 0);
});
test('complete_recovery_budget_is_checked_before_deleting_a_bound_document', async (t) => {
  const f = templateFixture(t, { historyOptions: { maxBytes: 1 } }), [a, b] = f.records;
  const before = f.canvases.getProject(f.projectId).projectRevision, bytesA = f.bytes(a), bytesB = f.bytes(b);
  await assert.rejects(f.deletion.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath }), /undo|history|budget/i);
  assert.equal(f.canvases.getProject(f.projectId).projectRevision, before); assert.equal(f.bytes(a), bytesA); assert.equal(f.bytes(b), bytesB);
  assert.deepEqual(f.instances.resolveDocument(f.projectId, a.documentPath), a);
});
test('cancelled_and_failed_real_deletions_keep_both_envelopes', async (t) => {
  const f = templateFixture(t, { confirm: () => false }), [a, b] = f.records;
  const beforeA = f.bytes(a), beforeB = f.bytes(b);
  assert.equal((await f.deletion.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath })).canceled, true);
  assert.equal(f.bytes(a), beforeA); assert.equal(f.bytes(b), beforeB);
  const failed = templateFixture(t, { confirm: () => { throw new Error('Confirmation failed'); } });
  const bytes = failed.records.map(failed.bytes);
  await assert.rejects(failed.deletion.deleteProjectFile(failed.hostController, failed.projectId, { path: 'a.html' }), /Confirmation failed/);
  assert.deepEqual(failed.records.map(failed.bytes), bytes);
});

test('failed_metadata_restore_rolls_source_back_and_keeps_history', async (t) => {
  const fs = require('node:fs'); let fail = false;
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (...args) => { if (fail) throw new Error('Registry unavailable'); return fs.renameSync(...args); };
  const f = templateFixture(t, { instanceFileSystem: fileSystem }), [a, b] = f.records;
  const beforeA = f.bytes(a), beforeB = f.bytes(b);
  await f.deletion.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath });
  const deletedRevision = f.canvases.getProject(f.projectId).projectRevision;
  fail = true;
  assert.throws(() => canvasHistory.restoreCanvasHistory({ history: f.history, canvasStore: f.canvases, instances: f.instances }, f.projectId), /Registry unavailable/);
  assert.equal(f.canvases.getProject(f.projectId).projectRevision, deletedRevision);
  assert.equal(f.timelines.read(f.projectId, a.timelineId), null); assert.equal(f.bytes(b), beforeB); assert.equal(f.history.canUndo(f.projectId), true);
  fail = false;
  canvasHistory.restoreCanvasHistory({ history: f.history, canvasStore: f.canvases, instances: f.instances }, f.projectId);
  assert.equal(f.bytes(a), beforeA); assert.equal(f.bytes(b), beforeB);
});

test('recovery_conflict_never_overwrites_newer_independent_state', async (t) => {
  const f = templateFixture(t), [a, b] = f.records;
  await f.deletion.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath });
  f.timelines.create(f.projectId, a.timelineId, { width: 100 });
  const currentA = f.bytes(a), currentB = f.bytes(b), deletedRevision = f.canvases.getProject(f.projectId).projectRevision;
  assert.throws(() => canvasHistory.restoreCanvasHistory({ history: f.history, canvasStore: f.canvases, instances: f.instances }, f.projectId), /conflict/i);
  assert.equal(f.bytes(a), currentA); assert.equal(f.bytes(b), currentB);
  assert.equal(f.history.canUndo(f.projectId), true); assert.equal(f.canvases.getProject(f.projectId).projectRevision, deletedRevision);
});

test('undo_does_not_reset_independent_timeline_edits_made_after_deletion', async (t) => {
  const f = templateFixture(t), [a, b] = f.records;
  const beforeA = f.bytes(a);
  await f.deletion.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath });
  f.timelines.apply(f.projectId, b.timelineId, { expectedRevision: 0, operations: [{ type: 'insert', item: { ...f.clip, id: 'independent' } }] });
  const editedB = f.bytes(b);
  canvasHistory.restoreCanvasHistory({ history: f.history, canvasStore: f.canvases, instances: f.instances }, f.projectId);
  assert.equal(f.bytes(a), beforeA); assert.equal(f.bytes(b), editedB);
});

test('stale_real_source_deletion_leaves_binding_and_recovery_history_unchanged', async (t) => {
  const f = templateFixture(t), [a, b] = f.records;
  const beforeA = f.bytes(a), beforeB = f.bytes(b);
  await assert.rejects(f.deletion.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath, expectedRevision: 'f'.repeat(64) }), /changed|revision|stale/i);
  assert.equal(f.bytes(a), beforeA); assert.equal(f.bytes(b), beforeB);
  assert.deepEqual(f.instances.resolveDocument(f.projectId, a.documentPath), a); assert.equal(f.history.canUndo(f.projectId), false);
});

test('failed_runtime_reload_retains_real_recovery_until_a_successful_retry', async (t) => {
  const f = templateFixture(t), [a, b] = f.records;
  const beforeA = f.bytes(a), beforeB = f.bytes(b);
  await f.deletion.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath });
  await assert.rejects(canvasHistory.restoreCanvasHistory({ history: f.history, canvasStore: f.canvases, instances: f.instances,
    afterRestore: async () => { throw new Error('Runtime reload failed'); },
  }, f.projectId), /Runtime reload failed/);
  assert.equal(f.history.canUndo(f.projectId), true); assert.equal(f.bytes(a), beforeA); assert.equal(f.bytes(b), beforeB);
  await canvasHistory.restoreCanvasHistory({ history: f.history, canvasStore: f.canvases, instances: f.instances, afterRestore: async (saved) => saved }, f.projectId);
  assert.equal(f.history.canUndo(f.projectId), false); assert.equal(f.bytes(a), beforeA); assert.equal(f.bytes(b), beforeB);
});

test('real_bound_deletion_requires_a_complete_recovery_history_sink', async (t) => {
  const { createDeletionService } = require('../src/deletion-service');
  const f = templateFixture(t), [a, b] = f.records;
  const before = [f.bytes(a), f.bytes(b)];
  const service = createDeletionService({ canvasStore: f.canvases, instances: f.instances, confirm: () => true });
  await assert.rejects(service.deleteProjectFile(f.hostController, f.projectId, { path: a.documentPath }), /undo|history|recovery/i);
  assert.deepEqual([f.bytes(a), f.bytes(b)], before);
  assert.ok(f.canvases.listDocuments(f.projectId).documents.some((document) => document.path === a.documentPath));
});
