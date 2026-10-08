const test = require('node:test');
const assert = require('node:assert/strict');
const { createVideoTimelineBridge } = require('../src/video-timeline-bridge');
const projectId = 'a'.repeat(32);
const scope = { projectId, instanceId: 'd'.repeat(32), timelineId: 'timeline', documentPath: 'video-editor/index.html', runtimeGeneration: 1 };
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

test('bridge_binds_every_action_to_the_host_instance_and_enriches_selection', async () => {
  const instanceId = 'd'.repeat(32), timelineId = 'e'.repeat(32);
  const trusted = { ...scope, instanceId, timelineId };
  const calls = [];
  const bridge = createVideoTimelineBridge({ assertOrigin: () => {}, controller: {
    read: (...args) => { calls.push(args); return { id: timelineId, revision: 0 }; },
    resolveSelection: (input) => ({ selection: input }),
  }, select: (selection) => calls.push(selection) });
  await bridge.handle({ action: 'read' }, trusted);
  assert.deepEqual(calls[0], [projectId, timelineId]);
  const selection = { projectId, timelineId, timelineRevision: 0, trackIds: [], itemIds: [], startFrame: 0, endFrame: 1 };
  await bridge.handle({ action: 'select', input: selection }, trusted);
  assert.deepEqual(calls[1], { ...selection, instanceId, documentPath: scope.documentPath, runtimeGeneration: 1 });
  for (const change of [{ timelineId: 'f'.repeat(32) }, { instanceId: 'f'.repeat(32) }, { projectId: 'f'.repeat(32) }, { runtimeGeneration: 2 }]) {
    await assert.rejects(bridge.handle({ action: 'select', input: { ...selection, ...change } }, trusted), /instance|timeline|project|runtime|stale/i);
  }
  await assert.rejects(bridge.handle({ action: 'read' }, { projectId, documentPath: scope.documentPath, runtimeGeneration: 1 }), /instance|bound/i);
});

test('exports_keep_instance_provenance_and_duplicate_receipts_are_isolated', async () => {
  const captures = [];
  const bridge = createVideoTimelineBridge({ assertOrigin: () => {}, controller: { read: (_projectId, timelineId) => ({ id: timelineId, revision: 3 }) },
    saveMedia: async (media) => { captures.push(media); return String(captures.length).repeat(32); }, attach: async () => {},
  });
  const request = { action: 'save-export', input: { exportId: 'same-export-id', expectedRevision: 3, media: { data: 'GkXfow==', mimeType: 'video/webm', name: 'Video.webm', width: 320, height: 180, duration: 1, includesAudio: false } } };
  const first = await bridge.handle(request, scope);
  assert.equal((await bridge.handle(request, scope)).assetId, first.assetId);
  const secondScope = { ...scope, timelineId: 'e'.repeat(32), instanceId: 'f'.repeat(32), documentPath: 'other.html' };
  const second = await bridge.handle(request, secondScope);
  assert.notEqual(second.assetId, first.assetId); assert.equal(captures.length, 2);
  for (const [index, target] of [scope, secondScope].entries()) {
    assert.equal(captures[index].scope.instanceId, target.instanceId);
    assert.equal(captures[index].scope.timelineId, target.timelineId);
    assert.equal(captures[index].scope.documentPath, target.documentPath);
  }
});
