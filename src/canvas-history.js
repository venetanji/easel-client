'use strict';

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

  function record(id, html) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id) || typeof html !== 'string') return false;

    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > maxBytes || maxEntries === 0) {
      clear(id);
      return false;
    }

    let canvasEntries = histories.get(id);
    if (canvasEntries?.at(-1)?.html === html) return false;

    while (entries.length >= maxEntries || totalBytes + bytes > maxBytes) {
      removeEntry(entries[0]);
    }

    canvasEntries = histories.get(id);
    if (!canvasEntries) {
      canvasEntries = [];
      histories.set(id, canvasEntries);
    }

    const entry = { id, html, bytes };
    canvasEntries.push(entry);
    entries.push(entry);
    totalBytes += bytes;

    if (canvasEntries.length > MAX_PER_CANVAS) removeEntry(canvasEntries[0]);
    return true;
  }

  function undo(id) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id)) return null;
    const canvasEntries = histories.get(id);
    if (!canvasEntries?.length) return null;
    const entry = canvasEntries.at(-1);
    removeEntry(entry);
    return entry.html;
  }

  function canUndo(id) {
    return typeof id === 'string' && CANVAS_ID_PATTERN.test(id) && (histories.get(id)?.length ?? 0) > 0;
  }

  function clear(id) {
    if (typeof id !== 'string' || !CANVAS_ID_PATTERN.test(id)) return;
    const canvasEntries = histories.get(id);
    if (!canvasEntries) return;
    for (const entry of [...canvasEntries]) removeEntry(entry);
  }

  return { record, undo, canUndo, clear };
}

module.exports = { createCanvasHistory };
