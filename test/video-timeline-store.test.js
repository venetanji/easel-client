const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVideoTimelineStore } = require('../src/video-timeline-store');
const { createTimelineDocument } = require('../src/video-timeline');

const projectId = 'a'.repeat(32);
const secondProjectId = 'b'.repeat(32);
const assetId = 'c'.repeat(64);
const clip = { id: 'clip-1', trackId: 'video-1', startFrame: 0, endFrame: 24,
  assetId, sourceStartSeconds: 0, sourceEndSeconds: 1 };
function setup(t, overrides = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-timeline-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const options = { userDataPath, idFactory: () => 'timeline-1', ...overrides };
  return { userDataPath, options, store: createVideoTimelineStore(options),
    filename: path.join(userDataPath, 'video-timelines', `${projectId}.json`) };
}
function insert(store, id = projectId, expectedRevision = 0) {
  return store.apply(id, { expectedRevision, operations: [{ type: 'insert', item: clip }] });
}

test('creates and reloads a plain validated document, while missing projects return null', (t) => {
  const { store, options, filename } = setup(t);
  assert.equal(store.read(projectId), null);
  assert.deepEqual(store.status(projectId), { undoAvailable: false, redoAvailable: false });
  const created = store.create(projectId);
  assert.equal(created.id, 'timeline-1');
  assert.equal(created.revision, 0);
  assert.deepEqual(createVideoTimelineStore(options).read(projectId), created);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).document.id, created.id);
  assert.throws(() => store.create(projectId), { code: 'TIMELINE_EXISTS' });
  assert.deepEqual(store.read(projectId), created);
});

test('accepts initial geometry or an explicit revision-zero document without mutating either', (t) => {
  const { store } = setup(t);
  const options = { width: 1280, height: 720, frameRate: { numerator: 30000, denominator: 1001 } };
  const copy = structuredClone(options);
  assert.equal(store.create(projectId, options).width, 1280);
  assert.deepEqual(options, copy);
  const initial = createTimelineDocument({ id: 'another-timeline', items: [clip] });
  assert.deepEqual(store.create(secondProjectId, initial), initial);
  assert.equal(store.read(secondProjectId).items.length, 1);
});

test('commits a whole operation batch and history with exactly one revision increment', (t) => {
  const { store, filename } = setup(t);
  store.create(projectId);
  const changed = store.apply(projectId, { expectedRevision: 0, operations: [
    { type: 'insert', item: clip }, { type: 'move', itemId: clip.id, startFrame: 24 },
  ] });
  assert.equal(changed.revision, 1);
  assert.equal(changed.items[0].startFrame, 24);
  assert.deepEqual(store.status(projectId), { undoAvailable: true, redoAvailable: false });
  const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(envelope.document.revision, 1);
  assert.equal(envelope.undo.length, 1);
  assert.equal(envelope.undo[0].revision, 0);
  assert.deepEqual(envelope.redo, []);
  changed.items[0].startFrame = 9;
  assert.equal(store.read(projectId).items[0].startFrame, 24);
});

test('rejects stale edits and stale history requests without any persisted changes', (t) => {
  const { store, filename } = setup(t);
  store.create(projectId);
  insert(store);
  const before = fs.readFileSync(filename, 'utf8');
  for (const action of [() => insert(store), () => store.undo(projectId, { expectedRevision: 0 }),
    () => store.redo(projectId, { expectedRevision: 0 })]) {
    assert.throws(action, { code: 'TIMELINE_REVISION_CONFLICT' });
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
  }
});

test('supports undo/redo after restart with monotonic revisions and one envelope', (t) => {
  const { store, options, filename } = setup(t);
  store.create(projectId);
  insert(store);
  const restarted = createVideoTimelineStore(options);
  const undone = restarted.undo(projectId, { expectedRevision: 1 });
  assert.equal(undone.revision, 2);
  assert.deepEqual(undone.items, []);
  assert.deepEqual(restarted.status(projectId), { undoAvailable: false, redoAvailable: true });
  const redone = createVideoTimelineStore(options).redo(projectId, { expectedRevision: 2 });
  assert.equal(redone.revision, 3);
  assert.deepEqual(redone.items, [clip]);
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), [`${projectId}.json`]);
  assert.deepEqual(store.status(projectId), { undoAvailable: true, redoAvailable: false });
});

