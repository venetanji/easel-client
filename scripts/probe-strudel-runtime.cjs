// Disposable, bounded native-synth probe. Never attach to a running Easel app.
// No GPU, remote debugging, network, Node access in renderers, or CSP relaxation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { buildCanvasDocument, CSP } = require('../src/canvas-policy');
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
  return {
    phase: clip(state.phase, 80), ready: state.ready === true, playEvents: state.playEvents || 0, plays: state.plays || 0,
    audioState: clip(state.audioState, 40), audioTime: state.audioTime, schedulerStarted: state.schedulerStarted,
    trustedKeyboardPlay: state.trustedKeyboardPlay, stopped: state.stopped, stoppedAt: state.stoppedAt,
    peakCount: peaks.length, maxPeak: peaks.length ? Math.max(...peaks) : 0, lastPeak: peaks.at(-1),
    errors: last(state.errors, 20).map((error) => clip(error)),
    violations: last(state.violations, 20).map((item) => ({ directive: clip(item.directive, 100), blocked: clip(item.blocked, 200) })),
    nativeInput: last(state.nativeInput, 12).map((item) => ({ type: clip(item.type, 40), key: clip(item.key, 40),
      target: clip(item.target, 80), trusted: item.trusted === true, active: item.active === true })),
    logs: last(state.logs, 20).map((item) => ({ type: clip(item.type, 40), message: clip(item.message) })),
  };
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

async function electronMain() {
  const { app, BrowserWindow } = require('electron');
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
    check(requests.length === 0, `Unexpected resource requests: ${requests.join(', ')}`);
    const evidence = { status: 'passed', csp: CSP, initialState: initial.initialState,
      trustedKeyboardPlay: playing.trustedKeyboardPlay, playPeak: Math.max(...playing.peaks),
      stopSilence: true, oldVoiceDrainSeconds: drained.audioTime - drained.stoppedAt, restartSustainedSamples: 10, restartPeak: Math.max(...restarted.peaks), offline: offline.offline,
      networkRequests: requests, electron: process.versions.electron, chromium: process.versions.chrome };
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
    clearTimeout(watchdog);
    for (const win of windows) win.destroy();
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
module.exports = { fixtureHtml, TIMEOUT_MS, sendKeyboardActivation, stopIsDrained, hasRestartSignal, waitForProbeState, summarizeProbeState };
