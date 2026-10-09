// Disposable, bounded native-synth probe. Never attach to a running Easel app.
// No GPU, remote debugging, network, Node access in renderers, or CSP relaxation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { buildCanvasDocument, CSP } = require('../src/canvas-policy');
const { createStrudelTemplate } = require('../src/strudel-template');
const { renderCanvasInputScript } = require('../src/canvas-input-runtime');
const root = path.resolve(__dirname, '..');
const TIMEOUT_MS = 30_000;
// Pinned default CPS 0.5: 2s note + <=0.3s lookahead/latency + 0.06s tail.
// Waiting 3s after Stop ensures unmuting cannot expose any old fixture voice.
const OLD_VOICE_BOUND_SECONDS = 3;

function stopIsDrained(state) {
  return state.stopped && state.schedulerStarted === false && Number.isFinite(state.stoppedAt) &&
    state.audioTime >= state.stoppedAt + OLD_VOICE_BOUND_SECONDS &&
    state.peaks.length >= 10 && state.peaks.slice(-10).every((peak) => peak < 0.00001);
}

function hasRestartSignal(state) {
  return state.plays === 2 && state.schedulerStarted === true && state.peaks.length >= 10 &&
    state.peaks.slice(-10).every((peak) => peak > 0.001);
}

function summarizeProbeState(state = {}) {
  const clip = (value, limit = 1000) => String(value ?? '').slice(0, limit);
  const last = (values, limit) => Array.isArray(values) ? values.slice(-limit) : [];
  const peaks = last(state.peaks, 100).filter(Number.isFinite);
  const finite = (value) => Number.isFinite(value) ? value : null;
  return {
    phase: clip(state.phase, 80), ready: state.ready === true, playEvents: state.playEvents || 0, plays: state.plays || 0,
    audioState: clip(state.audioState, 40), audioTime: state.audioTime, schedulerStarted: state.schedulerStarted,
    gain: finite(state.gain), cps: finite(state.cps), activeAudioContexts: finite(state.activeAudioContexts),
    settings: state.settings ? { bpm: finite(state.settings.bpm), volume: finite(state.settings.volume),
      patternVersion: finite(state.settings.patternVersion), playing: typeof state.settings.playing === 'boolean' ? state.settings.playing : null } : null,
    trustedKeyboardPlay: state.trustedKeyboardPlay, stopped: state.stopped, stoppedAt: state.stoppedAt,
    peakCount: peaks.length, maxPeak: peaks.length ? Math.max(...peaks) : 0, lastPeak: peaks.at(-1),
    errors: last(state.errors, 20).map((error) => clip(error)),
    violations: last(state.violations, 20).map((item) => ({ directive: clip(item.directive, 100), blocked: clip(item.blocked, 200) })),
    nativeInput: last(state.nativeInput, 12).map((item) => ({ type: clip(item.type, 40), key: clip(item.key, 40),
      target: clip(item.target, 80), trusted: item.trusted === true, active: item.active === true })),
    logs: last(state.logs, 20).map((item) => ({ type: clip(item.type, 40), message: clip(item.message) })),
  };
}

function assertTemplateInitialSilence(state) {
  const checks = [
    [state.plays === 0, 'Starter scheduled playback before Play'],
    [state.gain === 0, 'Starter initial output gain must be 0'],
    [state.settings?.playing === false, 'Starter restored playback instead of only settings'],
  ];
  for (const [passed, message] of checks) {
    if (!passed) throw new Error(`${message}: ${JSON.stringify(summarizeProbeState(state))}`);
  }
}

