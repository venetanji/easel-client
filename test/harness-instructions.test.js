const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMON_INSTRUCTIONS, BUILTIN_INSTRUCTIONS, CODEX_INSTRUCTIONS, EXTERNAL_INSTRUCTIONS } = require('../src/harness-instructions');
const { PROJECT_CANVAS_TOOLS } = require('../src/canvas-project-tools');
const { TIMELINE_TOOLS } = require('../src/video-timeline-tools');

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

test('tools run before the final reply and JavaScript media resolves offline', () => {
  assert.match(COMMON_INSTRUCTIONS, /Execute the next needed tool in this turn/);
  assert.match(COMMON_INSTRUCTIONS, /do not end with a promise to reload, capture, read, or patch/);
  assert.match(COMMON_INSTRUCTIONS, /End when done, blocked, or waiting for a job\/user response/);
  assert.match(COMMON_INSTRUCTIONS, /In JavaScript use getUrl\(id\) or the returned \{\{asset:id\}\} placeholder; assets\/ paths resolve in HTML\/CSS only/);
});

test('current API guidance exposes typed advanced controls and separates discovery from paid checks', () => {
  assert.match(COMMON_INSTRUCTIONS, /Discovery does not prove generation/);
  assert.match(COMMON_INSTRUCTIONS, /discover_video_capabilities/);
  assert.match(COMMON_INSTRUCTIONS, /list_video_loras/);
  assert.match(COMMON_INSTRUCTIONS, /guidingFrames/);
  assert.match(COMMON_INSTRUCTIONS, /decimal string/);
  assert.match(COMMON_INSTRUCTIONS, /read-only --probe/);
  assert.match(COMMON_INSTRUCTIONS, /Never invent tools or use billed generation as a capability probe/);
});


test('shared stitching guidance uses real revision-safe timeline tools', () => {
  for (const name of ['inspect_timeline', 'apply_timeline_edit']) {
    assert.ok(TIMELINE_TOOLS.some(({ function: tool }) => tool.name === name));
    assert.ok(COMMON_INSTRUCTIONS.includes(name));
  }
  assert.match(COMMON_INSTRUCTIONS, /inspect_timeline.*list_media_assets.*attach_canvas_assets.*before apply_timeline_edit/);
  assert.match(COMMON_INSTRUCTIONS, /expectedRevision/);
  assert.match(COMMON_INSTRUCTIONS, /integer half-open \[startFrame,endFrame\)/);
  assert.match(COMMON_INSTRUCTIONS, /sourceStartSeconds\/sourceEndSeconds are seconds/);
  assert.match(COMMON_INSTRUCTIONS, /[Rr]einspect revision conflicts/);
  assert.match(COMMON_INSTRUCTIONS, /fresh.*selection/);
});

test('shared stitching guidance separates hard cuts, synthesis, review and user export', () => {
  assert.match(COMMON_INSTRUCTIONS, /Hard cuts only.*generative/);
  assert.match(COMMON_INSTRUCTIONS, /server features require exposed tool fields/);
  assert.match(COMMON_INSTRUCTIONS, /boundary frames, continuity and audio/);
  assert.match(COMMON_INSTRUCTIONS, /Export video button; no agent export tool/);
});

test('template co-creation keeps specific permission, adaptive questions and silent restore within the existing budgets', () => {
  for (const instructions of [BUILTIN_INSTRUCTIONS, CODEX_INSTRUCTIONS, EXTERNAL_INSTRUCTIONS]) {
    assert.match(instructions, /list_templates/);
    assert.match(instructions, /create_template_instance/);
    assert.match(instructions, /specific.*(?:create|add).*target/i);
    assert.match(instructions, /one.*question.*(?:rhythm|melody)/i);
    assert.match(instructions, /calm.*energetic/i);
    assert.match(instructions, /restorePreviousView.*clear.*(?:never|avoid).*resetState/i);
    assert.match(instructions, /model round trip.*source.*reload/i);
    assert.match(instructions, /Escape.*Stop/);
    assert.match(instructions, /(?:answers|questions).*media.*(?:permission|authorize)/i);
    assert.ok(instructions.length < 6500);
  }
});

test('Tone gesture instructions are scoped to Tone rather than replacing the Strudel kit', () => {
  assert.match(COMMON_INSTRUCTIONS, /For Tone, enable its kit/);
});