test('track reorder persists as one undoable edit and preserves clip source ranges after restart', (t) => {
  const { store, options, filename } = setup(t);
  const initial = store.create(projectId, { items: [clip] });
  const reordered = store.apply(projectId, { expectedRevision: 0, operations: [
    { type: 'reorder-track', trackId: 'video-1', index: 2 },
    { type: 'reorder-track', trackId: 'overlay-1', index: 0 },
  ] });
  assert.deepEqual(reordered.tracks.map((track) => track.id), ['overlay-1', 'audio-1', 'video-1']);
  assert.deepEqual(reordered.items, initial.items);
  assert.equal(reordered.revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).undo.length, 1);
  assert.deepEqual(createVideoTimelineStore(options).read(projectId), reordered);
  const undone = createVideoTimelineStore(options).undo(projectId, { expectedRevision: 1 });
  assert.deepEqual(undone, { ...initial, revision: 2 });
  const redone = createVideoTimelineStore(options).redo(projectId, { expectedRevision: 2 });
  assert.deepEqual(redone, { ...reordered, revision: 3 });
});

test('a failed reorder batch preserves persisted order, revision, and redo history', (t) => {
  const { store, filename } = setup(t);
  store.create(projectId, { items: [clip] });
  store.apply(projectId, { expectedRevision: 0, operations: [{ type: 'reorder-track', trackId: 'video-1', index: 2 }] });
  store.undo(projectId, { expectedRevision: 1 });
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.apply(projectId, { expectedRevision: 2, operations: [
    { type: 'reorder-track', trackId: 'video-1', index: 2 },
    { type: 'reorder-track', trackId: 'missing', index: 0 },
  ] }), /track does not exist/i);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.deepEqual(store.status(projectId), { undoAvailable: false, redoAvailable: true });
});

test('a new edit after undo clears redo and empty history errors are actionable', (t) => {
  const { store } = setup(t);
  store.create(projectId);
  assert.throws(() => store.undo(projectId, { expectedRevision: 0 }), /nothing to undo/i);
  assert.throws(() => store.redo(projectId, { expectedRevision: 0 }), /nothing to redo/i);
  insert(store);
  store.undo(projectId, { expectedRevision: 1 });
  store.apply(projectId, { expectedRevision: 2, operations: [{ type: 'add-track', track: { id: 'extra', type: 'audio', name: 'Extra' } }] });
  assert.deepEqual(store.status(projectId), { undoAvailable: true, redoAvailable: false });
  assert.throws(() => store.redo(projectId, { expectedRevision: 3 }), /nothing to redo/i);
});

test('rejects invalid operations as an atomic batch and does not consume history', (t) => {
  const { store, filename } = setup(t);
  store.create(projectId);
  const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.apply(projectId, { expectedRevision: 0, operations: [
    { type: 'insert', item: clip }, { type: 'remove', itemId: 'missing' },
  ] }));
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.deepEqual(store.status(projectId), { undoAvailable: false, redoAvailable: false });
});

test('separate store instances cannot commit stale edits or overwrite other projects', (t) => {
  const { store, options } = setup(t);
  store.create(projectId);
  const other = createVideoTimelineStore(options);
  const snapshot = other.read(projectId);
  insert(store);
  assert.throws(() => insert(other, projectId, snapshot.revision), { code: 'TIMELINE_REVISION_CONFLICT' });
  other.create(secondProjectId);
  assert.deepEqual(other.read(secondProjectId).items, []);
  assert.equal(store.read(projectId).revision, 1);
});

test('rejects traversal project IDs and unexpected request fields before accessing storage', (t) => {
  const { store, userDataPath } = setup(t);
  for (const id of ['../settings', '..\\settings', '/tmp/settings', 'a'.repeat(31), '']) {
    for (const action of [() => store.create(id), () => store.read(id), () => store.status(id),
      () => store.apply(id, { expectedRevision: 0, operations: [] }), () => store.remove(id)]) assert.throws(action, /project ID/i);
  }
  assert.deepEqual(fs.readdirSync(userDataPath), []);
  store.create(projectId);
  for (const request of [undefined, {}, { expectedRevision: -1 }, { expectedRevision: 0, path: '/tmp' }]) {
    assert.throws(() => store.undo(projectId, request));
  }
  assert.throws(() => store.apply(projectId, { expectedRevision: 0, operations: [], command: 'sh' }));
});

