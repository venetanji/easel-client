const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeletionService } = require('../src/deletion-service');

function fixture(confirm) {
  const calls = [];
  const info = { ok: true, path: 'old.html', revision: 'a'.repeat(64), projectRevision: 'b'.repeat(64), isDocument: true };
  const controller = {
    getCurrentCanvasId: () => 'project', getCurrentDocumentPath: () => 'old.html', getContract: () => ({ previewHidden: false }),
    async openSaved(id, path) { calls.push(['open', path]); return { id, documentPath: path }; },
    markSourcePendingReload() { calls.push(['pending']); },
  };
  const canvasStore = {
      inspectDeletion: () => info,
      inspectProjectDeletion: () => ({ ok: true, title: 'Study project', projectRevision: info.projectRevision, fileCount: 3, mediaCount: 1, sharedMediaCount: 0 }),
      inspectAssetDeletion: () => ({ ok: true, projectRevision: info.projectRevision, asset: { name: 'Study.png' } }),
      get: () => ({ html: 'authored source' }), getProject: () => ({ manifest: { entry: 'index.html' } }),
      listDocuments: () => ({ documents: [{ path: 'index.html' }] }),
      deleteFile(id, args) { calls.push(['delete', args]); return { id }; },
      deleteProject(id, args) { calls.push(['delete-project', args]); return { id, projectDeleted: true, keptAssetIds: args.deleteMedia ? [] : ['image'], deletedAssetIds: args.deleteMedia ? ['image'] : [], mediaDeletionCandidates: args.deleteMedia ? ['image'] : [] }; },
      detachAsset(id, args) { calls.push(['detach', args]); return { id }; },
  };
  const service = createDeletionService({
    canvasStore,
    mediaStore: { get: async () => ({ name: 'Library study.png' }), remove: async (id) => { calls.push(['remove', id]); return { id }; } },
    confirm: async (...args) => { calls.push(['confirm']); return confirm(...args); },
    previewFile: async () => { calls.push(['preview']); },
    previewMedia: async () => { calls.push(['media-preview']); },
    recordUndo: () => { calls.push(['undo']); }, onEvent: (event) => { calls.push(['event', event]); },
    onProjectDeleted: async (controller, id, result) => { calls.push(['project-cleanup', id, result]); },
  });
  return { service, controller, calls, info, canvasStore };
}

test('agent previews a file before confirmation and cancellation does not mutate it', async () => {
  const { service, controller, calls } = fixture(() => false);
  const result = await service.deleteProjectFile(controller, 'project', { path: 'old.html' }, { preview: true });
  assert.equal(result.deleted, false);
  assert.equal(result.canceled, true);
  assert.deepEqual(calls.map(([name]) => name), ['preview', 'confirm']);
});

test('confirmed file deletion uses inspected revisions and opens a surviving document', async () => {
  const { service, controller, calls, info } = fixture(() => true);
  const result = await service.deleteProjectFile(controller, 'project', { path: 'old.html' });
  assert.equal(result.deleted, true);
  assert.equal(result.documentPath, 'index.html');
  assert.deepEqual(calls.find(([name]) => name === 'delete')[1], { path: 'old.html', expectedRevision: info.revision, expectedProjectRevision: info.projectRevision });
  assert.deepEqual(calls.map(([name]) => name), ['confirm', 'delete', 'undo', 'pending', 'open', 'event']);
});

test('aborting while confirmation is open prevents file deletion', async () => {
  const abort = new AbortController();
  const { service, controller, calls } = fixture(() => { abort.abort('Stopped'); return true; });
  await assert.rejects(service.deleteProjectFile(controller, 'project', { path: 'old.html' }, { signal: abort.signal }), /Stopped|abort/i);
  assert.equal(calls.some(([name]) => name === 'delete'), false);
});

test('project media removal and library deletion remain separate confirmed operations', async () => {
  const { service, controller, calls } = fixture(() => true);
  await service.deleteMedia(controller, { projectId: 'project', assetId: 'image', scope: 'project' });
  assert.equal(calls.filter(([name]) => name === 'detach').length, 1);
  assert.equal(calls.some(([name]) => name === 'remove'), false);
  calls.length = 0;
  await service.deleteMedia(controller, { assetId: 'image', scope: 'library' }, { preview: true });
  assert.deepEqual(calls.map(([name]) => name), ['media-preview', 'confirm', 'remove', 'event']);
});

