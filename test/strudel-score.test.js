const test = require('node:test');
const assert = require('node:assert/strict');
const { appendStrudelLayer } = require('../src/strudel-score');

test('adding a layer preserves a plain pattern and its setup without rewriting the score', () => {
  const source = 'setcpm(30);\n// a label in a comment: drums:\nnote("c3 e3").s("sine") // keep this comment';
  assert.equal(appendStrudelLayer(source, 's("sbd*4").gain(.3)'),
    'setcpm(30);\n// a label in a comment: drums:\n$: note("c3 e3").s("sine") // keep this comment\n\n$: s("sbd*4").gain(.3)');
});

test('adding to a labeled score preserves its layers and tempo', () => {
  const source = 'setcpm(40)\ndrums: s("sbd*4")\n$: note("c3").s("sine")';
  assert.equal(appendStrudelLayer(source, 'note("e4").s("triangle")'),
    source + '\n\n$: note("e4").s("triangle")');
});

test('adding to an empty or setup-only score creates its first layer', () => {
  assert.equal(appendStrudelLayer('', 's("sbd*4")'), '$: s("sbd*4")');
  assert.equal(appendStrudelLayer('const root = "c3";', 'note(root).s("sine")'),
    'const root = "c3";\n\n$: note(root).s("sine")');
});

test('invalid source is rejected before an example can overwrite it', () => {
  assert.throws(() => appendStrudelLayer('note(', 's("sbd*4")'), /Unexpected token/);
});

test('muted labels do not hide the plain pattern when adding an example', () => {
  const source = '_bass: note("c2").s("sine")\nnote("d4 f4 a4").s("triangle")';
  assert.equal(appendStrudelLayer(source, 's("sbd*4")'),
    '_bass: note("c2").s("sine")\n$: note("d4 f4 a4").s("triangle")\n\n$: s("sbd*4")');
});

test('ambiguous registrations are rejected instead of dropping or doubling existing layers', () => {
  for (const source of [
    'note("d4").s("sine")["p"]("melody")',
    'const method = "p"; note("d4").s("sine")[method]("melody")',
    'note("c2").s("sine").p("_bass"); note("d4").s("triangle")',
    'const helper = () => note("c2").s("sine").p("bass"); note("d4").s("triangle")',
    'const helper = () => note("c2").s("sine").p("bass"); helper()',
    'if (false) { bass: note("c2").s("sine") } note("d4").s("triangle")',
  ]) assert.throws(() => appendStrudelLayer(source, 's("sbd*4")'), /manually/);
});
