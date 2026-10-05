const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TIMELINE_SCHEMA_VERSION, createTimelineDocument, validateTimelineDocument,
  validateTimelineSelection, validateTimelineOperations, applyTimelineOperations,
} = require('../src/video-timeline');

const assetId = 'a'.repeat(64);
const projectId = 'b'.repeat(32);
function item(overrides = {}) {
  return { id: 'clip-1', trackId: 'video-1', startFrame: 0, endFrame: 24,
    assetId, sourceStartSeconds: 0, sourceEndSeconds: 1, ...overrides };
}
function document(overrides = {}) { return createTimelineDocument({ id: 'timeline-1', ...overrides }); }
function selection(doc, overrides = {}) {
  return { projectId, timelineId: doc.id, timelineRevision: doc.revision,
    trackIds: ['video-1'], itemIds: [], startFrame: 0, endFrame: 24, ...overrides };
}

test('creates a detached schema-1 document with rational rate and ordered default tracks', () => {
  const doc = document();
  assert.equal(TIMELINE_SCHEMA_VERSION, 1);
  assert.deepEqual(doc, { schemaVersion: 1, id: 'timeline-1', revision: 0,
    frameRate: { numerator: 24, denominator: 1 }, width: 1920, height: 1080,
    tracks: [{ id: 'video-1', type: 'video', name: 'Video' },
      { id: 'audio-1', type: 'audio', name: 'Audio' },
      { id: 'overlay-1', type: 'overlay', name: 'Overlay' }], items: [], transitions: [] });
  const checked = validateTimelineDocument(doc);
  checked.tracks[0].name = 'Changed';
  assert.equal(doc.tracks[0].name, 'Video');
  assert.notEqual(document().id, createTimelineDocument().id);
});

test('preserves source timestamps independently of a rational project frame rate', () => {
  const doc = document({ frameRate: { numerator: 30000, denominator: 1001 }, items: [item({
    endFrame: 30, sourceStartSeconds: 1.123, sourceEndSeconds: 2.124, sourceDurationSeconds: 3,
  })] });
  assert.equal(validateTimelineDocument(doc).items[0].sourceStartSeconds, 1.123);
});

test('rejects malformed schema, identity, geometry, frame rates, and unsupported fields', () => {
  const invalid = [
    { schemaVersion: 2 }, { revision: -1 }, { revision: 0.5 }, { id: '../other' },
    { id: '' }, { id: 'x'.repeat(65) }, { width: 0 }, { height: 8193 },
    { frameRate: { numerator: 24, denominator: 0 } },
    { frameRate: { numerator: 0.5, denominator: 1 } },
    { frameRate: { numerator: 121, denominator: 1 } },
    { frameRate: { numerator: 24, denominator: 1, path: '/tmp' } },
    { script: 'alert(1)' }, { transitions: [{ type: 'cross-dissolve' }] },
  ];
  for (const change of invalid) assert.throws(() => validateTimelineDocument({ ...document(), ...change }), undefined, JSON.stringify(change));
  assert.throws(() => validateTimelineDocument(null));
  assert.throws(() => createTimelineDocument({ executable: 'ffmpeg' }));
});

test('validates item IDs, half-open frame spans, managed asset IDs, and source bounds', () => {
  const invalid = [
    { id: 'path/clip' }, { trackId: 'missing' }, { startFrame: -1 }, { startFrame: 0.1 },
    { startFrame: 24 }, { endFrame: 0 }, { endFrame: Infinity }, { endFrame: 24 * 86400 + 1 },
    { assetId: '/tmp/a.mp4' }, { assetId: 'a'.repeat(63) }, { sourceStartSeconds: -1 },
    { sourceStartSeconds: 1 }, { sourceEndSeconds: Infinity }, { sourceEndSeconds: 86401 },
    { sourceDurationSeconds: 0.9 }, { sourceDurationSeconds: NaN }, { sourcePath: '/tmp/a.mp4' },
    { name: 'x'.repeat(121) }, { gain: 4.01 }, { gain: -0.01 }, { fadeInFrames: 25 },
    { fadeInFrames: 15, fadeOutFrames: 15 }, { fadeOutFrames: 0.5 },
  ];
  for (const change of invalid) assert.throws(() => validateTimelineDocument({ ...document(), items: [item(change)] }), undefined, JSON.stringify(change));
  assert.equal(document({ items: [item({ assetId: 'c'.repeat(32) })] }).items.length, 1);
});

