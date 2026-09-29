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
