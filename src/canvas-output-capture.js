const { MAX_MEDIA_BYTES, MAX_FRAME_BYTES, MAX_VIDEO_FRAMES } = require('./canvas-media-store');

const MAX_RECORDING_SECONDS = 30;

function validateRecordingOptions(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !['canvasIndex', 'seconds', 'fps', 'maxWidth', 'frameCount', 'format', 'name'].includes(key))) throw new Error('Canvas recording options are invalid.');
  const options = { canvasIndex: 0, seconds: 5, fps: 30, maxWidth: 1600, frameCount: 4, format: 'auto', ...args };
  for (const [name, minimum, maximum] of [['canvasIndex', 0, 99], ['fps', 1, 60], ['maxWidth', 320, 1920], ['frameCount', 1, MAX_VIDEO_FRAMES]]) if (!Number.isInteger(options[name]) || options[name] < minimum || options[name] > maximum) throw new Error(`Recording ${name} must be between ${minimum} and ${maximum}.`);
  if (typeof options.seconds !== 'number' || !Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > MAX_RECORDING_SECONDS) throw new Error('Record between one and 30 seconds.');
  if (!['auto', 'webm', 'mp4'].includes(options.format)) throw new Error('Choose auto, webm, or mp4 recording.');
  if (options.name !== undefined && (typeof options.name !== 'string' || !options.name.trim() || options.name.length > 160 || /[\u0000-\u001f\u007f]/.test(options.name))) throw new Error('Recording name is invalid.');
  return options;
}

