const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function catalog() {
  assert.ok(fs.existsSync(path.join(__dirname, '../src/template-catalog.js')), 'The packaged template catalog must exist');
  return require('../src/template-catalog');
}
test('catalog describes ready and planned templates without implying runtime availability', () => {
  const { listTemplates } = catalog();
  const entries = listTemplates();
  assert.deepEqual(entries.filter((entry) => entry.status === 'ready').map((entry) => entry.id), ['video-editor', 'strudel-sound']);
  assert.ok(entries.some((entry) => entry.status === 'planned'));
  for (const entry of entries) {
    assert.equal(entry.version, 1);
    for (const field of ['title', 'purpose']) assert.ok(entry[field]);
    for (const field of ['requiredKits', 'outputs', 'limitations', 'questions', 'actions']) assert.ok(Array.isArray(entry[field]));
    assert.equal(typeof entry.availability.available, 'boolean');
    if (entry.status === 'planned') { assert.deepEqual(entry.actions, []); assert.equal(entry.availability.available, false); }
  }
  const strudel = entries.find((entry) => entry.id === 'strudel-sound');
  assert.equal(strudel.availability.available, false);
  assert.match(strudel.availability.reason, /runtime|compatibility/i);
  assert.equal(listTemplates({ includePlanned: false }).length, 2);
});
test('catalog returns independent metadata and rejects unknown options', () => {
  const { listTemplates } = catalog();
  const first = listTemplates();
  first[0].requiredKits.push('untrusted'); first[0].availability.available = false;
  assert.deepEqual(listTemplates()[0].requiredKits, ['canvas-2d']);
  assert.equal(listTemplates()[0].availability.available, true);
  assert.throws(() => listTemplates({ includePlanned: 'yes' }), /invalid/i);
  assert.throws(() => listTemplates({ html: '<script></script>' }), /invalid/i);
});