async function waitForProbeState(read, predicate, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error(`${label} timed out: ${JSON.stringify(summarizeProbeState(value))}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function sendKeyboardActivation(win, id) {
  win.show();
  win.focus();
  win.webContents.focus();
  const deadline = Date.now() + 1000;
  while (!await win.webContents.executeJavaScript('document.hasFocus()')) {
    if (Date.now() >= deadline) throw new Error('Disposable playback document did not receive native focus.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).focus(); void 0;`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  // Electron keyDown becomes rawKeyDown. Chromium activates an Enter button
  // on keypress, so its native char event is required between down and up.
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}

async function pushStrudelCode(win, source) {
  const result = await win.webContents.executeJavaScript(`EaselStrudel.evaluate(${JSON.stringify(source)})`);
  if (!result?.ok) throw new Error(`Live Strudel evaluation failed: ${result?.error || 'no success receipt'}`);
}

function installDiagnostics() {
  window.probe = { errors: [], violations: [], plays: 0, playEvents: 0, peaks: [], ready: false, phase: 'initializing', nativeInput: [], logs: [] };
  for (const type of ['keydown', 'keypress', 'keyup', 'click']) {
    document.addEventListener(type, (event) => {
      probe.nativeInput.push({ type, key: event.key, target: event.target?.id, trusted: event.isTrusted, active: navigator.userActivation.isActive });
      if (probe.nativeInput.length > 12) probe.nativeInput.shift();
    }, true);
  }
  document.addEventListener('strudel.log', (event) => {
    probe.logs.push({ message: String(event.detail?.message || '').slice(0, 1000), type: event.detail?.type });
    if (probe.logs.length > 20) probe.logs.shift();
  });
  window.addEventListener('error', (event) => probe.errors.push(event.message));
  window.addEventListener('unhandledrejection', (event) => probe.errors.push(String(event.reason?.stack || event.reason)));
  document.addEventListener('securitypolicyviolation', (event) => probe.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
}

async function playbackProbe() {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const state = window.probe;
  try {
    const repl = await strudel.initStrudel({ sync: false });
    const context = strudel.getAudioContext();
    state.initialState = context.state;
    check(context.state === 'suspended', 'Opening the sketch must not start audio.');
    const output = strudel.getSuperdoughAudioController().output;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    output.destinationGain.connect(analyser);
    const values = new Float32Array(analyser.fftSize);
    setInterval(() => {
      analyser.getFloatTimeDomainData(values);
      let peak = 0;
      for (const value of values) peak = Math.max(peak, Math.abs(value));
      state.audioState = context.state;
      state.audioTime = context.currentTime;
      state.schedulerStarted = repl.scheduler.started;
      state.peaks.push(peak);
      if (state.peaks.length > 100) state.peaks.shift();
    }, 20);
    document.querySelector('#play').onclick = async (event) => {
      try {
        state.playEvents = (state.playEvents || 0) + 1;
        state.phase = 'play-click';
        check(event.isTrusted && navigator.userActivation.isActive, 'Play requires trusted keyboard activation.');
        state.trustedKeyboardPlay = event.detail === 0;
        // Upstream first-click initialization only observes mousedown. Keyboard
        // Play explicitly resumes and initializes the same native-only context.
        state.phase = 'resuming-audio';
        await context.resume();
        state.phase = 'initializing-native-audio';
        await strudel.initAudio({ disableWorklets: true });
        output.destinationGain.gain.setValueAtTime(1, context.currentTime);
        state.phase = 'scheduling-pattern';
        strudel.note('a4').s('sine').gain(0.3).release(0.05).play();
        state.plays++;
        state.phase = 'awaiting-sound';
      } catch (error) { state.errors.push(error.stack || String(error)); }
    };
    document.querySelector('#stop').onclick = () => {
      state.phase = 'stopping';
      strudel.hush();
      // hush stops scheduling; mute the output explicitly to silence tails.
      output.destinationGain.gain.setValueAtTime(0, context.currentTime);
      state.stopped = true;
      state.stoppedAt = context.currentTime;
    };
    state.dispose = async () => { strudel.hush(); output.disconnect(); await context.close(); };
    state.ready = true;
    state.phase = 'ready';
  } catch (error) { state.errors.push(error.stack || String(error)); }
}

async function offlineProbe() {
  const state = window.probe;
  try {
    const context = new OfflineAudioContext(2, 48_000, 48_000);
    strudel.setAudioContext(context);
    strudel.setSuperdoughAudioController(null);
    await strudel.registerSynthSounds();
    const waveforms = ['sine', 'triangle', 'square', 'sawtooth'];
    for (const [index, s] of waveforms.entries()) {
      await strudel.superdough({ note: 'a4', s, gain: 0.3, release: 0.01 }, index * 0.2 + 0.01, 0.12, 0.5, 0);
    }
    const buffer = await context.startRendering();
    state.offline = { sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
      frames: buffer.length, duration: buffer.duration, waveforms: [] };
    for (const [index, name] of waveforms.entries()) {
      const peaks = [];
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        let peak = 0;
        for (let frame = index * 9600; frame < (index + 1) * 9600; frame++) peak = Math.max(peak, Math.abs(data[frame]));
        if (!(peak > 0.001)) throw new Error(`${name}: empty channel ${channel}`);
        peaks.push(peak);
      }
      state.offline.waveforms.push({ name, peaks });
    }
    strudel.getSuperdoughAudioController().output.disconnect();
    strudel.setSuperdoughAudioController(null);
    strudel.setAudioContext(null);
    state.ready = true;
    state.phase = 'ready';
  } catch (error) { state.errors.push(error.stack || String(error)); }
}

function fixtureHtml(bundle, offline) {
  // Put diagnostics before the kit without moving the policy or changing it.
  const diagnostics = `<script>(${installDiagnostics.toString()})();</script>`;
  const html = buildCanvasDocument({ html: '<!doctype html><html><head><title>Disposable Strudel probe</title></head><body>' +
    '<button id="play">Play</button><button id="stop">Stop</button>' +
    `<script>(${(offline ? offlineProbe : playbackProbe).toString()})();</script></body></html>`,
  kits: ['strudel'], kitBundles: { strudel: bundle } });
  return html.replace('<script data-easel-canvas-kit="strudel">', diagnostics + '<script data-easel-canvas-kit="strudel">');
}

// A deliberately silent second pattern must not reveal the still-alive first
// eight-second voice. The separate original probe rejects no-op restarts.
function hasSilentTemplateRestart(state) {
  return state.plays === 2 && state.schedulerStarted === true && state.gain > 0 &&
    Number.isFinite(state.oldVoiceStartedAt) && state.audioTime >= state.oldVoiceStartedAt + 0.5 &&
    state.audioTime < state.oldVoiceStartedAt + 7 && state.peaks.length >= 10 &&
    state.peaks.slice(-10).every((peak) => peak < 0.00001);
}

function hasAudibleTemplateRestart(state) {
  return state.plays === 3 && state.schedulerStarted === true && state.gain > 0 &&
    state.peaks.length >= 10 && state.peaks.slice(-10).every((peak) => peak > 0.001);
}

function monitorTemplate(instanceId) {
  const state = window.probe;
  const context = strudel.getAudioContext();
  let node, analyser, values, wasPlaying = false;
  document.addEventListener('click', (event) => {
    if (event.target.id === `strudel-${instanceId}-play`) {
      state.playEvents++;
      state.trustedKeyboardPlay = event.isTrusted && event.detail === 0 && navigator.userActivation.isActive;
    }
  }, true);
  setInterval(() => {
    const output = strudel.getSuperdoughAudioController().output;
    if (output.destinationGain && node !== output.destinationGain) {
      analyser?.disconnect();
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      values = new Float32Array(analyser.fftSize);
      node = output.destinationGain;
      node.connect(analyser);
      state.peaks = [];
    }
    let peak = 0;
    analyser?.getFloatTimeDomainData(values);
    for (const value of values || []) peak = Math.max(peak, Math.abs(value));
    state.audioState = context.state;
    state.audioTime = context.currentTime;
    state.schedulerStarted = strudel.getIsStarted() === true;
    if (state.schedulerStarted && !wasPlaying) { state.plays++; state.oldVoiceStartedAt ??= context.currentTime; }
    wasPlaying = state.schedulerStarted;
    state.peaks.push(peak);
    if (state.peaks.length > 100) state.peaks.shift();
    state.settings = window.EaselStrudel?.getState();
    state.cps = strudel.getCps();
    state.gain = node?.gain.value;
    state.phase = document.getElementById(`strudel-${instanceId}-status`).textContent;
    state.ready = /^Ready/.test(state.phase);
    state.activeAudioContexts = EaselCanvas.inspect().audio.contexts.filter((entry) => entry.state !== 'closed').length;
  }, 20);
  state.dispose = async () => {
    const report = await EaselCanvas.cleanup();
    state.disposal = { ...report, audioState: context.state, schedulerStarted: strudel.getIsStarted() === true,
      activeAudioContexts: EaselCanvas.inspect().audio.contexts.filter((entry) => entry.state !== 'closed').length };
  };
}

// Test-only transport observes the real editable export action. No preload,
// Node, devices, network or general application bridge is added to a renderer.
function installExportFixtureHost() {
  window.EaselHost = {
    onStrudelExportContext(callback) { probe.exportContextListener = callback; return () => { delete probe.exportContextListener; }; },
    strudelExport(request) {
      if (request.action === 'cancel') { probe.cancelRequest = request; return Promise.resolve({ cancelled: true }); }
      probe.exportRequest = JSON.parse(JSON.stringify(request));
      return new Promise((resolve, reject) => { probe.exportResolve = resolve; probe.exportReject = reject; });
    },
  };
}

async function decodeExportWav(base64, snapshot) {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const decoder = new OfflineAudioContext(2, 1, 48000);
  const audio = await decoder.decodeAudioData(bytes.buffer);
  const peak = (begin, end) => {
    const channels = [];
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const data = audio.getChannelData(channel); let value = 0;
      for (let i = Math.ceil(begin * audio.sampleRate); i < Math.min(data.length, Math.floor(end * audio.sampleRate)); i++) value = Math.max(value, Math.abs(data[i]));
      channels.push(value);
    }
    return channels;
  };
  return { sampleRate: audio.sampleRate, channels: audio.numberOfChannels, frames: audio.length, duration: audio.duration,
    peaks: peak(0, audio.duration), latePeaks: peak(audio.duration - 1.2, audio.duration - 0.8),
    eventPeaks: snapshot.events.map(event => peak(event.timeSeconds + 0.03, event.timeSeconds + event.durationSeconds - 0.03)),
    // The fixture pattern deliberately has initial/interior rests and short tails.
    quietPeaks: [peak(0.05, 0.3), peak(1.15, 1.3), peak(2.15, 2.4)] };
}

