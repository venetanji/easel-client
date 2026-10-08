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

  function filename(projectId, timelineId) {
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) throw error('Project ID is invalid.', 'TIMELINE_INVALID');
    if (timelineId !== undefined && (typeof timelineId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(timelineId))) throw error('Timeline ID is invalid.', 'TIMELINE_INVALID');
    return timelineId === undefined ? path.join(directory, `${projectId}.json`) : path.join(directory, projectId, `${timelineId}.json`);
  }
  function readFile(projectId, target, timelineId) {
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
      const saved = validateEnvelope(JSON.parse(raw), projectId);
      if (timelineId !== undefined && saved.document.id !== timelineId) throw new Error('Timeline file identity does not match its location.');
      return saved;
    } catch (cause) {
      const failure = error(`Saved timeline is corrupt or unsupported: ${cause.message}`, 'TIMELINE_CORRUPT');
      failure.cause = cause;
      throw failure;
    }
  }
  function readLegacy(projectId) { return readFile(projectId, filename(projectId)); }
  function list(projectId) {
    filename(projectId);
    const saved = new Map();
    const legacy = readLegacy(projectId);
    if (legacy) saved.set(legacy.document.id, legacy.document);
    let names;
    try { names = fileSystem.readdirSync(path.join(directory, projectId)); }
    catch (cause) { if (cause.code === 'ENOENT') return [...saved.values()]; throw cause; }
    for (const name of names.sort()) {
      if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(name)) continue;
      const id = name.slice(0, -5);
      const envelope = readFile(projectId, filename(projectId, id), id);
      if (envelope) saved.set(id, envelope.document);
    }
    return [...saved.values()];
  }
  function resolveLegacy(projectId) {
    const documents = list(projectId);
    if (documents.length > 1) throw error('This project has multiple timelines. Choose a timeline or template instance.', 'TIMELINE_AMBIGUOUS');
    return documents[0]?.id ?? null;
  }
  function readEnvelope(projectId, timelineId) {
    const id = timelineId === undefined ? resolveLegacy(projectId) : timelineId;
    if (id === null) return null;
    const saved = readFile(projectId, filename(projectId, id), id);
    if (saved) return saved;
    const legacy = readLegacy(projectId);
    return legacy?.document.id === id ? legacy : null;
  }
  function storageFile(projectId, timelineId) {
    const target = filename(projectId, timelineId);
    if (fileSystem.existsSync(target)) return target;
    const legacy = readLegacy(projectId);
    return legacy?.document.id === timelineId ? filename(projectId) : target;
  }
  function writeEnvelope(projectId, value, target = filename(projectId)) {
    const checked = validateEnvelope(value, projectId);
    let content = JSON.stringify(checked);
    // Bound disk/memory growth even for projects with many large snapshots.
    while (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES && (checked.undo.length || checked.redo.length)) {
      if (checked.undo.length) checked.undo.shift();
      else checked.redo.shift();
      content = JSON.stringify(checked);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw error('Timeline exceeds its storage size limit.', 'TIMELINE_INVALID');
    fileSystem.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      fileSystem.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      // Windows requires a writable handle to flush the file with fsync.
      const descriptor = fileSystem.openSync(temporary, 'r+');
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
  function request(projectId, timelineId, input, keys) {
    filename(projectId);
    strictObject(input, keys, 'Timeline request');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw error('Expected timeline revision is invalid.', 'TIMELINE_INVALID');
    const saved = readEnvelope(projectId, timelineId);
    if (!saved) throw error('No timeline exists for this project. Create one first.', 'TIMELINE_NOT_FOUND');
    if (saved.document.revision !== input.expectedRevision) throw error('Timeline revision changed; inspect the current revision and retry the edit.', 'TIMELINE_REVISION_CONFLICT');
    return saved;
  }
  function create(projectId, timelineId, initial = {}) {
    const explicit = typeof timelineId === 'string';
    if (!explicit) { initial = timelineId ?? {}; timelineId = undefined; }
    else if (!PROJECT_ID_PATTERN.test(timelineId)) throw error('New timeline IDs must be 32 lowercase hexadecimal characters.', 'TIMELINE_INVALID');
    return exclusive(projectId, () => {
      if (explicit ? readEnvelope(projectId, timelineId) : resolveLegacy(projectId)) throw error('This timeline already exists.', 'TIMELINE_EXISTS');
      let document;
      if (initial && Object.hasOwn(initial, 'schemaVersion')) {
        document = validateTimelineDocument(initial);
        if (document.revision !== 0) throw error('A new timeline must start at revision zero.', 'TIMELINE_INVALID');
      } else {
        document = createTimelineDocument(initial);
        if (!Object.hasOwn(initial, 'id')) document = validateTimelineDocument({ ...document, id: timelineId ?? idFactory() });
      }
      if (explicit && document.id !== timelineId) throw error('Timeline identity does not match.', 'TIMELINE_INVALID');
      return writeEnvelope(projectId, { schemaVersion: ENVELOPE_SCHEMA_VERSION, projectId, document, undo: [], redo: [] }, filename(projectId, timelineId));
    });
  }
  function apply(projectId, timelineId, input) {
    if (typeof timelineId !== 'string') { input = timelineId; timelineId = undefined; }
    return exclusive(projectId, () => {
      const saved = request(projectId, timelineId, input, ['expectedRevision', 'operations']);
      const { document } = applyTimelineOperations(saved.document, input.operations);
      return writeEnvelope(projectId, { ...saved, document,
        undo: [...saved.undo, saved.document].slice(-MAX_HISTORY), redo: [] }, storageFile(projectId, document.id));
    });
  }
  function restore(projectId, timelineId, input, direction, validateRestore) {
    return exclusive(projectId, () => {
      const saved = request(projectId, timelineId, input, ['expectedRevision']);
      const from = direction === 'undo' ? saved.undo : saved.redo;
      if (!from.length) throw error(`There is nothing to ${direction}.`, 'TIMELINE_HISTORY_EMPTY');
      const document = validateTimelineDocument({ ...from.at(-1), revision: saved.document.revision + 1 });
      validateRestore?.(document);
      const opposite = direction === 'undo' ? 'redo' : 'undo';
      return writeEnvelope(projectId, { ...saved, document, [direction]: from.slice(0, -1),
        [opposite]: [...saved[opposite], saved.document].slice(-MAX_HISTORY) }, storageFile(projectId, document.id));
    });
  }
  function restoreSnapshot(projectId, timelineId, envelope) {
    return exclusive(projectId, () => {
      const checked = validateEnvelope(envelope, projectId);
      if (checked.document.id !== timelineId) throw error('Recovered timeline identity does not match.', 'TIMELINE_INVALID');
      const existing = readEnvelope(projectId, timelineId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(checked)) throw error('The recovered timeline conflicts with current edits. Recovery history is retained.', 'TIMELINE_EXISTS');
        return false;
      }
      writeEnvelope(projectId, checked, filename(projectId, timelineId));
      return true;
    });
  }
  function migrateLegacy(projectId) {
    return exclusive(projectId, () => {
      const legacy = readLegacy(projectId);
      if (!legacy) return null;
      const target = filename(projectId, legacy.document.id);
      let existing;
      try { existing = readFile(projectId, target, legacy.document.id); }
      catch (cause) {
        if (cause.code !== 'TIMELINE_CORRUPT') throw cause;
        // An interrupted unbound migration can be recovered from the validated original.
        // Keep the damaged copy for recovery; never silently discard it.
        fileSystem.renameSync(target, `${target}.${crypto.randomUUID()}.corrupt`);
      }
      if (existing) return existing.document;
      // Keep the original envelope until the separately atomic instance registry commits.
      // Retry discovers this validated copy; it must never reset newer edits or history.
      writeEnvelope(projectId, legacy, target);
      return readFile(projectId, target, legacy.document.id).document;
    });
  }
  function removeFiles(targets) {
    const staged = [];
    try {
      for (const target of targets) {
        const temporary = `${target}.${crypto.randomUUID()}.deleted`;
        try { fileSystem.renameSync(target, temporary); staged.push([target, temporary]); }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
    } catch (cause) {
      for (const [target, temporary] of staged.reverse()) fileSystem.renameSync(temporary, target);
      throw cause;
    }
    // Renames commit logical deletion together. Leftover tombstones are never read.
    for (const [, temporary] of staged) { try { fileSystem.rmSync(temporary, { recursive: true, force: true }); } catch { /* recoverable cleanup only */ } }
    return staged.length > 0;
  }
  function remove(projectId, timelineId) {
    return exclusive(projectId, () => {
      const id = timelineId === undefined ? resolveLegacy(projectId) : timelineId;
      if (id === null) return false;
      const targets = [filename(projectId, id)];
      if (readLegacy(projectId)?.document.id === id) targets.push(filename(projectId));
      return removeFiles(targets);
    });
  }
  function historyAction(direction, projectId, timelineId, input, validateRestore) {
    if (typeof timelineId !== 'string') { validateRestore = input; input = timelineId; timelineId = undefined; }
    return restore(projectId, timelineId, input, direction, validateRestore);
  }
  return {
    create, list, resolveLegacy, readLegacy, migrateLegacy,
    snapshot: (projectId, timelineId) => readEnvelope(projectId, timelineId), restoreSnapshot,
    read: (projectId, timelineId) => readEnvelope(projectId, timelineId)?.document ?? null,
    status: (projectId, timelineId) => {
      const saved = readEnvelope(projectId, timelineId);
      return { undoAvailable: Boolean(saved?.undo.length), redoAvailable: Boolean(saved?.redo.length) };
    },
    apply,
    undo: (projectId, timelineId, input, validateRestore) => historyAction('undo', projectId, timelineId, input, validateRestore),
    redo: (projectId, timelineId, input, validateRestore) => historyAction('redo', projectId, timelineId, input, validateRestore),
    remove,
    removeAll: (projectId) => exclusive(projectId, () => removeFiles([filename(projectId), path.join(directory, projectId)])),
  };
}

module.exports = { createVideoTimelineStore };