test('cancelling a media confirmation leaves both stores unchanged', async () => {
  const { service, controller, calls } = fixture(() => false);
  const result = await service.deleteMedia(controller, { assetId: 'image', scope: 'library' });
  assert.equal(result.deleted, false);
  assert.deepEqual(calls.map(([name]) => name), ['confirm']);
});

test('last canvas deletion asks to delete the project and defaults to keeping its media', async () => {
  let request;
  const { service, controller, calls, info } = fixture((input) => { request = input; return { confirmed: true, deleteMedia: false }; });
  info.ok = false;
  info.requiresProjectDeletion = true;
  const result = await service.deleteProjectFile(controller, 'project', { path: 'old.html' }, { preview: true });
  assert.equal(request.kind, 'project');
  assert.equal(request.lastFile, 'old.html');
  assert.equal(result.projectDeleted, true);
  assert.equal(result.deletedPath, 'old.html');
  assert.deepEqual(result.keptAssetIds, ['image']);
  assert.deepEqual(calls.map(([name]) => name), ['preview', 'confirm', 'delete-project', 'project-cleanup', 'event']);
  assert.deepEqual(calls.find(([name]) => name === 'delete-project')[1], { expectedProjectRevision: info.projectRevision, deleteMedia: false });
  const event = calls.find(([name]) => name === 'event')[1];
  assert.equal(event.type, 'project-deleted');
  assert.equal(event.projectDeleted, true);
});

test('last canvas project deletion cancellation does not delete files or media', async () => {
  const { service, controller, calls, info } = fixture(() => ({ confirmed: false, deleteMedia: true }));
  info.ok = false;
  info.requiresProjectDeletion = true;
  const result = await service.deleteProjectFile(controller, 'project', { path: 'old.html' });
  assert.equal(result.canceled, true);
  assert.equal(result.deleted, false);
  assert.deepEqual(calls.map(([name]) => name), ['confirm']);
});

test('confirmed project and media deletion closes project and jobs before removing exclusive library IDs', async () => {
  const { service, controller, calls } = fixture(() => ({ confirmed: true, deleteMedia: true }));
  const result = await service.deleteProject(controller, 'project');
  assert.equal(result.deleted, true);
  assert.deepEqual(result.deletedAssetIds, ['image']);
  assert.deepEqual(calls.map(([name]) => name), ['confirm', 'delete-project', 'project-cleanup', 'remove', 'event']);
});

test('project confirmation preserves revision check and abort prevents project mutation', async () => {
  const abort = new AbortController();
  const { service, controller, calls } = fixture(() => { abort.abort('Stopped'); return { confirmed: true }; });
  await assert.rejects(service.deleteProject(controller, 'project', {}, { signal: abort.signal }), /Stopped|abort/i);
  assert.deepEqual(calls.map(([name]) => name), ['confirm']);
  const second = fixture(() => ({ confirmed: true }));
  second.canvasStore.deleteProject = (_id, args) => { assert.equal(args.expectedProjectRevision, second.info.projectRevision); throw new Error('Canvas project changed.'); };
  await assert.rejects(second.service.deleteProject(second.controller, 'project'), /project changed/);
  assert.equal(second.calls.some(([name]) => name === 'project-cleanup'), false);
});

test('project deletion remains reported when library cleanup fails after source deletion', async () => {
  const { service, controller, calls, canvasStore } = fixture(() => ({ confirmed: true, deleteMedia: true }));
  canvasStore.deleteProject = () => ({ projectDeleted: true, deletedAssetIds: ['image'], mediaDeletionCandidates: ['image'] });
  const failed = createDeletionService({ canvasStore, mediaStore: { remove: async () => { throw new Error('Disk is busy'); } }, confirm: async () => ({ confirmed: true, deleteMedia: true }), onProjectDeleted: async () => { calls.push(['cleanup']); } });
  const result = await failed.deleteProject(controller, 'project');
  assert.equal(result.projectDeleted, true);
  assert.deepEqual(result.mediaWarnings, [{ assetId: 'image', message: 'Disk is busy' }]);
  assert.deepEqual(calls.map(([name]) => name), ['cleanup']);
});
