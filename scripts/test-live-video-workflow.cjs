#!/usr/bin/env node
// Explicitly opt-in: no request, generation, credential read, or app launch on import.
// Live mode uses the SAME provider/import/store/timeline/export modules as Easel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const JOBS = 2, SECONDS = 1, SIZE = '512x320', MODEL = 'ltx-2.5';
const SCENARIOS = new Set(['baseline', 'camera', 'guided-frames']);
const STATUSES = new Set(['queued', 'in_progress', 'completed', 'failed', 'cancelled']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const redact = (value, secret = '') => [secret, secret.trim()].filter(Boolean).reduce((text, key) => text.split(key).join('[redacted]'), String(value));

function parseOptions(args) {
  const options = { mode: 'help', timeoutSeconds: 1200 }; let modes = 0, consent = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '--probe', '--offline', '--live', '--resume'].includes(arg)) {
      if (++modes > 1) throw new Error('Choose exactly one mode.');
      options.mode = arg.slice(2);
      if (arg === '--resume') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--resume requires an evidence directory.');
        options.directory = path.resolve(args[++i]);
      }
    } else if (arg === '--scenario') {
      if (options.scenario || !SCENARIOS.has(args[i + 1])) throw new Error('--scenario requires one of baseline, camera, guided-frames, selected only once.');
      options.scenario = args[++i];
    } else if (arg === '--allow-generation-cost') consent = true;
    else if (arg === '--timeout-seconds') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 30 || value > 3600) throw new Error('--timeout-seconds must be 30–3600.');
      options.timeoutSeconds = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.scenario && options.mode !== 'live') throw new Error('--scenario applies only to --live; resume uses the saved scenario.');
  if (consent && !modes) throw new Error('Choose a mode; consent alone never starts a run.');
  if (options.mode === 'live' && !consent) throw new Error('--live requires --allow-generation-cost: exactly two 1-second 512x320 generations may incur provider/GPU charges.');
  if (consent && options.mode !== 'live') throw new Error('--allow-generation-cost applies only to --live.');
  return options;
}
function guardPublicResponse(value, secret = '') {
  const encoded = JSON.stringify(value);
  for (const key of new Set([secret, secret.trim()].filter(Boolean))) {
    if (encoded.includes(key) || encoded.includes(JSON.stringify(key).slice(1, -1))) throw new Error('Credential found in endpoint response. Refusing to print or persist it; preserve any earlier receipts and inspect the server.');
  }
  return value;
}
function checkReceipt(job, expectedId, secret = '') {
  guardPublicResponse(job, secret);
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(job.id)) throw new Error('Missing or invalid receipt ID; never resubmit automatically.');
  if (expectedId && job.id !== expectedId) throw new Error('Receipt ID mismatch; never resubmit automatically.');
  if (!STATUSES.has(job.status)) throw new Error('Unknown job status; retain the receipt and inspect the server.');
  return job;
}
function recordSubmissionReceipt(manifest, index, job, filename, secret) {
  guardPublicResponse(job, secret);
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(job.id)) throw new Error('Missing or invalid receipt ID; never resubmit automatically.');
  // Receipt identity is recoverable even if a future server adds an unknown state.
  // Persist it before rejecting the state, and never invent a replacement job.
  manifest.jobs[index] = job;
  saveJson(filename, manifest);
  if (manifest.jobs.some((other, offset) => offset !== index && other.id === job.id)) throw new Error('Duplicate receipt ID returned for two submissions. Both responses are saved; inspect the server and do not generate replacements.');
  return checkReceipt(job, undefined, secret);
}
function scenarioRequests(name = 'baseline') {
  if (!SCENARIOS.has(name)) throw new Error('Unknown live scenario.');
  const base = { model: MODEL, seconds: SECONDS, size: SIZE };
  if (name === 'baseline') return [
    { ...base, prompt: 'A red wooden toy boat floating gently on blue water, fixed camera, daylight.' },
    { ...base, prompt: 'A blue paper kite moving gently against a warm orange sky, fixed camera, daylight.' },
  ];
  if (name === 'camera') return [
    { ...base, prompt: 'A red wooden toy boat floating gently on blue water. The camera dollies toward the boat, daylight.', seed: '0', cameraLora: 'dolly-in', cameraLoraStrength: 0.8 },
    { ...base, prompt: 'A blue paper kite moving gently against a warm orange sky, fixed camera, daylight.', seed: '18446744073709551614', loras: [{ id: 'camera-static', strength: 0.8 }] },
  ];
  // A committed, synthetic still only: no URL fetching, user path, or extra generation.
  const image = { data: fs.readFileSync(path.join(root, 'test/fixtures/video-export/overlay.png')).toString('base64'), mimeType: 'image/png', name: 'synthetic-guide.png' };
  return ['0', '18446744073709551614'].map(seed => ({ ...base,
    prompt: 'A simple geometric composition with a gently moving colored shape, clean flat background, fixed camera.', seed,
    guidingFrames: [0, SECONDS * 24].map(frameIndex => ({ image: { ...image }, frameIndex, strength: 0.7 })),
  }));
}
function validateScenarioPreflight(name, discovery) {
  if (!SCENARIOS.has(name)) throw new Error('Unknown live scenario.');
  if (name === 'baseline') return;
  const c = discovery.capabilities;
  if (!c || c.object !== 'video.capabilities' || c.schema_version !== 1 || c.model !== MODEL || c.fps !== 24 ||
      c.seconds?.min !== 1 || c.seconds?.max !== 12 || !c.sizes?.includes(SIZE) ||
      c.seed?.encoding !== 'decimal_string' || c.seed?.min !== '0' || c.seed?.max !== '18446744073709551614') {
    throw new Error('Advanced scenario requires the current validated video capabilities contract, model, size and exact seed encoding. No generation was submitted.');
  }
  if (name === 'camera') {
    for (const id of ['camera-dolly-in', 'camera-static']) {
      const adapter = discovery.adapters?.find(item => item.id === id);
      if (!adapter || adapter.supported !== true || adapter.installed !== true || !Array.isArray(adapter.requires) || adapter.requires.length) {
        throw new Error(`Camera scenario requires supported, installed ${id} with no additional input requirements. No generation was submitted.`);
      }
    }
  } else {
    const guides = c.guiding_frames;
    if (guides?.supported !== true || guides.available !== true || guides.frame_index_multiple !== 1 || guides.max_count < 2 ||
        !c.uploads?.mime_types?.includes('image/png') || c.uploads.max_total_bytes !== 33554432) {
      throw new Error('Guided-frames scenario requires available guiding-frame nodes, pixel-frame positions and PNG upload support. No generation was submitted.');
    }
  }
}
function validateResume(manifest, baseUrl) {
  if (!manifest || ![1, 2].includes(manifest.schemaVersion) || manifest.mode !== 'live') throw new Error('Unsupported live-run receipt.');
  if (manifest.baseUrl !== baseUrl) throw new Error('Resume endpoint differs from the saved endpoint; select the original EASEL_BASE_URL.');
  if (manifest.schemaVersion === 1) {
    if (manifest.scenario !== undefined || manifest.expectedJobs !== undefined) throw new Error('Legacy receipts cannot select an advanced scenario or change the job count.');
    if ((manifest.model !== undefined && manifest.model !== MODEL) || (manifest.seconds !== undefined && manifest.seconds !== SECONDS) || (manifest.size !== undefined && manifest.size !== SIZE)) throw new Error('Legacy receipt model or generation bounds differ from baseline.');
  } else {
    if (!SCENARIOS.has(manifest.scenario) || manifest.expectedJobs !== JOBS) throw new Error('Saved scenario or expected receipt count is invalid. Never submit replacements.');
    if (manifest.model !== MODEL || manifest.seconds !== SECONDS || manifest.size !== SIZE) throw new Error('Saved scenario bounds differ from the fixed model, duration or size.');
  }
  if (!Array.isArray(manifest.jobs) || manifest.jobs.length !== JOBS) throw new Error('Resume needs two saved receipts. Recover known IDs individually with the CLI; missing receipts must not trigger replacement generation.');
  manifest.jobs.forEach(job => checkReceipt(job));
  if (new Set(manifest.jobs.map(job => job.id)).size !== JOBS) throw new Error('Receipt IDs must be distinct.');
  return manifest;
}
function saveJson(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
const help = `Easel local video integration test (Node 22+, npm ci && npm run build)
  node scripts/test-live-video-workflow.cjs --probe
  node scripts/test-live-video-workflow.cjs --offline
  node scripts/test-live-video-workflow.cjs --live --allow-generation-cost [--scenario baseline|camera|guided-frames]
  node scripts/test-live-video-workflow.cjs --resume /path/printed/by/run
Optional: --timeout-seconds 1200 (30–3600; polling only, no replacement submissions)
Probe/live/resume require EASEL_API_KEY and EASEL_BASE_URL (HTTPS, or loopback HTTP).
No key argument, settings decryption, persisted credential, auto-generation retry, or remote render.
Each live scenario submits exactly 2 × 1 second, 512x320, ltx-2.5; default: baseline.
Advanced cases require current read-only capabilities and use exact decimal-string seeds.
Guided frames use only the committed synthetic PNG. No price is advertised by the API;
check your provider/host cost before opting in. Stop/timeout does NOT cancel accepted jobs.
Offline uses committed synthetic clips. It makes no network requests and proves no live API behavior.
Linux render modes need a desktop DISPLAY, or xvfb-run -a before the command.
Evidence contains source clips, job IDs, a fresh disposable app profile, timeline, and rendered WebM.
See docs/live-video-testing.md for coverage, recovery, retention, and limits.\n`;

async function loadProvider() {
  for (const name of ['video', 'easel', 'media-http']) if (!fs.existsSync(path.join(root, `packages/media-mcp/dist/${name}.js`))) throw new Error('Build the current provider first: npm run build');
  const load = name => import(pathToFileURL(path.join(root, `packages/media-mcp/dist/${name}.js`)).href);
  return { ...await load('video'), ...await load('easel'), ...await load('media-http') };
}
function endpoint(provider) {
  if (!process.env.EASEL_BASE_URL) throw new Error('Set EASEL_BASE_URL explicitly to the intended Easel server.');
  const baseUrl = provider.normalizeEaselBaseUrl(process.env.EASEL_BASE_URL);
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for a remote API key; HTTP is allowed only on loopback.');
  const apiKey = process.env.EASEL_API_KEY?.trim();
  if (!apiKey) throw new Error('Set EASEL_API_KEY in this local process environment; never put it in a command argument.');
  guardPublicResponse(baseUrl, apiKey);
  return { baseUrl, apiKey };
}
async function probe(provider, config) {
  const models = await provider.listModels(config);
  if (!models.includes(MODEL)) throw new Error(`The live catalog does not expose ${MODEL}; enable the video backend before generation.`);
  const result = { checkedAt: new Date().toISOString(), baseUrl: config.baseUrl, models, videoModelAvailable: true };
  const read = endpointPath => provider.requestJson(config.baseUrl + endpointPath,
    { method: 'GET', headers: provider.headers(config.apiKey), signal: AbortSignal.timeout(30_000) }, config.apiKey, fetch);
  try {
    const schema = await read('/openapi.json');
    const routes = { '/v1/models': 'get', '/v1/videos': 'post', '/v1/videos/{video_id}': 'get', '/v1/videos/{video_id}/content': 'get', '/v1/videos/queue/{video_id}': 'get', '/v1/images/jobs/{job_id}': 'get' };
    result.routes = Object.fromEntries(Object.entries(routes).map(([route, verb]) => [route, Boolean(schema.paths?.[route]?.[verb])]));
    if (Object.values(result.routes).includes(false)) throw new Error('Current server is missing a documented route.');
    result.schemaAvailable = true;
  } catch (error) { result.schemaAvailable = false; result.schemaNote = redact(error.message, config.apiKey); }
  try {
    result.capabilities = await provider.discoverVideoCapabilities({ ...config, model: MODEL });
  } catch (error) { result.capabilityNote = redact(error.message, config.apiKey); }
  try {
    result.adapters = await provider.listVideoLoras({ ...config, model: MODEL });
  } catch (error) { result.adapterNote = redact(error.message, config.apiKey); }
  return guardPublicResponse(result, config.apiKey);
}

// Runs inside sandboxed Electron; only managed bytes and timeline metadata enter it.
async function browserWorkflow(payload) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const bunny = globalThis.EaselMediabunny;
  check(await bunny.canEncodeVideo('vp8', { width: 512, height: 320, frameRate: 24 }) || await bunny.canEncodeVideo('vp9', { width: 512, height: 320, frameRate: 24 }), 'WebM video encoder unavailable.');
  check(await bunny.canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000 }), 'Opus audio encoder unavailable.');
  const decode = data => Uint8Array.from(atob(data), char => char.charCodeAt(0));
  const inputFor = data => new bunny.Input({ source: new bunny.BufferSource(decode(data)), formats: [bunny.MP4, bunny.WEBM] });
  if (payload.action === 'preflight') {
    const input = inputFor(payload.fixture);
    try {
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
      check(video && await video.canDecode(), 'MP4/H.264 decoder unavailable.');
      check(audio && await audio.canDecode(), 'MP4/AAC decoder unavailable.');
      check(await new bunny.CanvasSink(video).getCanvas(0), 'Fixture video did not decode.');
      check(await new bunny.AudioBufferSink(audio).getBuffer(0), 'Fixture audio did not decode.');
    } finally { input.dispose(); }
    return { preflight: true, ua: navigator.userAgent };
  }
  const metadata = [];
  for (const asset of payload.sources) {
    const input = inputFor(asset.data);
    try {
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
      check(video && await video.canDecode(), 'Generated source video cannot be decoded.');
      check(!audio || await audio.canDecode(), 'Generated source audio cannot be decoded.');
      const duration = await input.computeDuration();
      check(duration >= 0.75 && duration <= 14, 'Unexpected source duration.');
      const frame = await new bunny.CanvasSink(video).getCanvas(0.25);
      check(frame, 'Source has no frame at trim start.');
      metadata.push({ width: frame.canvas.width, height: frame.canvas.height, duration, includesAudio: Boolean(audio) });
    } finally { input.dispose(); }
  }
  if (payload.action === 'inspect') return { metadata };
  let progressFinished = false;
  const result = await EaselVideoExport.exportVideoTimeline({ timeline: payload.timeline,
    getAsset: async id => payload.assets[id], name: 'Live API stitched verification',
    onProgress: value => { if (value.progress === 1) progressFinished = true; } });
  check(progressFinished && result.frameCount === 24 && result.timelineDuration === 1, 'Timeline/export frame count or duration mismatch.');
  check(result.mimeType === 'video/webm' && result.includesAudio, 'Expected WebM video plus the independent audio layer.');
  const output = inputFor(result.data);
  let decodedFrames = 0, decodedAudioSamples = 0;
  const cutComparisons = [];
  try {
    const video = await output.getPrimaryVideoTrack(), audio = await output.getPrimaryAudioTrack();
    check(video && audio && await video.canDecode() && await audio.canDecode(), 'Exported A/V tracks cannot be decoded.');
    const sink = new bunny.CanvasSink(video);
    for await (const _frame of sink.canvases()) decodedFrames++;
    check(decodedFrames === 24, 'Export did not decode to 24 frames.');
    for await (const segment of new bunny.AudioBufferSink(audio).buffers()) decodedAudioSamples += segment.buffer.length;
    check(decodedAudioSamples > 0, 'Exported audio is empty.');
    // Two image comparisons verify the actual hard-cut order against the generated
    // source pixels, rather than requiring unpredictable generation prompt fidelity.
    for (const [index, outputTime] of [[1, 0], [0, 0.5]]) {
      const source = inputFor(payload.sources[index].data);
      try {
        const reference = await new bunny.CanvasSink(await source.getPrimaryVideoTrack()).getCanvas(0.25);
        const rendered = await sink.getCanvas(outputTime);
        const pixels = canvas => {
          const small = new OffscreenCanvas(24, 24), context = small.getContext('2d');
          const side = Math.min(canvas.width, canvas.height) * 0.5;
          context.drawImage(canvas, (canvas.width - side) / 2, (canvas.height - side) / 2, side, side, 0, 0, 24, 24);
          return context.getImageData(0, 0, 24, 24).data;
        };
        const expected = pixels(reference.canvas), actual = pixels(rendered.canvas);
        const difference = expected.reduce((sum, value, offset) => sum + (offset % 4 === 3 ? 0 : Math.abs(value - actual[offset])), 0) / (24 * 24 * 3);
        check(difference < 35, 'Decoded export does not match the reordered source at the cut boundary.');
        cutComparisons.push({ sourceIndex: index, outputTime, meanChannelDifference: difference });
      } finally { source.dispose(); }
    }
  } finally { output.dispose(); }
  return { result, evidence: { decodedFrames, decodedAudioSamples, cutComparisons, sourceMetadata: metadata, ua: navigator.userAgent } };
}