function assertNativeLongNoteEvidence(result, eventCount) {
  if (eventCount <= 128 || result.sampleRate !== 48000 || result.channels !== 2 || result.frames !== 408000 || result.duration !== 8.5 || !Array.isArray(result.latePeaks) || result.latePeaks.length !== 2 || !result.latePeaks.every(peak => peak > 0.001)) throw new Error('The >128-event offline score lost its long note late segment through native stealing.');
}

async function proveProductionWavExport({ BrowserWindow, session, open, until, read, windows, requests, directory, decoderWindow, stage, check }) {
  const { createCanvasStore } = require('../src/canvas-store');
  const { createTemplateInstanceStore } = require('../src/template-instance-store');
  const { createCanvasMediaStore } = require('../src/canvas-media-store');
  const { createStrudelExportRenderer } = require('../src/strudel-export-renderer');
  const { createStrudelExportController } = require('../src/strudel-export-controller');
  const { createStrudelExportBridge, assertStrudelScope } = require('../src/strudel-export-bridge');
  const { validateStrudelWav } = require('../src/strudel-export-policy');
  const { captureStrudelSamples } = require('../src/strudel-sample-assets');
  const userDataPath = path.join(directory, 'wav-media-proof');
  const media = createCanvasMediaStore({ userDataPath });
  const bundle = fs.readFileSync(path.join(root, 'canvas-kits/strudel.js'), 'utf8');
  const store = createCanvasStore({ userDataPath, kitBundles: { strudel: bundle }, assetStore: media });
  const instances = createTemplateInstanceStore({ userDataPath, projectStore: store });
  const instanceId = 'e'.repeat(32), documentPath = `sketches/${instanceId}/index.html`;
  const source = createStrudelTemplate({ instanceId });
  const project = store.createTemplateDocument({ title: 'WAV proof', path: documentPath, kits: ['strudel'],
    html: source.files[source.entry].replace("note('c4 e4 g4 b4')", "note('~ c4 ~ g4')") },
  ({ projectId }) => instances.create({ projectId, instanceId, documentPath, templateId: 'strudel-sound', templateVersion: 1 }));
  const scopeOptions = { projectStore: store, instances, view: { getCurrentCanvasId: () => project.id, getCurrentDocumentPath: () => documentPath,
    getContract: () => ({ runtimeGeneration: 1, loading: false, previewHidden: false, sourcePendingReload: false }) } };
  const renderer = createStrudelExportRenderer({ BrowserWindow: function ExportWindow(options) { const win = new BrowserWindow(options); windows.push(win); return win; },
    sessionFactory: async partition => {
      const isolated = session.fromPartition(partition, { cache: false });
      return { partition, session: { protocol: isolated.protocol,
        setPermissionCheckHandler: handler => isolated.setPermissionCheckHandler(handler),
        setPermissionRequestHandler: handler => isolated.setPermissionRequestHandler(handler),
        webRequest: { onBeforeRequest: (filter, handler) => isolated.webRequest.onBeforeRequest(filter, (details, callback) => handler(details, decision => { if (decision.cancel) requests.push(details.url); callback(decision); })) } } };
    } });
  const controller = createStrudelExportController({ render: renderer.renderStrudelSnapshot, saveMedia: media.save, findExport: media.findExport,
    isAttached: async (projectId, assetId) => store.getProject(projectId).manifest.assets.some(asset => asset.id === assetId),
    attach: (projectId, assetIds, beforeCommit) => store.attachAssets(projectId, { assetIds }, { beforeCommit }),
    assertScope: captured => assertStrudelScope(captured, scopeOptions), captureDependency: captured => store.getProjectKitSource(captured.projectId, 'strudel'),
    captureSamples: (captured, snapshot) => captureStrudelSamples(store, captured.projectId, snapshot) });
  const bridge = createStrudelExportBridge({ ...scopeOptions, controller, exportReady: true });
  const sound = await open('export.html');
  await until(sound, state => state.ready, 'wav-template-ready');
  await pushStrudelCode(sound, "note('~ c4 ~ g4').s('sine')");
  const context = await bridge.handle({ action: 'context' });
  await sound.webContents.executeJavaScript(`probe.exportContextListener(${JSON.stringify(context)}); document.getElementById('strudel-${instanceId}-bpm').value = '120'; document.getElementById('strudel-${instanceId}-bpm').dispatchEvent(new Event('input')); void 0;`);
  await sendKeyboardActivation(sound, `strudel-${instanceId}-play`);
  await until(sound, state => state.schedulerStarted && state.peaks.some(value => value > 0.001), 'wav-live-playing');
  await sound.webContents.executeJavaScript('window.__exportLiveIdentity = { context: strudel.getAudioContext(), controller: strudel.getSuperdoughAudioController(), time: strudel.getAudioContext().currentTime }; void 0;');
  const decoded = [], receipts = [];
  for (const volume of [1, 0.5, 0]) {
    await sound.webContents.executeJavaScript(`probe.exportRequest = null; document.getElementById('strudel-${instanceId}-volume').value = '${volume}'; document.getElementById('strudel-${instanceId}-volume').dispatchEvent(new Event('input')); EaselStrudel.exportLoop(); void 0;`);
    const request = (await until(sound, state => !!state.exportRequest, `wav-snapshot-volume-${volume}`)).exportRequest;
    const receipt = await bridge.handle(request);
    check(receipt.attachmentStatus === 'attached' && receipt.projectId === project.id, 'WAV was not attached to its captured project.');
    await sound.webContents.executeJavaScript(`probe.exportResolve(${JSON.stringify(receipt)}); void 0;`);
    const asset = await media.get(receipt.assetId);
    const timing = validateStrudelWav(Buffer.from(asset.data, 'base64'), request.input.snapshot);
    const reopened = await createCanvasMediaStore({ userDataPath }).getPlaybackSource(receipt.assetId);
    check(fs.readFileSync(reopened.filename).equals(Buffer.from(asset.data, 'base64')), 'Saved/reopened byte integrity differs.');
    const result = await decoderWindow.webContents.executeJavaScript(`(${decodeExportWav.toString()})(${JSON.stringify(asset.data)},${JSON.stringify(request.input.snapshot)})`);
    check(result.sampleRate === 48000 && result.channels === 2 && result.frames === timing.frames && result.duration === 2.5, 'Decoded WAV frame/header contract failed.');
    if (volume) {
      check(result.eventPeaks.every(peaks => peaks.every(value => value > 0.001)), 'A queried onset is silent or shifted.');
      check(result.quietPeaks.every(peaks => peaks.every(value => value < 0.00001)), 'WAV has sound in its expected rests/tail.');
    } else check(result.peaks.every(value => value === 0), 'Volume zero was not baked once into offline gain.');
    const retry = await bridge.handle(request);
    check(retry.assetId === receipt.assetId, 'An identical export request created another asset.');
    decoded.push(result); receipts.push(receipt);
    stage(`wav-saved-decoded-volume-${volume}`);
  }
  const volumeRatio = decoded[1].peaks[0] / decoded[0].peaks[0];
  check(Math.abs(volumeRatio - 0.5) < 0.005, 'Volume is missing or applied twice.');
  check((await media.list()).length === 3, 'Idempotent WAV retry duplicated a saved capture.');
  // Query actual pinned patterns without a scheduler/audio context. The same
  // production bridge/controller/renderer saves and decodes these plain scores.
  const { validateStrudelSnapshot, queryStrudelSnapshot } = require('../src/strudel-export-policy');
  const queryScore = async (expression, realm = decoderWindow) => {
    const result = await realm.webContents.executeJavaScript(`(() => {
      try {
        const validateStrudelSnapshot = ${validateStrudelSnapshot.toString()};
        const queryStrudelSnapshot = ${queryStrudelSnapshot.toString()};
        return { snapshot: queryStrudelSnapshot(${expression}, { bpm: 120, volume: 1 }, 1, '${'d'.repeat(64)}', strudel, window.EaselStrudelSamples) };
      } catch (error) { return { error: String(error.message || error) }; }
    })()`);
    if (result.error) throw new Error(`Native export query ${expression} failed: ${result.error}`);
    return result.snapshot;
  };
  const synthProofs = [];
  for (const [name, expression] of [
    ['omitted-gain-default-envelope', "strudel.note('c4').s('sine')"],
    ['explicit-equivalent-gain', "strudel.note('c4').s('sine').gain(0.8)"],
    ['explicit-default-valued-envelope', "strudel.note('c4').s('sine').gain(0.8).attack(0.001).release(0.01)"],
    ['attack-only-envelope', "strudel.note('c4').s('sine').gain(0.8).attack(0.001)"],
    ['release-only-envelope', "strudel.note('c4').s('sine').gain(0.8).release(0.01)"],
  ]) {
    const snapshot = await queryScore(expression);
    const receipt = await bridge.handle({ action: 'export', input: { exportId: name, expectedSourceRevision: context.sourceRevision, snapshot } });
    const asset = await media.get(receipt.assetId);
    const result = await decoderWindow.webContents.executeJavaScript(`(${decodeExportWav.toString()})(${JSON.stringify(asset.data)},${JSON.stringify(snapshot)})`);
    check(result.latePeaks.every(peak => peak > 0.001), `${name}: late envelope segment is silent.`);
    synthProofs.push({ name, latePeaks: result.latePeaks });
  }
  check(Math.abs(synthProofs[0].latePeaks[0] - synthProofs[1].latePeaks[0]) < 0.00004, 'Omitted gain differs from the native explicit 0.8 equivalent.');
  const nativeSustainRatio = synthProofs[0].latePeaks[0] / synthProofs[2].latePeaks[0];
  check(Math.abs(nativeSustainRatio - 0.6) < 0.005, 'The all-omitted native envelope branch lost its default sustain.');
  check(synthProofs.slice(3).every(proof => Math.abs(proof.latePeaks[0] - synthProofs[2].latePeaks[0]) < 0.00004), 'One-sided explicit envelopes differ from their native branch.');
  const percussionProofs = [];
  for (const [name, expression] of [
    ['native-kick', "strudel.s('sbd').fast(4).gain(0.3)"],
    ['native-hats', "strudel.s('white').fast(8).gain(0.08).decay(0.04).sustain(0).release(0.02)"],
    ['native-pink', "strudel.s('pink').fast(4).gain(0.1).decay(0.07).sustain(0)"],
    ['native-brown', "strudel.s('brown').fast(4).gain(0.1).decay(0.07).sustain(0)"],
  ]) {
    const snapshot = await queryScore(expression);
    const receipt = await bridge.handle({ action: 'export', input: { exportId: name, expectedSourceRevision: context.sourceRevision, snapshot } });
    const asset = await media.get(receipt.assetId);
    const result = await decoderWindow.webContents.executeJavaScript(`(${decodeExportWav.toString()})(${JSON.stringify(asset.data)},${JSON.stringify(snapshot)})`);
    check(result.frames === 120000 && result.sampleRate === 48000 && result.channels === 2, `${name}: WAV format/timing changed.`);
    check(result.eventPeaks.every(peaks => peaks.every(peak => peak > 0.001)), `${name}: a percussion onset is silent.`);
    percussionProofs.push({ name, frames: result.frames, peaks: result.peaks, eventPeaks: result.eventPeaks });
  }
  const longSnapshot = await decoderWindow.webContents.executeJavaScript(`(() => {
    const validateStrudelSnapshot = ${validateStrudelSnapshot.toString()};
    const queryStrudelSnapshot = ${queryStrudelSnapshot.toString()};
    const pattern = strudel.stack(strudel.note('c4').s('sine').gain(0.3).attack(0.01).release(0.01).slow(4), strudel.note('g4').s('sine').gain(0).attack(0.01).release(0.01).fast(50));
    return queryStrudelSnapshot(pattern, { bpm: 120, volume: 1 }, 4, '${'d'.repeat(64)}', strudel);
  })()`);
  const longReceipt = await bridge.handle({ action: 'export', input: { exportId: 'long-native-score', expectedSourceRevision: context.sourceRevision, snapshot: longSnapshot } });
  const longAsset = await media.get(longReceipt.assetId);
  const longResult = await decoderWindow.webContents.executeJavaScript(`(${decodeExportWav.toString()})(${JSON.stringify(longAsset.data)},${JSON.stringify(longSnapshot)})`);
  assertNativeLongNoteEvidence(longResult, longSnapshot.events.length);
  stage('wav-native-defaults-and-long-score-proven');

  // AAC decoding is unavailable in Playwright Chromium. Exercise the exact
  // Electron kit, live REPL and production Media/export path with original M4A.
  const m4aBytes = fs.readFileSync(path.join(root, 'test/fixtures/strudel-samples/snare.m4a'));
  const m4aData = m4aBytes.toString('base64');
  const m4aId = await media.save({ data: m4aData, mimeType: 'audio/mp4', name: 'Suno-format snare.m4a' });
  await store.attachAssets(project.id, { assetIds: [m4aId] });
  await sound.webContents.executeJavaScript(`window.__easelProjectAssets = Object.freeze({ '${m4aId}': { url: 'data:audio/mp4;base64,${m4aData}' } }); void 0;`);
  const m4aCode = `await window.EaselStrudelSamples.add('suno_hat', '${m4aId}')\ns("suno_hat*4").gain(.3)`;
  await pushStrudelCode(sound, m4aCode);
  const registered = await sound.webContents.executeJavaScript("EaselStrudelSamples.get('suno_hat')");
  check(registered.assetId === m4aId && registered.digest === crypto.createHash('sha256').update(m4aBytes).digest('hex') && registered.durationSeconds === 0.25, 'M4A lost its original asset, content hash or decoded duration.');
  await sound.webContents.executeJavaScript(`probe.peaks = []; probe.m4aStartedAt = strudel.getAudioContext().currentTime; document.getElementById('strudel-${instanceId}-volume').value = '0.5'; document.getElementById('strudel-${instanceId}-volume').dispatchEvent(new Event('input')); void 0;`);
  await until(sound, state => state.schedulerStarted && state.audioTime >= state.m4aStartedAt + OLD_VOICE_BOUND_SECONDS && state.peaks.slice(-10).some(value => value > 0.001), 'm4a-live-signal');
  const m4aSnapshot = await queryScore("strudel.s('suno_hat').fast(4).gain(.3)", sound);
  const m4aRequest = { action: 'export', input: { exportId: 'attached-m4a', expectedSourceRevision: context.sourceRevision, snapshot: m4aSnapshot } };
  const m4aReceipt = await bridge.handle(m4aRequest);
  check(m4aReceipt.attachmentStatus === 'attached', 'M4A score export did not attach its WAV.');
  const m4aWav = await media.get(m4aReceipt.assetId);
  const m4aTiming = validateStrudelWav(Buffer.from(m4aWav.data, 'base64'), m4aSnapshot);
  const m4aResult = await decoderWindow.webContents.executeJavaScript(`(${decodeExportWav.toString()})(${JSON.stringify(m4aWav.data)},${JSON.stringify(m4aSnapshot)})`);
  check(m4aResult.frames === m4aTiming.frames && m4aResult.frames === 120000 && m4aResult.eventPeaks.every(peaks => peaks.every(peak => peak > 0.001)), 'M4A WAV export lost an onset or changed format/timing.');
  const reopenedM4a = await createCanvasMediaStore({ userDataPath }).getPlaybackSource(m4aReceipt.assetId);
  check(fs.readFileSync(reopenedM4a.filename).equals(Buffer.from(m4aWav.data, 'base64')), 'M4A score saved/reopened WAV bytes differ.');
  check((await bridge.handle(m4aRequest)).assetId === m4aReceipt.assetId, 'M4A export retry duplicated the WAV.');
  await pushStrudelCode(sound, "note('~ c4 ~ g4').s('sine')");
  stage('m4a-live-and-wav-export-proven');

  await sound.webContents.executeJavaScript(`probe.liveContextIdentity = strudel.getAudioContext() === __exportLiveIdentity.context && strudel.getSuperdoughAudioController() === __exportLiveIdentity.controller && strudel.getAudioContext().state === 'running' && strudel.getAudioContext().currentTime > __exportLiveIdentity.time && strudel.getIsStarted(); probe.peaks = []; document.getElementById('strudel-${instanceId}-volume').value = '0.5'; document.getElementById('strudel-${instanceId}-volume').dispatchEvent(new Event('input')); void 0;`);
  const alive = await until(sound, state => state.liveContextIdentity && state.peaks.length >= 10 && state.peaks.slice(-10).every(value => value > 0.001), 'wav-live-context-survived');
  check(alive.activeAudioContexts === 1, 'Export created a live audio context in the authored realm.');
  await sound.webContents.executeJavaScript('probe.dispose()');
  const disposed = await read(sound);
  check(disposed.disposal.audioState === 'closed' && !disposed.disposal.schedulerStarted && disposed.disposal.activeAudioContexts === 0, 'WAV fixture cleanup leaked live audio.');
  // Exercise the installed Electron version's actual same-URL navigation event.
  // Host canvas cancellation itself is covered by the fake-WebContents regression.
  const navigationDetails = new Promise(resolve => sound.webContents.once('did-start-navigation', (details, url, isInPlace, isMainFrame) => resolve({ url: details.url ?? url, isSameDocument: details.isSameDocument ?? isInPlace, isMainFrame: details.isMainFrame ?? isMainFrame })));
  const sameUrl = sound.webContents.getURL();
  sound.webContents.reload();
  const navigation = await navigationDetails;
  check(navigation.url === sameUrl && navigation.isMainFrame === true && navigation.isSameDocument === false, 'Native same-URL reload did not emit a top-level replacement event.');

  return { decoded: decoded.map(({ eventPeaks, quietPeaks, ...summary }) => ({ ...summary, eventPeaks, quietPeaks })), volumeRatio, liveContextIdentity: true,
    sustainedLiveSamples: 10, sameUrlNavigationEvent: true, savedReopenedBytes: true, nativeDefaultProofs: synthProofs, percussionProofs, nativeSustainRatio, longScore: { events: longSnapshot.events.length, latePeaks: longResult.latePeaks, duration: longResult.duration },
    m4aSample: { ...registered, frames: m4aResult.frames, eventPeaks: m4aResult.eventPeaks, liveSignal: true, savedReopenedBytes: true, idempotentRetry: true },
    durableAssets: receipts.map(receipt => receipt.assetId), idempotentRetries: true, pinnedKitDigest: store.getProjectKitSource(project.id, 'strudel').digest };
}

