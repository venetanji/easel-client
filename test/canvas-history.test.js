const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasHistory } = require('../src/canvas-history');

const canvasId = 'a'.repeat(32);

test('records valid snapshots and undoes one mutation at a time', () => {
  const history = createCanvasHistory();

  assert.equal(history.canUndo(canvasId), false);
  assert.equal(history.record(canvasId, '<p>before</p>'), true);
  assert.equal(history.record(canvasId, '<p>middle</p>'), true);
  assert.equal(history.canUndo(canvasId), true);
  assert.equal(history.undo(canvasId), '<p>middle</p>');
  assert.equal(history.undo(canvasId), '<p>before</p>');
  assert.equal(history.undo(canvasId), null);
  assert.equal(history.canUndo(canvasId), false);
});

test('ignores invalid canvas IDs and non-string snapshots', () => {
  const history = createCanvasHistory();

  assert.equal(history.record('A'.repeat(32), '<p>bad id</p>'), false);
  assert.equal(history.record('a'.repeat(31), '<p>short id</p>'), false);
  assert.equal(history.record(canvasId, null), false);
  assert.equal(history.canUndo(canvasId), false);
});

test('deduplicates adjacent snapshots and caps each canvas at ten entries', () => {
  const history = createCanvasHistory();

  history.record(canvasId, 'same');
  history.record(canvasId, 'same');
  for (let i = 0; i < 12; i += 1) history.record(canvasId, `snapshot-${i}`);

  assert.equal(history.undo(canvasId), 'snapshot-11');
  assert.equal(history.undo(canvasId), 'snapshot-10');
  assert.equal(history.undo(canvasId), 'snapshot-9');
  assert.equal(history.undo(canvasId), 'snapshot-8');
  assert.equal(history.undo(canvasId), 'snapshot-7');
  assert.equal(history.undo(canvasId), 'snapshot-6');
  assert.equal(history.undo(canvasId), 'snapshot-5');
  assert.equal(history.undo(canvasId), 'snapshot-4');
  assert.equal(history.undo(canvasId), 'snapshot-3');
  assert.equal(history.undo(canvasId), 'snapshot-2');
  assert.equal(history.undo(canvasId), null);
});

test('bounds memory globally and drops a snapshot larger than the byte ceiling', () => {
  const history = createCanvasHistory({ maxBytes: 8 });
  const secondCanvasId = 'b'.repeat(32);
  const thirdCanvasId = 'c'.repeat(32);

  history.record(canvasId, '1234');
  history.record(secondCanvasId, '5678');
  history.record(thirdCanvasId, 'x');
  assert.equal(history.canUndo(canvasId), false);
  assert.equal(history.record(canvasId, '123456789'), false);
  assert.equal(history.canUndo(secondCanvasId), true);
  assert.equal(history.undo(secondCanvasId), '5678');
  assert.equal(history.undo(thirdCanvasId), 'x');
});

test('clears stale undo entries when the latest snapshot cannot be retained', () => {
  const history = createCanvasHistory({ maxBytes: 8 });
  history.record(canvasId, 'before');

  assert.equal(history.record(canvasId, 'snapshot-too-large'), false);
  assert.equal(history.canUndo(canvasId), false);
});

test('clear removes only the requested canvas history', () => {
  const history = createCanvasHistory();
  const secondCanvasId = 'b'.repeat(32);
  history.record(canvasId, 'first');
  history.record(secondCanvasId, 'other');

  history.clear(canvasId);

  assert.equal(history.canUndo(canvasId), false);
  assert.equal(history.canUndo(secondCanvasId), true);
  assert.equal(history.undo(secondCanvasId), 'other');
});

test('trusted_recovery_is_retained_with_history_and_counts_its_full_byte_budget', () => {
  const history = createCanvasHistory({ maxBytes: 120 });
  const recovery = { instances: [{ instanceId: 'b'.repeat(32), envelope: { undo: ['kept'] } }] };
  assert.equal(history.record(canvasId, 'source', recovery), true);
  recovery.instances[0].envelope.undo[0] = 'tampered';
  let observed;
  assert.equal(history.restore(canvasId, (html, saved) => { observed = saved; return html; }), 'source');
  assert.equal(observed.instances[0].envelope.undo[0], 'kept');
  assert.equal(history.canUndo(canvasId), false);
  assert.equal(history.canRecord(canvasId, 'source', { large: 'x'.repeat(120) }), false);
  history.record(canvasId, 'source', { data: 'x'.repeat(60) });
  history.record('b'.repeat(32), 'other', { data: 'x'.repeat(60) });
  assert.equal(history.canUndo(canvasId), false);
});
test('failed_trusted_restore_keeps_the_original_history_entry', () => {
  const history = createCanvasHistory();
  history.record(canvasId, 'source', { trusted: 'state' });
  assert.throws(() => history.restore(canvasId, () => { throw new Error('Restore failed'); }), /Restore failed/);
  assert.equal(history.canUndo(canvasId), true);
  assert.deepEqual(history.restore(canvasId, (html, recovery) => ({ html, recovery })), { html: 'source', recovery: { trusted: 'state' } });
});