function startCanvasOutputCapture(options) {
  if (window.__easelOutputCapture?.inspect().running) throw new Error('Another canvas output capture is running.');
  const source = document.querySelectorAll('canvas')[options.canvasIndex];
  if (!(source instanceof HTMLCanvasElement) || !source.width || !source.height) throw new Error('Select an existing nonempty canvas element using its index from inspect_canvas.');
  const bounds = source.getBoundingClientRect();
  const style = getComputedStyle(source);
  if (!bounds.width || !bounds.height || style.display === 'none' || style.visibility === 'hidden') throw new Error('The selected canvas is hidden. Select the visible output canvas.');
  if (typeof source.captureStream !== 'function' || typeof MediaRecorder !== 'function') throw new Error('Canvas captureStream and MediaRecorder are unavailable in this runtime.');
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'];
  const supportedCodecs = candidates.filter((value) => MediaRecorder.isTypeSupported(value));
  const codec = supportedCodecs.find((value) => options.format === 'auto' || value.startsWith('video/' + options.format));
  if (!codec) throw new Error('The requested video format is not supported. Available codecs: ' + (supportedCodecs.join(', ') || 'none'));
  const scale = Math.min(1, options.maxWidth / source.width, 1920 / source.height, Math.sqrt(4_194_304 / (source.width * source.height)));
  const surface = document.createElement('canvas');
  surface.width = Math.max(1, Math.round(source.width * scale));
  surface.height = Math.max(1, Math.round(source.height * scale));
  const context = surface.getContext('2d', { alpha: false });
  if (!context) throw new Error('A recording canvas context could not be created.');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const sampleCanvas = document.createElement('canvas');
  const sampleContext = sampleCanvas.getContext('2d', { alpha: false });
  if (!sampleContext) { surface.width = 0; surface.height = 0; throw new Error('A video sampling context could not be created.'); }
  const state = { id: options.id, status: 'starting', width: surface.width, height: surface.height, canvasIndex: options.canvasIndex, sourceWidth: source.width, sourceHeight: source.height, fps: options.fps, supportedCodecs, codec, mimeType: codec.split(';')[0], bytes: 0, duration: 0, includesAudio: false, sampleCount: 0 };
  const chunks = [];
  const samples = [];
  let sourceStream;
  let outputStream;
  let recorder;
  let frame;
  let stopTimer;
  let setupTimer;
  let finalizeTimer;
  let startedAt = 0;
  let stoppedAt = 0;
  let lastDraw = 0;
  let released = false;
  let data = '';
  let thumbnail = '';

  function cleanup() {
    cancelAnimationFrame(frame);
    clearTimeout(stopTimer); clearTimeout(setupTimer); clearTimeout(finalizeTimer);
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
    if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; }
    for (const stream of [sourceStream, outputStream]) for (const track of stream?.getTracks() || []) track.stop();
    video.pause(); video.srcObject = null;
    surface.width = 0; surface.height = 0;
    sampleCanvas.width = 0; sampleCanvas.height = 0;
    window.removeEventListener('pagehide', pagehide);
  }

  function fail(message, cancelled = false) {
    if (released || ['done', 'failed', 'cancelled'].includes(state.status)) return;
    state.status = cancelled ? 'cancelled' : 'failed';
    state.error = String(message).slice(0, 1000);
    chunks.length = 0; samples.length = 0; data = ''; thumbnail = '';
    cleanup();
  }

  function pagehide() { fail('The canvas document was closed or replaced.', true); }

  function jpeg(maxWidth, maxCharacters) {
    const ratio = Math.min(1, maxWidth / surface.width);
    sampleCanvas.width = Math.max(1, Math.round(surface.width * ratio));
    sampleCanvas.height = Math.max(1, Math.round(surface.height * ratio));
    sampleContext.drawImage(surface, 0, 0, sampleCanvas.width, sampleCanvas.height);
    for (const quality of [0.8, 0.6, 0.4, 0.2]) {
      const value = sampleCanvas.toDataURL('image/jpeg', quality);
      if (value.length <= maxCharacters) return value;
    }
    throw new Error('A sampled video frame exceeded its image budget. Reduce the recording dimensions.');
  }

  function sample(elapsed) {
    if (samples.length >= options.frameCount) return;
    samples.push({ timestamp: Math.max(0, elapsed), data: jpeg(1280, Math.ceil(options.maxFrameBytes / 3) * 4).split(',')[1] });
    state.sampleCount = samples.length;
    if (!thumbnail) thumbnail = jpeg(240, 65_536);
  }

  function draw(now) {
    if (released || state.status !== 'recording') return;
    const currentBounds = source.getBoundingClientRect();
    const currentStyle = getComputedStyle(source);
    if (!source.isConnected || !currentBounds.width || !currentBounds.height || currentStyle.display === 'none' || currentStyle.visibility === 'hidden') { fail('The selected canvas was removed or hidden during recording.'); return; }
    try {
      if (now - lastDraw >= 1000 / options.fps) {
        context.fillStyle = '#000'; context.fillRect(0, 0, surface.width, surface.height);
        context.drawImage(video, 0, 0, surface.width, surface.height);
        outputStream.getVideoTracks()[0]?.requestFrame?.();
        lastDraw = now;
        const elapsed = (now - startedAt) / 1000;
        state.duration = elapsed;
        const target = options.frameCount === 1 ? 0 : samples.length * options.seconds / (options.frameCount - 1);
        if (elapsed >= target && samples.length < options.frameCount) sample(elapsed);
      }
      frame = requestAnimationFrame(draw);
    } catch (error) { fail(error.message); }
  }

  function stop() {
    if (state.status !== 'recording') return;
    stoppedAt = performance.now();
    state.duration = Math.max(0.001, (stoppedAt - startedAt) / 1000);
    try { if (samples.length < options.frameCount) sample(state.duration); }
    catch (error) { fail(error.message); return; }
    state.status = 'finalizing';
    cancelAnimationFrame(frame);
    finalizeTimer = setTimeout(() => fail('Video encoding did not finish within five seconds.'), 5000);
    try { recorder.stop(); } catch (error) { fail(error.message); }
  }

  async function finalize() {
    if (released || state.status !== 'finalizing') return;
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || codec });
      if (!blob.size || blob.size > options.maxBytes) throw new Error('Recorded video is empty or exceeds 32 MiB.');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (released || state.status !== 'finalizing') return;
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      data = btoa(binary);
      state.bytes = blob.size;
      state.codec = recorder.mimeType || codec;
      state.mimeType = state.codec.split(';')[0].toLowerCase();
      for (const item of samples) item.timestamp = Math.min(item.timestamp, state.duration);
      state.status = 'done';
      chunks.length = 0;
      cleanup();
    } catch (error) { fail(error.message); }
  }

  const api = {
    inspect: () => ({ ...state, running: ['starting', 'recording', 'finalizing'].includes(state.status), thumbnail: state.status === 'done' ? thumbnail : '' }),
    cancel: (reason = 'Canvas output recording was stopped.') => { fail(reason, true); return { ...state }; },
    read: (offset, maxCharacters = 1_048_576) => {
      if (state.status !== 'done' || !Number.isInteger(offset) || offset < 0 || offset > data.length || !Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 1_048_576) throw new Error('Video data read is invalid.');
      const end = Math.min(offset + maxCharacters, data.length);
      return { data: data.slice(offset, end), nextOffset: end < data.length ? end : null, totalCharacters: data.length };
    },
    frame: (index) => { if (state.status !== 'done' || !Number.isInteger(index) || index < 0 || index >= samples.length) throw new Error('Video sample index is invalid.'); return { ...samples[index] }; },
    release: () => { if (!released) { cleanup(); released = true; data = ''; samples.length = 0; chunks.length = 0; thumbnail = ''; if (window.__easelOutputCapture === api) delete window.__easelOutputCapture; } return { released: true }; },
  };
  window.__easelOutputCapture = api;
  window.addEventListener('pagehide', pagehide, { once: true });
  (async () => {
    sourceStream = source.captureStream(options.fps);
    video.srcObject = sourceStream;
    setupTimer = setTimeout(() => fail('No canvas frames arrived within five seconds. Start the scene animation and try again.'), 5000);
    await video.play();
    clearTimeout(setupTimer);
    if (released || state.status !== 'starting') return;
    context.fillStyle = '#000'; context.fillRect(0, 0, surface.width, surface.height);
    context.drawImage(video, 0, 0, surface.width, surface.height);
    outputStream = surface.captureStream(options.fps);
    recorder = new MediaRecorder(outputStream, { mimeType: codec, videoBitsPerSecond: Math.min(8_000_000, Math.max(1_000_000, surface.width * surface.height * options.fps * 0.08)) });
    recorder.ondataavailable = (event) => {
      if (!event.data?.size || !['recording', 'finalizing'].includes(state.status)) return;
      chunks.push(event.data); state.bytes += event.data.size;
      if (state.bytes > options.maxBytes) fail('Recorded video exceeded 32 MiB. Reduce its duration or dimensions.');
    };
    recorder.onstop = finalize;
    recorder.onerror = (event) => fail(event.error?.message || 'Browser video recording failed.');
    startedAt = performance.now();
    state.status = 'recording';
    sample(0);
    recorder.start(250);
    frame = requestAnimationFrame(draw);
    stopTimer = setTimeout(stop, options.seconds * 1000);
  })().catch((error) => fail(error.message));
  return api.inspect();
}

function captureStartScript(options, id) {
  return `(${startCanvasOutputCapture.toString()})(${JSON.stringify({ ...options, id, maxBytes: MAX_MEDIA_BYTES, maxFrameBytes: MAX_FRAME_BYTES })})`;
}

function captureOperationScript(id, method, args = []) {
  if (!['inspect', 'cancel', 'read', 'frame', 'release'].includes(method)) throw new Error('Unknown output capture operation.');
  return `(() => {const capture=window.__easelOutputCapture;if(!capture || capture.inspect().id!==${JSON.stringify(id)})throw new Error('Canvas output capture was replaced.');return capture[${JSON.stringify(method)}](...${JSON.stringify(args)});})()`;
}

module.exports = { MAX_RECORDING_SECONDS, captureOperationScript, captureStartScript, validateRecordingOptions };
