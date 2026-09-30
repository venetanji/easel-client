const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID = /^[a-f0-9]{32}$/;
const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const TERMINAL = new Set(['ready', 'failed']);

function mediaJobSummary(entry) {
  const { turnOptions, approvedAgent, baseUrl, ...summary } = entry;
  return summary;
}

function createMediaJobStore({ userDataPath, fileSystem = fs, now = Date.now }) {
  const directory = path.join(userDataPath, 'media-jobs');
  function filename(id) {
    if (!ID.test(id || '')) throw new Error('Media job ID is invalid.');
    return path.join(directory, id + '.json');
  }
  function validate(entry) {
    filename(entry?.id);
    if (!REMOTE_ID.test(entry.remoteId || '') || !['image', 'video', 'audio'].includes(entry.mediaType)) throw new Error('Saved media job identity is invalid.');
    if (typeof entry.modelId !== 'string' || !entry.modelId || entry.modelId.length > 320) throw new Error('Saved media job model is invalid.');
    const url = new URL(entry.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Saved media job endpoint is invalid.');
    if (entry.chatId && !ID.test(entry.chatId) || entry.projectId && !ID.test(entry.projectId)) throw new Error('Saved media job destination is invalid.');
    if (!['queued', 'generating', 'downloading', 'ready', 'failed'].includes(entry.status) || !Array.isArray(entry.assets) || entry.assets.length > 16 || entry.assets.some((asset) => !ID.test(asset.assetId || '') || typeof asset.mimeType !== 'string')) throw new Error('Saved media job state is invalid.');
    if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.nextPollAt) || !Number.isInteger(entry.attempts) || entry.attempts < 0) throw new Error('Saved media job polling state is invalid.');
    return entry;
  }
  function get(id) {
    const file = filename(id);
    if (fileSystem.statSync(file).size > 96_000) throw new Error('Saved media job is oversized.');
    const entry = validate(JSON.parse(fileSystem.readFileSync(file, 'utf8')));
    if (entry.id !== id) throw new Error('Saved media job identity does not match its file.');
    return entry;
  }
  function list({ projectId, chatId, pending = false, raw = false } = {}) {
    if (!fileSystem.existsSync(directory)) return [];
    const entries = fileSystem.readdirSync(directory).filter((file) => ID.test(file.slice(0, -5)) && file.endsWith('.json')).map((file) => get(file.slice(0, -5)))
      .filter((entry) => (!projectId || entry.projectId === projectId) && (!chatId || entry.chatId === chatId) && (!pending || !TERMINAL.has(entry.status)))
      .sort((a, b) => b.createdAt - a.createdAt);
    return raw ? entries : entries.map(mediaJobSummary);
  }
  function write(entry) {
    validate(entry);
    const text = JSON.stringify(entry);
    if (Buffer.byteLength(text) > 96_000) throw new Error('Media job metadata exceeds its limit.');
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = filename(entry.id);
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    fileSystem.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    try { fileSystem.renameSync(temporary, file); }
    catch (error) { fileSystem.rmSync(temporary, { force: true }); throw error; }
    return entry;
  }
  function track({ job, mediaType, modelId, baseUrl, projectId = '', chatId = '', prompt = '', turnOptions = {}, approvedAgent }) {
    const existing = list({ raw: true }).find((entry) => entry.remoteId === job.id && entry.modelId === modelId && entry.baseUrl === baseUrl);
    if (existing) return existing;
    if (list().length >= 1024) throw new Error('The media job monitor is full. Remove old job records before submitting more.');
    return write({ id: crypto.randomUUID().replaceAll('-', ''), remoteId: job.id, modelId, baseUrl, mediaType, projectId, chatId,
      prompt: String(prompt).slice(0, 2000), name: prompt ? String(prompt).replace(/\s+/g, ' ').slice(0, 80) : `Generated ${mediaType}`,
      status: ['failed', 'cancelled'].includes(job.status) ? 'failed' : 'queued', providerStatus: job.status,
      progress: Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : 0,
      assets: [], attempts: 0, nextPollAt: now(), createdAt: now(), updatedAt: now(), notification: 'pending',
      turnOptions, ...(approvedAgent ? { approvedAgent } : {}), ...(job.error ? { error: String(job.error).slice(0, 1000) } : {}) });
  }
  function update(id, changes) { return write({ ...get(id), ...changes, id, updatedAt: now() }); }
  function remove(id) { get(id); fileSystem.unlinkSync(filename(id)); return { id, deleted: true }; }
  return { get, list, track, update, remove };
}

module.exports = { createMediaJobStore, mediaJobSummary, TERMINAL };
