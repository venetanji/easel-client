const PROJECT_ID = /^[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FRAME = 3_600 * 120;
function object(input, keys, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} must be an object.`);
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error(`${label} contains unsupported fields.`);
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Timeline revision must be a non-negative integer.');
}
function project(value) {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) throw new Error('Timeline project ID is invalid.');
  return value;
}
function validateTimelineSelectionInput(input) {
  object(input, ['projectId', 'timelineId', 'timelineRevision', 'trackIds', 'itemIds', 'startFrame', 'endFrame'], 'Timeline selection');
  project(input.projectId);
  if (!ID.test(input.timelineId || '')) throw new Error('Timeline ID is invalid.');
  revision(input.timelineRevision);
  for (const key of ['trackIds', 'itemIds']) {
    if (!Array.isArray(input[key]) || input[key].length > 100 || input[key].some((id) => typeof id !== 'string' || !ID.test(id)) || new Set(input[key]).size !== input[key].length) throw new Error(`Timeline ${key} are invalid.`);
  }
  if (!Number.isSafeInteger(input.startFrame) || !Number.isSafeInteger(input.endFrame) || input.startFrame < 0 || input.endFrame <= input.startFrame || input.endFrame > MAX_FRAME) throw new Error('Timeline selection range is invalid.');
  return structuredClone(input);
}
function validateTimelineRequest(action, input = {}) {
  const fields = { create: ['frameRate', 'width', 'height'], apply: ['expectedRevision', 'operations'], undo: ['expectedRevision'], redo: ['expectedRevision'] }[action];
  if (!fields) throw new Error('Unsupported timeline action.');
  object(input, fields, 'Timeline request');
  if (action !== 'create') revision(input.expectedRevision);
  if (action === 'apply' && (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100 || Buffer.byteLength(JSON.stringify(input.operations)) > 128 * 1024)) throw new Error('Provide 1–100 bounded timeline operations.');
  return structuredClone(input);
}

function createVideoTimelineController({ store, projectStore, getActiveProjectId, onChanged }) {
  const { applyTimelineOperations, validateTimelineSelection } = require('./video-timeline');
  function assertProject(projectId, active = false) {
    project(projectId);
    if (active && projectId !== getActiveProjectId()) throw new Error('Open the timeline’s active project before editing or sharing its selection.');
    projectStore.getProject(projectId);
  }
  function read(projectId) { assertProject(projectId); return store.read(projectId); }
  function history(projectId) { assertProject(projectId); return store.status(projectId); }
  function changed(projectId, document) {
    onChanged?.({ type: 'timeline-changed', projectId, timelineId: document.id, revision: document.revision });
    return document;
  }
  function create(projectId, input = {}) {
    assertProject(projectId, true);
    const options = validateTimelineRequest('create', input);
    return changed(projectId, store.create(projectId, options));
  }
  function validateAssets(projectId, document) {
    const manifestAssets = projectStore.getProject(projectId).manifest?.assets || projectStore.listAssets(projectId).assets;
    const assets = new Map(manifestAssets.map((asset) => [asset.id, asset]));
    const tracks = new Map(document.tracks.map((track) => [track.id, track]));
    for (const item of document.items) {
      const asset = assets.get(item.assetId);
      if (!asset) throw new Error(`Timeline asset ${item.assetId} is not attached to this project. Attach it in Media first.`);
      const type = tracks.get(item.trackId).type;
      const family = type === 'overlay' ? 'image' : type;
      if (!asset.mimeType?.startsWith(`${family}/`) && !(type === 'video' && asset.mimeType?.startsWith('image/'))) throw new Error(`The ${type} track requires ${family} media${type === 'video' ? ' or a still image' : ''}.`);
      if (family !== 'image' && Number.isFinite(asset.duration) && item.sourceEndSeconds > asset.duration + 0.001) throw new Error(`Timeline clip ${item.id} exceeds its source duration.`);
    }
  }
  function apply(projectId, input) {
    assertProject(projectId, true);
    const options = validateTimelineRequest('apply', input);
    const current = store.read(projectId);
    if (!current) throw new Error('Create a timeline first.');
    if (current.revision !== options.expectedRevision) throw Object.assign(new Error('Timeline revision changed. Inspect the timeline and rebase your edit.'), { code: 'TIMELINE_REVISION_CONFLICT' });
    const candidate = applyTimelineOperations(current, options.operations).document;
    validateAssets(projectId, candidate);
    return changed(projectId, store.apply(projectId, options));
  }
  function undo(projectId, input) { assertProject(projectId, true); return changed(projectId, store.undo(projectId, validateTimelineRequest('undo', input), (document) => validateAssets(projectId, document))); }
  function redo(projectId, input) { assertProject(projectId, true); return changed(projectId, store.redo(projectId, validateTimelineRequest('redo', input), (document) => validateAssets(projectId, document))); }
  function resolveSelection(input) {
    const selection = validateTimelineSelectionInput(input);
    assertProject(selection.projectId, true);
    const document = store.read(selection.projectId);
    if (!document) throw new Error('The selected timeline no longer exists. Select a range again.');
    validateTimelineSelection(selection, document);
    const selectedIds = new Set(selection.itemIds);
    const nearby = document.items.filter((item) => selectedIds.has(item.id) || item.startFrame <= selection.endFrame && item.endFrame >= selection.startFrame);
    const items = [...nearby.filter((item) => selectedIds.has(item.id)), ...nearby.filter((item) => !selectedIds.has(item.id))].slice(0, 30);
    return { selection, frameRate: document.frameRate, width: document.width, height: document.height,
      tracks: document.tracks, items, truncated: nearby.length > items.length,
      capabilities: { livePreview: true, export: 'webm-vp8-opus', transitions: false, localGeneration: false },
      sourceTiming: 'Source ranges are seconds, timeline ranges are integer project frames [start,end). Browser preview is approximate; WebM export samples project frames with Mediabunny.' };
  }
  function inspect({ projectId }) {
    assertProject(projectId, true);
    const document = store.read(projectId);
    return { projectId, document, ...store.status(projectId), capabilities: { livePreview: true, export: 'webm-vp8-opus', transitions: false, localGeneration: false },
      note: 'Use create_timeline if absent. Managed assets must already be attached to this project. The editable HTML video template exports WebM with Mediabunny (up to 60 seconds/32 MiB). Transitions, speed changes and local generation are unavailable.' };
  }
  function assertAssetUnused(projectId, assetId) {
    const document = store.read(project(projectId));
    if (document?.items.some((item) => item.assetId === assetId)) throw new Error('This media is used by the video timeline. Remove its timeline clips before detaching it.');
  }
  return { create, read, history, apply, undo, redo, resolveSelection, inspect, assertAssetUnused,
    openEditor: (projectId, open) => { assertProject(projectId, true); return open(); },
  };
}
module.exports = { createVideoTimelineController, validateTimelineRequest, validateTimelineSelectionInput };
