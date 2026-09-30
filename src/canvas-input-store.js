const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canvasInputSummary, inputId, validateCanvasInputRequest, validateCanvasInputSubmission } = require('./canvas-input');
const { validateChatOptions, validateDocumentPath } = require('./ipc-contract');
const { validateInteractionOrigin } = require('./interaction-origin');

const RETRYABLE_STATUSES = new Set(['answered', 'queued', 'failed', 'interrupted']);

function validateApprovedMediaModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The approved capture model is required. Share the capture again to confirm its destination.');
  if (value.backend === 'external') {
    if (Object.keys(value).some((key) => key !== 'backend')) throw new Error('An external capture destination accepts its backend only.');
    return { backend: 'external' };
  }
  if (value.backend === 'codex') {
    if (Object.keys(value).some((key) => !['backend', 'model'].includes(key))) throw new Error('A Codex capture destination accepts its backend and model only.');
    const approved = validateInteractionOrigin(value);
    if (!approved.model) throw new Error('The approved Codex capture model is required.');
    return approved;
  }
  if (value.backend !== undefined && value.backend !== 'builtin' || Object.keys(value).some((key) => !['backend', 'connectionId', 'model', 'baseUrl'].includes(key))) throw new Error('The approved capture model is required. Share the capture again to confirm its destination.');
  const connectionId = inputId(value.connectionId, 'Approved model endpoint ID');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256) throw new Error('The approved capture model is invalid. Share the capture again.');
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048) throw new Error('The approved capture endpoint is invalid.');
  let url;
  try { url = new URL(value.baseUrl); } catch { throw new Error('The approved capture endpoint is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('The approved capture endpoint must be HTTP(S) without embedded credentials or query parameters.');
  return { ...(value.backend ? { backend: 'builtin' } : {}), connectionId, model: value.model.trim(), baseUrl: url.href.replace(/\/+$/, '') };
}

function createCanvasInputStore({ userDataPath, fileSystem = fs, idFactory = () => crypto.randomUUID().replaceAll('-', '') }) {
  const directory = path.join(userDataPath, 'canvas-inputs');
  function filename(id) { return path.join(directory, `${inputId(id, 'Input request ID')}.json`); }
  function write(entry, { create = false } = {}) {
    if (entry.origin !== undefined) entry = { ...entry, origin: validateInteractionOrigin(entry.origin) };
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = filename(entry.id);
    if (create && fileSystem.existsSync(target)) throw new Error('Input request ID already exists.');
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    fileSystem.writeFileSync(temporary, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fileSystem.renameSync(temporary, target); } catch (error) { fileSystem.rmSync(temporary, { force: true }); throw error; }
    return JSON.parse(JSON.stringify(entry));
  }
  function get(id) {
    const entry = JSON.parse(fileSystem.readFileSync(filename(id), 'utf8'));
    if (entry.id !== id || !['choice', 'media'].includes(entry.kind)) throw new Error('Saved canvas input is invalid.');
    inputId(entry.canvasId, 'Canvas ID');
    inputId(entry.chatId, 'Chat ID');
    if (entry.origin !== undefined) entry.origin = validateInteractionOrigin(entry.origin);
    return entry;
  }
  function list({ canvasId, chatId, status, limit = 50, raw = false } = {}) {
    if (canvasId !== undefined) inputId(canvasId, 'Canvas ID');
    if (chatId !== undefined) inputId(chatId, 'Chat ID');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Canvas input list limit must be 1 to 200.');
    if (!fileSystem.existsSync(directory)) return [];
    const statuses = status === undefined ? null : new Set(Array.isArray(status) ? status : [status]);
    const entries = fileSystem.readdirSync(directory).filter((file) => /^[a-f0-9]{32}\.json$/.test(file)).map((file) => get(file.slice(0, -5)))
      .filter((entry) => (!canvasId || entry.canvasId === canvasId) && (!chatId || entry.chatId === chatId) && (!statuses || statuses.has(entry.status)))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    return raw ? entries : entries.map(canvasInputSummary);
  }
  function turnOptions(options) {
    const { mode, size, skills, kits } = validateChatOptions(options || {});
    return { mode, size, skills, kits };
  }
  function create({ canvasId, documentPath, chatId, question, options, afterSubmit, turnOptions: optionsForTurn, origin }) {
    inputId(canvasId, 'Canvas ID');
    inputId(chatId, 'Chat ID');
    if (documentPath !== undefined) validateDocumentPath(documentPath);
    if (list({ canvasId, status: 'pending', limit: 200, raw: true }).some((entry) => (entry.documentPath || '') === (documentPath || ''))) throw new Error('This document already has an unanswered request.');
    const request = validateCanvasInputRequest({ question, options, afterSubmit });
    return write({ id: inputId(idFactory(), 'Input request ID'), kind: 'choice', canvasId, ...(documentPath ? { documentPath } : {}), chatId, ...request, ...(origin === undefined ? {} : { origin: validateInteractionOrigin(origin) }), turnOptions: turnOptions(optionsForTurn), status: 'pending', createdAt: Date.now() }, { create: true });
  }
  function createMedia({ canvasId, documentPath, chatId, prompt = '', attachments, approvedModel, turnOptions: optionsForTurn, origin }) {
    inputId(canvasId, 'Canvas ID');
    inputId(chatId, 'Chat ID');
    if (documentPath !== undefined) validateDocumentPath(documentPath);
    if (typeof prompt !== 'string' || prompt.length > 20_000) throw new Error('Canvas media prompt is invalid.');
    if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > 6) throw new Error('Share 1 to 6 canvas media assets.');
    const assets = attachments.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['assetId', 'type', 'name', 'mimeType'].includes(key))) throw new Error('Canvas media asset reference is invalid.');
      inputId(item.assetId, 'Media asset ID');
      if (!(item.type === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType)) && !(item.type === 'audio' && ['audio/wav', 'audio/mpeg'].includes(item.mimeType))) throw new Error('Canvas media format is unsupported.');
      if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160) throw new Error('Canvas media name is invalid.');
      return { assetId: item.assetId, type: item.type, name: item.name.trim(), mimeType: item.mimeType };
    });
    return write({ id: inputId(idFactory(), 'Input request ID'), kind: 'media', canvasId, ...(documentPath ? { documentPath } : {}), chatId, prompt: prompt.trim(), attachments: assets, approvedModel: validateApprovedMediaModel(approvedModel), ...(origin === undefined ? {} : { origin: validateInteractionOrigin(origin) }), turnOptions: turnOptions(optionsForTurn), status: 'queued', createdAt: Date.now(), answeredAt: Date.now() }, { create: true });
  }
  function submit(input) {
    const { requestId, canvasId, documentPath, value } = validateCanvasInputSubmission(input);
    const entry = get(requestId);
    if (entry.kind !== 'choice' || entry.canvasId !== canvasId || (entry.documentPath && entry.documentPath !== documentPath)) throw new Error('This input request belongs to another canvas.');
    if (entry.status !== 'pending') throw new Error('This input request was already answered or is no longer active.');
    if (!entry.options.some((option) => option.value === value)) throw new Error('Choose one of the declared canvas options.');
    // Persist before the host clears UI or resets app state.
    return write({ ...entry, value, status: 'answered', answeredAt: Date.now() });
  }
  function update(id, changes) { return write({ ...get(id), ...changes, id }); }
  function beginDispatch(id) {
    const entry = get(id);
    if (!RETRYABLE_STATUSES.has(entry.status)) throw new Error('This canvas response is not ready to resume.');
    return update(id, { status: 'dispatching', error: '', dispatchedAt: Date.now() });
  }
  function complete(id) { return update(id, { status: 'completed', completedAt: Date.now(), error: '' }); }
  function fail(id, error) { return update(id, { status: 'failed', error: String(error?.message || error).slice(0, 1000) }); }
  function interrupt(id, reason = 'The application closed during this response. Retry explicitly to continue; previous tool effects may already have occurred.') { return update(id, { status: 'interrupted', error: String(reason).slice(0, 1000) }); }
  function cancel(id, reason) {
    const entry = get(id);
    if (entry.status !== 'pending') throw new Error('Only an unanswered request can be cancelled.');
    return update(id, { status: 'cancelled', error: String(reason).slice(0, 1000) });
  }
  function markActionApplied(id) { return update(id, { actionApplied: true, actionError: '' }); }
  function markActionError(id, error) { return update(id, { actionError: String(error?.message || error).slice(0, 1000) }); }
  return { create, createMedia, get, list, submit, beginDispatch, complete, fail, interrupt, cancel, markActionApplied, markActionError };
}

module.exports = { createCanvasInputStore, validateApprovedMediaModel };