test('requires unique tracks/items, supported track types, and audio-compatible controls', () => {
  const doc = document();
  for (const tracks of [[...doc.tracks, doc.tracks[0]], [{ id: 'track-1', type: 'script', name: 'Unsafe' }]]) {
    assert.throws(() => validateTimelineDocument({ ...doc, tracks }));
  }
  assert.throws(() => document({ items: [item(), item()] }));
  assert.throws(() => document({ items: [item({ trackId: 'overlay-1', gain: 1 })] }));
  assert.equal(document({ items: [item({ trackId: 'audio-1', gain: 0.5, fadeInFrames: 4 })] }).items[0].gain, 0.5);
});

test('accepts adjacent clips and cross-track overlaps but rejects same-track overlaps', () => {
  assert.equal(document({ items: [item(), item({ id: 'clip-2', startFrame: 24, endFrame: 48 })] }).items.length, 2);
  assert.equal(document({ items: [item(), item({ id: 'clip-2', trackId: 'audio-1' })] }).items.length, 2);
  assert.throws(() => document({ items: [item(), item({ id: 'clip-2', startFrame: 23, endFrame: 47 })] }), /overlap/i);
});

test('bounds the track, item, and operation collections', () => {
  assert.throws(() => document({ tracks: Array.from({ length: 129 }, (_, i) => ({ id: `t-${i}`, type: 'video', name: 'Video' })) }));
  assert.throws(() => document({ items: Array.from({ length: 4097 }, (_, i) => item({ id: `i-${i}`, startFrame: i * 24, endFrame: (i + 1) * 24 })) }));
  assert.throws(() => validateTimelineOperations([]));
  assert.throws(() => validateTimelineOperations(Array(129).fill({ type: 'remove', itemId: 'clip-1' })));
});

test('applies a batch atomically without mutating the document or operation inputs', () => {
  const doc = document();
  const ops = [{ type: 'insert', item: item() }, { type: 'move', itemId: 'clip-1', startFrame: 48 }];
  const before = structuredClone({ doc, ops });
  const result = applyTimelineOperations(doc, ops);
  assert.equal(result.document.revision, 1);
  assert.deepEqual(result.changedItemIds, ['clip-1']);
  assert.equal(result.document.items[0].endFrame, 72);
  assert.deepEqual({ doc, ops }, before);
  assert.throws(() => applyTimelineOperations(doc, [...ops, { type: 'remove', itemId: 'unknown' }]));
  assert.deepEqual({ doc, ops }, before);
});

test('adds/removes empty tracks and rejects removing occupied tracks', () => {
  const doc = document();
  const added = applyTimelineOperations(doc, [{ type: 'add-track', track: { id: 'video-2', type: 'video', name: 'Second video' } }]).document;
  assert.equal(added.tracks.at(-1).id, 'video-2');
  const removed = applyTimelineOperations(added, [{ type: 'remove-track', trackId: 'video-2' }]).document;
  assert.deepEqual(removed.tracks, doc.tracks);
  assert.throws(() => applyTimelineOperations(document({ items: [item()] }), [{ type: 'remove-track', trackId: 'video-1' }]), /occupied|items|empty/i);
  assert.throws(() => applyTimelineOperations(doc, [{ type: 'remove-track', trackId: 'unknown' }]));
});

test('reorders occupied tracks to the final stored index without changing clips or inputs', () => {
  const doc = document({ items: [item({ name: 'Shot', sourceDurationSeconds: 2, gain: 0.5 }),
    item({ id: 'title-1', trackId: 'overlay-1' })] });
  const operations = [{ type: 'reorder-track', trackId: 'video-1', index: 2 }];
  const before = structuredClone({ doc, operations });
  const result = applyTimelineOperations(doc, operations);
  assert.deepEqual(result.document.tracks, [doc.tracks[1], doc.tracks[2], doc.tracks[0]]);
  assert.deepEqual(result.document.items, doc.items);
  assert.deepEqual(result.changedItemIds, []);
  assert.equal(result.document.revision, 1);
  assert.deepEqual({ doc, operations }, before);

  const restored = applyTimelineOperations(result.document, [{ type: 'reorder-track', trackId: 'video-1', index: 0 }]);
  assert.deepEqual(restored.document.tracks, doc.tracks);
  assert.deepEqual(restored.document.items, doc.items);
  assert.equal(restored.document.revision, 2);
});

test('reordering a track to its existing index preserves order with the usual edit revision', () => {
  const doc = document();
  const result = applyTimelineOperations(doc, [{ type: 'reorder-track', trackId: 'audio-1', index: 1 }]);
  assert.deepEqual(result.document, { ...doc, revision: 1 });
  assert.deepEqual(result.changedItemIds, []);
});

