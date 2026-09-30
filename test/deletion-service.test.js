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
  const service = createDeletionService({
    canvasStore: {
      inspectDeletion: () => info,
      inspectAssetDeletion: () => ({ ok: true, projectRevision: info.projectRevision, asset: { name: 'Study.png' } }),
      get: () => ({ html: 'authored source' }), getProject: () => ({ manifest: { entry: 'index.html' } }),
      listDocuments: () => ({ documents: [{ path: 'index.html' }] }),
      deleteFile(id, args) { calls.push(['delete', args]); return { id }; },
      detachAsset(id, args) { calls.push(['detach', args]); return { id }; },
    },
    mediaStore: { get: async () => ({ name: 'Library study.png' }), remove: async (id) => { calls.push(['remove', id]); return { id }; } },
    confirm: async (...args) => { calls.push(['confirm']); return confirm(...args); },
    previewFile: async () => { calls.push(['preview']); },
    previewMedia: async () => { calls.push(['media-preview']); },
    recordUndo: () => { calls.push(['undo']); }, onEvent: (event) => { calls.push(['event', event]); },
  });
  return { service, controller, calls, info };
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
