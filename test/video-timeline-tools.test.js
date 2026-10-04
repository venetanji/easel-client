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
