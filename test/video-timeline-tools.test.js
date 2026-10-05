const test = require('node:test');
const assert = require('node:assert/strict');
const { toOpenAITools, executeEaselTool, validateToolArguments } = require('../src/agent');
const { TIMELINE_TOOLS, timelineContextText } = require('../src/video-timeline-tools');
const projectId = 'a'.repeat(32);
test('timeline tools expose bounded schemas without raw paths, export or generation', () => {
  const tools = toOpenAITools([]).filter((tool) => /timeline/.test(tool.function.name));
  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ['apply_timeline_edit', 'create_timeline', 'inspect_timeline', 'redo_timeline', 'undo_timeline']);
  assert.deepEqual(tools, TIMELINE_TOOLS);
  for (const tool of tools) assert.equal(tool.function.parameters.additionalProperties, false);
  const edit = tools.find((tool) => tool.function.name === 'apply_timeline_edit');
  assert.throws(() => validateToolArguments({ projectId, expectedRevision: 0, operations: [{ type: 'shell', path: '/tmp/movie' }] }, edit.function.parameters));
});
test('timeline tools dispatch to the host and retain stale revision errors', async () => {
  const calls = [];
  const canvasController = { inspectTimeline(args) { calls.push(args); return { projectId, document: null }; }, applyTimelineEdit() { throw Object.assign(new Error('Reinspect timeline'), { code: 'TIMELINE_REVISION_CONFLICT' }); } };
  const result = await executeEaselTool('inspect_timeline', { projectId }, { canvasController });
  assert.deepEqual(calls, [{ projectId }]);
  assert.deepEqual(JSON.parse(result.content), { projectId, document: null });
  await assert.rejects(executeEaselTool('apply_timeline_edit', { projectId, expectedRevision: 0, operations: [] }, { canvasController }), { code: 'TIMELINE_REVISION_CONFLICT' });
});
test('timeline context is explicitly scoped to one message and never contains media payloads', () => {
  assert.equal(timelineContextText(), '');
  const context = { selection: { projectId, startFrame: 10, endFrame: 20 }, items: [{ id: 'clip', assetId: 'b'.repeat(32) }] };
  assert.match(timelineContextText(context), /this message only/i);
  assert.match(timelineContextText(context), /"startFrame":10/);
  assert.throws(() => timelineContextText({ ...context, data: 'data:video/mp4;base64,abc' }), /context/i);
});

test('agent_tools_accept_instance_identity_and_selected_turns_cannot_cross_it', async () => {
  const timelineId = 'b'.repeat(32), instanceId = 'c'.repeat(32);
  const tool = TIMELINE_TOOLS.find((tool) => tool.function.name === 'inspect_timeline');
  assert.doesNotThrow(() => validateToolArguments({ projectId, timelineId, instanceId }, tool.function.parameters));
  let inspected;
  const canvasController = { assertTimelineSelectionOrigin: () => {}, inspectTimeline: (args) => { inspected = args; return {}; } };
  const context = { turnOptions: { timelineSelection: { projectId, timelineId, instanceId } } };
  await executeEaselTool('inspect_timeline', { projectId }, { canvasController, context });
  assert.equal(inspected.timelineId, timelineId); assert.equal(inspected.instanceId, instanceId);
  await assert.rejects(executeEaselTool('inspect_timeline', { projectId, timelineId: 'd'.repeat(32) }, { canvasController, context }), /selected|instance|timeline/i);
});

const { templateFixture } = require('./helpers/template-lifecycle');
test('selected_turn_rejects_runtime_or_document_switch_before_tool', async (t) => {
  const f = templateFixture(t), [a, b] = f.records;
  f.controller.resolveSelection(f.selection);
  const before = [f.bytes(a), f.bytes(b)];
  for (const active of [{ ...a, runtimeGeneration: 2 }, { ...b, runtimeGeneration: 1 }]) {
    f.setActive(active);
    await assert.rejects(executeEaselTool('apply_timeline_edit', { projectId: f.projectId, expectedRevision: 0, operations: [{ type: 'insert', item: f.clip }] }, { canvasController: f.hostController, context: { turnOptions: { timelineSelection: f.selection } } }), /stale|runtime|document/i);
    assert.deepEqual([f.bytes(a), f.bytes(b)], before);
  }
});
test('selected_turn_allows_successive_edits_in_the_same_runtime', async (t) => {
  const f = templateFixture(t), [a, b] = f.records;
  f.controller.resolveSelection(f.selection); const beforeB = f.bytes(b);
  const options = { canvasController: f.hostController, context: { turnOptions: { timelineSelection: f.selection } } };
  await executeEaselTool('apply_timeline_edit', { projectId: f.projectId, expectedRevision: 0, operations: [{ type: 'insert', item: f.clip }] }, options);
  await executeEaselTool('apply_timeline_edit', { projectId: f.projectId, expectedRevision: 1, operations: [{ type: 'move', itemId: 'clip', startFrame: 24 }] }, options);
  assert.equal(f.timelines.read(f.projectId, a.timelineId).revision, 2); assert.equal(f.bytes(b), beforeB);
});

test('agent remove-track schema exposes explicit boolean cascade intent and explains safe default', () => {
  const edit = TIMELINE_TOOLS.find(tool => tool.function.name === 'apply_timeline_edit').function;
  assert.doesNotThrow(() => validateToolArguments({ projectId, expectedRevision: 0, operations: [{ type: 'remove-track', trackId: 'video-1', removeItems: true }] }, edit.parameters));
  assert.throws(() => validateToolArguments({ projectId, expectedRevision: 0, operations: [{ type: 'remove-track', trackId: 'video-1', removeItems: 'true' }] }, edit.parameters));
  assert.match(edit.description, /empty.*default|default.*empty/i);
  assert.match(edit.description, /removeItems:true/);
});

test('explicit cascade cannot bypass the selected instance or runtime boundary', async t => {
  const f = templateFixture(t), [a, b] = f.records;
  f.controller.apply(f.projectId, a.timelineId, { expectedRevision: 0, operations: [{ type: 'insert', item: f.clip }] });
  const before = [f.bytes(a), f.bytes(b)];
  const context = { turnOptions: { timelineSelection: { ...f.selection, timelineRevision: 1 } } };
  for (const active of [{ ...a, runtimeGeneration: 2 }, { ...b, runtimeGeneration: 1 }]) {
    f.setActive(active);
    await assert.rejects(executeEaselTool('apply_timeline_edit', { projectId: f.projectId, expectedRevision: 1, operations: [{ type: 'remove-track', trackId: 'video-1', removeItems: true }] }, { canvasController: f.hostController, context }), /stale|runtime|document/i);
    assert.deepEqual([f.bytes(a), f.bytes(b)], before);
  }
});
