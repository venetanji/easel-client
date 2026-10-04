(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EaselVideoExport = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  // Deliberately bounded, offline export. Mediabunny provides decoding/muxing;
  // this module owns composition and sends no media to an external service.
  const EXPORT_LIMITS = Object.freeze({ maxDurationSeconds: 60, maxPixels: 1920 * 1080, maxDimension: 1920,
    maxFrameRate: 60, maxItems: 32, maxAssetBytes: 32 * 1024 * 1024, maxInputBytes: 128 * 1024 * 1024,
    maxOutputBytes: 32 * 1024 * 1024, maxDecodedImagePixels: 16_000_000, sampleRate: 48000 });
  const INPUT_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp3', 'audio/mp4',
    'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/ogg', 'audio/flac', 'audio/x-flac',
    'image/png', 'image/jpeg', 'image/webp']);
  const fail = message => { throw new Error(message); };
  function abortError() { const error = new Error('Video export was cancelled.'); error.name = 'AbortError'; return error; }
  function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
  function planVideoExport(value) {
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.items) || !Array.isArray(value.tracks)) fail('Invalid timeline document.');
    const { numerator, denominator } = value.frameRate || {};
    const fps = numerator / denominator;
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator < 1 || !Number.isFinite(fps) || fps < 1 || fps > EXPORT_LIMITS.maxFrameRate) fail('Export frame rate must be between 1 and 60 fps.');
    if (![value.width, value.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= EXPORT_LIMITS.maxDimension)
      || value.width * value.height > EXPORT_LIMITS.maxPixels) fail('Export resolution is limited to 1920 pixels per side and 1920×1080 pixels in total.');
    if (!Array.isArray(value.transitions) || value.transitions.length) fail('Transitions are not supported by this exporter.');
    if (!value.items.length) fail('Cannot export an empty timeline.');
    if (value.items.length > EXPORT_LIMITS.maxItems) fail('Export is limited to 32 timeline items.');
    const tracks = new Map();
    for (const track of value.tracks) {
      if (!track || typeof track.id !== 'string' || tracks.has(track.id) || !['video', 'audio', 'overlay'].includes(track.type)) fail('Timeline tracks must have unique IDs and supported types.');
      tracks.set(track.id, track);
    }
    let frames = 0;
    const seen = new Set();
    const byTrack = new Map();
    for (const item of value.items) {
      if (!item || typeof item.id !== 'string' || seen.has(item.id)) fail('Timeline item IDs must be unique.');
      seen.add(item.id);
      const track = tracks.get(item.trackId);
      if (!track) fail('Timeline item refers to a missing track.');
      if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(item.assetId)) fail('Timeline item requires a managed asset ID.');
      if (![item.startFrame, item.endFrame].every(Number.isSafeInteger) || item.startFrame < 0 || item.endFrame <= item.startFrame) fail('Timeline item has an invalid frame range.');
      if (![item.sourceStartSeconds, item.sourceEndSeconds].every(Number.isFinite) || item.sourceStartSeconds < 0 || item.sourceEndSeconds <= item.sourceStartSeconds) fail('Timeline item has an invalid source range.');
      if (item.gain !== undefined && (!Number.isFinite(item.gain) || item.gain < 0 || item.gain > 1)) fail('Audio gain must be between 0 and 1.');
      const span = item.endFrame - item.startFrame;
      for (const key of ['fadeInFrames', 'fadeOutFrames']) if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || item[key] < 0 || item[key] > span)) fail('Audio fades must fit the item range.');
      if ((item.fadeInFrames || 0) + (item.fadeOutFrames || 0) > span) fail('Audio fades must fit the item range.');
      if (track.type === 'overlay' && ['gain', 'fadeInFrames', 'fadeOutFrames'].some(key => item[key] !== undefined)) fail('Overlay items cannot have audio controls.');
      if (Math.abs(item.sourceEndSeconds - item.sourceStartSeconds - span / fps) > 1e-6) fail('Source retiming is not supported; adjust source in/out to match the timeline item duration.');
      frames = Math.max(frames, item.endFrame);
      if (!byTrack.has(item.trackId)) byTrack.set(item.trackId, []);
      byTrack.get(item.trackId).push(item);
    }
    if (frames / fps > EXPORT_LIMITS.maxDurationSeconds) fail('Export is limited to 60 seconds.');
    for (const items of byTrack.values()) {
      items.sort((a, b) => a.startFrame - b.startFrame);
      for (let i = 1; i < items.length; i++) if (items[i].startFrame < items[i - 1].endFrame) fail('Items cannot overlap on the same track.');
    }
    return { ...JSON.parse(JSON.stringify(value)), fps, frameCount: frames, duration: frames * denominator / numerator };
  }
  function validateExportAsset(asset) {
    if (!asset || typeof asset.data !== 'string' || !asset.data.length || asset.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)) fail('Managed media must contain valid raw base64 data.');
    const bytes = asset.data.length / 4 * 3 - (asset.data.endsWith('==') ? 2 : asset.data.endsWith('=') ? 1 : 0);
    if (bytes > EXPORT_LIMITS.maxAssetBytes) fail('Each export source is limited to 32 MiB.');
    const mimeType = String(asset.mimeType || '').toLowerCase();
    if (!INPUT_TYPES.has(mimeType)) fail('This media type is not supported for export. Use PNG/JPEG/WebP images or supported video/audio files.');
    return { data: asset.data, mimeType, bytes };
  }
  async function chooseWebMVideoCodec(bunny, plan) {
    for (const codec of ['vp8', 'vp9']) {
      if (await bunny.canEncodeVideo(codec, { width: plan.width, height: plan.height, frameRate: plan.fps, bitrate: 4_000_000 })) return codec;
    }
    fail('This browser cannot encode WebM video at the requested size.');
  }
  function containRect(sw, sh, width, height) {
    const scale = Math.min(width / sw, height / sh);
    return { x: (width - sw * scale) / 2, y: (height - sh * scale) / 2, width: sw * scale, height: sh * scale };
  }
  function mixAudioBuffer(output, wrapped, item, fps, baseTimestamp = 0) {
    const input = wrapped.buffer;
    if (input.numberOfChannels > 2) fail('Export currently supports mono and stereo source audio.');
    const start = item.startFrame / fps;
    const end = item.endFrame / fps;
    const sourceStart = baseTimestamp + item.sourceStartSeconds;
    const sourceEnd = baseTimestamp + item.sourceEndSeconds;
    const lo = Math.max(sourceStart, wrapped.timestamp);
    const hi = Math.min(sourceEnd, wrapped.timestamp + input.length / input.sampleRate);
    const first = Math.max(0, Math.ceil((start + lo - sourceStart) * output.sampleRate - 1e-7));
    const last = Math.min(output.length, Math.ceil(Math.min(end, start + hi - sourceStart) * output.sampleRate - 1e-7));
    const fadeIn = (item.fadeInFrames || 0) / fps;
    const fadeOut = (item.fadeOutFrames || 0) / fps;
    for (let channel = 0; channel < 2; channel++) {
      const source = input.getChannelData(Math.min(channel, input.numberOfChannels - 1));
      const dest = output.getChannelData(channel);
      for (let i = first; i < last; i++) {
        const t = i / output.sampleRate;
        const position = (sourceStart + t - start - wrapped.timestamp) * input.sampleRate;
        const index = Math.max(0, Math.min(source.length - 1, Math.floor(position)));
        const fraction = Math.max(0, Math.min(1, position - index));
        let gain = item.gain ?? 1;
        if (fadeIn) gain *= Math.min(1, Math.max(0, (t - start) / fadeIn));
        if (fadeOut) gain *= Math.min(1, Math.max(0, (end - t) / fadeOut));
        dest[i] += (source[index] * (1 - fraction) + source[Math.min(index + 1, source.length - 1)] * fraction) * gain;
      }
    }
  }
  function imageDecodeBudget(bytes, mimeType, usedPixels) {
    // Read allocation dimensions before handing compressed data to a decoder.
    // The sum bounds retained RGBA image storage to 64 MB, independently of compression.
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    const be16 = index => bytes[index] * 256 + bytes[index + 1];
    const be32 = index => bytes[index] * 16777216 + bytes[index + 1] * 65536 + bytes[index + 2] * 256 + bytes[index + 3];
    const le24 = index => bytes[index] + bytes[index + 1] * 256 + bytes[index + 2] * 65536;
    let width, height;
    if (mimeType === 'image/png' && bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n) && ascii(12, 16) === 'IHDR') {
      width = be32(16); height = be32(20);
    } else if (mimeType === 'image/webp' && bytes.length >= 25 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
      const format = ascii(12, 16);
      if (format === 'VP8X' && bytes.length >= 30) { width = le24(24) + 1; height = le24(27) + 1; }
      else if (format === 'VP8L' && bytes[20] === 47) {
        width = 1 + ((bytes[21] | bytes[22] << 8) & 0x3fff);
        height = 1 + ((bytes[22] >> 6 | bytes[23] << 2 | bytes[24] << 10) & 0x3fff);
      } else if (format === 'VP8 ' && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
        width = (bytes[26] | bytes[27] << 8) & 0x3fff; height = (bytes[28] | bytes[29] << 8) & 0x3fff;
      }
    } else if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
      let offset = 2;
      while (offset + 8 < bytes.length && bytes[offset] === 255) {
        const marker = bytes[offset + 1];
        if (marker === 255) { offset++; continue; }
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || marker >= 208 && marker <= 215) { offset += 2; continue; }
        const length = be16(offset + 2);
        if (length < 2 || offset + length + 2 > bytes.length) break;
        if (length >= 7 && [192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
          height = be16(offset + 5); width = be16(offset + 7); break;
        }
        offset += length + 2;
      }
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) fail('The source image dimensions are malformed or unsupported.');
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels + usedPixels > EXPORT_LIMITS.maxDecodedImagePixels) fail('The decoded image memory budget is 16 million pixels in total. Resize source images or use fewer images.');
    return { pixels, totalPixels: pixels + usedPixels };
  }
  function decodeBase64(data) {
    const raw = root.atob(data); const result = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
    return result;
  }
  function encodeBase64(buffer) {
    const bytes = new Uint8Array(buffer); let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return root.btoa(binary);
  }
  async function exportVideoTimeline({ timeline, getAsset, signal, onProgress = () => {}, name = 'Timeline export' } = {}) {
    checkAbort(signal);
    const plan = planVideoExport(timeline);
    const bunny = root.EaselMediabunny;
    if (!bunny || !root.document || typeof root.VideoEncoder !== 'function') fail('The offline Mediabunny browser export runtime is unavailable.');
    if (typeof getAsset !== 'function') fail('A managed-media reader is required for export.');
    const inputs = new Set(), bitmaps = new Set(), iterators = new Set();
    const assets = new Map(), prepared = new Map();
    let output, finished = false, cancelled = false, resourcesClosed = false, encodedBytes = 0, encodedEnd = 0;
    let cancelPromise;
    const abort = () => {
      cancelled = true;
      for (const input of inputs) input.dispose();
      if (output && !finished && !cancelPromise) cancelPromise = output.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    const check = () => { if (cancelled || signal?.aborted) throw abortError(); };
    // Bound a broken parser/decoder operation; errors cancel all owned resources.
    const bounded = promise => new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(abortError()); };
      timer = setTimeout(() => { cleanup(); reject(new Error('Media decoding or encoding timed out.')); }, 30_000);
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signal?.aborted) onAbort();
    });
    try {
      onProgress({ phase: 'preparing', progress: 0 });
      const codec = await bounded(chooseWebMVideoCodec(bunny, plan)); check();
      let inputBytes = 0, decodedImagePixels = 0;
      for (const assetId of new Set(plan.items.map(item => item.assetId))) {
        check();
        const asset = validateExportAsset(await bounded(getAsset(assetId))); check();
        inputBytes += asset.bytes;
        if (inputBytes > EXPORT_LIMITS.maxInputBytes) fail('Export source media is limited to 128 MiB in total.');
        const bytes = decodeBase64(asset.data);
        if (asset.mimeType.startsWith('image/')) {
          const imageBudget = imageDecodeBudget(bytes, asset.mimeType, decodedImagePixels);
          decodedImagePixels = imageBudget.totalPixels;
          const bitmap = await bounded(root.createImageBitmap(new Blob([bytes], { type: asset.mimeType })).then(value => {
            if (resourcesClosed || cancelled || signal?.aborted) { value.close(); throw abortError(); }
            bitmaps.add(value); return value;
          })); check();
          if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height !== imageBudget.pixels) fail('Decoded image dimensions do not match the source allocation header.');
          assets.set(assetId, { bitmap, kind: 'image' });
        } else {
          const input = new bunny.Input({ source: new bunny.BufferSource(bytes), formats: [bunny.MP4, bunny.QTFF, bunny.WEBM, bunny.WAVE, bunny.MP3, bunny.OGG, bunny.FLAC, bunny.ADTS] });
          inputs.add(input);
          if (!await bounded(input.canRead())) fail('A source file is malformed or has an unsupported container.');
          const video = await bounded(input.getPrimaryVideoTrack());
          const audio = await bounded(input.getPrimaryAudioTrack());
          const baseTimestamp = Math.max(0, await bounded(input.getFirstTimestamp()));
          if (!video && !audio) fail('A source file has no playable audio or video track.');
          assets.set(assetId, { input, video, audio, kind: asset.mimeType.startsWith('audio/') ? 'audio' : 'video', baseTimestamp });
        }
      }
      let includesAudio = false;
      const trackOrder = new Map(plan.tracks.map((track, index) => [track.id, { ...track, index }]));
      const ordered = [...plan.items].sort((a, b) => {
        const x = trackOrder.get(a.trackId), y = trackOrder.get(b.trackId);
        return x.index - y.index || a.startFrame - b.startFrame;
      });
      for (const item of ordered) {
        check();
        const asset = assets.get(item.assetId), track = trackOrder.get(item.trackId);
        if (track.type === 'audio' && !asset.audio) fail('An audio track item has no source audio.');
        if (track.type !== 'audio' && !asset.bitmap && !asset.video) fail('A visual track item has no source image or video.');
        if (track.type === 'overlay' && asset.kind !== 'image') fail('Overlay export currently supports static PNG/JPEG/WebP images.');
        if (asset.bitmap && ['gain', 'fadeInFrames', 'fadeOutFrames'].some(key => item[key] !== undefined)) fail('Still images cannot use audio controls.');
        if (asset.video && track.type !== 'audio') {
          if (!await bounded(asset.video.canDecode())) fail('A source video codec cannot be decoded in this browser.');
          const duration = await bounded(asset.video.computeDuration());
          if (asset.baseTimestamp + item.sourceEndSeconds > duration + 1 / plan.fps + 0.002) fail('A source trim exceeds the actual video duration.');
        }
        if (asset.audio && track.type !== 'overlay' && (item.gain ?? 1) > 0) {
          if (!await bounded(asset.audio.canDecode())) fail('A source audio codec cannot be decoded in this browser.');
          if (await bounded(asset.audio.getNumberOfChannels()) > 2) fail('Export currently supports mono and stereo source audio.');
          if (track.type === 'audio' && asset.baseTimestamp + item.sourceEndSeconds > await bounded(asset.audio.computeDuration()) + 0.05) fail('A source trim exceeds the actual audio duration.');
          includesAudio = true;
        }
        prepared.set(item.id, { item, asset, track });
      }
      let mix;
      if (includesAudio) {
        if (!await bounded(bunny.canEncodeAudio('opus', { sampleRate: EXPORT_LIMITS.sampleRate, numberOfChannels: 2, bitrate: 128_000 }))) fail('This browser cannot encode Opus audio for WebM.');
        mix = new root.AudioBuffer({ length: Math.ceil(plan.duration * EXPORT_LIMITS.sampleRate), sampleRate: EXPORT_LIMITS.sampleRate, numberOfChannels: 2 });
        let mixedItems = 0;
        for (const { item, asset, track } of prepared.values()) {
          if (!asset.audio || track.type === 'overlay' || (item.gain ?? 1) === 0) continue;
          const sink = new bunny.AudioBufferSink(asset.audio);
          const iterator = sink.buffers(asset.baseTimestamp + item.sourceStartSeconds, asset.baseTimestamp + item.sourceEndSeconds);
          iterators.add(iterator);
          while (true) {
            check(); const next = await bounded(iterator.next()); if (next.done) break;
            mixAudioBuffer(mix, next.value, item, plan.fps, asset.baseTimestamp);
          }
          await iterator.return(); iterators.delete(iterator);
          mixedItems++;
          onProgress({ phase: 'preparing', progress: 0.15 * mixedItems / plan.items.length });
        }
        // Fixed unity mixing with hard clipping; no hidden loudness normalization.
        for (let channel = 0; channel < 2; channel++) {
          const samples = mix.getChannelData(channel);
          for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-1, Math.min(1, samples[i]));
        }
      }
      const canvas = root.document.createElement('canvas'); canvas.width = plan.width; canvas.height = plan.height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) fail('The browser could not create the export canvas.');
      const target = new bunny.BufferTarget();
      output = new bunny.Output({ format: new bunny.WebMOutputFormat(), target });
      const countPacket = packet => { encodedEnd = Math.max(encodedEnd, packet.timestamp + packet.duration); encodedBytes += packet.data.byteLength; if (encodedBytes > EXPORT_LIMITS.maxOutputBytes) fail('The exported video exceeds the 32 MiB limit. Shorten the timeline or reduce resolution.'); };
      const videoSource = new bunny.CanvasSource(canvas, { codec, quality: new bunny.Quality({ bitrate: 4_000_000 }), onEncodedPacket: countPacket });
      output.addVideoTrack(videoSource, { frameRate: plan.fps });
      let audioSource;
      if (includesAudio) { audioSource = new bunny.AudioBufferSource({ codec: 'opus', quality: new bunny.Quality({ bitrate: 128_000 }), onEncodedPacket: countPacket }); output.addAudioTrack(audioSource); }
      check(); await bounded(output.start()); check();
      if (audioSource) { await bounded(audioSource.add(mix)); audioSource.close(); mix = null; }
      for (let frame = 0; frame < plan.frameCount; frame++) {
        check(); context.fillStyle = '#000000'; context.fillRect(0, 0, plan.width, plan.height);
        for (const record of prepared.values()) {
          const { item, asset, track } = record;
          if (frame >= item.endFrame && record.iterator) { await record.iterator.return(); iterators.delete(record.iterator); record.iterator = null; }
          if (track.type === 'audio' || frame < item.startFrame || frame >= item.endFrame) continue;
          let source = asset.bitmap;
          if (!source) {
            if (!record.iterator) {
              const sink = new bunny.CanvasSink(asset.video, { width: plan.width, height: plan.height, fit: 'contain', poolSize: 2 });
              const timestamps = Array.from({ length: item.endFrame - item.startFrame }, (_, index) => asset.baseTimestamp + item.sourceStartSeconds + index / plan.fps);
              record.iterator = sink.canvasesAtTimestamps(timestamps); iterators.add(record.iterator);
            }
            const next = await bounded(record.iterator.next()); check();
            if (next.done || !next.value) fail('A source video did not provide the requested frame.');
            source = next.value.canvas;
          }
          const rect = containRect(source.width, source.height, plan.width, plan.height);
          context.drawImage(source, rect.x, rect.y, rect.width, rect.height);
        }
        await bounded(videoSource.add(frame / plan.fps, 1 / plan.fps));
        if (frame % Math.max(1, Math.floor(plan.fps / 4)) === 0) {
          onProgress({ phase: 'rendering', progress: 0.15 + 0.8 * (frame + 1) / plan.frameCount });
          await new Promise(resolve => setTimeout(resolve, 0)); // let the Cancel button run
        }
      }
      videoSource.close(); check(); onProgress({ phase: 'finalizing', progress: 0.97 });
      await bounded(output.finalize()); check();
      if (!target.buffer?.byteLength) fail('The encoder produced an empty video.');
      if (target.buffer.byteLength > EXPORT_LIMITS.maxOutputBytes) fail('The exported video exceeds the 32 MiB limit.');
      finished = true;
      const data = encodeBase64(target.buffer); check(); onProgress({ phase: 'finalizing', progress: 1 }); check();
      return { data, mimeType: 'video/webm', name: String(name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) || 'Timeline export',
        width: plan.width, height: plan.height, duration: Math.max(plan.duration, encodedEnd), timelineDuration: plan.duration, codec: includesAudio ? `${codec},opus` : codec,
        includesAudio, frameCount: plan.frameCount };
    } catch (error) {
      if (signal?.aborted || cancelled) throw abortError();
      throw error;
    } finally {
      resourcesClosed = true;
      signal?.removeEventListener('abort', abort);
      for (const input of inputs) input.dispose();
      for (const iterator of iterators) { try { await iterator.return(); } catch {} }
      for (const bitmap of bitmaps) bitmap.close();
      if (output && !finished) { try { await (cancelPromise || output.cancel()); } catch {} }
    }
  }
  return { EXPORT_LIMITS, planVideoExport, validateExportAsset, chooseWebMVideoCodec, containRect, mixAudioBuffer, exportVideoTimeline };
});
