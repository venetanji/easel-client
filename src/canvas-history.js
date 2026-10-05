'use strict';

const { projectSnapshot } = require('./canvas-project');
const TEMPLATE_CREATION_BOUNDARY = 'Undo stops here because a template was added. Your earlier history is kept, but source Undo cannot cross this boundary. Later source edits can still be undone; timeline Undo is separate.';
const BOUNDARY_BYTES = Buffer.byteLength(TEMPLATE_CREATION_BOUNDARY, 'utf8');

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;
const MAX_PER_CANVAS = 10;
const CANVAS_ID_PATTERN = /^[a-f0-9]{32}$/;

function createCanvasHistory(options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries >= 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const histories = new Map();
  const entries = [];
  let totalBytes = 0;

  function removeEntry(entry) {
    if (!entries.includes(entry)) return;
    const canvasEntries = histories.get(entry.id);
    const canvasIndex = canvasEntries ? canvasEntries.indexOf(entry) : -1;
    if (canvasIndex !== -1) {
      canvasEntries.splice(canvasIndex, 1);
      if (canvasEntries.length === 0) histories.delete(entry.id);
    }

    const globalIndex = entries.indexOf(entry);
    if (globalIndex !== -1) entries.splice(globalIndex, 1);
    totalBytes -= entry.bytes;
  }

  function canRecord(id, html, recovery = null) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id) || typeof html !== 'string') return false;
    return maxEntries > 0 && Buffer.byteLength(html, 'utf8') + (recovery === null ? 0 : Buffer.byteLength(JSON.stringify(recovery), 'utf8')) <= maxBytes;
  }

  function record(id, html, recovery = null) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id) || typeof html !== 'string') return false;

    const recoveryText = recovery === null ? '' : JSON.stringify(recovery);
    const bytes = Buffer.byteLength(html, 'utf8') + Buffer.byteLength(recoveryText, 'utf8');
    if (bytes > maxBytes || maxEntries === 0) {
      clear(id);
      return false;
    }

    let canvasEntries = histories.get(id);
    if (!canvasEntries?.at(-1)?.boundary && canvasEntries?.at(-1)?.html === html && canvasEntries.at(-1).recoveryText === recoveryText) return false;

    while (entries.length >= maxEntries || totalBytes + bytes > maxBytes) {
      removeEntry(entries[0]);
    }

    canvasEntries = histories.get(id);
    if (!canvasEntries) {
      canvasEntries = [];
      histories.set(id, canvasEntries);
    }

    const entry = { id, html, bytes, recoveryText };
    canvasEntries.push(entry);
    entries.push(entry);
    totalBytes += bytes;

    if (canvasEntries.length > MAX_PER_CANVAS) removeEntry(canvasEntries[0]);
    return true;
  }

  function canRecordBoundary(id) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id)) return false;
    const entry = histories.get(id)?.at(-1);
    return !entry || Boolean(entry.boundary) || totalBytes + BOUNDARY_BYTES <= maxBytes;
  }

  function recordBoundary(id) {
    if (!canRecordBoundary(id)) return false;
    const entry = histories.get(id)?.at(-1);
    // Annotate the newest pre-creation entry instead of appending/evicting a
    // snapshot. Every earlier entry and its recovery data stays exactly intact.
    // With no older history there is nothing for source Undo to cross.
    if (entry && !entry.boundary) {
      entry.boundary = true;
      entry.bytes += BOUNDARY_BYTES;
      totalBytes += BOUNDARY_BYTES;
    }
    return true;
  }

  function assertNoBoundary(entry) {
    if (entry.boundary) throw Object.assign(new Error(TEMPLATE_CREATION_BOUNDARY), { code: 'UNDO_TEMPLATE_BOUNDARY' });
  }

  function getUndoState(id) {
    const canvasEntries = typeof id === 'string' && CANVAS_ID_PATTERN.test(id) ? histories.get(id) : null;
    const entry = canvasEntries?.at(-1);
    return { undoAvailable: Boolean(entry && !entry.boundary), undoHistoryEntries: canvasEntries?.length || 0,
      ...(entry?.boundary ? { undoBlockedReason: TEMPLATE_CREATION_BOUNDARY } : {}) };
  }

  function undo(id) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id)) return null;
    const canvasEntries = histories.get(id);
    if (!canvasEntries?.length) return null;
    const entry = canvasEntries.at(-1);
    assertNoBoundary(entry);
    if (entry.recoveryText) throw new Error('Use transactional restore for a snapshot with trusted template recovery state.');
    removeEntry(entry);
    return entry.html;
  }

  function restore(id, restoreSnapshot) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id)) return null;
    const entry = histories.get(id)?.at(-1);
    if (!entry) return null;
    assertNoBoundary(entry);
    const result = restoreSnapshot(entry.html, entry.recoveryText ? JSON.parse(entry.recoveryText) : null);
    if (result && typeof result.then === 'function') return result.then((value) => { removeEntry(entry); return value; });
    removeEntry(entry);
    return result;
  }

  function canUndo(id) {
    return getUndoState(id).undoAvailable;
  }

  function clear(id) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id)) return;
    const canvasEntries = histories.get(id);
    if (!canvasEntries) return;
    for (const entry of [...canvasEntries]) removeEntry(entry);
  }

  return { record, undo, restore, canRecord, canUndo, clear, canRecordBoundary, recordBoundary, getUndoState };
}

// Source and host-owned template state form one recoverable Undo operation. No
// identity is ever reconstructed from the editable source snapshot.
function restoreCanvasHistory({ history, canvasStore, instances, afterRestore }, projectId) {
  return history.restore(projectId, (html, recovery) => {
    // Legacy/unmarked snapshots must also preserve every currently bound
    // document. Deletion recovery can restore absent bindings, but cannot remove
    // a different live instance by replacing the whole source project.
    const bindings = [...(instances?.list?.(projectId) || []), ...(recovery?.instances || []).map((saved) => saved.instance)];
    if (bindings.length) {
      const snapshot = projectSnapshot(html);
      if (!snapshot || snapshot.id !== projectId || bindings.some((binding) => !Object.hasOwn(snapshot.files, binding.documentPath))) {
        throw Object.assign(new Error('This source snapshot would remove a bound template document. Undo cannot cross that template creation boundary; the source and earlier history are unchanged.'), { code: 'UNDO_TEMPLATE_BOUNDARY' });
      }
    }
    const before = canvasStore.get(projectId).html;
    // Stored canonical snapshots restore exact authored files. Re-parsing their
    // rendered HTML would normalize unrelated source on each ordinary Undo.
    const restoreSource = (snapshot) => projectSnapshot(snapshot) ? canvasStore.restoreSourceSnapshot(projectId, snapshot) : canvasStore.update(projectId, snapshot, { restoreMetadata: true });
    const saved = restoreSource(html);
    try { if (recovery?.instances?.length) instances.restore(projectId, recovery.instances); }
    catch (cause) {
      try { restoreSource(before); }
      catch (rollbackError) { throw new AggregateError([cause, rollbackError], 'Template Undo could not finish or roll back its source. Recovery history is retained.'); }
      throw cause;
    }
    return afterRestore ? afterRestore(saved) : saved;
  });
}
module.exports = { createCanvasHistory, restoreCanvasHistory };