function templateFixtureHtml(bundle, { instanceId = 'c'.repeat(32), preserved, saved, edited = false, exportEnabled = false, replEnabled = true } = {}) {
  const source = createStrudelTemplate({ instanceId });
  // Real Strudel templates opt into the evaluator; disable only for policy controls.
  let html = source.files[source.entry];
  if (!replEnabled) html = html.replace(' data-easel-strudel-repl="v1"', '');
  if (exportEnabled) html = html.replaceAll('<bb2 ~ bb2 bb2>', '<~ bb2 ~ bb2>');
  if (edited) html = html.replaceAll('<bb2 ~ bb2 bb2>', 'a5 c6 e6 a6');
  html = html.replace('</body>', `<script>(${monitorTemplate.toString()})(${JSON.stringify(instanceId)});</script></body>`);
  html = buildCanvasDocument({ html, kits: ['strudel'], kitBundles: { strudel: bundle } });
  const initial = `<script>window.__easelPreservedState=${JSON.stringify(preserved || {}).replace(/</g, '\\u003c')};window.__easelProjectState=${JSON.stringify(saved || {}).replace(/</g, '\\u003c')};</script>`;
  html = html.replace('<script id="easel-runtime-lifecycle">', initial + '<script id="easel-runtime-lifecycle">');
  return html.replace('<script data-easel-canvas-kit="strudel">', `<script>(${installDiagnostics.toString()})();${exportEnabled ? `(${installExportFixtureHost.toString()})();` : ''}</script><script data-easel-canvas-kit="strudel">`);
}