test('surfaces malformed JSON, future schemas, and invalid history without resetting the file', (t) => {
  const { store, filename } = setup(t);
  store.create(projectId);
  const valid = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const badValues = ['{broken', JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, projectId: secondProjectId }), JSON.stringify({ ...valid, unknown: true }),
    JSON.stringify({ ...valid, undo: [{ ...valid.document, id: 'wrong-timeline' }] }),
    JSON.stringify({ ...valid, redo: [{ ...valid.document, revision: 100 }] }),
    JSON.stringify({ ...valid, document: { ...valid.document, items: [{ ...clip, assetId: '/tmp/media' }] } }),
  ];
  for (const content of badValues) {
    fs.writeFileSync(filename, content);
    assert.throws(() => store.read(projectId), { code: 'TIMELINE_CORRUPT' });
    assert.equal(fs.readFileSync(filename, 'utf8'), content);
    assert.throws(() => store.create(projectId));
  }
});

test('rename failure keeps the prior document and history intact and cleans its temporary file', (t) => {
  let failRename = false;
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (...args) => { if (failRename) throw Object.assign(new Error('Disk failure'), { code: 'EIO' }); return fs.renameSync(...args); };
  const { store, filename } = setup(t, { fileSystem });
  store.create(projectId);
  const before = fs.readFileSync(filename, 'utf8');
  failRename = true;
  assert.throws(() => insert(store), /disk failure/i);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), [`${projectId}.json`]);
  failRename = false;
  assert.equal(insert(store).revision, 1);
});

test('partial temporary writes and orphaned temp files cannot become committed data', (t) => {
  let failWrite = false;
  const fileSystem = Object.create(fs);
  fileSystem.writeFileSync = (filename, content, options) => {
    if (failWrite) { fs.writeFileSync(filename, content.slice(0, 20), options); throw new Error('Partial write'); }
    return fs.writeFileSync(filename, content, options);
  };
  const { store, options, filename } = setup(t, { fileSystem });
  store.create(projectId);
  failWrite = true;
  assert.throws(() => insert(store), /partial write/i);
  assert.equal(store.read(projectId).revision, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), [`${projectId}.json`]);
  fs.writeFileSync(`${filename}.interrupted.tmp`, '{broken');
  assert.equal(createVideoTimelineStore(options).read(projectId).revision, 0);
});

test('bounds durable history while retaining the newest undo states', (t) => {
  const { store, filename } = setup(t);
  store.create(projectId);
  insert(store);
  for (let revision = 1; revision <= 30; revision += 1) {
    store.apply(projectId, { expectedRevision: revision, operations: [{ type: 'move', itemId: clip.id, startFrame: revision * 24 }] });
  }
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).undo.length, 20);
  assert.equal(store.undo(projectId, { expectedRevision: 31 }).items[0].startFrame, 29 * 24);
});

test('removes only the requested project timeline and is idempotent when absent', (t) => {
  const { store } = setup(t);
  store.create(projectId);
  store.create(secondProjectId);
  insert(store);
  assert.equal(store.remove(projectId), true);
  assert.equal(store.read(projectId), null);
  assert.equal(store.remove(projectId), false);
  assert.notEqual(store.read(secondProjectId), null);
});

test('two_timelines_are_independent', (t) => {
  const { store, userDataPath } = setup(t);
  const a = 'd'.repeat(32), b = 'e'.repeat(32);
  store.create(projectId, a, {}); store.create(projectId, b, {});
  const beforeB = store.read(projectId, b);
  const filenameB = path.join(userDataPath, 'video-timelines', projectId, `${b}.json`);
  const bytesB = fs.readFileSync(filenameB);
  store.apply(projectId, a, { expectedRevision: 0, operations: [{ type: 'insert', item: clip }] });
  store.undo(projectId, a, { expectedRevision: 1 });
  assert.deepEqual(store.read(projectId, b), beforeB);
  assert.deepEqual(fs.readFileSync(filenameB), bytesB);
  assert.throws(() => store.read(projectId), { code: 'TIMELINE_AMBIGUOUS' });
  assert.throws(() => store.remove(projectId), { code: 'TIMELINE_AMBIGUOUS' });
  assert.equal(store.remove(projectId, a), true);
  assert.deepEqual(store.read(projectId), beforeB);
});
