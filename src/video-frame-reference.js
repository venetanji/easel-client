const { isMediaBase64 } = require('./media-base64');
const { throwIfAborted } = require('./turn-abort');

const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const MAX_STILL_BYTES = 4 * 1024 * 1024;
const ASSET_ID = /^(?!0+$)(?:[a-f0-9]{32}|[a-f0-9]{64})$/;

function frameOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['assetId', 'projectId', 'position', 'timestampSeconds', 'maxWidth'].includes(key))) throw new Error('Video frame options are invalid.');
  const { assetId, projectId, position, timestampSeconds, maxWidth = 1600 } = input;
  if (!ASSET_ID.test(assetId || '') || projectId !== undefined && !/^[a-f0-9]{32}$/.test(projectId)) throw new Error('Choose valid saved video and project IDs.');
  if (position !== undefined && position !== 'last' || position !== undefined && timestampSeconds !== undefined) throw new Error('Choose only position:last or timestampSeconds; they cannot be combined.');
  if (timestampSeconds !== undefined && (!Number.isFinite(timestampSeconds) || timestampSeconds < 0 || timestampSeconds > 3600)) throw new Error('Video timestamp is invalid; choose between 0 and 3600 seconds.');
  if (!Number.isInteger(maxWidth) || maxWidth < 320 || maxWidth > 1920) throw new Error('Frame maxWidth must be between 320 and 1920.');
  return { assetId, ...(projectId !== undefined ? { projectId } : {}), maxWidth,
    ...(timestampSeconds === undefined ? { position: 'last' } : { timestampSeconds }) };
}

function createManagedVideoSourceResolver({ mediaStore, readMediaReference }) {
  return async ({ assetId, projectId }) => {
    if (assetId.length === 32) {
      try { return await mediaStore.getPlaybackSource(assetId); }
      catch (error) { if (error.code !== 'ENOENT' && !/not found/i.test(error.message)) throw error; }
    }
    const asset = await readMediaReference({ assetId, ...(projectId !== undefined ? { projectId } : {}) });
    if (!['video/mp4', 'video/webm'].includes(asset?.mimeType)) throw new Error('Choose a saved MP4 or WebM video.');
    if (!isMediaBase64(asset.data) || asset.data.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4) throw new Error('Saved video bytes are invalid or exceed 32 MiB.');
    const buffer = Buffer.from(asset.data, 'base64');
    if (!buffer.length || buffer.length > MAX_VIDEO_BYTES || asset.bytes !== undefined && asset.bytes !== buffer.length) throw new Error('Saved video bytes are invalid or exceed 32 MiB.');
    return { id: assetId, mimeType: asset.mimeType, name: asset.name, bytes: buffer.length, buffer };
  };
}

// Runs in the isolated browser with the bundled decoder, never in the open canvas.
async function decodeVideoFrame(url, options) {
  const bunny = globalThis.EaselMediabunny;
  if (!bunny) throw new Error('The offline video decoder is unavailable.');
  const response = await fetch(url);
  if (!response.ok) throw new Error('The saved video could not be read.');
  const data = await response.arrayBuffer();
  if (!data.byteLength || data.byteLength > 32 * 1024 * 1024) throw new Error('Saved video exceeds 32 MiB.');
  const input = new bunny.Input({ source: new bunny.BufferSource(data), formats: [bunny.MP4, bunny.WEBM] });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !await track.canDecode()) throw new Error('This browser cannot decode the saved video codec.');
    const sourceWidth = await track.getDisplayWidth(), sourceHeight = await track.getDisplayHeight();
    if (![sourceWidth, sourceHeight].every(value => Number.isInteger(value) && value > 0 && value <= 16384) || sourceWidth * sourceHeight > 32_000_000) throw new Error('Video dimensions exceed the decoding limit.');
    const duration = await track.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('Video duration exceeds the decoding limit.');
    if (options.timestampSeconds !== undefined && options.timestampSeconds >= duration) throw new Error('Choose a timestamp before the video track ends or use position:last.');
    const scale = Math.min(1, options.maxWidth / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
    const sink = new bunny.CanvasSink(track, { width, height, fit: 'contain', poolSize: 1 });
    // Infinity selects the final presentation sample, independent of audio tails and frame rate.
    const frame = await sink.getCanvas(options.position === 'last' ? Infinity : options.timestampSeconds);
    if (!frame) throw new Error('No video frame exists at the requested timestamp.');
    const dataUrl = frame.canvas.toDataURL('image/jpeg', 0.92);
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > Math.ceil(4 * 1024 * 1024 / 3) * 4 + 23) throw new Error('Extracted image exceeds the 4 MiB limit.');
    return { data: dataUrl.slice('data:image/jpeg;base64,'.length), mimeType: 'image/jpeg', width, height, sourceWidth, sourceHeight, timestampSeconds: frame.timestamp, duration };
  } finally { input.dispose(); }
}

function validateDecodedFrame(result, options, signal) {
  throwIfAborted(signal);
  const invalid = () => { throw new Error('The video decoder returned an invalid or oversized frame.'); };
  if (!result || result.mimeType !== 'image/jpeg' || !isMediaBase64(result.data) || result.data.length > Math.ceil(MAX_STILL_BYTES / 3) * 4) invalid();
  const bytes = Buffer.from(result.data, 'base64');
  if (bytes.length < 4 || bytes.length > MAX_STILL_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) invalid();
  if (![result.width, result.height].every(value => Number.isInteger(value) && value > 0 && value <= options.maxWidth)
    || ![result.sourceWidth, result.sourceHeight].every(value => Number.isInteger(value) && value > 0 && value <= 16384)
    || result.sourceWidth * result.sourceHeight > 32_000_000 || result.width > result.sourceWidth || result.height > result.sourceHeight
    || !Number.isFinite(result.duration) || result.duration <= 0 || result.duration > 3600
    || !Number.isFinite(result.timestampSeconds) || result.timestampSeconds < 0 || result.timestampSeconds >= result.duration
    || options.timestampSeconds !== undefined && (options.timestampSeconds >= result.duration || result.timestampSeconds > options.timestampSeconds + 1e-6)) invalid();
  return bytes.length;
}

module.exports = { MAX_VIDEO_BYTES, MAX_STILL_BYTES, frameOptions, createManagedVideoSourceResolver, decodeVideoFrame, validateDecodedFrame };
