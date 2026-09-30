const { mediaJobSummary, TERMINAL } = require('./media-job-store');
const { handleMcpResult } = require('./agent');
const { createMediaMcpClient } = require('./media-mcp-client');
const { defaultMcpLaunchOptions } = require('./chat-service');
const { createMediaJobWorkerClient } = require('./media-job-worker-client');
const { generatedMediaName } = require('./media-names');

function createMediaJobMonitor({ store, settingsStore, mediaAssetStore, attachAssets, enrichAssets, onEvent, onReady,
  runtime = {}, mcpFactory = createMediaMcpClient, workerFactory = createMediaJobWorkerClient, now = Date.now, intervalMs = 5000 }) {
  let timer;
  let running = false;
  let stopped = true;
  let work = Promise.resolve();
  let worker;
  const isolated = mcpFactory === createMediaMcpClient && Boolean(runtime.userDataPath);
  const removed = new Set();
  const emit = (entry) => onEvent?.({ type: 'media-job', job: mediaJobSummary(entry) });
  function track(input) {
    const entry = store.track(input);
    emit(entry);
    return mediaJobSummary(entry);
  }
  function launch(entry) {
    const settings = settingsStore.loadPublic();
    const connection = settings.connections?.find((item) => entry.modelId.startsWith(item.id + ':'));
    if (!connection || connection.baseUrl !== entry.baseUrl) throw new Error('The original endpoint is missing or changed. Restore it to retrieve this job; its ID is still saved.');
    const model = { connectionId: connection.id, model: entry.modelId.slice(connection.id.length + 1), enabled: true, roles: ['media'], mediaTypes: [entry.mediaType] };
    const secrets = { connectionKeys: { [connection.id]: settingsStore.loadSecrets(connection.id).litellmApiKey } };
    return defaultMcpLaunchOptions({ ...settings, models: [model] }, secrets, runtime);
  }
  async function finishDownload(entry, result) {
    if (removed.has(entry.id)) return;
    let index = 0;
    let saveFailure;
    const resumableStore = {
      get: mediaAssetStore.get,
      async save(media) {
        if (saveFailure) throw saveFailure;
        try {
          const current = store.get(entry.id);
          const existing = current.assets[index++];
          if (existing) { await mediaAssetStore.get(existing.assetId); return existing.assetId; }
          const name = generatedMediaName(entry.prompt || entry.name, media.mimeType, index - 1);
          const assetId = await mediaAssetStore.save({ ...media, ...(name ? { name } : {}) });
          if (removed.has(entry.id)) return assetId;
          store.update(entry.id, { downloadComplete: false, assets: [...store.get(entry.id).assets, { assetId, mimeType: media.mimeType, ...(name || media.name ? { name: name || media.name } : {}) }] });
          return assetId;
        } catch (error) { saveFailure = error; throw error; }
      },
    };
    if (result) {
      const saved = JSON.parse(await handleMcpResult(result, resumableStore));
      if (saved.saveErrors?.length || !saved.assets.length) throw new Error(saved.saveErrors?.join(' ') || 'The completed job returned no downloadable media. Its ID is retained.');
      if (removed.has(entry.id)) return;
      store.update(entry.id, { downloadComplete: true });
    }
    if (removed.has(entry.id)) return;
    entry = store.get(entry.id);
    if (typeof enrichAssets === 'function' && !entry.metadataEnriched) {
      try {
        const assets = await enrichAssets(entry.assets, mediaJobSummary(entry));
        if (removed.has(entry.id)) return;
        entry = store.update(entry.id, { assets, metadataEnriched: true });
      } catch {
        // Optional poster metadata must not strand an otherwise completed generation.
        if (removed.has(entry.id)) return;
        entry = store.get(entry.id);
      }
    }
    if (entry.projectId && !entry.attached) {
      const attachment = await attachAssets?.(entry.projectId, entry.assets.map((asset) => asset.assetId));
      if (removed.has(entry.id)) return;
      entry = store.update(entry.id, { attached: true, ...(attachment?.projectDeleted ? { projectId: '', notification: 'interrupted' } : {}) });
    }
    entry = store.update(entry.id, { status: 'ready', progress: 100, error: '', completedAt: now() });
    emit(entry);
    await onReady?.(mediaJobSummary(entry));
  }
  async function poll(entry) {
    if (removed.has(entry.id)) return;
    let mcp;
    try {
      if (entry.assets.length && entry.downloadComplete !== false) return await finishDownload(entry);
      const launchOptions = launch(entry);
      let result;
      if (isolated) {
        worker ||= workerFactory({ userDataPath: runtime.userDataPath });
        result = await worker.poll({ id: entry.id, remoteId: entry.remoteId, modelId: entry.modelId, mediaType: entry.mediaType, prompt: entry.prompt, name: entry.name, assets: entry.assets }, launchOptions, (asset) => {
          if (removed.has(entry.id)) return false;
          const current = store.get(entry.id);
          if (!current.assets.some((saved) => saved.assetId === asset.assetId)) store.update(entry.id, { downloadComplete: false, assets: [...current.assets, asset] });
          return true;
        });
      } else {
        mcp = await mcpFactory(launchOptions);
        const tool = entry.mediaType === 'video' ? 'get_video' : 'get_image_job';
        const args = entry.mediaType === 'video' ? { model: entry.modelId, videoId: entry.remoteId, includeQueue: true } : { model: entry.modelId, jobId: entry.remoteId };
        result = await mcp.callTool(tool, args);
      }
      if (removed.has(entry.id)) return;
      if (result.isError) throw new Error((result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n') || 'Media job status could not be retrieved.');
      const job = result.structuredContent?.job;
      if (!job || job.id !== entry.remoteId) throw new Error('The status response does not match the saved job ID.');
      const failed = ['failed', 'cancelled'].includes(job.status);
      entry = store.update(entry.id, { status: failed ? 'failed' : job.status === 'completed' ? 'downloading' : 'generating', providerStatus: job.status,
        progress: Number.isFinite(job.progress) ? job.progress : entry.progress,
        queuePosition: job.queuePosition ?? null, queueAhead: job.queueAhead ?? null, estimatedWaitSeconds: job.estimatedWaitSeconds ?? null, estimatedCompletionAt: job.estimatedCompletionAt ?? null,
        error: failed ? job.error || `The service reported ${job.status}.` : '', attempts: 0, nextPollAt: now() + intervalMs });
      emit(entry);
      if (failed) await onReady?.(mediaJobSummary(entry));
      else if (job.status === 'completed') await finishDownload(entry, result);
    } catch (error) {
      if (worker?.failed) { await worker.close().catch(() => {}); worker = undefined; }
      if (removed.has(entry.id)) return;
      const current = store.get(entry.id);
      const attempts = current.attempts + 1;
      emit(store.update(entry.id, { attempts, error: String(error.message || error).slice(0, 1000), nextPollAt: now() + Math.min(60000, intervalMs * 2 ** Math.min(attempts, 4)) }));
    } finally { await mcp?.close().catch(() => {}); }
  }
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      for (const entry of store.list({ pending: true, raw: true }).reverse()) {
        if (stopped) break;
        if (entry.nextPollAt <= now()) await poll(entry);
      }
    } finally { running = false; }
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    const run = () => { if (!running) work = tick().catch((error) => onEvent?.({ type: 'error', message: `Media job monitor: ${error.message}` })); };
    timer = setInterval(run, intervalMs);
    timer.unref?.();
    run();
  }
  async function stop() {
    stopped = true;
    clearInterval(timer);
    await work;
    const closing = worker;
    worker = undefined;
    await closing?.close().catch(() => {});
  }
  function forget(id) { const result = store.remove(id); removed.add(id); worker?.forget?.(id); onEvent?.({ type: 'media-job-removed', jobId: id }); return result; }
  function retry(id) { const entry = store.get(id); if (TERMINAL.has(entry.status)) throw new Error('Only a pending job can retry retrieval.'); const next = store.update(id, { nextPollAt: 0, error: '', attempts: 0 }); emit(next); return mediaJobSummary(next); }
  return { track, start, stop, tick, forget, retry, list: store.list };
}

module.exports = { createMediaJobMonitor };
