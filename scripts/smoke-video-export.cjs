// Real Electron/WebCodecs smoke. All source fixtures are synthetic and committed;
// no network, FFmpeg, Python, camera, microphone, GPU or user media is required.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, 'test/fixtures/video-export');

async function browserSmoke(payload) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const bunny = globalThis.EaselMediabunny;
  const timeline = { schemaVersion: 1, id: 'smoke', revision: 0, frameRate: { numerator: 24, denominator: 1 }, width: 96, height: 64,
    tracks: [{ id: 'video', type: 'video' }, { id: 'sound', type: 'audio' }, { id: 'overlay', type: 'overlay' }], transitions: [],
    items: [
      { id: 'b', trackId: 'video', assetId: 'b'.repeat(64), startFrame: 0, endFrame: 12, sourceStartSeconds: 0.25, sourceEndSeconds: 0.75, gain: 0.5 },
      { id: 'a', trackId: 'video', assetId: 'a'.repeat(64), startFrame: 12, endFrame: 24, sourceStartSeconds: 0.25, sourceEndSeconds: 0.75, gain: 0.5 },
      { id: 'music', trackId: 'sound', assetId: 'c'.repeat(64), startFrame: 6, endFrame: 18, sourceStartSeconds: 0, sourceEndSeconds: 0.5, gain: 0.5, fadeInFrames: 3, fadeOutFrames: 3 },
      { id: 'still', trackId: 'overlay', assetId: 'd'.repeat(64), startFrame: 6, endFrame: 12, sourceStartSeconds: 0, sourceEndSeconds: 0.25 },
    ] };
  const getAsset = async id => payload[id];
  const progress = [];
  const result = await EaselVideoExport.exportVideoTimeline({ timeline, getAsset, name: 'Synthetic export smoke', onProgress: value => progress.push(value) });
  check(result.timelineDuration === 1 && result.duration >= 1 && result.duration <= 1.03, 'Encoded duration metadata must distinguish codec padding from the timeline.');
  check(result.frameCount === 24 && result.includesAudio && result.mimeType === 'video/webm', 'Wrong export metadata.');
  check(progress.at(-1).progress === 1, 'Export did not finish progress.');
  const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
  const input = new bunny.Input({ source: new bunny.BufferSource(bytes), formats: [bunny.WEBM] });
  let frameCount = 0;
  const samples = [];
  const tones = [];
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    check(video && audio, 'Export did not mux both video and audio.');
    const sink = new bunny.CanvasSink(video);
    for await (const frame of sink.canvases()) {
      const pixels = frame.canvas.getContext('2d').getImageData(48, 32, 1, 1).data;
      samples.push([...pixels]); frameCount++;
    }
    check(frameCount === 24, `Expected 24 frames, decoded ${frameCount}.`);
    check(samples[0][2] > 180 && samples[5][2] > 180, 'Reordered first blue clip is missing.');
    check(samples[6][0] > 160 && samples[6][1] > 160 && samples[11][1] > 160, 'Image overlay boundaries are wrong.');
    check(samples[12][0] > 180 && samples[12][2] < 80 && samples[23][0] > 180, 'Trimmed second red clip or hard-cut boundary is wrong.');
    const rate = 48000, pcm = new Float32Array(rate * 2);
    for await (const part of new bunny.AudioBufferSink(audio).buffers()) {
      const data = part.buffer.getChannelData(0);
      const start = Math.round(part.timestamp * rate);
      for (let i = 0; i < data.length; i++) if (start + i >= 0 && start + i < pcm.length) pcm[start + i] = data[i];
    }
    const energy = (frequency, t) => {
      const from = Math.round(t * rate), n = 2400; let re = 0, im = 0;
      for (let i = 0; i < n; i++) { re += pcm[from + i] * Math.cos(2 * Math.PI * frequency * i / rate); im += pcm[from + i] * Math.sin(2 * Math.PI * frequency * i / rate); }
      return Math.hypot(re, im) * 2 / n;
    };
    for (const t of [0.1, 0.4, 0.6, 0.9]) tones.push({ t, a440: energy(440, t), b660: energy(660, t), bed880: energy(880, t) });
    check(tones[0].b660 > 0.025 && tones[0].a440 < 0.005 && tones[0].bed880 < 0.005, 'First retained source audio is wrong.');
    check(tones[1].b660 > 0.025 && tones[1].bed880 > 0.025, 'Independent audio layer is not mixed with first source.');
    check(tones[2].a440 > 0.025 && tones[2].bed880 > 0.025, 'Independent audio layer is not mixed with second source.');
    check(energy(880, 0.26) < tones[1].bed880 * 0.6 && energy(880, 0.69) < tones[1].bed880 * 0.6, 'Audio fades were not applied.');
    check(tones[3].a440 > 0.025 && tones[3].b660 < 0.005 && tones[3].bed880 < 0.005, 'Final audio trim boundary is wrong.');
  } finally { input.dispose(); }
  // A later video track must cover an earlier overlay, matching stored track order.
  const stacked = JSON.parse(JSON.stringify(timeline));
  stacked.tracks.push({ id: 'foreground', type: 'video' });
  stacked.items.push({ id: 'cover', trackId: 'foreground', assetId: 'a'.repeat(64), startFrame: 6, endFrame: 12,
    sourceStartSeconds: 0.25, sourceEndSeconds: 0.5, gain: 0 });
  const trackOrderResult = await EaselVideoExport.exportVideoTimeline({ timeline: stacked, getAsset });
  const trackOrderInput = new bunny.Input({ source: new bunny.BufferSource(Uint8Array.from(atob(trackOrderResult.data), c => c.charCodeAt(0))), formats: [bunny.WEBM] });
  try {
    const frame = await new bunny.CanvasSink(await trackOrderInput.getPrimaryVideoTrack()).getCanvas(6 / 24);
    const color = frame.canvas.getContext('2d').getImageData(48, 32, 1, 1).data;
    check(color[0] > 180 && color[1] < 80 && color[2] < 80, 'Export layer order differs from stored track order: a later video must cover an earlier overlay.');
  } finally { trackOrderInput.dispose(); }
  const controller = new AbortController(); let wasAborted = false;
  try { await EaselVideoExport.exportVideoTimeline({ timeline, getAsset, signal: controller.signal,
    onProgress: value => { if (value.phase === 'rendering') controller.abort(); } }); }
  catch (error) { wasAborted = error.name === 'AbortError'; }
  check(wasAborted, 'In-progress export did not cancel with AbortError.');
  const finalController = new AbortController(); let finalAbort = false;
  try { await EaselVideoExport.exportVideoTimeline({ timeline, getAsset, signal: finalController.signal,
    onProgress: value => { if (value.progress === 1) finalController.abort(); } }); }
  catch (error) { finalAbort = error.name === 'AbortError'; }
  check(finalAbort, 'Cancellation before returning a finished export must discard the result.');
  let malformedFailed = false;
  try { await EaselVideoExport.exportVideoTimeline({ timeline, getAsset: async () => ({ data: 'AAAA', mimeType: 'video/mp4' }) }); }
  catch (error) { malformedFailed = /malformed|unsupported|parse|format/i.test(error.message); }
  check(malformedFailed, 'Malformed source did not fail clearly.');
  const repeated = await EaselVideoExport.exportVideoTimeline({ timeline, getAsset });
  check(repeated.frameCount === 24 && repeated.includesAudio, 'Export after cancellation did not recover.');
  return { result, trackOrderData: trackOrderResult.data, repeatedData: repeated.data, evidence: { frameCount, tones, samples: { first: samples[0], overlay: samples[6], afterCut: samples[12], last: samples[23] },
    storedTrackOrder: true, cancellation: true, malformedRejected: true, duration: result.duration, timelineDuration: result.timelineDuration, ua: navigator.userAgent, includesAudio: result.includesAudio, codec: result.codec } };
}

