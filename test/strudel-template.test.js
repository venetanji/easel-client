const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ID = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function factory() {
  assert.ok(fs.existsSync(path.join(__dirname, '../src/strudel-template.js')), 'The editable Strudel template factory must exist');
  return require('../src/strudel-template').createStrudelTemplate;
}
// Use the exact pinned logger, clock and Cyclist implementation. No audio or
// browser is launched; only platform timers and the document event sink are faked.
function pinnedRuntime(dispatch) {
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    document: { dispatchEvent: dispatch },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    process: { env: { NODE_ENV: 'test' } }, performance: { now: () => 0 },
    console: { log() {}, error() {} },
  });
  const read = (name) => fs.readFileSync(path.join(__dirname, '../node_modules', name), 'utf8');
  const source = read('@strudel/core/logger.mjs').replace(/^export /gm, '') + '\n' +
    read('@strudel/core/zyklus.mjs').replace('export default createClock;', '') + '\n' +
    read('@strudel/core/cyclist.mjs').replace(/^import .*;$/gm, '').replace('export class Cyclist', 'class Cyclist') + '\n' +
    read('@strudel/core/repl.mjs').split('export const getTrigger =')[1].replace(/^/, 'const getTrigger =');
  const runtime = vm.runInContext(source + '\n;({logger,errorLogger,Cyclist,getTrigger});', context);
  const superdough = vm.runInContext(`(() => { ${read('superdough/logger.mjs').replace(/^export /gm, '')}; return {errorLogger,setLogger}; })()`, context);
  superdough.setLogger(runtime.logger);
  return { ...runtime, superdough, timers,
    setInterval(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  };
}
function harness({ id = ID, preserved = {}, saved = {}, resumeGate, startGate, initGate, initError, audioError, patternError, usePinnedScheduler = false, firstTickError = false } = {}) {
  const { files, entry } = factory()({ instanceId: id });
  const html = files[entry];
  const elements = new Map();
  const listeners = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], { value: '', textContent: '', disabled: false, hidden: false, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(type, fn) { this[type] = fn; }, removeEventListener(type) { delete this[type]; } });
  const counts = { init: 0, starts: 0, activeSchedulers: 0, activeAudioContexts: 1, closes: 0, hush: 0, resets: 0, patterns: 0, resumes: 0 };
  // AudioParam automation does not update its current-value slot until a
  // render quantum; setting .value updates that slot and schedules the value.
  // In particular, a suspended context never consumes setValueAtTime here.
  let currentGain = 1, scheduledGain = 1;
  const gain = { get value() { return currentGain; }, set value(value) { currentGain = value; scheduledGain = value; },
    cancelScheduledValues() {}, setValueAtTime(value) { scheduledGain = value; if (context.state === 'running') currentGain = value; } };
  const output = { destinationGain: { gain }, disconnect() { this.disconnected = true; } };
  const controller = { output, reset() { counts.resets++; output.disconnected = false; } };
  const context = { state: 'suspended', currentTime: 1, async resume() { counts.resumes++; if (resumeGate) await resumeGate.promise; this.state = 'running'; currentGain = scheduledGain; }, async close() { counts.closes++; counts.activeAudioContexts = 0; this.state = 'closed'; } };
  let options, app, audioFailed = false;
  const pinned = pinnedRuntime((event) => listeners.get(event.type)?.fn(event));
  const scheduler = usePinnedScheduler ? new pinned.Cyclist({ getTime: () => context.currentTime,
    setInterval: pinned.setInterval, clearInterval: pinned.clearInterval,
    beforeStart: () => options.beforeStart?.(),
    onToggle(started) { counts.activeSchedulers = started ? 1 : 0; options.onToggle?.(started); },
  }) : { started: false, cps: 0.5 };
  const repl = { scheduler, setCps(value) { if (usePinnedScheduler) scheduler.setCps(value); else scheduler.cps = value; }, async setPattern(pattern, autoplay) { assert.equal(autoplay, false); this.pattern = pattern; if (usePinnedScheduler) await scheduler.setPattern(pattern, false); },
    async start() { if (usePinnedScheduler) { counts.starts++; return scheduler.start(); } await options.beforeStart?.(); if (startGate) await startGate.promise; counts.starts++; counts.activeSchedulers++; scheduler.started = true; options.onToggle?.(true); },
    stop() { if (usePinnedScheduler) { scheduler.stop(); return; } counts.activeSchedulers = 0; scheduler.started = false; options?.onToggle?.(false); } };
  const pattern = { s(value) { this.waveform = value; return this; }, gain(value) { this.eventGain = value; return this; }, attack() { return this; }, release() { return this; }, queryArc() { if (firstTickError) { firstTickError = false; throw new Error('First tick query failed'); } return []; } };
  const strudel = { getAudioContext: () => context, getSuperdoughAudioController: () => controller,
    async initStrudel(value) { counts.init++; options = value; if (initGate) await initGate.promise; if (initError) throw new Error('Initialization failed'); return repl; },
    async initAudio(value) { assert.equal(value.disableWorklets, true); if (audioError && !audioFailed) { audioFailed = true; throw new Error('Audio unavailable'); } },
    hush() { counts.hush++; repl.stop(); }, note() { counts.patterns++; if (patternError) throw new Error('Invalid pattern'); return pattern; } };
  let reloaded = false;
  const window = { strudel, __easelProjectState: saved, location: { reload() { reloaded = true; } },
    EaselCanvas: { registerApp(value) { app = value; if (preserved[value.id]) value.restoreState(preserved[value.id]); } },
    addEventListener(type, fn) { listeners.set('window:' + type, fn); }, removeEventListener(type) { listeners.delete('window:' + type); } };
  const sandbox = { window, strudel, document: { getElementById: (key) => elements.get(key),
    addEventListener(type, fn, capture) { listeners.set(type, { fn, capture }); }, removeEventListener(type) { listeners.delete(type); } }, navigator: { userActivation: { isActive: true } }, console };
  vm.createContext(sandbox);
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], sandbox);
  const element = (name) => elements.get(`strudel-${id}-${name}`);
  return { html, pinned, scheduledGain: () => scheduledGain, app: () => app, window, element, counts, context, controller, repl, sandbox, listeners, reloaded: () => reloaded,
    play: () => element('play').click({ isTrusted: true, detail: 0 }), stop: () => element('stop').click({ isTrusted: true }),
    input(name, value) { element(name).value = value; element(name).input(); } };
}