async function electronMain() {
  const { app, BrowserWindow, protocol, session } = require('electron');
  // Identical to main.js: the production renderer serves its host-only URL.
  protocol.registerSchemesAsPrivileged([{ scheme: 'easel-canvas', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  const directory = process.env.EASEL_STRUDEL_PROBE_DIR;
  const diagnostic = { status: 'running', phase: 'startup', snapshots: {} };
  const persist = () => fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(diagnostic, null, 2));
  const stage = (name) => { diagnostic.phase = name; persist(); fs.appendFileSync(path.join(directory, 'stages.log'), `${name}\n`); };
  stage('electron-main-entered');
  app.setPath('userData', path.join(directory, 'user-data'));
  app.setPath('cache', path.join(directory, 'cache'));
  app.disableHardwareAcceleration();
  app.enableSandbox();
  const windows = [];
  const requests = [];
  const labels = new Map();
  const watchdog = setTimeout(() => { diagnostic.status = 'failed'; diagnostic.error = 'Global watchdog timeout'; stage('watchdog-timeout'); app.exit(1); }, TIMEOUT_MS);
  const check = (value, message) => { if (!value) throw new Error(message); };
  try {
    await app.whenReady();
    stage('app-ready');
    async function open(filename) {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'document-user-activation-required',
        partition: `strudel-probe-${filename}` } });
      windows.push(win);
      labels.set(win, filename);
      const url = pathToFileURL(path.join(directory, filename)).href;
      win.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
      win.webContents.session.setPermissionCheckHandler(() => false);
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const allowed = details.url === url;
        if (!allowed) requests.push(details.url);
        callback({ cancel: !allowed });
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await win.loadURL(url);
      stage(`loaded-${filename}`);
      return win;
    }
    async function read(win) {
      const result = await win.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.probe))');
      diagnostic.snapshots[labels.get(win)] = summarizeProbeState(result);
      persist();
      check(!result.errors.length && !result.violations.length, JSON.stringify(result));
      return result;
    }
    async function until(win, predicate, label) {
      stage(`waiting-${label}`);
      const value = await waitForProbeState(() => read(win), predicate, label);
      stage(label);
      return value;
    }
    const live = await open('playback.html');
    const initial = await until(live, (state) => state.ready, 'playback-ready');
    check(initial.plays === 0 && initial.peaks.every((peak) => peak === 0), 'Playback began before Play.');
    stage('sending-first-play');
    await sendKeyboardActivation(live, 'play');
    stage('first-play-sent');
    const playing = await until(live, (state) => state.plays === 1 && state.peaks.some((peak) => peak > 0.001), 'first-signal');
    check(playing.trustedKeyboardPlay, 'Keyboard Play was not a trusted activation.');
    await sendKeyboardActivation(live, 'stop');
    await until(live, (state) => state.stopped && state.peaks.length >= 10 && state.peaks.slice(-10).every((peak) => peak < 0.00001), 'stop-muted');
    const drained = await until(live, stopIsDrained, 'stop-drained');
    await live.webContents.executeJavaScript('probe.peaks = []; void 0;');
    await sendKeyboardActivation(live, 'play');
    const restarted = await until(live, hasRestartSignal, 'restart-signal');
    const isolated = await open('offline.html');
    const offline = await until(isolated, (state) => state.ready, 'offline-ready');
    check((await read(live)).plays === 2, 'The offline realm changed live state.');
    await live.webContents.executeJavaScript('probe.dispose()');
    const templateId = 'c'.repeat(32);
    const control = (name) => `strudel-${templateId}-${name}`;
    const starter = await open('template.html');
    const starterInitial = await until(starter, (state) => state.ready, 'template-ready');
    assertTemplateInitialSilence(starterInitial);
    check(starterInitial.activeAudioContexts === 1, 'Starter created duplicate audio contexts.');
    // Long first voice: eight seconds at 30 BPM. Replacing it with a zero-gain
    // pattern tests real output isolation, not just that reset() was called.
    await pushStrudelCode(starter, "note('a4').s('sine').gain(0.3).release(0.5)");
    await starter.webContents.executeJavaScript(`document.getElementById('${control('bpm')}').value = '30'; document.getElementById('${control('bpm')}').dispatchEvent(new Event('input')); void 0;`);
    await sendKeyboardActivation(starter, control('play'));
    const starterPlaying = await until(starter, (state) => state.plays === 1 && state.schedulerStarted && state.peaks.some((peak) => peak > 0.001), 'template-signal');
    check(starterPlaying.trustedKeyboardPlay, 'Template Play was not trusted keyboard activation.');
    await sendKeyboardActivation(starter, control('stop'));
    await until(starter, (state) => !state.schedulerStarted && state.gain === 0, 'template-stop');
    await pushStrudelCode(starter, "note('a4').s('sine').gain(0).release(0.05)");
    await starter.webContents.executeJavaScript('probe.peaks = []; void 0;');
    await sendKeyboardActivation(starter, control('play'));
    const silentRestart = await until(starter, hasSilentTemplateRestart, 'template-no-old-voice');
    await starter.webContents.executeJavaScript(`document.getElementById('${control('bpm')}').value = '120'; document.getElementById('${control('bpm')}').dispatchEvent(new Event('input')); document.getElementById('${control('volume')}').value = '0.2'; document.getElementById('${control('volume')}').dispatchEvent(new Event('input')); void 0;`);
    await until(starter, (state) => state.cps === 0.5 && Math.abs(state.gain - 0.2) < 0.0001, 'template-controls-immediate');
    // Pair the silent negative control with positive output on this same
    // starter. The monitor reconnects to every new destinationGain graph.
    await sendKeyboardActivation(starter, control('stop'));
    await until(starter, (state) => !state.schedulerStarted && state.gain === 0, 'template-before-positive-restart');
    await pushStrudelCode(starter, "note('a5').s('sine').gain(0.3).release(0.05)");
    await starter.webContents.executeJavaScript('probe.peaks = []; void 0;');
    await sendKeyboardActivation(starter, control('play'));
    const positiveRestart = await until(starter, hasAudibleTemplateRestart, 'template-positive-restart');
    // Exercise the existing question overlay with native Escape, without adding
    // an answer system or submitting any answer from this disposable fixture.
    await starter.webContents.executeJavaScript('window.EaselHost = { submitInput: async () => ({ok:true}), cancelInput: async () => ({ok:true}) }; void 0;');
    await starter.webContents.executeJavaScript(renderCanvasInputScript({ id: 'template-probe-question', question: 'Choose a sound', options: [{ value: 'calm', label: 'Calm' }] }));
    starter.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    starter.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(starter, (state) => !state.schedulerStarted && state.gain === 0 && state.peaks.length >= 10 && state.peaks.slice(-10).every((peak) => peak < 0.00001), 'template-overlay-escape');
    const preserved = await starter.webContents.executeJavaScript('EaselCanvas.captureState()');
    const bundle = fs.readFileSync(path.join(root, 'canvas-kits/strudel.js'), 'utf8');
    fs.writeFileSync(path.join(directory, 'template-reloaded.html'), templateFixtureHtml(bundle, { instanceId: templateId, preserved, edited: true }));
    await starter.webContents.executeJavaScript('probe.dispose()');
    const disposed = await read(starter);
    check(disposed.disposal.audioState === 'closed' && !disposed.disposal.schedulerStarted && disposed.disposal.activeAudioContexts === 0 && disposed.disposal.failures.length === 0, 'Starter disposal leaked audio/scheduler resources.');
    starter.destroy();
    const reloaded = await open('template-reloaded.html');
    const afterEdit = await until(reloaded, (state) => state.ready, 'template-source-reloaded');
    const restoredCode = await reloaded.webContents.executeJavaScript(`document.getElementById('${control('code')}').value`);
    check(restoredCode.includes('a5 c6 e6 a6') && afterEdit.plays === 0 &&
      afterEdit.settings.bpm === 120 && afterEdit.settings.volume === 0.2 && afterEdit.gain === 0,
      'Reload must retain the new authored default over old editor state and restore settings without playing.');
    await pushStrudelCode(reloaded, restoredCode);
    await until(reloaded, (state) => state.phase.startsWith('Code ready'), 'template-restored-code-pushed');
    await sendKeyboardActivation(reloaded, control('play'));
    await until(reloaded, (state) => state.schedulerStarted && state.peaks.some((peak) => peak > 0.001), 'template-edited-source-signal');
    const other = await open('template-other.html');
    const otherState = await until(other, (state) => state.ready, 'template-other-ready');
    check(otherState.settings.bpm === 160 && otherState.settings.volume === 0.7 && otherState.plays === 0, 'Two instances did not restore independently.');
    for (const win of [reloaded, other]) {
      await win.webContents.executeJavaScript('probe.dispose()');
      const result = await read(win);
      check(result.disposal.audioState === 'closed' && !result.disposal.schedulerStarted && result.disposal.activeAudioContexts === 0, 'Repeated close leaked resources.');
    }
    const wav = await proveProductionWavExport({ BrowserWindow, session, open, until, read, windows, requests, directory, decoderWindow: isolated, stage, check });
    check(requests.length === 0, `Unexpected resource requests: ${requests.join(', ')}`);
    const evidence = { status: 'passed', csp: CSP, initialState: initial.initialState,
      trustedKeyboardPlay: playing.trustedKeyboardPlay, playPeak: Math.max(...playing.peaks),
      stopSilence: true, oldVoiceDrainSeconds: drained.audioTime - drained.stoppedAt, restartSustainedSamples: 10, restartPeak: Math.max(...restarted.peaks), offline: offline.offline,
      template: { trustedKeyboardPlay: starterPlaying.trustedKeyboardPlay, initialSilence: true, oldVoiceMutedRestartSeconds: silentRestart.audioTime - silentRestart.oldVoiceStartedAt, positiveRestartPeak: Math.max(...positiveRestart.peaks), positiveRestartSustainedSamples: 10, controlsImmediate: true, overlayEscapeStops: true, sourceReloadSilent: true, editedSourcePlays: true, independentSettings: true, disposedContexts: 0 },
      wav, networkRequests: requests, electron: process.versions.electron, chromium: process.versions.chrome };
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
    clearTimeout(watchdog);
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    app.exit(0);
  } catch (error) {
    diagnostic.status = 'failed';
    diagnostic.error = String(error.message || error).slice(0, 50000);
    stage(`error: ${error.message || error}`);
    console.error(error.stack || error);
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    app.exit(1);
  }
}

