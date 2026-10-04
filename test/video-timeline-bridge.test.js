const test = require('node:test');
const assert = require('node:assert/strict');
const { createVideoTimelineBridge } = require('../src/video-timeline-bridge');
const projectId = 'a'.repeat(32);
const scope = { projectId, documentPath: 'video-editor/index.html', runtimeGeneration: 1 };
function fixture() {
  const calls = [];
  let current = true;
  let busy = false;
  let saveCount = 0;
  const controller = { read: () => ({ id: 'timeline', revision: 3 }), resolveSelection: (selection) => ({ selection }), apply: (id, input) => { calls.push([id, input]); return {}; } };
  const bridge = createVideoTimelineBridge({ controller, assertOrigin: () => { if (!current) throw new Error('Project changed'); },
    getAssets: () => ({ assets: [] }), getAsset: () => ({}), listLibrary: () => [], attach: async (id, ids) => calls.push(['attach', id, ids]),
    select: (selection) => calls.push(['select', selection]),
    saveMedia: async () => { saveCount++; return 'b'.repeat(32); }, onExport: (value) => calls.push(['export', value]), isBusy: () => busy,
  });
  return { bridge, calls, stale: () => { current = false; }, saveCount: () => saveCount, setBusy: (value) => { busy = value; } };
}
test('canvas timeline bridge derives its project scope and rejects arbitrary methods/paths', async () => {
  const f = fixture();
  await f.bridge.handle({ action: 'apply', input: { expectedRevision: 3, operations: [] } }, scope);
  assert.equal(f.calls[0][0], projectId);
  await assert.rejects(f.bridge.handle({ action: 'apply', projectId: 'c'.repeat(32), input: {} }, scope), /unsupported/i);
  await assert.rejects(f.bridge.handle({ action: 'shell', input: {} }, scope), /unsupported/i);
  f.stale();
  await assert.rejects(f.bridge.handle({ action: 'read' }, scope), /changed/i);
});
test('one export receipt saves and attaches once, rejects stale revisions and arbitrary media fields', async () => {
  const f = fixture();
  const media = { data: 'GkXfow==', mimeType: 'video/webm', name: 'Edit.webm', width: 320, height: 180, duration: 1.02, timelineDuration: 1, frameCount: 24, codec: 'video/webm;codecs=vp8,opus', includesAudio: true };
  const input = { exportId: 'render-1', expectedRevision: 3, media };
  const [a, b] = await Promise.all([f.bridge.handle({ action: 'save-export', input }, scope), f.bridge.handle({ action: 'save-export', input }, scope)]);
  assert.equal(a.assetId, b.assetId);
  assert.equal(f.saveCount(), 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'attach').length, 1);
  await assert.rejects(f.bridge.handle({ action: 'save-export', input: { ...input, exportId: 'render-2', expectedRevision: 2 } }, scope), /revision/i);
  await assert.rejects(f.bridge.handle({ action: 'save-export', input: { ...input, exportId: 'render-3', media: { ...media, url: 'https://remote' } } }, scope), /unsupported/i);
});

test('export admission validates multi-megabyte base64 without overflowing the call stack', async () => {
  const f = fixture();
  const result = await f.bridge.handle({ action: 'save-export', input: { exportId: 'large', expectedRevision: 3,
    media: { data: Buffer.alloc(8_000_000).toString('base64'), mimeType: 'video/webm', name: 'Large.webm', width: 320, height: 180, duration: 4, includesAudio: false } } }, scope);
  assert.equal(result.ok, true);
});


test('a completed export can be saved during an unrelated chat without losing its bytes', async () => {
  const f = fixture(); f.setBusy(true);
  await assert.rejects(f.bridge.handle({ action: 'apply', input: { expectedRevision: 3, operations: [] } }, scope), /current agent/i);
  const result = await f.bridge.handle({ action: 'save-export', input: { exportId: 'while-chatting', expectedRevision: 3,
    media: { data: 'GkXfow==', mimeType: 'video/webm', name: 'Finished.webm', width: 320, height: 180, duration: 1, includesAudio: false } } }, scope);
  assert.equal(result.ok, true);
  assert.equal(f.saveCount(), 1);
});
