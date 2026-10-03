(function exposeTimeline(root) {

const TIMELINE_SCHEMA_VERSION = 1;
const MAX_TIMELINE_SECONDS = 86_400;
const MAX_TIMELINE_FRAMES = MAX_TIMELINE_SECONDS * 120;
const MAX_TIMELINE_TRACKS = 128;
const MAX_TIMELINE_ITEMS = 4096;
const MAX_TIMELINE_OPERATIONS = 128;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PROJECT_ID_PATTERN = /^[a-f0-9]{32}$/;
const ASSET_ID_PATTERN = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const DOCUMENT_KEYS = ['schemaVersion', 'id', 'revision', 'frameRate', 'width', 'height', 'tracks', 'items', 'transitions'];
const ITEM_KEYS = ['id', 'trackId', 'startFrame', 'endFrame', 'assetId', 'sourceStartSeconds', 'sourceEndSeconds'];
const ITEM_OPTIONAL_KEYS = ['sourceDurationSeconds', 'name', 'gain', 'fadeInFrames', 'fadeOutFrames'];

function fail(message, code = 'TIMELINE_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function objectKeys(value, required, optional = [], label = 'Timeline value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.has(key) || !Object.getOwnPropertyDescriptor(value, key).enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail(`${label} contains an unsupported property.`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} requires ${key}.`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}.`);
}
function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${label} must be a finite number between ${min} and ${max}.`);
}
function id(value, label = 'Timeline ID', pattern = ID_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid.`);
}
function name(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} must be a nonempty name of at most 120 characters.`);
}
function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array of at most ${max} entries.`);
  if (Reflect.ownKeys(value).length !== value.length + 1) fail(`${label} contains missing or unsupported entries.`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} cannot contain missing or hidden entries.`);
  }
}
function range(start, end, max = MAX_TIMELINE_FRAMES) {
  integer(start, 0, max, 'Start frame');
  integer(end, 1, max, 'End frame');
  if (end <= start) fail('A timeline range must be a nonempty half-open span.');
}
function sourceRange(start, end) {
  number(start, 0, MAX_TIMELINE_SECONDS, 'Source start');
  number(end, 0, MAX_TIMELINE_SECONDS, 'Source end');
  if (end <= start) fail('Source end must be after source start.');
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validateTrack(track) {
  objectKeys(track, ['id', 'type', 'name'], [], 'Track');
  id(track.id, 'Track ID');
  if (!['video', 'audio', 'overlay'].includes(track.type)) fail('Track type is unsupported.');
  name(track.name, 'Track name');
}
function validateAudio(value, span = MAX_TIMELINE_FRAMES) {
  if (Object.hasOwn(value, 'gain')) number(value.gain, 0, 1, 'Audio gain');
  for (const key of ['fadeInFrames', 'fadeOutFrames']) if (Object.hasOwn(value, key)) integer(value[key], 0, span, key);
  if ((value.fadeInFrames ?? 0) + (value.fadeOutFrames ?? 0) > span) fail('Audio fades exceed the item frame span.');
}
function validateItem(item, maxFrame = MAX_TIMELINE_FRAMES) {
  objectKeys(item, ITEM_KEYS, ITEM_OPTIONAL_KEYS, 'Timeline item');
  id(item.id, 'Item ID');
  id(item.trackId, 'Track ID');
  id(item.assetId, 'Managed asset ID', ASSET_ID_PATTERN);
  range(item.startFrame, item.endFrame, maxFrame);
  sourceRange(item.sourceStartSeconds, item.sourceEndSeconds);
  if (Object.hasOwn(item, 'sourceDurationSeconds')) {
    number(item.sourceDurationSeconds, 0, MAX_TIMELINE_SECONDS, 'Source duration');
    if (item.sourceEndSeconds > item.sourceDurationSeconds) fail('Item source range exceeds source duration.');
  }
  if (Object.hasOwn(item, 'name')) name(item.name, 'Item name');
  validateAudio(item, item.endFrame - item.startFrame);
}
function uniqueIds(values, label) {
  const seen = new Set();
  for (const value of values) {
    id(value, label);
    if (seen.has(value)) fail(`${label} must be unique.`);
    seen.add(value);
  }
  return seen;
}

function validateTimelineDocument(input) {
  objectKeys(input, DOCUMENT_KEYS, [], 'Timeline document');
  if (input.schemaVersion !== TIMELINE_SCHEMA_VERSION) fail('Unsupported timeline schema version.');
  id(input.id);
  integer(input.revision, 0, Number.MAX_SAFE_INTEGER, 'Timeline revision');
  objectKeys(input.frameRate, ['numerator', 'denominator'], [], 'Frame rate');
  integer(input.frameRate.numerator, 1, 120_000, 'Frame rate numerator');
  integer(input.frameRate.denominator, 1, 10_000, 'Frame rate denominator');
  const fps = input.frameRate.numerator / input.frameRate.denominator;
  number(fps, 1, 120, 'Frame rate');
  integer(input.width, 1, 8192, 'Timeline width');
  integer(input.height, 1, 8192, 'Timeline height');
  array(input.tracks, MAX_TIMELINE_TRACKS, 'Tracks');
  array(input.items, MAX_TIMELINE_ITEMS, 'Items');
  // Renderer capabilities have not been selected. Reject rather than silently ignore effects.
  array(input.transitions, 0, 'Transitions (not supported by this timeline version)');
  for (const track of input.tracks) validateTrack(track);
  uniqueIds(input.tracks.map((track) => track.id), 'Track IDs');
  const tracks = new Map(input.tracks.map((track) => [track.id, track]));
  const byTrack = new Map();
  for (const item of input.items) {
    validateItem(item, Math.floor(MAX_TIMELINE_SECONDS * fps));
    const track = tracks.get(item.trackId);
    if (!track) fail('Timeline item refers to an unknown track.');
    if (track.type === 'overlay' && ['gain', 'fadeInFrames', 'fadeOutFrames'].some((key) => Object.hasOwn(item, key))) fail('Audio controls require a video or audio track.');
    if (!byTrack.has(track.id)) byTrack.set(track.id, []);
    byTrack.get(track.id).push(item);
  }
  uniqueIds(input.items.map((item) => item.id), 'Item IDs');
  for (const items of byTrack.values()) {
    items.sort((a, b) => a.startFrame - b.startFrame);
    for (let index = 1; index < items.length; index += 1) {
      if (items[index].startFrame < items[index - 1].endFrame) fail('Items cannot overlap on the same track; use separate tracks.');
    }
  }
  return clone(input);
}

function createTimelineDocument(options = {}) {
  objectKeys(options, [], ['id', 'frameRate', 'width', 'height', 'tracks', 'items', 'transitions'], 'Initial timeline');
  return validateTimelineDocument({
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    id: options.id ?? root.crypto.randomUUID().replaceAll('-', ''), revision: 0,
    frameRate: { numerator: 24, denominator: 1 }, width: 1920, height: 1080,
    tracks: [{ id: 'video-1', type: 'video', name: 'Video' },
      { id: 'audio-1', type: 'audio', name: 'Audio' },
      { id: 'overlay-1', type: 'overlay', name: 'Overlay' }],
    items: [], transitions: [], ...options,
  });
}

function validateTimelineOperations(operations) {
  array(operations, MAX_TIMELINE_OPERATIONS, 'Timeline operations');
  if (!operations.length) fail('At least one timeline operation is required.');
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') fail('Timeline operation must be an object.');
    switch (operation.type) {
      case 'add-track':
        objectKeys(operation, ['type', 'track'], [], 'Add track operation');
        validateTrack(operation.track);
        break;
      case 'remove-track':
        objectKeys(operation, ['type', 'trackId'], [], 'Remove track operation');
        id(operation.trackId, 'Track ID');
        break;
      case 'insert':
        objectKeys(operation, ['type', 'item'], [], 'Insert operation');
        validateItem(operation.item);
        break;
      case 'remove':
        objectKeys(operation, ['type', 'itemId'], [], 'Remove operation');
        id(operation.itemId, 'Item ID');
        break;
      case 'move':
        objectKeys(operation, ['type', 'itemId', 'startFrame'], ['trackId'], 'Move operation');
        id(operation.itemId, 'Item ID');
        integer(operation.startFrame, 0, MAX_TIMELINE_FRAMES, 'Start frame');
        if (Object.hasOwn(operation, 'trackId')) id(operation.trackId, 'Track ID');
        break;
      case 'trim':
        objectKeys(operation, ['type', 'itemId', 'startFrame', 'endFrame', 'sourceStartSeconds', 'sourceEndSeconds'], [], 'Trim operation');
        id(operation.itemId, 'Item ID');
        range(operation.startFrame, operation.endFrame);
        sourceRange(operation.sourceStartSeconds, operation.sourceEndSeconds);
        break;
      case 'set-audio-level':
        objectKeys(operation, ['type', 'itemId'], ['gain', 'fadeInFrames', 'fadeOutFrames'], 'Audio operation');
        id(operation.itemId, 'Item ID');
        if (!['gain', 'fadeInFrames', 'fadeOutFrames'].some((key) => Object.hasOwn(operation, key))) fail('An audio operation must change gain or fades.');
        validateAudio(operation);
        break;
      default: fail('Timeline operation type is unsupported.');
    }
  }
  return clone(operations);
}

function applyTimelineOperations(input, operations) {
  const document = validateTimelineDocument(input);
  const validated = validateTimelineOperations(operations);
  const changedItemIds = new Set();
  for (const operation of validated) {
    if (operation.type === 'add-track') {
      if (document.tracks.some((track) => track.id === operation.track.id)) fail('Track ID already exists.');
      document.tracks.push(operation.track);
    } else if (operation.type === 'remove-track') {
      if (!document.tracks.some((track) => track.id === operation.trackId)) fail('Track does not exist.');
      if (document.items.some((item) => item.trackId === operation.trackId)) fail('Only empty tracks may be removed.');
      document.tracks = document.tracks.filter((track) => track.id !== operation.trackId);
    } else if (operation.type === 'insert') {
      if (document.items.some((item) => item.id === operation.item.id)) fail('Item ID already exists.');
      document.items.push(operation.item);
      changedItemIds.add(operation.item.id);
    } else {
      const item = document.items.find((candidate) => candidate.id === operation.itemId);
      if (!item) fail('Timeline item does not exist.');
      changedItemIds.add(item.id);
      if (operation.type === 'remove') document.items = document.items.filter((candidate) => candidate.id !== item.id);
      if (operation.type === 'move') {
        item.endFrame = operation.startFrame + item.endFrame - item.startFrame;
        item.startFrame = operation.startFrame;
        if (Object.hasOwn(operation, 'trackId')) item.trackId = operation.trackId;
      }
      if (operation.type === 'trim') {
        for (const key of ['startFrame', 'endFrame', 'sourceStartSeconds', 'sourceEndSeconds']) item[key] = operation[key];
      }
      if (operation.type === 'set-audio-level') {
        for (const key of ['gain', 'fadeInFrames', 'fadeOutFrames']) if (Object.hasOwn(operation, key)) item[key] = operation[key];
      }
    }
  }
  document.revision += 1;
  return { document: validateTimelineDocument(document), changedItemIds: [...changedItemIds] };
}

function validateTimelineSelection(input, document) {
  objectKeys(input, ['projectId', 'timelineId', 'timelineRevision', 'trackIds', 'itemIds', 'startFrame', 'endFrame'], [], 'Timeline selection');
  id(input.projectId, 'Project ID', PROJECT_ID_PATTERN);
  id(input.timelineId);
  integer(input.timelineRevision, 0, Number.MAX_SAFE_INTEGER, 'Selection revision');
  array(input.trackIds, MAX_TIMELINE_TRACKS, 'Selection track IDs');
  array(input.itemIds, MAX_TIMELINE_ITEMS, 'Selection item IDs');
  const trackIds = uniqueIds(input.trackIds, 'Selection track IDs');
  uniqueIds(input.itemIds, 'Selection item IDs');
  if (!trackIds.size) fail('A timeline selection requires at least one track.');
  const checked = validateTimelineDocument(document);
  if (input.timelineId !== checked.id) fail('Selection belongs to another timeline.');
  if (input.timelineRevision !== checked.revision) fail('Timeline revision changed; inspect and select the current revision before editing.', 'TIMELINE_REVISION_CONFLICT');
  range(input.startFrame, input.endFrame, Math.floor(MAX_TIMELINE_SECONDS * checked.frameRate.numerator / checked.frameRate.denominator));
  for (const trackId of trackIds) if (!checked.tracks.some((track) => track.id === trackId)) fail('Selection track does not exist.');
  for (const itemId of input.itemIds) {
    const item = checked.items.find((candidate) => candidate.id === itemId);
    if (!item || !trackIds.has(item.trackId) || item.endFrame <= input.startFrame || item.startFrame >= input.endFrame) fail('Selection item must intersect the selected tracks and frame range.');
  }
  return clone(input);
}

const api = { TIMELINE_SCHEMA_VERSION, MAX_TIMELINE_SECONDS, MAX_TIMELINE_FRAMES,
  MAX_TIMELINE_TRACKS, MAX_TIMELINE_ITEMS, MAX_TIMELINE_OPERATIONS,
  createTimelineDocument, validateTimelineDocument, validateTimelineSelection,
  validateTimelineOperations, applyTimelineOperations };

if (typeof module === 'object' && module.exports) module.exports = api;
else root.EaselVideoTimeline = api;
})(globalThis);