function run() {
  const bundle = fs.readFileSync(path.join(root, 'canvas-kits/strudel.js'), 'utf8');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-strudel-probe-'));
  fs.writeFileSync(path.join(directory, 'playback.html'), fixtureHtml(bundle, false));
  fs.writeFileSync(path.join(directory, 'offline.html'), fixtureHtml(bundle, true));
  fs.writeFileSync(path.join(directory, 'export.html'), templateFixtureHtml(bundle, { instanceId: 'e'.repeat(32), exportEnabled: true }));
  fs.writeFileSync(path.join(directory, 'template.html'), templateFixtureHtml(bundle));
  fs.writeFileSync(path.join(directory, 'template-other.html'), templateFixtureHtml(bundle, { instanceId: 'd'.repeat(32), saved: { strudel: { ['c'.repeat(32)]: { bpm: 90, volume: 0.1 }, ['d'.repeat(32)]: { bpm: 160, volume: 0.7, playing: true } } } }));
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const env = { ...process.env, EASEL_STRUDEL_PROBE_DIR: directory, HOME: directory,
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_RUNTIME_DIR: runtime };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--disable-gpu', '--disable-gpu-compositing', ...(process.platform === 'linux' && !env.DISPLAY ? ['--ozone-platform=headless'] : []), __filename];
  const result = spawnSync(require('electron'), args, { env, encoding: 'utf8', timeout: TIMEOUT_MS + 5000, maxBuffer: 2 * 1024 * 1024 });
  fs.writeFileSync(path.join(directory, 'electron.log'), `${result.stdout || ''}\n${result.stderr || ''}`);
  process.stdout.write(`Probe evidence directory: ${directory}\n`);
  if (result.error || result.status !== 0) throw new Error(`Strudel runtime gate blocked/failed (${result.status}, ${result.signal}): ${result.error || result.stderr || result.stdout}`);
  process.stdout.write(result.stdout);
}

if (process.versions.electron) electronMain().catch((error) => { console.error(error); require('electron').app.exit(1); });
else if (require.main === module) {
  try { run(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
module.exports = { assertNativeLongNoteEvidence, decodeExportWav, assertTemplateInitialSilence, fixtureHtml, templateFixtureHtml, hasSilentTemplateRestart, hasAudibleTemplateRestart, TIMEOUT_MS, sendKeyboardActivation, stopIsDrained, hasRestartSignal, waitForProbeState, summarizeProbeState };
