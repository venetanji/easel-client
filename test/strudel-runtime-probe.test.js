const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const runtime = require('../scripts/probe-strudel-runtime.cjs');

async function restartSimulation({ brokenRestart }) {
  const html = runtime.fixtureHtml('window.strudel = {};', false);
  const matched = html.match(/<script>\((async function playbackProbe\(\) \{[\s\S]*?)\)\(\);<\/script>/);
  assert.ok(matched);
  const state = { errors: [], violations: [], plays: 0, peaks: [], ready: false };
  const buttons = { '#play': {}, '#stop': {} };
  let gain = 1, tick, playCalls = 0, notesScheduled = 0, noteEnds = 0;
  const scheduler = { started: false };
  const context = { state: 'suspended', currentTime: 0, async resume() { this.state = 'running'; }, async close() {},
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData(data) { data.fill(context.currentTime < noteEnds ? 0.2 * gain : 0); } }; } };
  const output = { destinationGain: { connect() {}, gain: { setValueAtTime(value) { gain = value; } } }, disconnect() {} };
  const pattern = { s() { return this; }, gain() { return this; }, release() { return this; }, play() {
    playCalls++;
    if (playCalls === 1 || !brokenRestart) { scheduler.started = true; notesScheduled++; noteEnds = context.currentTime + 2.06; }
    return this;
  } };
  const strudel = { async initStrudel() { return { scheduler }; }, getAudioContext() { return context; }, getSuperdoughAudioController() { return { output }; },
    async initAudio() {}, note() { return pattern; }, hush() { scheduler.started = false; } };
  await vm.runInNewContext(`(${matched[1]})()`, { window: { probe: state }, strudel,
    document: { querySelector: (id) => buttons[id] }, navigator: { userActivation: { isActive: true } },
    setInterval(callback) { tick = callback; } });
  const advance = () => { context.currentTime += 0.02; tick(); };
  const event = { isTrusted: true, detail: 0 };
  await buttons['#play'].onclick(event);
  for (let i = 0; i < 12; i++) advance();
  buttons['#stop'].onclick();
  const drained = runtime.stopIsDrained;
  for (let i = 0; i < 250 && !drained(state); i++) advance();
  assert.ok(drained(state), 'bounded Stop drain must complete');
  const oldVoiceEnds = noteEnds;
  state.peaks = [];
  await buttons['#play'].onclick(event);
  for (let i = 0; i < 12; i++) advance();
  assert.deepEqual(state.errors, []);
  const accepts = runtime.hasRestartSignal;
  return { accepted: accepts(state), notesScheduled, restartAt: context.currentTime - 0.24, oldVoiceEnds };
}

test('restart_gate_rejects_unmuting_an_old_voice_when_second_play_is_noop', async () => {
  const result = await restartSimulation({ brokenRestart: true });
  assert.equal(result.notesScheduled, 1);
  assert.equal(result.accepted, false, 'a restart with no new scheduled note must not pass');
  assert.ok(result.restartAt > result.oldVoiceEnds, 'restart must wait beyond the first voice lifetime');
});

test('restart_gate_accepts_sustained_new_signal_after_prior_voices_end', async () => {
  const result = await restartSimulation({ brokenRestart: false });
  assert.equal(result.notesScheduled, 2);
  assert.equal(result.accepted, true);
  assert.ok(result.restartAt > result.oldVoiceEnds);
});

test('keyboard_input_requires_native_window_and_document_focus', async () => {
  assert.equal(typeof runtime.sendKeyboardActivation, 'function');
  const events = [];
  let focused = false;
  const win = { show() { events.push('show'); }, focus() { events.push('window-focus'); },
    webContents: { focus() { events.push('web-focus'); focused = true; },
      async executeJavaScript(source) { events.push(source); if (source === 'document.hasFocus()') return focused; },
      sendInputEvent(event) { assert.ok(focused); events.push(event.type); } } };
  await runtime.sendKeyboardActivation(win, 'play');
  assert.deepEqual(events.slice(0, 3), ['show', 'window-focus', 'web-focus']);
  assert.ok(events.indexOf('document.hasFocus()') < events.indexOf('keyDown'));
  assert.deepEqual(events.slice(-3), ['keyDown', 'char', 'keyUp']);
});

test('unfocused_document_never_receives_native_keyboard_input', async () => {
  assert.equal(typeof runtime.sendKeyboardActivation, 'function');
  let sent = 0;
  const win = { show() {}, focus() {}, webContents: { focus() {}, async executeJavaScript() { return false; }, sendInputEvent() { sent++; } } };
  await assert.rejects(runtime.sendKeyboardActivation(win, 'play'), /focus/i);
  assert.equal(sent, 0);
});

test('stop_and_restart_evidence_requires_matching_scheduler_state', () => {
  assert.equal(runtime.stopIsDrained({ stopped: true, stoppedAt: 1, audioTime: 5, schedulerStarted: true, peaks: Array(10).fill(0) }), false);
  assert.equal(runtime.hasRestartSignal({ plays: 2, schedulerStarted: false, peaks: Array(10).fill(0.2) }), false);
});


test('native_enter_includes_char_to_activate_a_button', async () => {
  const sent = [];
  const win = { show() {}, focus() {}, webContents: { focus() {},
    async executeJavaScript(source) { return source === 'document.hasFocus()' ? true : undefined; },
    sendInputEvent(event) { sent.push(event); } } };
  await runtime.sendKeyboardActivation(win, 'play');
  assert.deepEqual(sent, [
    { type: 'keyDown', keyCode: 'Enter' },
    { type: 'char', keyCode: 'Enter' },
    { type: 'keyUp', keyCode: 'Enter' },
  ]);
});

test('bounded_stage_wait_reports_last_audio_state_instead_of_bare_watchdog', async () => {
  assert.equal(typeof runtime.waitForProbeState, 'function');
  const state = { phase: 'resuming-audio', playEvents: 1, plays: 0, audioState: 'suspended', audioTime: 0,
    errors: [], violations: [], peaks: [0], nativeInput: [{ type: 'click', trusted: true, active: true, target: 'play' }] };
  await assert.rejects(runtime.waitForProbeState(async () => state, () => false, 'first-signal', 1),
    (error) => /first-signal timed out/.test(error.message) && /resuming-audio/.test(error.message) && /suspended/.test(error.message));
  assert.equal(await runtime.waitForProbeState(async () => state, () => true, 'ready', 1), state);
});

test('diagnostic_snapshot_is_bounded_and_keeps_input_audio_and_strudel_errors', () => {
  assert.equal(typeof runtime.summarizeProbeState, 'function');
  const summary = runtime.summarizeProbeState({ phase: 'awaiting-sound', audioState: 'running', audioTime: 2,
    schedulerStarted: true, playEvents: 1, plays: 1, peaks: Array(10000).fill(0.2),
    errors: Array(100).fill('x'.repeat(2000)), violations: [], nativeInput: Array(100).fill({ type: 'keypress', key: 'Enter' }),
    logs: Array(100).fill({ message: '[getTrigger] error: native failure', type: 'error' }) });
  assert.equal(summary.phase, 'awaiting-sound');
  assert.equal(summary.audioState, 'running');
  assert.equal(summary.maxPeak, 0.2);
  assert.ok(summary.errors.length <= 20 && summary.errors[0].length <= 1000);
  assert.ok(summary.nativeInput.length <= 12 && summary.logs.length <= 20);
  assert.match(summary.logs.at(-1).message, /getTrigger/);
});
