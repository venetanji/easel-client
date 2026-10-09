const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function enrichAudioDownload(result, { model, trackId }, client, { track, checkActive = () => {} } = {}) {
  if (result.isError || !result.content?.some(item => item.type === 'audio' || item.type === 'resource' && item.resource?.mimeType?.startsWith('audio/'))) return result;
  const received = result.structuredContent?.audio?.track || result.structuredContent?.track || {};
  const titleOf = metadata => typeof metadata?.title === 'string' ? metadata.title.trim() : '';
  const receivedId = received.id || received.song_id;
  if (receivedId && receivedId !== trackId) throw new Error('The audio download does not match the requested track UUID.');
  if (!track && !titleOf(received)) {
    checkActive();
    let inspected;
    try { inspected = await client.callTool('get_audio_track', { model, trackId }); }
    catch { /* Audio remains downloadable when title lookup is unavailable. */ }
    checkActive();
    if (inspected && !inspected.isError) {
      const metadata = inspected.structuredContent?.audio || inspected.structuredContent;
      track = metadata?.track || metadata;
      const inspectedId = track?.id || track?.song_id;
      if (inspectedId && inspectedId !== trackId) throw new Error('Audio title metadata does not match the requested track UUID.');
    }
  }
  const title = titleOf(received) || titleOf(track) || `Untitled song ${trackId.slice(0, 8)}`;
  return { ...result, structuredContent: { ...result.structuredContent,
    audio: { ...result.structuredContent?.audio, modelId: model, trackId, monitored: false,
      track: { ...track, ...received, title } } } };
}

async function registerAudioTrackJobs(result, { model, prompt = '', projectId = '' }, register) {
  if (result.isError || typeof register !== 'function' || result.structuredContent?.monitoredAudioJobs) return result;
  const receipt = result.structuredContent?.audio || result.structuredContent;
  const songs = Array.isArray(receipt?.songs) ? receipt.songs : [];
  const seen = new Set();
  const monitoredAudioJobs = [];
  const monitoringErrors = [];
  for (const song of songs.slice(0, 16)) {
    if (!UUID.test(song?.id || '') || seen.has(song.id)) continue;
    seen.add(song.id);
    try {
      const saved = await register({ job: { id: song.id, modelId: model, status: song.status || 'submitted' }, modelId: model,
        mediaType: 'audio', projectId, prompt: song.title || prompt });
      if (saved) {
        const fields = ['id', 'remoteId', 'modelId', 'mediaType', 'projectId', 'status'];
        monitoredAudioJobs.push(Object.fromEntries(fields.filter(field => saved[field] !== undefined).map(field => [field, saved[field]])));
      }
    } catch (error) { monitoringErrors.push(`Track ${song.id}: ${error.message}. Keep this ID; do not regenerate.`); }
  }
  return !seen.size ? result : { ...result, structuredContent: { ...result.structuredContent, monitoredAudioJobs, ...(monitoringErrors.length ? { monitoringErrors } : {}) } };
}

async function retrieveAudioTrackJob(client, entry, { checkActive = () => {} } = {}) {
  checkActive();
  const args = { model: entry.modelId, trackId: entry.remoteId };
  const response = await client.callTool('get_audio_track', args);
  checkActive();
  if (response.isError) return response;
  const track = response.structuredContent;
  if ((track?.id || track?.song_id) !== entry.remoteId) throw new Error('The audio track response does not match the saved track UUID.');
  const status = track.status === 'complete' || track.status === 'completed' ? 'completed'
    : ['failed', 'error', 'cancelled'].includes(track.status) ? 'failed' : 'in_progress';
  const job = { id: entry.remoteId, modelId: entry.modelId, status, ...(track.error ? { error: track.error } : {}), ...(track.duration ? { seconds: track.duration } : {}) };
  if (status !== 'completed') return { content: [], structuredContent: { job } };
  const downloaded = await client.callTool('download_audio', args);
  checkActive();
  if (downloaded.isError) return downloaded;
  const enriched = await enrichAudioDownload(downloaded, args, client, { track, checkActive });
  return { ...enriched, structuredContent: { ...enriched.structuredContent, job,
    audio: { ...enriched.structuredContent.audio, monitored: true } } };
}

async function managedAudioTrackResult(entry, mediaAssetStore) {
  if (entry.status === 'ready') {
    if (!entry.assets?.length) return undefined;
    try { for (const asset of entry.assets) await mediaAssetStore.get(asset.assetId); }
    catch { return undefined; }
  }
  const fields = ['id', 'remoteId', 'modelId', 'mediaType', 'projectId', 'status'];
  const monitoredJob = Object.fromEntries(fields.filter(field => entry[field] !== undefined).map(field => [field, entry[field]]));
  return { content: [], structuredContent: {
    audio: { modelId: entry.modelId, trackId: entry.remoteId, monitored: ['queued', 'generating', 'downloading'].includes(entry.status),
      track: { id: entry.remoteId, status: entry.status === 'ready' ? 'complete' : entry.status } },
    monitoredAudioJobs: [monitoredJob],
    ...(entry.status === 'ready' ? { assets: entry.assets, cached: true, projectAttachment: { ok: Boolean(entry.attached && entry.projectId), projectId: entry.projectId } } : {}),
  } };
}

module.exports = { registerAudioTrackJobs, retrieveAudioTrackJob, managedAudioTrackResult, enrichAudioDownload };
