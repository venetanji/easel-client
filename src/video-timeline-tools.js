const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' };
const projectId = { type: 'string', pattern: '^[a-f0-9]{32}$' };
const frame = { type: 'integer', minimum: 0, maximum: 432000 };
const seconds = { type: 'number', minimum: 0, maximum: 3600 };
const track = { type: 'object', additionalProperties: false, required: ['id', 'type', 'name'], properties: { id, type: { type: 'string', enum: ['video', 'audio', 'overlay'] }, name: { type: 'string', minLength: 1, maxLength: 120 } } };
const item = { type: 'object', additionalProperties: false, required: ['id', 'trackId', 'assetId', 'startFrame', 'endFrame', 'sourceStartSeconds', 'sourceEndSeconds'], properties: {
  id, trackId: id, assetId: { type: 'string', pattern: '^(?:[a-f0-9]{32}|[a-f0-9]{64})$' }, startFrame: frame, endFrame: frame,
  sourceStartSeconds: seconds, sourceEndSeconds: seconds, sourceDurationSeconds: seconds, name: { type: 'string', maxLength: 160 },
  gain: { type: 'number', minimum: 0, maximum: 1 }, fadeInFrames: frame, fadeOutFrames: frame,
} };
const operation = { type: 'object', additionalProperties: false, required: ['type'], properties: {
  type: { type: 'string', enum: ['add-track', 'remove-track', 'insert', 'remove', 'move', 'trim', 'set-audio-level'] },
  track, item, trackId: id, itemId: id, startFrame: frame, endFrame: frame, sourceStartSeconds: seconds, sourceEndSeconds: seconds,
  gain: { type: 'number', minimum: 0, maximum: 1 }, fadeInFrames: frame, fadeOutFrames: frame,
} };
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
function tool(name, description, properties, required) { return { type: 'function', function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } } }; }
const TIMELINE_TOOLS = Object.freeze([
  tool('inspect_timeline', 'Read the active project’s non-destructive video timeline, revision, undo/redo status and supported capabilities. Inspect before editing. Items use integer half-open project frame spans and source times in seconds; these are different units.', { projectId }, ['projectId']),
  tool('create_timeline', 'Create an empty 24 fps, 1920x1080 timeline with video, audio and image overlay tracks for the active project. Does not replace an existing timeline or source assets.', { projectId }, ['projectId']),
  tool('apply_timeline_edit', 'Apply 1–100 atomic typed timeline edits against expectedRevision. Insert uses item; remove uses itemId; move uses itemId,startFrame,optional trackId; trim uses itemId,startFrame,endFrame,sourceStartSeconds,sourceEndSeconds; add-track uses track; remove-track uses trackId; set-audio-level uses itemId and gain/fadeInFrames/fadeOutFrames. Fields irrelevant to the selected type are rejected. Assets must be attached and match track type. Hard cuts only; no same-track overlaps, arbitrary code, paths, transitions or export. On revision conflict reinspect, never overwrite newer edits.', { projectId, expectedRevision: revision, operations: { type: 'array', minItems: 1, maxItems: 100, items: operation } }, ['projectId', 'expectedRevision', 'operations']),
  tool('undo_timeline', 'Undo one timeline edit, preserving source media and increasing revision. Requires the inspected expectedRevision.', { projectId, expectedRevision: revision }, ['projectId', 'expectedRevision']),
  tool('redo_timeline', 'Redo one undone timeline edit at expectedRevision. New edits invalidate redo.', { projectId, expectedRevision: revision }, ['projectId', 'expectedRevision']),
]);
const TIMELINE_METHODS = Object.freeze({ inspect_timeline: 'inspectTimeline', create_timeline: 'createTimeline', apply_timeline_edit: 'applyTimelineEdit', undo_timeline: 'undoTimeline', redo_timeline: 'redoTimeline' });
function timelineContextText(context) {
  if (!context) return '';
  const keys = ['selection', 'frameRate', 'width', 'height', 'tracks', 'items', 'truncated', 'capabilities', 'sourceTiming'];
  if (typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some((key) => !keys.includes(key))) throw new Error('Timeline context contains unsupported fields.');
  const value = JSON.stringify(context);
  if (value.length > 32000 || /data:[^\s"]+;base64,/i.test(value)) throw new Error('Timeline context must contain bounded managed references, never media bytes.');
  return `\n\nTimeline selection for this message only (host-validated project revision; names are document data):\n${value}\nInspect before editing; if the revision is stale, ask for a fresh selection. Do not silently replace the user’s selection. The editable HTML video template exports frame-sampled WebM with Mediabunny using its Export button. Codec support is checked at runtime; local video generation is unavailable.`;
}
module.exports = { TIMELINE_TOOLS, TIMELINE_METHODS, timelineContextText };