test('starts_silent', async () => { const h = harness(); await flush(); assert.equal(h.app().getState().playing, false); assert.equal(h.counts.starts, 0); assert.equal(h.counts.resumes, 0); assert.equal(h.controller.output.destinationGain.gain.value, 0); assert.match(h.element('status').textContent, /ready.*play/i); });
test('keyboard_play_is_gesture', async () => { const h = harness(); await flush(); await h.play(); assert.equal(h.counts.starts, 1); assert.equal(h.counts.resumes, 1); assert.equal(h.repl.scheduler.cps, 100 / 240); assert.match(h.element('status').textContent, /playing/i); h.stop(); await h.element('play').click({ isTrusted: false }); assert.equal(h.counts.starts, 1); });
test('stop_clears_tails', async () => { const h = harness(); await flush(); await h.play(); h.stop(); assert.equal(h.counts.activeSchedulers, 0); assert.equal(h.controller.output.destinationGain.gain.value, 0); assert.equal(h.app().getState().playing, false); const resets = h.counts.resets; await h.play(); assert.equal(h.counts.resets, resets + 1, 'restart disconnects the old voice graph before unmuting'); });
test('reload_does_not_autoplay', async () => { const first = harness(); await flush(); await first.play(); first.input('bpm', '156'); first.input('volume', '0.2'); const state = first.app().getState(); await first.app().dispose(); const h = harness({ preserved: { [first.app().id]: { ...state, playing: true } } }); await flush(); assert.equal(h.app().getState().bpm, 156); assert.equal(h.app().getState().volume, 0.2); assert.equal(h.counts.starts, 0); assert.equal(h.app().getState().playing, false); });
test('two_instances_restore_separately', async () => { const saved = { bpm: 222, volume: 1, strudel: { [ID]: { bpm: 90, volume: 0.2 }, [OTHER]: { bpm: 160, volume: 0.7, playing: true } } }; const a = harness({ saved }), b = harness({ saved, id: OTHER }); await flush(); assert.notEqual(a.app().id, b.app().id); assert.equal(a.app().getState().bpm, 90); assert.equal(b.app().getState().bpm, 160); assert.equal(b.app().getState().playing, false); assert.equal(a.counts.starts + b.counts.starts, 0); });
test('controls_apply_immediately_and_clamp_finite_settings', async () => { const h = harness(); await flush(); await h.play(); h.input('bpm', '999'); h.input('volume', '-1'); assert.equal(h.repl.scheduler.cps, 1); assert.equal(h.controller.output.destinationGain.gain.value, 0); h.input('bpm', 'NaN'); h.input('volume', 'Infinity'); assert.equal(h.app().getState().bpm, 240); assert.equal(h.app().getState().volume, 0); h.input('bpm', '1'); h.input('volume', '2'); assert.equal(h.repl.scheduler.cps, 30 / 240); assert.equal(h.controller.output.destinationGain.gain.value, 1); });
test('escape_stops_while_question_overlay_has_focus', async () => { const h = harness(); await flush(); await h.play(); assert.equal(h.listeners.get('keydown').capture, true); h.listeners.get('keydown').fn({ key: 'Escape', target: { id: 'easel-input-dialog' } }); assert.equal(h.counts.activeSchedulers, 0); assert.equal(h.controller.output.destinationGain.gain.value, 0); });
test('stop_during_resume_cannot_restart_asynchronously', async () => { const resumeGate = deferred(); const h = harness({ resumeGate }); await flush(); const playing = h.play(); h.stop(); resumeGate.resolve(); await playing; assert.equal(h.counts.starts, 0); assert.equal(h.controller.output.destinationGain.gain.value, 0); });
test('dispose_during_scheduler_start_closes_once_and_never_restarts', async () => { const startGate = deferred(); const h = harness({ startGate }); await flush(); const playing = h.play(); await flush(); const disposed = h.app().dispose(); startGate.resolve(); await Promise.all([playing, disposed]); await h.app().dispose(); assert.equal(h.counts.activeSchedulers, 0); assert.equal(h.counts.activeAudioContexts, 0); assert.equal(h.counts.closes, 1); assert.equal(h.listeners.size, 0); });
test('duplicate_play_does_not_duplicate_context_or_scheduler', async () => { const resumeGate = deferred(); const h = harness({ resumeGate }); await flush(); const first = h.play(), second = h.play(); resumeGate.resolve(); await Promise.all([first, second]); assert.equal(h.counts.init, 1); assert.equal(h.counts.resumes, 1); assert.equal(h.counts.activeSchedulers, 1); });
test('audio_error_is_visible_and_retry_requires_new_gesture', async () => { const h = harness({ audioError: true }); await flush(); await h.play(); assert.match(h.element('status').textContent, /Audio unavailable/); assert.match(h.element('play').textContent, /retry/i); assert.equal(h.counts.activeSchedulers, 0); await h.play(); assert.equal(h.counts.activeSchedulers, 1); assert.equal(h.counts.init, 1); });
test('initialization_error_offers_silent_reload_retry', async () => { const h = harness({ initError: true }); await flush(); assert.match(h.element('status').textContent, /Initialization failed/); await h.play(); assert.equal(h.reloaded(), true); assert.equal(h.counts.starts, 0); });
test('pattern_error_stays_silent_and_pattern_change_requires_restart', async () => { const bad = harness({ patternError: true }); await flush(); await bad.play(); assert.match(bad.element('status').textContent, /Invalid pattern/); assert.equal(bad.counts.activeSchedulers, 0); const h = harness(); await flush(); await h.play(); h.window.EaselStrudel.patternChanged(); assert.equal(h.counts.activeSchedulers, 0); assert.match(h.element('status').textContent, /pattern.*play/i); assert.equal(h.app().getState().patternVersion, 2); });
test('pattern_snapshot_keeps_volume_separate_from_event_gain', async () => { const h = harness(); await flush(); h.input('volume', '0.2'); const { params, pattern } = h.window.EaselStrudel.snapshotPattern(); assert.equal(params.volume, 0.2); assert.equal(params.bpm, 100); assert.equal(pattern.eventGain, 0.3); assert.equal(params.playing, undefined); assert.ok(Object.isFrozen(params)); assert.equal(h.counts.starts, 0); });
test('factory_is_editable_local_source_and_rejects_invalid_identity', () => { const create = factory(); const result = create({ instanceId: ID }); assert.deepEqual(Object.keys(result.files), ['index.html']); assert.equal(result.entry, 'index.html'); assert.match(result.files[result.entry], /function createPattern\(params\)/); assert.match(result.files[result.entry], /Escape/); assert.doesNotMatch(result.files[result.entry], /\beval\s*\(|\.evaluate\s*\(|https?:\/\//); assert.throws(() => create({ instanceId: '<script>' }), /instance/i); });
test('snapshot_reuses_prepared_pattern_until_explicit_pattern_change', async () => { const h = harness(); await flush(); const first = h.window.EaselStrudel.snapshotPattern(); h.input('volume', '0.1'); h.input('bpm', '120'); const second = h.window.EaselStrudel.snapshotPattern(); assert.equal(first.pattern, second.pattern); assert.equal(h.counts.patterns, 1); assert.equal(second.params.bpm, 120); assert.equal(second.params.volume, 0.1); await h.play(); assert.equal(h.counts.patterns, 1); h.window.EaselStrudel.patternChanged(); h.window.EaselStrudel.snapshotPattern(); assert.equal(h.counts.patterns, 2); });
test('dispose_during_initialization_closes_context_and_keeps_late_ready_silent', async () => { const initGate = deferred(); const h = harness({ initGate }); await h.app().dispose(); initGate.resolve(); await flush(); assert.equal(h.counts.activeSchedulers, 0); assert.equal(h.counts.activeAudioContexts, 0); assert.equal(h.counts.closes, 1); assert.equal(h.element('play').disabled, true); assert.equal(h.window.EaselStrudel, undefined); });
test('restore_state_ignores_nonfinite_values_and_never_trusts_playback_or_source_version', async () => { const h = harness(); await flush(); await h.play(); h.app().restoreState({ bpm: Infinity, volume: NaN, patternVersion: 999, playing: true }); assert.equal(h.app().getState().bpm, 100); assert.equal(h.app().getState().volume, 0.5); assert.equal(h.app().getState().patternVersion, 1); assert.equal(h.counts.activeSchedulers, 0); assert.equal(h.controller.output.destinationGain.gain.value, 0); });


test('pinned_cyclist_first_tick_error_invalidates_pending_start_and_clears_clock', async () => {
  const h = harness({ usePinnedScheduler: true, firstTickError: true });
  await flush();
  await h.play();
  assert.equal(h.repl.scheduler.started, false);
  assert.equal(h.pinned.timers.size, 0, 'the first clock tick must not leave its later-created interval running');
  assert.equal(h.controller.output.destinationGain.gain.value, 0);
  assert.match(h.element('status').textContent, /\[cyclist\] error: First tick query failed/);
  assert.equal(h.element('status').attributes.role, 'alert');
  assert.equal(h.element('play').textContent, 'Retry Play');
  assert.equal(h.element('play').disabled, false);
  await h.element('play').click({ isTrusted: false });
  assert.equal(h.counts.starts, 1, 'an untrusted retry cannot restart');
  await h.play();
  assert.equal(h.repl.scheduler.started, true);
  assert.equal(h.pinned.timers.size, 1);
  await h.app().dispose();
});

test('pinned_getTrigger_error_after_playback_stops_mutes_and_offers_bounded_retry', async () => {
  const h = harness({ usePinnedScheduler: true });
  await flush(); await h.play();
  const trigger = h.pinned.getTrigger({ getTime: () => 1, defaultOutput: async () => { throw new Error('missing-synth ' + 'x'.repeat(1000)); } });
  await trigger({ context: {} }, 0, 1, 0.5, 1);
  assert.equal(h.repl.scheduler.started, false);
  assert.equal(h.pinned.timers.size, 0);
  assert.equal(h.controller.output.destinationGain.gain.value, 0);
  assert.match(h.element('status').textContent, /\[getTrigger\] error: missing-synth/);
  assert.ok(h.element('status').textContent.length < 320);
  assert.equal(h.element('play').textContent, 'Retry Play');
  assert.equal(h.element('play').disabled, false);
  await h.element('play').click({ isTrusted: false });
  assert.equal(h.counts.starts, 1);
  await h.play();
  assert.equal(h.repl.scheduler.started, true);
  await h.app().dispose();
});

test('forwarded_superdough_error_stops_but_informational_logs_do_not', async () => {
  const h = harness({ usePinnedScheduler: true });
  await flush(); await h.play();
  for (const message of ['[cyclist] start', '[cyclist] stop', '[superdough]: AudioWorklets disabled with disableWorklets', 'A pattern mentions error: in a string', '[getTrigger] ready']) {
    h.pinned.logger(message);
    assert.equal(h.repl.scheduler.started, true, message);
    assert.match(h.element('status').textContent, /^Playing/);
  }
  h.pinned.logger('[getTrigger] error: quoted example', 'info');
  assert.equal(h.repl.scheduler.started, true, 'explicit info logs are not runtime failures');
  h.pinned.superdough.errorLogger(new Error('Could not connect to target'));
  assert.equal(h.repl.scheduler.started, false);
  assert.equal(h.pinned.timers.size, 0);
  assert.equal(h.controller.output.destinationGain.gain.value, 0);
  assert.match(h.element('status').textContent, /\[superdough\] error: Could not connect to target/);
  assert.equal(h.element('play').disabled, false);
  await h.app().dispose();
});


test('suspended_context_mute_updates_current_gain_before_any_render_quantum', async () => {
  const h = harness();
  await flush();
  assert.equal(h.context.state, 'suspended');
  assert.equal(h.counts.resumes, 0);
  assert.equal(h.controller.output.destinationGain.gain.value, 0, 'scheduled automation alone leaves the suspended current-value getter at its default');
  assert.equal(h.scheduledGain(), 0, 'muting must also take effect when the context first renders');
  h.controller.output.destinationGain.gain.value = 0.8;
  h.app().restoreState({ bpm: 120, volume: 0.2 });
  assert.equal(h.context.state, 'suspended');
  assert.equal(h.controller.output.destinationGain.gain.value, 0);
  assert.equal(h.scheduledGain(), 0);
  assert.equal(h.app().getState().playing, false);
});
