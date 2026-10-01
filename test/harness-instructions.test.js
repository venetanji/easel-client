const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMON_INSTRUCTIONS, BUILTIN_INSTRUCTIONS, CODEX_INSTRUCTIONS, EXTERNAL_INSTRUCTIONS } = require('../src/harness-instructions');
const { PROJECT_CANVAS_TOOLS } = require('../src/canvas-project-tools');

test('backend guidance shares one compact set of source, media and lifecycle contracts', () => {
  for (const instructions of [BUILTIN_INSTRUCTIONS, CODEX_INSTRUCTIONS, EXTERNAL_INSTRUCTIONS]) {
    assert.ok(instructions.startsWith(COMMON_INSTRUCTIONS));
    assert.ok(instructions.length < 6500, 'Keep routine instructions out of tool and turn context.');
    assert.equal(instructions.split('You are Easel,').length - 1, 1);
    for (const name of ['apply_canvas_file_patches', 'request_canvas_input', 'registerApp', 'inspect_canvas']) assert.ok(instructions.includes(name));
    assert.match(instructions, /previewed automatically in chat/);
    assert.match(instructions, /Do not end with only a View\/Watch\/Download link/);
    assert.match(instructions, /omit size unless the user requests dimensions/);
  }
});

test('Codex native and configured generation coexist without imposing the built-in route', () => {
  assert.match(CODEX_INSTRUCTIONS, /Native Codex image_generation and Easel Media models are both available/);
  assert.match(CODEX_INSTRUCTIONS, /unless the user requests a configured endpoint\/model/);
  assert.match(CODEX_INSTRUCTIONS, /scope:"library",limit:4/);
  assert.doesNotMatch(CODEX_INSTRUCTIONS, /Generate images through the enabled Easel Media models/);
  assert.doesNotMatch(BUILTIN_INSTRUCTIONS, /Prefer native generation/);
  assert.match(EXTERNAL_INSTRUCTIONS, /get_control_events after event notifications/);
});

test('source discovery distinguishes existing edits from new sketches', () => {
  const listing = PROJECT_CANVAS_TOOLS.find(({ function: tool }) => tool.name === 'list_canvas_files').function;
  assert.match(listing.description, /For a new sketch use present_canvas directly/);
  assert.equal(listing.parameters.properties.includeAssets.default, false);
});

test('missing kits require user enablement before the agent continues', () => {
  assert.match(COMMON_INSTRUCTIONS, /creating a document does not enable its kit/);
  assert.match(COMMON_INSTRUCTIONS, /tell the user to enable it under Project files > Canvas kits, then end the turn until they confirm/);
  assert.match(COMMON_INSTRUCTIONS, /Uninstalled kits need installation in Settings > Kits first/);
});
