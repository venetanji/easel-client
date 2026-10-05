const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTimelineDocument, validateTimelineDocument, applyTimelineOperations } = require('./video-timeline');

const ENVELOPE_SCHEMA_VERSION = 1;
const MAX_HISTORY = 20;
const MAX_FILE_BYTES = 32 * 1_048_576;
const PROJECT_ID_PATTERN = /^[a-f0-9]{32}$/;
// All writers run synchronously in Electron's owning main process. Guard reentrant
// calls too; each independent store instance always rereads the committed revision.
const writing = new Set();

function error(message, code) { return Object.assign(new Error(message), { code }); }
function strictObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw error(`${label} contains missing or unsupported properties.`, 'TIMELINE_INVALID');
  }
}
function validateEnvelope(value, projectId) {
  strictObject(value, ['schemaVersion', 'projectId', 'document', 'undo', 'redo'], 'Timeline file');
  if (value.schemaVersion !== ENVELOPE_SCHEMA_VERSION || value.projectId !== projectId) throw new Error('Timeline file schema or project does not match.');
  const document = validateTimelineDocument(value.document);
  const history = {};
  for (const key of ['undo', 'redo']) {
    if (!Array.isArray(value[key]) || value[key].length > MAX_HISTORY) throw new Error('Timeline history exceeds its limit.');
    history[key] = value[key].map((snapshot) => {
      const checked = validateTimelineDocument(snapshot);
      if (checked.id !== document.id || checked.revision > document.revision) throw new Error('Timeline history belongs to an invalid timeline or revision.');
      return checked;
    });
  }
  return { schemaVersion: ENVELOPE_SCHEMA_VERSION, projectId, document, ...history };
}

function createVideoTimelineStore({ userDataPath, fileSystem = fs, idFactory = () => crypto.randomUUID().replaceAll('-', '') }) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new Error('Timeline storage requires a user data path.');
  const directory = path.join(userDataPath, 'video-timelines');

  function filename(projectId) {
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) throw error('Project ID is invalid.', 'TIMELINE_INVALID');
    return path.join(directory, `${projectId}.json`);
  }
  function readEnvelope(projectId) {
    const target = filename(projectId);
    let raw;
    try {
      if (fileSystem.statSync(target).size > MAX_FILE_BYTES) throw error('Timeline file exceeds its size limit.', 'TIMELINE_CORRUPT');
      raw = fileSystem.readFileSync(target, 'utf8');
    } catch (cause) {
      if (cause.code === 'ENOENT') return null;
      throw cause;
    }
    try {
      if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) throw new Error('Timeline file exceeds its size limit.');
      return validateEnvelope(JSON.parse(raw), projectId);
    } catch (cause) {
      const failure = error(`Saved timeline is corrupt or unsupported: ${cause.message}`, 'TIMELINE_CORRUPT');
      failure.cause = cause;
      throw failure;
    }
  }
  function writeEnvelope(projectId, value) {
    const checked = validateEnvelope(value, projectId);
    let content = JSON.stringify(checked);
    // Bound disk/memory growth even for projects with many large snapshots.
    while (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES && (checked.undo.length || checked.redo.length)) {
      if (checked.undo.length) checked.undo.shift();
      else checked.redo.shift();
      content = JSON.stringify(checked);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw error('Timeline exceeds its storage size limit.', 'TIMELINE_INVALID');
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = filename(projectId);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      fileSystem.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const descriptor = fileSystem.openSync(temporary, 'r');
      try { fileSystem.fsyncSync(descriptor); } finally { fileSystem.closeSync(descriptor); }
      fileSystem.renameSync(temporary, target);
    } catch (cause) {
      try { fileSystem.rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
      throw cause;
    }
    return checked.document;
  }
  function exclusive(projectId, callback) {
    const target = filename(projectId);
    if (writing.has(target)) throw error('This timeline is already being edited. Try again after the current edit.', 'TIMELINE_BUSY');
    writing.add(target);
    try { return callback(); } finally { writing.delete(target); }
  }
  function request(projectId, input, keys) {
    filename(projectId);
    strictObject(input, keys, 'Timeline request');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw error('Expected timeline revision is invalid.', 'TIMELINE_INVALID');
    const saved = readEnvelope(projectId);
    if (!saved) throw error('No timeline exists for this project. Create one first.', 'TIMELINE_NOT_FOUND');
    if (saved.document.revision !== input.expectedRevision) throw error('Timeline revision changed; inspect the current revision and retry the edit.', 'TIMELINE_REVISION_CONFLICT');
    return saved;
  }
  function create(projectId, initial = {}) {
    return exclusive(projectId, () => {
      if (readEnvelope(projectId)) throw error('This project already has a timeline.', 'TIMELINE_EXISTS');
      let document;
      if (initial && Object.hasOwn(initial, 'schemaVersion')) {
        document = validateTimelineDocument(initial);
        if (document.revision !== 0) throw error('A new timeline must start at revision zero.', 'TIMELINE_INVALID');
      } else {
        // Let the core reject unsupported properties before adding a generated ID.
        document = createTimelineDocument(initial);
        if (!Object.hasOwn(initial, 'id')) document = validateTimelineDocument({ ...document, id: idFactory() });
      }
      return writeEnvelope(projectId, { schemaVersion: ENVELOPE_SCHEMA_VERSION, projectId, document, undo: [], redo: [] });
    });
  }
  function apply(projectId, input) {
    return exclusive(projectId, () => {
      const saved = request(projectId, input, ['expectedRevision', 'operations']);
      const { document } = applyTimelineOperations(saved.document, input.operations);
      return writeEnvelope(projectId, { ...saved, document,
        undo: [...saved.undo, saved.document].slice(-MAX_HISTORY), redo: [] });
    });
  }
  function restore(projectId, input, direction, validateRestore) {
    return exclusive(projectId, () => {
      const saved = request(projectId, input, ['expectedRevision']);
      const from = direction === 'undo' ? saved.undo : saved.redo;
      if (!from.length) throw error(`There is nothing to ${direction}.`, 'TIMELINE_HISTORY_EMPTY');
      const document = validateTimelineDocument({ ...from.at(-1), revision: saved.document.revision + 1 });
      validateRestore?.(document);
      const opposite = direction === 'undo' ? 'redo' : 'undo';
      return writeEnvelope(projectId, { ...saved, document, [direction]: from.slice(0, -1),
        [opposite]: [...saved[opposite], saved.document].slice(-MAX_HISTORY) });
    });
  }
  function remove(projectId) {
    return exclusive(projectId, () => {
      try { fileSystem.unlinkSync(filename(projectId)); return true; }
      catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
    });
  }
  return {
    create,
    read: (projectId) => readEnvelope(projectId)?.document ?? null,
    status: (projectId) => {
      const saved = readEnvelope(projectId);
      return { undoAvailable: Boolean(saved?.undo.length), redoAvailable: Boolean(saved?.redo.length) };
    },
    apply,
    undo: (projectId, input, validateRestore) => restore(projectId, input, 'undo', validateRestore),
    redo: (projectId, input, validateRestore) => restore(projectId, input, 'redo', validateRestore),
    remove,
  };
}

module.exports = { createVideoTimelineStore };