test('validates bounded reorder indexes and rejects absent IDs or unsupported fields', () => {
  const operations = [{ type: 'reorder-track', trackId: 'video-1', index: 0 },
    { type: 'reorder-track', trackId: 'video-1', index: 127 }];
  const checked = validateTimelineOperations(operations);
  assert.deepEqual(checked, operations);
  checked[0].index = 1;
  assert.equal(operations[0].index, 0);
  for (const index of [-1, 128, 0.5, NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => validateTimelineOperations([{ type: 'reorder-track', trackId: 'video-1', index }]), /index/i);
  }
  for (const operation of [
    { type: 'reorder-track', trackId: 'video-1' },
    { type: 'reorder-track', index: 0 },
    { type: 'reorder-track', trackId: '../video-1', index: 0 },
    { type: 'reorder-track', trackId: 'video-1', index: 0, extra: true },
  ]) assert.throws(() => validateTimelineOperations([operation]), { code: 'TIMELINE_INVALID' });
  const doc = document();
  assert.throws(() => applyTimelineOperations(doc, [{ type: 'reorder-track', trackId: 'video-1', index: 3 }]), /index/i);
  assert.throws(() => applyTimelineOperations(doc, [{ type: 'reorder-track', trackId: 'missing', index: 0 }]), /track does not exist/i);
});

test('reordering uses the current batch track order and leaves failed batches unchanged', () => {
  const doc = document({ items: [item()] });
  const operations = [
    { type: 'add-track', track: { id: 'video-2', type: 'video', name: 'Second video' } },
    { type: 'reorder-track', trackId: 'video-2', index: 0 },
    { type: 'reorder-track', trackId: 'video-1', index: 3 },
  ];
  const before = structuredClone({ doc, operations });
  const result = applyTimelineOperations(doc, operations);
  assert.deepEqual(result.document.tracks.map((track) => track.id), ['video-2', 'audio-1', 'overlay-1', 'video-1']);
  assert.deepEqual(result.document.items, doc.items);
  assert.equal(result.document.revision, 1);
  assert.throws(() => applyTimelineOperations(doc, [...operations,
    { type: 'remove-track', trackId: 'audio-1' },
    { type: 'reorder-track', trackId: 'video-1', index: 3 },
  ]), /index/i);
  assert.deepEqual({ doc, operations }, before);
});

test('trims source and timeline boundaries explicitly and preserves unrelated metadata', () => {
  const doc = document({ items: [item({ name: 'Shot', sourceDurationSeconds: 3 })] });
  const trimmed = applyTimelineOperations(doc, [{ type: 'trim', itemId: 'clip-1', startFrame: 6,
    endFrame: 18, sourceStartSeconds: 0.25, sourceEndSeconds: 0.75 }]).document;
  assert.deepEqual(trimmed.items[0], item({ name: 'Shot', sourceDurationSeconds: 3,
    startFrame: 6, endFrame: 18, sourceStartSeconds: 0.25, sourceEndSeconds: 0.75 }));
  assert.equal(doc.items[0].endFrame, 24);
});

test('supports audio gain/fades and removal with bounded typed operations', () => {
  const doc = document({ items: [item()] });
  const edited = applyTimelineOperations(doc, [{ type: 'set-audio-level', itemId: 'clip-1', gain: 0,
    fadeInFrames: 4, fadeOutFrames: 6 }]).document;
  assert.equal(edited.items[0].gain, 0);
  assert.equal(edited.items[0].fadeOutFrames, 6);
  assert.deepEqual(applyTimelineOperations(edited, [{ type: 'remove', itemId: 'clip-1' }]).document.items, []);
  assert.throws(() => applyTimelineOperations(doc, [{ type: 'move', itemId: 'clip-1', trackId: 'missing', startFrame: 0 }]));
});

test('rejects unknown operation fields, no-op audio requests, and unbounded execution payloads', () => {
  const invalid = [
    { type: 'shell', command: 'ffmpeg' }, { type: 'insert', item: item(), path: '/tmp/video.mp4' },
    { type: 'remove', itemId: 'clip-1', extra: true }, { type: 'move', itemId: 'clip-1', startFrame: 1.2 },
    { type: 'trim', itemId: 'clip-1', startFrame: 0, endFrame: 10 },
    { type: 'set-audio-level', itemId: 'clip-1' }, { type: 'set-audio-level', itemId: 'clip-1', gain: NaN },
    { type: 'add-track', track: { id: 't', type: 'video', name: 'T', code: 'alert(1)' } },
  ];
  for (const op of invalid) assert.throws(() => validateTimelineOperations([op]), undefined, JSON.stringify(op));
  const operations = [{ type: 'insert', item: item() }];
  const checked = validateTimelineOperations(operations);
  checked[0].item.id = 'other';
  assert.equal(operations[0].item.id, 'clip-1');
});

