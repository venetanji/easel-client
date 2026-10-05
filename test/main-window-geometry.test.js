const test = require('node:test');
const assert = require('node:assert/strict');
const { getMainWindowGeometry } = require('../src/main-window-geometry');

test('keeps the preferred window size centered on a large desktop', () => {
  assert.deepEqual(getMainWindowGeometry({ x: 0, y: 0, width: 1920, height: 1080 }), {
    x: 360, y: 90, width: 1200, height: 900, minWidth: 960, minHeight: 720,
  });
});

test('fits the initial and minimum window sizes inside a scaled or small desktop', () => {
  for (const workArea of [
    { x: 0, y: 0, width: 1280, height: 720 },
    { x: 0, y: 32, width: 960, height: 508 },
    { x: 0, y: 0, width: 800, height: 450 },
  ]) {
    const bounds = getMainWindowGeometry(workArea);
    assert.ok(bounds.x >= workArea.x + 24);
    assert.ok(bounds.y >= workArea.y + 24);
    assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width - 24);
    assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height - 24);
    assert.ok(bounds.minWidth <= bounds.width);
    assert.ok(bounds.minHeight <= bounds.height);
  }
});

test('positions the window inside an offset secondary monitor', () => {
  assert.deepEqual(getMainWindowGeometry({ x: -1280, y: 100, width: 1280, height: 720 }), {
    x: -1240, y: 124, width: 1200, height: 672, minWidth: 960, minHeight: 672,
  });
});