test('async_runtime_restore_failure_retains_the_complete_history_entry', async () => {
  const history = createCanvasHistory(); history.record(canvasId, 'source', { trusted: 'envelope' });
  await assert.rejects(history.restore(canvasId, async () => { throw new Error('Runtime reload failed'); }), /Runtime reload failed/);
  assert.equal(history.canUndo(canvasId), true);
  assert.equal(await history.restore(canvasId, async (_html, recovery) => recovery.trusted), 'envelope');
  assert.equal(history.canUndo(canvasId), false);
});
test('source_only_undo_cannot_discard_trusted_recovery_state', () => {
  const history = createCanvasHistory(); history.record(canvasId, 'source', { trusted: 'envelope' });
  assert.throws(() => history.undo(canvasId), /restore|recovery/i);
  assert.equal(history.canUndo(canvasId), true);
});


test('creation_boundary_retains_all_prior_entries_and_blocks_both_undo_paths', () => {
  const history = createCanvasHistory();
  history.record(canvasId, 'first'); history.record(canvasId, 'second');
  assert.equal(typeof history.recordBoundary, 'function');
  assert.equal(history.canRecordBoundary(canvasId), true);
  assert.equal(history.recordBoundary(canvasId), true);
  assert.equal(history.getUndoState(canvasId).undoHistoryEntries, 2);
  assert.equal(history.canUndo(canvasId), false);
  assert.match(history.getUndoState(canvasId).undoBlockedReason, /earlier.*kept|earlier.*retained/i);
  assert.throws(() => history.undo(canvasId), /Undo stops.*template|creation boundary/i);
  assert.throws(() => history.restore(canvasId, () => assert.fail('Blocked restore must not run')), /Undo stops.*template|creation boundary/i);
  assert.equal(history.getUndoState(canvasId).undoHistoryEntries, 2);
  history.record(canvasId, 'after-template');
  assert.equal(history.canUndo(canvasId), true);
  assert.equal(history.undo(canvasId), 'after-template');
  assert.equal(history.getUndoState(canvasId).undoHistoryEntries, 2);
  assert.equal(history.canUndo(canvasId), false);
});
test('creation_boundary_counts_bytes_without_evicting_existing_history_to_fit_it', () => {
  const history = createCanvasHistory({ maxBytes: 6 });
  history.record(canvasId, 'before');
  assert.equal(typeof history.canRecordBoundary, 'function');
  assert.equal(history.canRecordBoundary(canvasId), false);
  assert.equal(history.recordBoundary(canvasId), false);
  assert.equal(history.undo(canvasId), 'before');
});
test('normal_bounded_eviction_never_exposes_history_older_than_a_creation_boundary', () => {
  const history = createCanvasHistory();
  for (let i = 0; i < 10; i++) history.record(canvasId, `before-${i}`);
  assert.equal(typeof history.recordBoundary, 'function');
  history.recordBoundary(canvasId);
  assert.equal(history.getUndoState(canvasId).undoHistoryEntries, 10);
  for (let i = 0; i < 10; i++) history.record(canvasId, `after-${i}`);
  for (let i = 9; i >= 0; i--) assert.equal(history.undo(canvasId), `after-${i}`);
  assert.equal(history.undo(canvasId), null);
  assert.equal(history.getUndoState(canvasId).undoHistoryEntries, 0);
});

test('global_entry_eviction_removes_pre_boundary_entries_before_the_boundary_itself', () => {
  const history = createCanvasHistory({ maxEntries: 3 });
  const other = 'b'.repeat(32);
  history.record(canvasId, 'older'); history.record(canvasId, 'newer'); history.recordBoundary(canvasId);
  history.record(other, 'one'); history.record(other, 'two');
  assert.equal(history.getUndoState(canvasId).undoHistoryEntries, 1);
  assert.equal(history.canUndo(canvasId), false);
  history.record(other, 'three');
  assert.equal(history.getUndoState(canvasId).undoHistoryEntries, 0);
  assert.equal(history.undo(canvasId), null);
  assert.equal(history.undo(other), 'three');
});
test('boundary_byte_accounting_is_released_with_history_and_repeated_marking_is_idempotent', () => {
  const probe = createCanvasHistory(); probe.record(canvasId, 'a'); probe.recordBoundary(canvasId);
  const markerBytes = Buffer.byteLength(probe.getUndoState(canvasId).undoBlockedReason);
  const history = createCanvasHistory({ maxBytes: markerBytes + 2 });
  history.record(canvasId, 'a'); history.recordBoundary(canvasId); history.recordBoundary(canvasId);
  history.record('b'.repeat(32), 'b');
  assert.equal(history.getUndoState(canvasId).undoHistoryEntries, 1);
  assert.equal(history.getUndoState('b'.repeat(32)).undoHistoryEntries, 1);
  history.clear(canvasId);
  assert.equal(history.record('c'.repeat(32), 'x'.repeat(markerBytes + 1)), true);
  assert.equal(history.undo('b'.repeat(32)), 'b');
});