function electronRun(directory, payload) {
  if (process.platform === 'linux' && !process.env.DISPLAY) throw new Error('No DISPLAY. Run in a desktop session or use xvfb-run -a before this command. No generation has been submitted by this renderer step.');
  if (!fs.existsSync(path.join(root, 'canvas-kits/mediabunny.js'))) throw new Error('Build the current runtime first: npm run build');
  const work = fs.mkdtempSync(path.join(directory, 'renderer-'));
  fs.writeFileSync(path.join(work, 'payload.json'), JSON.stringify(payload), { mode: 0o600 });
  fs.writeFileSync(path.join(work, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Easel integration verification</title>');
  fs.mkdirSync(path.join(work, 'runtime'), { mode: 0o700 });
  // Intentionally allowlist OS display/system variables. API keys never reach Electron.
  const env = Object.fromEntries(['PATH', 'DISPLAY', 'XAUTHORITY', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LD_LIBRARY_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { EASEL_VIDEO_TEST_RENDERER: work, HOME: work, XDG_CONFIG_HOME: work, XDG_CACHE_HOME: work, XDG_RUNTIME_DIR: path.join(work, 'runtime') });
  const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=x11'] : []), __filename];
  const child = spawnSync(require('electron'), args, { env, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(`Local renderer failed: ${child.error?.message || child.stderr || child.stdout || child.status}`);
  return JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8'));
}
async function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const directory = process.env.EASEL_VIDEO_TEST_RENDERER;
  if (!directory) throw new Error('Renderer child needs its isolated test directory.');
  app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'canvas-kits/mediabunny.js'), 'utf8') + '\n;globalThis.EaselMediabunny = EaselMediabunny; void 0;');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'src/video-timeline-export.js'), 'utf8'));
    const payload = JSON.parse(fs.readFileSync(path.join(directory, 'payload.json'), 'utf8'));
    const result = await win.webContents.executeJavaScript(`(${browserWorkflow.toString()})(${JSON.stringify(payload)})`);
    saveJson(path.join(directory, 'result.json'), result); app.exit(0);
  } catch (error) { console.error(error.message); app.exit(1); }
}