async function electronMain() {
  const { app, BrowserWindow } = require('electron');
  const dir = process.env.EASEL_EXPORT_SMOKE_DIR;
  app.setPath('userData', path.join(dir, 'user-data'));
  app.setPath('cache', path.join(dir, 'cache'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  try {
    await win.loadFile(path.join(dir, 'index.html'));
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'canvas-kits/mediabunny.js'), 'utf8') + '\n;globalThis.EaselMediabunny = EaselMediabunny; void 0;');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'src/video-timeline-export.js'), 'utf8'));
    const payload = {};
    const fixtureHashes = {};
    const digest = filename => crypto.createHash('sha256').update(fs.readFileSync(path.join(fixtureDir, filename))).digest('hex');
    for (const [id, filename, mimeType] of [['a', 'red.mp4', 'video/mp4'], ['b', 'blue.mp4', 'video/mp4'], ['c', 'tone.wav', 'audio/wav'], ['d', 'overlay.png', 'image/png']]) {
      fixtureHashes[filename] = digest(filename);
      payload[id.repeat(64)] = { data: fs.readFileSync(path.join(fixtureDir, filename)).toString('base64'), mimeType };
    }
    const value = await win.webContents.executeJavaScript(`(${browserSmoke.toString()})(${JSON.stringify(payload)})`);
    for (const [filename, hash] of Object.entries(fixtureHashes)) if (digest(filename) !== hash) throw new Error('Export modified a source fixture.');
    value.evidence.sourceHashesUnchanged = fixtureHashes;
    const bytes = Buffer.from(value.result.data, 'base64');
    fs.writeFileSync(path.join(dir, 'output.webm'), bytes);
    fs.writeFileSync(path.join(dir, 'track-order.webm'), Buffer.from(value.trackOrderData, 'base64'));
    fs.writeFileSync(path.join(dir, 'repeated.webm'), Buffer.from(value.repeatedData, 'base64'));
    const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
    value.evidence.bytes = bytes.length;
    value.evidence.sha256 = hash(bytes);
    value.evidence.repeatedSha256 = hash(Buffer.from(value.repeatedData, 'base64'));
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(value.evidence, null, 2));
    console.log(JSON.stringify(value.evidence, null, 2));
    app.exit(0);
  } catch (error) { console.error(error.stack || error); app.exit(1); }
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-export-smoke-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Synthetic export smoke</title>');
  fs.mkdirSync(path.join(dir, 'runtime'));
  const env = { ...process.env, EASEL_EXPORT_SMOKE_DIR: dir, HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'runtime') };
  if (process.platform === 'linux' && !env.DISPLAY) {
    throw new Error('No DISPLAY available. Run in a desktop session or use xvfb-run -a npm run test:video-export.');
  }
  const executable = require('electron');
  const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=x11'] : []), __filename];
  const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(path.join(dir, 'electron.log'), `${result.stdout || ''}\n${result.stderr || ''}`);
  if (result.error || result.status !== 0) throw new Error(`Electron smoke failed (${result.status}): ${result.error || result.stderr || result.stdout}`);
  process.stdout.write(result.stdout);
  process.stdout.write(`Smoke evidence: ${dir}\n`);
}
if (process.versions.electron) electronMain().catch(error => { console.error(error); require('electron').app.exit(1); });
else run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
