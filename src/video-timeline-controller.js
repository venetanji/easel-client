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
  object(input, ['projectId', 'instanceId', 'documentPath', 'runtimeGeneration', 'timelineId', 'timelineRevision', 'trackIds', 'itemIds', 'startFrame', 'endFrame'], 'Timeline selection');
  project(input.projectId);
  if (typeof input.timelineId !== 'string' || !ID.test(input.timelineId)) throw new Error('Timeline ID is invalid.');
  revision(input.timelineRevision);
  if (input.instanceId !== undefined && (typeof input.instanceId !== 'string' || !PROJECT_ID.test(input.instanceId))) throw new Error('Timeline instance ID is invalid.');
  if (input.documentPath !== undefined && (typeof input.documentPath !== 'string' || input.documentPath.length > 240 || !/\.html?$/i.test(input.documentPath) || /[\\\u0000-\u001f]/.test(input.documentPath) || input.documentPath.split('/').some((part) => !part || part === '.' || part === '..'))) throw new Error('Timeline document path is invalid.');
  if (input.runtimeGeneration !== undefined && (!Number.isSafeInteger(input.runtimeGeneration) || input.runtimeGeneration < 0)) throw new Error('Timeline runtime generation is invalid.');
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

function createVideoTimelineController({ store, projectStore, getActiveProjectId, getActiveScope, instances, onChanged }) {
  const { applyTimelineOperations, validateTimelineSelection } = require('./video-timeline');
  function assertProject(projectId, active = false) {
    project(projectId);
    if (active && projectId !== getActiveProjectId()) throw new Error('Open the timeline’s active project before editing or sharing its selection.');
    projectStore.getProject(projectId);
  }
  function resolveLegacy(projectId) { assertProject(projectId); return store.resolveLegacy(projectId); }
  function resolveTarget(projectId, timelineId, instanceId) {
    assertProject(projectId);
    if (timelineId !== undefined && (typeof timelineId !== 'string' || !ID.test(timelineId))) throw new Error('Timeline ID is invalid.');
    if (instanceId !== undefined) {
      if (typeof instanceId !== 'string' || !PROJECT_ID.test(instanceId)) throw new Error('Timeline instance ID is invalid.');
      const binding = instances?.list(projectId).find((entry) => entry.instanceId === instanceId);
      if (!binding?.timelineId || timelineId !== undefined && binding.timelineId !== timelineId) throw new Error('Timeline instance does not match.');
      return binding.timelineId;
    }
    return timelineId ?? resolveLegacy(projectId);
  }
  function read(projectId, timelineId) { const id = resolveTarget(projectId, timelineId); return id === null ? null : store.read(projectId, id); }
  function history(projectId, timelineId) { const id = resolveTarget(projectId, timelineId); return id === null ? { undoAvailable: false, redoAvailable: false } : store.status(projectId, id); }
  function changed(projectId, document) {
    const binding = instances?.list(projectId).find((entry) => entry.timelineId === document.id);
    onChanged?.({ type: 'timeline-changed', projectId, timelineId: document.id, revision: document.revision,
      ...(binding ? { instanceId: binding.instanceId, documentPath: binding.documentPath } : {}) });
    return document;
  }
  function create(projectId, timelineId, input = {}) {
    assertProject(projectId, true);
    if (typeof timelineId !== 'string') { input = timelineId ?? input; timelineId = undefined; }
    const options = validateTimelineRequest('create', input);
    return changed(projectId, timelineId === undefined ? store.create(projectId, options) : store.create(projectId, timelineId, options));
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
  function apply(projectId, timelineId, input) {
    assertProject(projectId, true);
    if (typeof timelineId !== 'string') { input = timelineId; timelineId = undefined; }
    timelineId = resolveTarget(projectId, timelineId);
    const options = validateTimelineRequest('apply', input);
    const current = timelineId === null ? null : store.read(projectId, timelineId);
    if (!current) throw new Error('Create a timeline first.');
    if (current.revision !== options.expectedRevision) throw Object.assign(new Error('Timeline revision changed. Inspect the timeline and rebase your edit.'), { code: 'TIMELINE_REVISION_CONFLICT' });
    const candidate = applyTimelineOperations(current, options.operations).document;
    validateAssets(projectId, candidate);
    return changed(projectId, store.apply(projectId, timelineId, options));
  }
  function restore(direction, projectId, timelineId, input) {
    assertProject(projectId, true);
    if (typeof timelineId !== 'string') { input = timelineId; timelineId = undefined; }
    const id = resolveTarget(projectId, timelineId);
    if (!id) throw new Error('Create a timeline first.');
    return changed(projectId, store[direction](projectId, id, validateTimelineRequest(direction, input), (document) => validateAssets(projectId, document)));
  }
  function undo(projectId, timelineId, input) { return restore('undo', projectId, timelineId, input); }
  function redo(projectId, timelineId, input) { return restore('redo', projectId, timelineId, input); }
  function assertSelectionOrigin(input) {
    const selection = validateTimelineSelectionInput(input);
    assertProject(selection.projectId, true);
    if (instances) {
      const binding = instances.resolveDocument(selection.projectId, selection.documentPath);
      if (!binding || binding.instanceId !== selection.instanceId || binding.timelineId !== selection.timelineId) throw new Error('The selection belongs to another or deleted template instance. Select a range again.');
      const active = getActiveScope?.();
      if (!active || ['projectId', 'documentPath', 'instanceId', 'timelineId', 'runtimeGeneration'].some((key) => active[key] !== selection[key])) throw new Error('The selected document or runtime is stale. Select a range again.');
    }
    return selection;
  }
  function resolveSelection(input) {
    const selection = assertSelectionOrigin(input);
    const document = store.read(selection.projectId, selection.timelineId);
    if (!document) throw new Error('The selected timeline no longer exists. Select a range again.');
    const { instanceId, documentPath, runtimeGeneration, ...coreSelection } = selection;
    validateTimelineSelection(coreSelection, document);
    const selectedIds = new Set(selection.itemIds);
    const nearby = document.items.filter((item) => selectedIds.has(item.id) || item.startFrame <= selection.endFrame && item.endFrame >= selection.startFrame);
    const items = [...nearby.filter((item) => selectedIds.has(item.id)), ...nearby.filter((item) => !selectedIds.has(item.id))].slice(0, 30);
    return { selection, frameRate: document.frameRate, width: document.width, height: document.height,
      tracks: document.tracks, items, truncated: nearby.length > items.length,
      capabilities: { livePreview: true, export: 'webm-vp8-opus', transitions: false, localGeneration: false },
      sourceTiming: 'Source ranges are seconds, timeline ranges are integer project frames [start,end). Browser preview is approximate; WebM export samples project frames with Mediabunny.' };
  }
  function inspect({ projectId, timelineId, instanceId }) {
    assertProject(projectId, true);
    const id = resolveTarget(projectId, timelineId, instanceId);
    const document = id === null ? null : store.read(projectId, id);
    const binding = instances?.list(projectId).find((entry) => entry.timelineId === id);
    return { projectId, ...(id ? { timelineId: id } : {}), ...(binding ? { instanceId: binding.instanceId, documentPath: binding.documentPath } : {}), document, ...history(projectId, id ?? undefined), capabilities: { livePreview: true, export: 'webm-vp8-opus', transitions: false, localGeneration: false },
      note: 'Use create_timeline if absent. Managed assets must already be attached to this project. The editable HTML video template exports WebM with Mediabunny (up to 60 seconds/32 MiB). Transitions, speed changes and local generation are unavailable.' };
  }
  function assertAssetUnused(projectId, assetId) {
    const documents = store.list(project(projectId));
    if (documents.some((document) => document.items.some((item) => item.assetId === assetId))) throw new Error('This media is used by the video timeline. Remove its timeline clips before detaching it.');
  }
  return { create, read, history, resolveLegacy, resolveTarget, apply, undo, redo, assertSelectionOrigin, resolveSelection, inspect, assertAssetUnused,
    openEditor: (projectId, open) => { assertProject(projectId, true); return open(); },
  };
}
module.exports = { createVideoTimelineController, validateTimelineRequest, validateTimelineSelectionInput };
