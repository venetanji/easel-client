const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { generatedMediaName, isGenericGeneratedName } = require('./media-names');
const { MAX_VIDEO_BYTES, frameOptions, decodeVideoFrame, validateDecodedFrame } = require('./video-frame-reference');
const { abortError, awaitAbortable, throwIfAborted } = require('./turn-abort');

const MAX_DECODE_MS = 15_000;
const MAX_THUMBNAIL_CHARACTERS = 65_536;

async function localMediaResponse(request, source) {
  const headers = { 'Content-Type': source.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = request.headers?.get?.('range');
  let start = 0;
  let end = source.bytes - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || !match[1] && !match[2]) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${source.bytes}` } });
    if (match[1]) { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
    else start = Math.max(0, source.bytes - Number(match[2]));
    end = Math.min(end, source.bytes - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= source.bytes) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${source.bytes}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${source.bytes}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  return new Response(source.buffer ? source.buffer.subarray(start, end + 1) : Readable.toWeb(fs.createReadStream(source.filename, { start, end })), { status: range ? 206 : 200, headers });
}

async function decodeVideoPoster(url) {
  const video = document.createElement('video');
  video.muted = true;
  video.volume = 0;
  video.preload = 'auto';
  video.playsInline = true;
  document.body.append(video);
  const wait = (eventName, ready, action) => new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('The local video could not be decoded.')); };
    const cleanup = () => { video.removeEventListener(eventName, done); video.removeEventListener('error', failed); };
    video.addEventListener(eventName, done, { once: true });
    video.addEventListener('error', failed, { once: true });
    action?.();
    if (ready()) done();
  });
  try {
    await wait('loadedmetadata', () => video.readyState >= 1, () => { video.src = url; video.load(); });
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height || width > 16_384 || height > 16_384) throw new Error('The video dimensions are invalid.');
    const duration = Number.isFinite(video.duration) && video.duration > 0 && video.duration <= 3_600 ? video.duration : undefined;
    const target = Math.min(0.5, (duration || 2.5) * 0.2);
    await wait('seeked', () => !video.seeking && Math.abs(video.currentTime - target) < 0.01 && video.readyState >= 2, () => { video.currentTime = target; });
    await wait('loadeddata', () => video.readyState >= 2);
    const canvas = document.createElement('canvas');
    let scale = Math.min(1, 320 / Math.max(width, height));
    let thumbnail = '';
    for (const quality of [0.76, 0.6, 0.42, 0.25]) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      thumbnail = canvas.toDataURL('image/jpeg', quality);
      if (thumbnail.length <= 65_536) break;
      scale *= 0.8;
    }
    if (thumbnail.length > 65_536 || !thumbnail.startsWith('data:image/jpeg;base64,')) throw new Error('The decoded poster exceeded its size limit.');
    return { width, height, ...(duration ? { duration } : {}), thumbnail };
  } finally { video.removeAttribute('src'); video.load(); video.remove(); }
}

function compactAsset(asset, metadata) {
  return { ...asset, ...Object.fromEntries(['name', 'width', 'height', 'duration'].filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]])) };
}

function createVideoMetadataService({ BrowserWindow, sessionFactory, mediaStore, imageStore, readVideoSource = reference => mediaStore.getPlaybackSource(reference.assetId), onChanged, timeoutMs = MAX_DECODE_MS }) {
  let work = Promise.resolve();
  let environment;
  let activeWindow;
  let abortActive;
  let closed = false;
  let source;
  let pageUrl = '';
  let mediaUrl = '';

  async function ensureEnvironment() {
    if (environment) return environment;
    const partition = `easel-video-metadata-${crypto.randomUUID()}`;
    environment = await sessionFactory(partition);
    environment.session.setPermissionCheckHandler(() => false);
    environment.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    environment.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: ![pageUrl, mediaUrl].includes(details.url) }));
    await environment.session.protocol.handle('easel-canvas', (request) => {
      if (request.url === pageUrl) return new Response('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src \'self\'; connect-src \'self\'"></head><body></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (request.url === mediaUrl && source) return localMediaResponse(request, source);
      return new Response('Not found', { status: 404 });
    });
    return environment;
  }

  async function decode(saved, options, signal) {
    throwIfAborted(signal);
    const isolated = await ensureEnvironment();
    throwIfAborted(signal);
    if (closed) throw new Error('Video metadata service is closed.');
    source = saved;
    const token = crypto.randomUUID();
    pageUrl = `easel-canvas://video-metadata/${token}/index.html`;
    mediaUrl = `easel-canvas://video-metadata/${token}/media`;
    const window = new BrowserWindow({ show: false, width: 360, height: 260,
      webPreferences: { partition: isolated.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false },
    });
    activeWindow = window;
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const denyNavigation = (event, url) => { if (url !== pageUrl) event.preventDefault(); };
    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) window.webContents.on(event, denyNavigation);
    let timer;
    const stop = () => abortActive?.(abortError(signal));
    try {
      signal?.addEventListener('abort', stop, { once: true });
      const result = await Promise.race([
        (async () => {
          await window.loadURL(pageUrl);
          throwIfAborted(signal);
          const script = options
            ? fs.readFileSync(path.join(__dirname, '../canvas-kits/mediabunny.js'), 'utf8') + `\n;globalThis.EaselMediabunny = EaselMediabunny; (${decodeVideoFrame.toString()})(${JSON.stringify(mediaUrl)},${JSON.stringify(options)})`
            : `(${decodeVideoPoster.toString()})(${JSON.stringify(mediaUrl)})`;
          return window.webContents.executeJavaScript(script);
        })(),
        new Promise((_resolve, reject) => {
          abortActive = (error) => reject(error || new Error('Video metadata service is closing.'));
          timer = setTimeout(() => reject(new Error(`Video ${options ? 'frame' : 'poster'} decoding timed out.`)), Math.min(MAX_DECODE_MS, timeoutMs));
        }),
      ]);
      if (options) return result;
      if (!result || typeof result.thumbnail !== 'string' || result.thumbnail.length > MAX_THUMBNAIL_CHARACTERS) throw new Error('The video decoder returned an invalid poster.');
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      abortActive = undefined;
      if (!window.isDestroyed()) window.destroy();
      if (activeWindow === window) activeWindow = undefined;
      source = undefined;
      pageUrl = '';
      mediaUrl = '';
    }
  }

  async function enrich(refs, job = {}) {
    const results = [];
    const changed = [];
    for (const ref of refs) {
      if (closed || !ref.mimeType?.startsWith('video/')) { results.push(ref); continue; }
      try {
        const saved = await mediaStore.getPlaybackSource(ref.assetId || ref.id);
        const fields = {};
        if (job.prompt && isGenericGeneratedName(saved.name)) fields.name = generatedMediaName(job.prompt, saved.mimeType);
        if (!saved.thumbnail || !saved.width || !saved.height || !saved.duration) {
          try { Object.assign(fields, await decode(saved)); }
          catch { /* Poster decoding is optional; the completed media remains usable. */ }
        }
        const metadata = Object.keys(fields).length ? await mediaStore.updateMetadata(saved.id, fields, { onlyGenericName: true, expectedDigest: saved.digest }) : saved;
        const asset = compactAsset(ref, metadata);
        results.push(asset);
        if (Object.keys(fields).length) changed.push(asset);
      } catch { results.push(ref); }
    }
    if (changed.length && !closed) onChanged?.(changed);
    return results;
  }

  function enrichAssets(refs, job) {
    const operation = work.catch(() => {}).then(() => enrich(refs, job));
    work = operation;
    return operation;
  }
  function extractFrame(input, { signal } = {}) {
    const previous = work.catch(() => {});
    const operation = previous.then(async () => {
      throwIfAborted(signal);
      const options = frameOptions(input);
      if (!imageStore) throw new Error('Saved image references are unavailable.');
      if (closed) throw new Error('Video metadata service is closed.');
      const saved = await readVideoSource({ assetId: options.assetId, ...(options.projectId !== undefined ? { projectId: options.projectId } : {}) });
      throwIfAborted(signal);
      if (!['video/mp4', 'video/webm'].includes(saved?.mimeType)) throw new Error('Choose a saved MP4 or WebM video.');
      if (!Number.isSafeInteger(saved.bytes) || saved.bytes < 1 || saved.bytes > MAX_VIDEO_BYTES) throw new Error('Saved video exceeds its 32 MiB limit.');
      const decoded = await decode(saved, options, signal);
      const bytes = validateDecodedFrame(decoded, options, signal);
      const basename = String(saved.name || 'Video').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 125);
      const name = `${basename || 'Video'} frame ${decoded.timestampSeconds.toFixed(3)}s.jpg`;
      const assetId = await imageStore.save({ data: decoded.data, mimeType: 'image/jpeg', name });
      return { assetId, name, mimeType: 'image/jpeg', bytes, data: decoded.data, width: decoded.width, height: decoded.height,
        sourceAssetId: options.assetId, sourceWidth: decoded.sourceWidth, sourceHeight: decoded.sourceHeight,
        timestampSeconds: decoded.timestampSeconds, ...(options.position ? { position: options.position } : { requestedTimestampSeconds: options.timestampSeconds }) };
    });
    work = operation.catch(() => {});
    // Stop can cancel queue waiting immediately; a started local save still settles.
    return awaitAbortable(previous, signal).then(() => operation);
  }
  async function backfill({ jobs = [] } = {}) {
    const known = new Map(jobs.flatMap((job) => (job.assets || []).map((asset) => [asset.assetId, job])));
    const assets = await mediaStore.list();
    for (const asset of assets) {
      if (closed) break;
      if (asset.mimeType.startsWith('video/') && (!asset.thumbnail || !asset.width || !asset.height || !asset.duration || isGenericGeneratedName(asset.name) && known.get(asset.id)?.prompt)) await enrichAssets([{ assetId: asset.id, mimeType: asset.mimeType }], known.get(asset.id));
    }
  }
  async function close() {
    closed = true;
    abortActive?.();
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
    await work.catch(() => {});
    if (environment) await environment.session.protocol.unhandle('easel-canvas');
    environment = undefined;
    closed = false;
  }
  return { enrichAssets, extractFrame, backfill, close };
}

module.exports = { MAX_DECODE_MS, createVideoMetadataService, decodeVideoPoster, localMediaResponse };