test('validates detached, project-scoped half-open selections including empty gaps', () => {
  const doc = document({ items: [item()] });
  const input = selection(doc, { itemIds: ['clip-1'], endFrame: 12 });
  const checked = validateTimelineSelection(input, doc);
  assert.deepEqual(checked, input);
  checked.itemIds.length = 0;
  assert.equal(input.itemIds.length, 1);
  assert.equal(validateTimelineSelection(selection(doc, { startFrame: 24, endFrame: 48 }), doc).startFrame, 24);
});

test('rejects stale, mismatched, contradictory, duplicate, or malformed selections', () => {
  const doc = document({ items: [item()] });
  const invalid = [
    { projectId: '../project' }, { timelineId: 'different' }, { timelineRevision: 1 },
    { startFrame: 24 }, { startFrame: 25 }, { endFrame: 0 }, { endFrame: 0.5 },
    { trackIds: ['missing'] }, { itemIds: ['missing'] }, { trackIds: ['video-1', 'video-1'] },
    { itemIds: ['clip-1', 'clip-1'] }, { trackIds: ['audio-1'], itemIds: ['clip-1'] },
    { itemIds: ['clip-1'], startFrame: 24, endFrame: 48 }, { trackIds: [], itemIds: [] },
    { path: '/tmp/a.mp4' },
  ];
  for (const change of invalid) assert.throws(() => validateTimelineSelection(selection(doc, change), doc), undefined, JSON.stringify(change));
  assert.throws(() => validateTimelineSelection(selection(doc, { timelineRevision: 1 }), doc), { code: 'TIMELINE_REVISION_CONFLICT' });
});

test('audio gain stays within native preview volume without silently clipping amplification', () => {
  assert.throws(() => document({ items: [item({ gain: 1.01 })] }));
  assert.throws(() => validateTimelineOperations([{ type: 'set-audio-level', itemId: 'clip-1', gain: 1.01 }]));
});

test('loads as a browser script with no Node globals', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const sandbox = vm.createContext({ crypto: crypto.webcrypto });
  vm.runInContext(fs.readFileSync(require.resolve('../src/video-timeline'), 'utf8'), sandbox);
  const doc = vm.runInContext('EaselVideoTimeline.createTimelineDocument()', sandbox);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.items.length, 0);
  assert.match(doc.id, /^[a-f0-9]{32}$/);
});

test('rejects non-JSON hidden properties instead of accepting a document that changes on serialization', () => {
  const hidden = document();
  Object.defineProperty(hidden, 'id', { value: hidden.id, enumerable: false });
  assert.throws(() => validateTimelineDocument(hidden));
  const extras = document();
  extras.items.path = '/tmp/unmanaged.mp4';
  assert.throws(() => validateTimelineDocument(extras));
  const hiddenArray = document();
  Object.defineProperty(hiddenArray.tracks, '0', { enumerable: false });
  assert.throws(() => validateTimelineDocument(hiddenArray));
});

test('explicit remove-track cascade is atomic, reports removed IDs and preserves other tracks', () => {
  const clips = Array.from({ length: 101 }, (_, i) => item({ id: `clip-${i}`, startFrame: i * 24, endFrame: (i + 1) * 24 }));
  const retained = item({ id: 'audio-clip', trackId: 'audio-1' });
  const doc = document({ items: [...clips, retained] });
  const before = structuredClone(doc);
  const operations = [{ type: 'remove-track', trackId: 'video-1', removeItems: true }];
  const result = applyTimelineOperations(doc, operations);
  assert.deepEqual(result.document.items, [retained]);
  assert.deepEqual(result.document.tracks, doc.tracks.slice(1));
  assert.equal(result.document.revision, 1);
  assert.deepEqual(result.changedItemIds, clips.map(clip => clip.id));
  assert.deepEqual(doc, before);
  assert.throws(() => applyTimelineOperations(doc, [...operations, { type: 'remove', itemId: 'missing' }]));
  assert.deepEqual(doc, before);
});

test('remove-track never infers cascade and rejects untyped or irrelevant cascade intent', () => {
  const doc = document({ items: [item()] });
  for (const operation of [{ type: 'remove-track', trackId: 'video-1' }, { type: 'remove-track', trackId: 'video-1', removeItems: false }]) {
    assert.throws(() => applyTimelineOperations(doc, [operation]), /empty/i);
  }
  for (const removeItems of ['true', 1, null, {}, undefined]) {
    assert.throws(() => validateTimelineOperations([{ type: 'remove-track', trackId: 'video-1', removeItems }]), /boolean/i);
  }
  assert.throws(() => validateTimelineOperations([{ type: 'remove', itemId: 'clip-1', removeItems: true }]), /unsupported/i);
});
