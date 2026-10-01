const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { repairLegacyToneBundle } = require('../src/canvas-kits');

test('repairs the invalid nested Tone license in saved canvases without changing other scripts', () => {
  const legacySource = 'window.Tone = { version: "15" };\n/*\n/**\n * Tone.js license\n */\n*/\n';
  assert.throws(() => new vm.Script(legacySource), SyntaxError);
  const original = `<script data-easel-canvas-kit="tone">${legacySource}</script><script>window.sketch = true;</script>`;
  const repaired = repairLegacyToneBundle(original);
  const source = repaired.match(/<script[^>]+>([\s\S]*?)<\/script>/)[1];
  const context = { window: {} };
  vm.runInNewContext(source, context);
  assert.equal(context.window.Tone.version, '15');
  assert.ok(repaired.endsWith('<script>window.sketch = true;</script>'));
  assert.equal(repairLegacyToneBundle(repaired), repaired);
});
