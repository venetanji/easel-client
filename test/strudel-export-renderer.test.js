const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const snapshot = () => ({ bpm: 120, cycles: 1, tailSeconds: 0.5, parameterDigest: "d".repeat(64), events: [] });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture({ gate, sessionGate, timeoutMs, score = snapshot() } = {}) {
  assert.ok(fs.existsSync(path.join(__dirname, "../src/strudel-export-renderer.js")), "isolated Strudel WAV renderer is implemented");
  const { createStrudelExportRenderer, encodePCM16Wav } = require("../src/strudel-export-renderer");
  const { snapshotTiming } = require("../src/strudel-export-policy");
  const frames = snapshotTiming(score).frames;
  const wavBase64 = Buffer.from(encodePCM16Wav({ sampleRate: 48e3, numberOfChannels: 2, length: frames, getChannelData: () => new Float32Array(frames) })).toString("base64");
  const guards = {}, windows = [];
  let unhandled = 0;
  const session = { setPermissionCheckHandler(fn) {
    guards.check = fn;
  }, setPermissionRequestHandler(fn) {
    guards.permission = fn;
  }, webRequest: { onBeforeRequest(_filter, fn) {
    guards.request = fn;
  } }, protocol: { async handle(_scheme, fn) {
    guards.protocol = fn;
  }, async unhandle() {
    unhandled++;
  } } };
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setAudioMuted = (value) => {
        this.muted = value;
      };
      this.webContents.setWindowOpenHandler = (fn) => {
        guards.open = fn;
      };
      this.webContents.executeJavaScript = async (source) => {
        this.source = source;
        if (gate) await gate.promise;
        return { wavBase64, duration: frames / 48e3, channels: 2, sampleRate: 48e3 };
      };
    }
    async loadURL(url) {
      this.url = url;
    }
    isDestroyed() {
      return Boolean(this.destroyed);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const renderer = createStrudelExportRenderer({ BrowserWindow, sessionFactory: async (partition) => {
    if (sessionGate) await sessionGate.promise;
    return { partition, session };
  }, timeoutMs });
  return { renderer, guards, windows, unhandled: () => unhandled };
}
test("renderer_uses_current_canvas_policy_exact_pin_and_disposable_sandbox", async () => {
  const f = fixture();
  const result = await f.renderer.renderStrudelSnapshot(snapshot(), { kitSource: "window.strudel={};" });
  assert.ok(Buffer.isBuffer(result.wavBytes));
  assert.equal(f.windows.length, 1);
  const w = f.windows[0];
  assert.equal(w.options.webPreferences.sandbox, true);
  assert.equal(w.options.webPreferences.nodeIntegration, false);
  assert.equal(w.options.webPreferences.preload, void 0);
  assert.equal(w.muted, true);
  assert.equal(w.destroyed, true);
  assert.equal(f.guards.check(), false);
  assert.deepEqual(f.guards.open(), { action: "deny" });
  let response;
  f.guards.request({ url: "https://example.com" }, (r) => {
    response = r;
  });
  assert.equal(response.cancel, true);
  const html = await (await f.guards.protocol({ url: w.url })).text();
  assert.ok(html.includes(require("../src/canvas-policy").CSP));
  assert.match(html, /window\.strudel=\{\}/);
  assert.match(w.source, /setSuperdoughAudioController\(null\)/);
  assert.doesNotMatch(w.source, /initAudio|initStrudel|\.close\(|renderPatternAudio|eval\(/);
  assert.equal(f.unhandled(), 1);
});
test("cancel_during_render_destroys_realm_and_rejects_late_results", async () => {
  const gate = deferred(), f = fixture({ gate });
  const abort = new AbortController();
  const p = f.renderer.renderStrudelSnapshot(snapshot(), { kitSource: "window.strudel={};", signal: abort.signal });
  await tick();
  abort.abort("cancel export");
  assert.equal(f.windows[0].destroyed, true);
  await assert.rejects(p, /cancel/i);
  gate.resolve();
  await tick();
  assert.equal(f.unhandled(), 1);
});
test("cancel_before_or_during_environment_setup_never_creates_window", async () => {
  const sessionGate = deferred(), f = fixture({ sessionGate });
  const abort = new AbortController();
  const p = f.renderer.renderStrudelSnapshot(snapshot(), { kitSource: "window.strudel={};", signal: abort.signal });
  await tick();
  abort.abort("cancel export");
  await assert.rejects(p, /cancel/i);
  sessionGate.resolve();
  await tick();
  assert.equal(f.windows.length, 0);
  assert.equal(f.unhandled(), 1);
});
test("watchdog_destroys_realm_without_offline_close", async () => {
  const gate = deferred(), f = fixture({ gate, timeoutMs: 5 });
  await assert.rejects(f.renderer.renderStrudelSnapshot(snapshot(), { kitSource: "window.strudel={};" }), /timed out/i);
  assert.equal(f.windows[0].destroyed, true);
  gate.resolve();
});

test('renderer_accepts_near_maximum_budget_base64_without_regexp_stack_overflow', async () => {
  const score = { ...snapshot(), bpm: 32.6, cycles: 4 };
  const f = fixture({ score }); const result = await f.renderer.renderStrudelSnapshot(score, { kitSource: 'window.strudel={};' });
  assert.ok(result.wavBytes.length > 5_700_000); assert.ok(result.duration <= 30);
});

async function nativeSchedule(score) {
  const vm = require('node:vm'); const calls = [], limits = [];
  const { nativeRenderScript } = require('../src/strudel-export-renderer');
  const controller = { output: { destinationGain: { gain: { setValueAtTime() {} } }, disconnect() {} } };
  class OfflineAudioContext { constructor(channels, frames, rate) { this.channels = channels; this.frames = frames; this.rate = rate; } async startRendering() { return { sampleRate: this.rate, numberOfChannels: this.channels, length: this.frames, getChannelData: () => new Float32Array(this.frames) }; } }
  const native = { setAudioContext() {}, setSuperdoughAudioController() {}, async registerSynthSounds() {}, getSuperdoughAudioController: () => controller,
    setMaxPolyphony(value) { limits.push(value); }, async superdough(value, onset, duration) { calls.push({ value: { ...value }, onset, duration, admittedLimit: limits.at(-1) }); } };
  await vm.runInNewContext(nativeRenderScript(score), { window: { strudel: native }, OfflineAudioContext, Uint8Array, DataView, Float32Array, btoa: value => Buffer.from(value, 'binary').toString('base64') });
  return { calls, limits };
}
test('native_render_preserves_all_omitted_versus_explicit_adsr_semantics', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../node_modules/superdough/helpers.mjs'), 'utf8');
  const functionSource = source.slice(source.indexOf('export const getADSRValues ='), source.indexOf('export function getParamLfo'));
  const getADSR = require('node:vm').runInNewContext(functionSource.replace('export const', 'const') + '; getADSRValues;');
  const event = { timeSeconds: 0, durationSeconds: 0.5, absoluteCycle: 0, midiNote: 60, waveform: 'sine', gain: 0.3, attackSeconds: 0.001, releaseSeconds: 0.01 };
  for (const [fields, mode, expected] of [[{}, 'native-default', [0.001,0.05,0.6,0.01]], [{ attackSeconds: 0.02 }, 'explicit', [0.02,0.001,1,0.01]], [{ releaseSeconds: 0.05 }, 'explicit', [0.001,0.001,1,0.05]], [{}, 'explicit', [0.001,0.001,1,0.01]]]) {
    const result = await nativeSchedule({ ...snapshot(), events: [{ ...event, ...fields, envelopeMode: mode }] });
    const value = result.calls[0].value;
    assert.equal(Object.hasOwn(value, 'attack'), mode === 'explicit'); assert.equal(Object.hasOwn(value, 'release'), mode === 'explicit');
    assert.deepEqual(Array.from(getADSR([value.attack, value.decay, value.sustain, value.release], 'linear', [0.001,0.05,0.6,0.01])), expected);
  }
});
test('native_total_scheduled_limit_preserves_scores_above_128_without_expanding_overlap', async () => {
  const { validateStrudelSnapshot } = require('../src/strudel-export-policy');
  const event = { timeSeconds: 0, durationSeconds: 8, absoluteCycle: 0, midiNote: 60, waveform: 'sine', gain: 0.2, attackSeconds: 0.01, releaseSeconds: 0.01, envelopeMode: 'explicit' };
  const events = [event, ...Array.from({length:128}, (_,i) => ({ ...event, timeSeconds: (i+1)*0.04, absoluteCycle: (i+1)*0.02, durationSeconds: 0.02 }))];
  const score = validateStrudelSnapshot({ ...snapshot(), cycles: 4, events }); const scheduled = await nativeSchedule(score);
  assert.equal(scheduled.calls.length, 129); assert.ok(scheduled.limits[0] >= 129); assert.ok(scheduled.calls.every(call => call.admittedLimit >= 129));
  assert.throws(() => validateStrudelSnapshot({ ...score, events: Array(33).fill(event) }), /polyphony/);
});