async function localWorkflow(directory, sources) {
  const { createAssetStore } = require('../src/asset-store');
  const { createCanvasMediaStore } = require('../src/canvas-media-store');
  const { createCanvasStore } = require('../src/canvas-store');
  const { createVideoTimelineStore } = require('../src/video-timeline-store');
  const { createVideoTimelineController } = require('../src/video-timeline-controller');
  const { importMediaFiles } = require('../src/media-import');
  const profile = fs.mkdtempSync(path.join(directory, 'app-profile-'));
  const imageStore = createAssetStore({ userDataPath: profile }), mediaStore = createCanvasMediaStore({ userDataPath: profile });
  const sourceBytes = sources.map(filename => fs.readFileSync(filename));
  const sourceHashes = sourceBytes.map(hash);
  const mediaPayload = sourceBytes.map(bytes => ({ data: bytes.toString('base64'), mimeType: bytes.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4' : 'video/webm' }));
  const { metadata } = electronRun(directory, { action: 'inspect', sources: mediaPayload });
  const fixture = filename => path.join(root, 'test/fixtures/video-export', filename);
  const filenames = [...sources, fixture('tone.wav'), fixture('overlay.png')];
  const imported = await importMediaFiles({ filenames, imageStore, mediaStore });
  assert.equal(imported.errors.length, 0, `Managed import failed: ${JSON.stringify(imported.errors)}`);
  assert.equal(imported.assets.length, 4);
  for (let i = 0; i < 2; i++) await mediaStore.updateMetadata(imported.assets[i].assetId, { width: metadata[i].width, height: metadata[i].height, duration: metadata[i].duration });
  const timelineStore = createVideoTimelineStore({ userDataPath: profile });
  const projectStore = createCanvasStore({ userDataPath: profile, readTimeline: id => timelineStore.read(id), assetStore: { get: async id => {
    try { return await mediaStore.get(id); } catch (error) { if (!/not found/i.test(error.message)) throw error; return imageStore.get(id); }
  } } });
  const project = projectStore.createProject({ title: 'Local video integration verification', kits: ['canvas-2d'] });
  await projectStore.attachAssets(project.id, { assetIds: imported.assets.map(asset => asset.assetId) });
  const controller = createVideoTimelineController({ store: timelineStore, projectStore, getActiveProjectId: () => project.id });
  controller.create(project.id, { width: 512, height: 320, frameRate: { numerator: 24, denominator: 1 } });
  const item = (id, index, startFrame, endFrame, trackId = 'video-1', sourceStartSeconds = 0) => ({ id, assetId: imported.assets[index].assetId, trackId, startFrame, endFrame, sourceStartSeconds, sourceEndSeconds: sourceStartSeconds + (endFrame - startFrame) / 24 });
  let timeline = controller.apply(project.id, { expectedRevision: 0, operations: [
    { type: 'insert', item: item('clip-a', 0, 0, 18) }, { type: 'insert', item: item('clip-b', 1, 18, 36) },
  ] });
  timeline = controller.apply(project.id, { expectedRevision: timeline.revision, operations: [
    { type: 'trim', itemId: 'clip-a', startFrame: 0, endFrame: 12, sourceStartSeconds: 0.25, sourceEndSeconds: 0.75 },
    { type: 'trim', itemId: 'clip-b', startFrame: 18, endFrame: 30, sourceStartSeconds: 0.25, sourceEndSeconds: 0.75 },
    { type: 'move', itemId: 'clip-a', startFrame: 12 }, { type: 'move', itemId: 'clip-b', startFrame: 0 },
    { type: 'insert', item: { ...item('sound', 2, 6, 18, 'audio-1'), gain: 0.5, fadeInFrames: 3, fadeOutFrames: 3 } },
    { type: 'insert', item: item('overlay', 3, 6, 12, 'overlay-1') },
  ] });
  assert.deepEqual(createVideoTimelineStore({ userDataPath: profile }).read(project.id), timeline, 'Timeline did not survive reload.');
  const assets = Object.fromEntries(imported.assets.map(asset => [asset.assetId, projectStore.getAsset(project.id, asset.assetId)]));
  const { result, evidence } = electronRun(directory, { action: 'render', sources: mediaPayload, timeline, assets });
  const exportId = await mediaStore.save({ ...result, name: 'Stitched integration export.webm' });
  await projectStore.attachAssets(project.id, { assetIds: [exportId] });
  const savedExport = await mediaStore.get(exportId), output = Buffer.from(savedExport.data, 'base64');
  assert.equal(hash(output), hash(Buffer.from(result.data, 'base64')));
  for (let i = 0; i < 2; i++) {
    assert.equal(hash(fs.readFileSync(sources[i])), sourceHashes[i], 'Downloaded source file changed.');
    assert.equal(hash(Buffer.from((await mediaStore.get(imported.assets[i].assetId)).data, 'base64')), sourceHashes[i], 'Library source changed.');
    assert.equal(hash(Buffer.from(projectStore.getAsset(project.id, imported.assets[i].assetId).data, 'base64')), sourceHashes[i], 'Project source changed.');
  }
  fs.writeFileSync(path.join(directory, 'stitched.webm'), output, { mode: 0o600 });
  saveJson(path.join(directory, 'timeline.json'), timeline);
  return { ...evidence, profile, projectId: project.id, exportAssetId: exportId, sourceHashes, sourceHashesUnchanged: true,
    importedAssetIds: imported.assets.map(asset => asset.assetId), outputBytes: output.length, outputSha256: hash(output),
    frameCount: result.frameCount, duration: result.duration, timelineDuration: result.timelineDuration, codec: result.codec,
    stages: ['managed import', 'library save', 'project attachment', 'typed trim/reorder', 'timeline reload', 'WebCodecs render', 'decoded cut verification', 'render library save', 'render project attachment', 'source hash verification'] };
}

async function run(args = process.argv.slice(2), dependencies = {}) {
  const runtime = { loadProvider, electronRun, localWorkflow, ...dependencies };
  const options = parseOptions(args);
  if (options.mode === 'help') { process.stdout.write(help); return; }
  const provider = options.mode !== 'offline' ? await runtime.loadProvider() : null;
  const config = provider ? endpoint(provider) : null;
  if (options.mode === 'probe') { console.log(JSON.stringify(await probe(provider, config), null, 2)); return; }
  const directory = options.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'easel-video-integration-'));
  console.log(`Evidence directory: ${directory}`);
  const fixture = name => path.join(root, 'test/fixtures/video-export', name);
  runtime.electronRun(directory, { action: 'preflight', fixture: fs.readFileSync(fixture('red.mp4')).toString('base64') });
  let manifest, sources;
  const receiptFile = path.join(directory, 'receipts.json');
  if (options.mode === 'offline') sources = ['red.mp4', 'blue.mp4'].map(filename => {
    const destination = path.join(directory, filename); fs.copyFileSync(fixture(filename), destination, fs.constants.COPYFILE_EXCL); return destination;
  });
  else {
    if (options.mode === 'resume') {
      if (fs.statSync(receiptFile).size > 64 * 1024) throw new Error('Receipt file is oversized.');
      manifest = validateResume(guardPublicResponse(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), config.apiKey), config.baseUrl);
    } else {
      const discovery = await probe(provider, config);
      saveJson(path.join(directory, 'discovery.json'), discovery);
      const scenario = options.scenario || 'baseline';
      validateScenarioPreflight(scenario, discovery);
      const requests = scenarioRequests(scenario);
      assert.equal(requests.length, JOBS, 'Scenario must keep the fixed two-job budget.');
      manifest = { schemaVersion: 2, mode: 'live', scenario, expectedJobs: JOBS, createdAt: new Date().toISOString(), baseUrl: config.baseUrl, model: MODEL, size: SIZE, seconds: SECONDS, jobs: [] };
      saveJson(receiptFile, manifest);
      console.log(`Submitting scenario ${scenario}: exactly two 1-second 512x320 jobs. Charges are provider-dependent; generation POSTs will never be retried.`);
      for (let index = 0; index < JOBS; index++) {
        manifest.jobs.push({ submissionStarted: true }); saveJson(receiptFile, manifest);
        const job = recordSubmissionReceipt(manifest, index, await provider.generateVideo({ ...config, ...requests[index] }), receiptFile, config.apiKey);
        console.log(`Accepted source ${index + 1}: ${job.id}`);
      }
    }
    const deadline = Date.now() + options.timeoutSeconds * 1000;
    sources = [];
    for (let index = 0; index < JOBS; index++) {
      const id = manifest.jobs[index].id;
      for (;;) {
        if (Date.now() >= deadline) throw new Error('Polling timeout. Accepted jobs may still run. Resume this directory to retrieve the same IDs; no replacements were generated.');
        const response = await provider.getVideo({ ...config, model: MODEL, videoId: id, waitSeconds: 0, download: true, includeQueue: true,
          signal: AbortSignal.timeout(Math.max(1, Math.min(45_000, deadline - Date.now()))) });
        manifest.jobs[index] = checkReceipt(response.job, id, config.apiKey); saveJson(receiptFile, manifest);
        if (['failed', 'cancelled'].includes(response.job.status)) throw new Error(`Source ${index + 1} ${response.job.status}: ${response.job.error || 'inspect this job on the server'}. No replacement was submitted.`);
        if (response.job.status === 'completed') {
          if (!response.media?.data) throw new Error('Completed job returned no downloadable media.');
          const filename = path.join(directory, `source-${index + 1}.${response.media.mimeType === 'video/webm' ? 'webm' : 'mp4'}`);
          const bytes = Buffer.from(response.media.data, 'base64');
          if (fs.existsSync(filename)) assert.equal(hash(fs.readFileSync(filename)), hash(bytes), 'Existing source differs; refusing overwrite.');
          else fs.writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' });
          sources.push(filename); break;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(1, deadline - Date.now()))));
      }
    }
  }
  const evidence = { directory, mode: options.mode === 'offline' ? 'offline-fixtures' : 'live-api', liveGenerationVerified: options.mode !== 'offline',
    ...(manifest ? { scenario: manifest.scenario || 'baseline', baseUrl: manifest.baseUrl, jobs: manifest.jobs.map(({ id, status }) => ({ id, status })) } : {}),
    ...await runtime.localWorkflow(directory, sources) };
  saveJson(path.join(directory, 'evidence.json'), evidence);
  console.log(JSON.stringify(evidence, null, 2)); console.log(`Verified output: ${path.join(directory, 'stitched.webm')}`);
  return evidence;
}
module.exports = { parseOptions, checkReceipt, validateResume, redact, probe, recordSubmissionReceipt, scenarioRequests, validateScenarioPreflight, run };
if (require.main === module || (process.versions.electron && process.env.EASEL_VIDEO_TEST_RENDERER)) {
  const start = process.versions.electron ? electronMain : run;
  start().catch(error => { console.error(redact(error.message, process.env.EASEL_API_KEY || '')); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
}
