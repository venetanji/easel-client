const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EVENT_TYPES = new Set(['media-job-ready', 'media-job-notification', 'media-job-removed', 'canvas-input-answer', 'canvas-input', 'project-opened', 'project-created', 'project-deleted', 'project-assets', 'canvas']);
const FIELDS = {
  event: ['type', 'jobId', 'projectId', 'chatId', 'canvasId', 'documentPath', 'title', 'documentTitle', 'status', 'text', 'error'],
  job: ['id', 'remoteId', 'name', 'mediaType', 'modelId', 'projectId', 'chatId', 'status', 'progress', 'etaSeconds', 'seconds', 'queuePosition', 'createdAt', 'updatedAt', 'error'],
  request: ['id', 'kind', 'canvasId', 'documentPath', 'chatId', 'question', 'afterSubmit', 'value', 'prompt', 'text', 'status', 'createdAt', 'answeredAt', 'completedAt', 'error', 'actionApplied', 'actionError'],
  origin: ['backend', 'chatId', 'threadId', 'model'],
  asset: ['assetId', 'type', 'name', 'mimeType', 'width', 'height', 'duration', 'bytes'],
  option: ['value', 'label'],
};

function redactText(value) {
  return value.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '[redacted authorization]')
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|client[-_ ]?secret)\s*[:=]\s*["']?[^\s"'&,}]+/gi, '[redacted credential]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted key]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
}

function summary(value, shape) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const clean = {};
  for (const key of FIELDS[shape]) {
    const item = value[key];
    if (typeof item === 'string') clean[key] = redactText(item).slice(0, ['text', 'prompt', 'question', 'error', 'actionError'].includes(key) ? 4000 : 400);
    else if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) clean[key] = item;
  }
  if (['event', 'job', 'request'].includes(shape) && value.origin) clean.origin = summary(value.origin, 'origin');
  if (shape === 'event') {
    if (value.job) clean.job = summary(value.job, 'job');
    if (value.request) clean.request = summary(value.request, 'request');
    if (Array.isArray(value.assetIds)) clean.assetIds = value.assetIds.filter((id) => typeof id === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(id)).slice(0, 128);
  }
  if (shape === 'job' && Array.isArray(value.assets)) clean.assets = value.assets.slice(0, 16).map((asset) => summary(asset, 'asset')).filter(Boolean);
  if (shape === 'request' && Array.isArray(value.options)) clean.options = value.options.slice(0, 12).map((option) => summary(option, 'option')).filter(Boolean);
  if (shape === 'request' && Array.isArray(value.attachments)) clean.attachments = value.attachments.slice(0, 6).map((asset) => summary(asset, 'asset')).filter(Boolean);
  return clean;
}

function cleanEvent(event) {
  if (!EVENT_TYPES.has(event?.type)) throw new Error('Control event type is invalid.');
  // Persist known notification fields rather than arbitrary tool or runtime payloads.
  const clean = summary(event, 'event');
  if (Buffer.byteLength(JSON.stringify(clean)) > 24000) throw new Error('Control event is too large.');
  return clean;
}

function createControlEventStore({ userDataPath, fileSystem = fs, maxEvents = 256 } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1024) throw new Error('Control event capacity must be from 1 to 1024.');
  const filename = path.join(userDataPath, 'control-events.json');
  let state = { nextId: 1, events: [] };
  if (fileSystem.existsSync(filename)) {
    if (fileSystem.statSync?.(filename).size > 28_000_000) throw new Error('Saved control events exceed the storage limit.');
    const saved = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
    if (!Number.isSafeInteger(saved.nextId) || saved.nextId < 1 || !Array.isArray(saved.events)) throw new Error('Saved control events are invalid.');
    const events = saved.events.slice(-maxEvents).map((event) => {
      if (!Number.isSafeInteger(event.eventId) || event.eventId < 1 || event.eventId >= saved.nextId || !Number.isFinite(event.timestamp)) throw new Error('Saved control event identity is invalid.');
      return { ...cleanEvent(event), eventId: event.eventId, timestamp: event.timestamp };
    });
    if (events.some((event, index) => index && event.eventId <= events[index - 1].eventId)) throw new Error('Saved control event order is invalid.');
    state = { nextId: saved.nextId, events };
  }
  function append(event) {
    const clean = cleanEvent(event);
    if (!Number.isSafeInteger(state.nextId + 1)) throw new Error('Control event cursor is exhausted.');
    const entry = { ...clean, eventId: state.nextId, timestamp: Date.now() };
    const next = { nextId: state.nextId + 1, events: [...state.events, entry].slice(-maxEvents) };
    fileSystem.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
    fileSystem.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    try { fileSystem.renameSync(temporary, filename); }
    catch (error) { fileSystem.rmSync(temporary, { force: true }); throw error; }
    state = next;
    return structuredClone(entry);
  }
  function read({ after = 0, limit = 30 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Use a non-negative event cursor and a limit from 1 to 50.');
    const available = state.events.filter((event) => event.eventId > after);
    const events = [];
    let bytes = 0;
    for (const event of available.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 48000 && events.length) break;
      events.push(structuredClone(event));
      bytes += size;
    }
    return { events, nextCursor: events.at(-1)?.eventId || after, hasMore: events.length < available.length,
      gap: Boolean(state.events.length && after && after < state.events[0].eventId - 1), delivery: 'Saved locally across app restarts. Read once after a notification or at the beginning of a turn; do not poll.' };
  }
  return { append, read, getCursor: () => state.nextId - 1 };
}

module.exports = { createControlEventStore };
