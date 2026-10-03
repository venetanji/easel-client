const { isMediaBase64 } = require('./media-base64');
const crypto = require('node:crypto');

function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unsupported fields.`);
}
function createVideoTimelineBridge({ controller, assertOrigin, getAssets, getAsset, listLibrary, importMedia, attach, select, saveMedia, onExport, isBusy }) {
  const exports = new Map();
  async function handle(request, scope) {
    record(request, ['action', 'input'], 'Timeline bridge request');
    assertOrigin(scope);
    const { action, input = {} } = request;
    const projectId = scope.projectId;
    if (!['read', 'create', 'apply', 'undo', 'redo', 'history', 'assets', 'asset', 'library', 'attach', 'select', 'import', 'save-export'].includes(action)) throw new Error('Unsupported timeline bridge action.');
    if (['create', 'apply', 'undo', 'redo', 'attach', 'import'].includes(action) && isBusy?.()) throw new Error('Wait for the current agent operation before changing the timeline.');
    if (['read', 'history', 'library'].includes(action)) record(input, [], 'Timeline read');
    if (action === 'read' || action === 'history') return controller[action](projectId);
    if (['create', 'apply', 'undo', 'redo'].includes(action)) return controller[action](projectId, input);
    if (action === 'assets') { record(input, ['offset', 'limit'], 'Media list'); return getAssets(projectId, input); }
    if (action === 'asset') {
      record(input, ['assetId'], 'Media read');
      if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(input.assetId || '')) throw new Error('Managed media ID is invalid.');
      const asset = await getAsset(projectId, input.assetId);
      assertOrigin(scope);
      return asset;
    }
    if (action === 'import') { record(input, [], 'Media import'); const result = await importMedia(projectId); assertOrigin(scope); return result; }
    if (action === 'library') { const result = await listLibrary(); assertOrigin(scope); return result; }
    if (action === 'attach') {
      record(input, ['assetId'], 'Media attachment');
      if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(input.assetId || '')) throw new Error('Managed media ID is invalid.');
      const result = await attach(projectId, [input.assetId]);
      assertOrigin(scope);
      return result;
    }
    if (action === 'select') {
      if (input === null) { select(null, scope); return { ok: true }; }
      const context = controller.resolveSelection(input);
      if (context.selection.projectId !== projectId) throw new Error('Select a range in this project.');
      select(context.selection, scope);
      return { ok: true };
    }
    record(input, ['exportId', 'expectedRevision', 'media'], 'Timeline export');
    if (typeof input.exportId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.exportId)) throw new Error('Export receipt ID is invalid.');
    const current = controller.read(projectId);
    if (!current || current.revision !== input.expectedRevision) throw new Error('The timeline revision changed during export. Inspect the current timeline and export again.');
    const media = input.media;
    record(media, ['data', 'mimeType', 'name', 'width', 'height', 'duration', 'codec', 'includesAudio', 'frames', 'thumbnail', 'timelineDuration', 'frameCount'], 'Export media');
    if (media.mimeType !== 'video/webm' || typeof media.data !== 'string' || !isMediaBase64(media.data) || !media.data.length || media.data.length > Math.ceil(32 * 1024 * 1024 / 3) * 4) throw new Error('Export must be a WebM video no larger than 32 MiB.');
    if (typeof media.includesAudio !== 'boolean' || !Number.isFinite(media.duration) || media.duration <= 0 || media.duration > 61) throw new Error('Export audio/duration metadata is invalid.');
    if (media.timelineDuration !== undefined && (!Number.isFinite(media.timelineDuration) || media.timelineDuration <= 0 || media.timelineDuration > 60)) throw new Error('Export timeline duration is invalid.');
    if (media.frameCount !== undefined && (!Number.isSafeInteger(media.frameCount) || media.frameCount < 1 || media.frameCount > 3600)) throw new Error('Export frame count is invalid.');
    const key = `${projectId}:${current.id}:${scope.runtimeGeneration}:${input.exportId}`;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(media)).digest('hex');
    if (exports.has(key)) {
      const saved = exports.get(key);
      if (saved.fingerprint !== fingerprint) throw new Error('This export receipt was already used for different media.');
      return saved.promise;
    }
    if (exports.size >= 32) {
      const completed = [...exports].find(([, entry]) => entry.complete);
      if (!completed) throw new Error('Too many exports are in progress.');
      exports.delete(completed[0]);
    }
    const entry = { fingerprint, complete: false };
    entry.promise = (async () => {
      assertOrigin(scope);
      const { includesAudio, timelineDuration, frameCount, ...capture } = media;
      const assetId = await saveMedia({ ...capture, scope: { projectId, timelineId: current.id, revision: current.revision, includesAudio, ...(timelineDuration ? { timelineDuration } : {}), ...(frameCount ? { frameCount } : {}), renderer: 'mediabunny-1.61.0' } });
      // Never resave after admission: even attachment failure returns the durable asset receipt.
      let warning = '';
      try { assertOrigin(scope); await attach(projectId, [assetId]); }
      catch (error) { warning = `Video saved to the media library; attach it to the project manually. ${error.message}`; }
      const result = { ok: true, assetId, projectId, mimeType: media.mimeType, name: media.name, includesAudio, ...(warning ? { warning } : {}) };
      onExport?.(result);
      return result;
    })().finally(() => { entry.complete = true; });
    exports.set(key, entry);
    return entry.promise;
  }
  return { handle };
}
module.exports = { createVideoTimelineBridge };
