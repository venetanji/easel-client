const crypto = require('node:crypto');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { createMediaMcpClient } = require('./media-mcp-client');
const { createAssetStore } = require('./asset-store');
const { createCanvasMediaStore } = require('./canvas-media-store');
const { handleMcpResult } = require('./agent');
const { generatedMediaName } = require('./media-names');
const { retrieveAudioTrackJob } = require('./audio-track-jobs');

function createMediaJobWorkerRuntime({ userDataPath, mcpFactory = createMediaMcpClient, mediaAssetStore, checkpoint, isRemoved = () => false }) {
  const images = mediaAssetStore ? undefined : createAssetStore({ userDataPath });
  const captures = mediaAssetStore ? undefined : createCanvasMediaStore({ userDataPath });
  const assets = mediaAssetStore || {
    save: (media) => media.mimeType?.startsWith('image/') ? images.save(media) : captures.save(media),
    get: async (id) => { try { return await images.get(id); } catch { return captures.get(id); } },
  };
  const connections = new Map();
  async function connection(options) {
    const key = crypto.createHash('sha256').update(JSON.stringify(options)).digest('hex');
    if (connections.has(key)) return { key, client: connections.get(key) };
    // Keep a few endpoints warm, avoiding a new executable launch on every poll.
    if (connections.size >= 4) {
      const [oldKey, oldClient] = connections.entries().next().value;
      connections.delete(oldKey);
      await oldClient.close().catch(() => {});
    }
    const client = await mcpFactory(options);
    connections.set(key, client);
    return { key, client };
  }
  async function poll(entry, options) {
    const checkRemoved = () => { if (isRemoved(entry.id)) throw new Error('The job was removed before its output could be saved.'); };
    checkRemoved();
    const { key, client } = await connection(options);
    let result;
    try {
      const tool = entry.mediaType === 'video' ? 'get_video' : 'get_image_job';
      const args = entry.mediaType === 'video' ? { model: entry.modelId, videoId: entry.remoteId, includeQueue: true } : { model: entry.modelId, jobId: entry.remoteId };
      result = entry.mediaType === 'audio' ? await retrieveAudioTrackJob(client, entry, { checkActive: checkRemoved }) : await client.callTool(tool, args);
    } catch (error) {
      connections.delete(key);
      await client.close().catch(() => {});
      throw error;
    }
    checkRemoved();
    if (result.isError) return result;
    const job = result.structuredContent?.job;
    if (!job || job.id !== entry.remoteId) throw new Error('The status response does not match the saved job ID.');
    if (job.status !== 'completed') return { structuredContent: { job }, content: [] };
    let index = 0;
    let saveFailure;
    const names = [];
    const resumableStore = {
      get: assets.get,
      async save(media) {
        // Checkpoint a contiguous prefix so a partial multi-image download can resume safely.
        if (saveFailure) throw saveFailure;
        try {
          checkRemoved();
          const existing = entry.assets[index++];
          const name = existing?.name || (entry.mediaType === 'audio' && media.name ? media.name : generatedMediaName(entry.prompt || entry.name, media.mimeType, index - 1)) || media.name;
          names.push(name);
          if (existing) { await assets.get(existing.assetId); return existing.assetId; }
          const assetId = await assets.save({ ...media, ...(name ? { name } : {}) });
          await checkpoint({ assetId, mimeType: media.mimeType, ...(name ? { name } : {}), ...(media.duration ? { duration: media.duration } : {}) });
          return assetId;
        } catch (error) { saveFailure = error; throw error; }
      },
    };
    // Decode, validate and write media here; only compact references cross to Electron.
    const saved = JSON.parse(await handleMcpResult(result, resumableStore));
    if (saved.saveErrors?.length || !saved.assets.length) throw new Error(saved.saveErrors?.join(' ') || 'The completed job returned no downloadable media. Its ID is retained.');
    return { structuredContent: { job, assets: saved.assets.map((asset, item) => ({ ...asset, ...(names[item] ? { name: names[item] } : {}) })) }, content: [] };
  }
  async function close() {
    await Promise.allSettled([...connections.values()].map((client) => client.close()));
    connections.clear();
  }
  return { poll, close };
}

if (!isMainThread) {
  const acknowledgments = new Map();
  const removed = new Set();
  let sequence = 0;
  let requestId;
  let work = Promise.resolve();
  const runtime = createMediaJobWorkerRuntime({ userDataPath: workerData.userDataPath, isRemoved: (id) => removed.has(id),
    checkpoint: (asset) => new Promise((resolve, reject) => {
      const checkpointId = ++sequence;
      acknowledgments.set(checkpointId, { resolve, reject });
      parentPort.postMessage({ type: 'checkpoint', id: requestId, checkpointId, asset });
    }),
  });
  parentPort.on('message', (message) => {
    if (message.type === 'forget') { removed.add(message.jobId); return; }
    if (message.type === 'checkpoint-result') {
      const pending = acknowledgments.get(message.checkpointId);
      acknowledgments.delete(message.checkpointId);
      if (message.ok) pending?.resolve();
      else pending?.reject(new Error(message.error || 'The job was removed before its output could be attached.'));
      return;
    }
    work = work.then(async () => {
      requestId = message.id;
      try {
        const result = message.type === 'close' ? await runtime.close() : await runtime.poll(message.entry, message.launchOptions);
        parentPort.postMessage({ type: 'result', id: message.id, result });
        if (message.type === 'close') parentPort.close();
      } catch (error) {
        parentPort.postMessage({ type: 'result', id: message.id, error: String(error.message || error).slice(0, 2000) });
      }
    });
  });
}

module.exports = { createMediaJobWorkerRuntime };
