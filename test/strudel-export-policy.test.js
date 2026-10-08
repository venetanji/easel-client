const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const load = () => {
  assert.ok(fs.existsSync(require("node:path").join(__dirname, "../src/strudel-export-policy.js")), "bounded Strudel snapshot policy is implemented");
  return require("../src/strudel-export-policy");
};
const snapshot = (overrides = {}) => ({ bpm: 120, cycles: 1, tailSeconds: 0.5, parameterDigest: "d".repeat(64), events: [{ timeSeconds: 0, durationSeconds: 0.5, absoluteCycle: 0, midiNote: 60, waveform: "sin", gain: 0.3, attackSeconds: 0.01, releaseSeconds: 0.05, envelopeMode: "explicit" }], ...overrides });
test("rejects_budget_and_unsupported_events", () => {
  const { validateStrudelSnapshot: validate } = load();
  const s = snapshot();
  const clean = validate(s);
  assert.equal(clean.events[0].waveform, "sine");
  assert.ok(Object.isFrozen(clean.events[0]));
  for (const change of [{ cycles: 17 }, { bpm: 30, cycles: 4 }, { tailSeconds: 0.4 }, { effects: [] }, { parameterDigest: "not-a-digest" }]) assert.throws(() => validate(snapshot(change)));
  for (const change of [{ waveform: "samples" }, { gain: 1.1 }, { midiNote: 23 }, { timeSeconds: NaN }, { callback: () => {
  } }, { releaseSeconds: 0.6 }, { durationSeconds: 3 }, { absoluteCycle: 0.2 }]) assert.throws(() => validate(snapshot({ events: [{ ...s.events[0], ...change }] })));
  assert.throws(() => validate(snapshot({ events: Array(4097).fill(s.events[0]) })), /event/i);
  assert.throws(() => validate(snapshot({ events: Array(33).fill(s.events[0]) })), /polyphony/i);
});
test("rounds_total_frames_once_and_counts_native_stop_allowance_in_polyphony", () => {
  const { validateStrudelSnapshot: validate, snapshotTiming } = load();
  const s = validate(snapshot({ bpm: 137 }));
  assert.equal(snapshotTiming(s).frames, Math.ceil((240 / 137 + 0.5) * 48e3));
  const e = snapshot().events[0];
  const events = Array(32).fill(e).concat([{ ...e, timeSeconds: 0.55, absoluteCycle: 0.275 }]);
  assert.throws(() => validate(snapshot({ events })), /polyphony/i);
  assert.equal(validate(snapshot({ events: [] })).events.length, 0, "bounded rests and volume-zero loops may export silence");
});
test("wav_matches_header_and_frames", () => {
  const { validateStrudelWav, snapshotTiming } = load();
  const { encodePCM16Wav } = require("../src/strudel-export-renderer");
  const timing = snapshotTiming(snapshot());
  const a = new Float32Array(timing.frames);
  a[0] = 0.5;
  a[1] = -1;
  const bytes = Buffer.from(encodePCM16Wav({ sampleRate: 48e3, numberOfChannels: 2, length: timing.frames, getChannelData: () => a }));
  const result = validateStrudelWav(bytes, snapshot());
  assert.equal(result.channels, 2);
  assert.equal(result.bitsPerSample, 16);
  assert.equal(result.frames, timing.frames);
  assert.equal(result.duration, timing.frames / 48e3);
  assert.equal(bytes.readInt16LE(44), 16384);
  assert.equal(bytes.readInt16LE(48), -32768);
  for (const [offset, value] of [[4, bytes.length], [20, 3], [22, 1], [24, 44100], [28, 1], [32, 1], [34, 32], [40, 4]]) {
    const bad = Buffer.from(bytes);
    if ([20, 22, 32, 34].includes(offset)) bad.writeUInt16LE(value, offset);
    else bad.writeUInt32LE(value, offset);
    assert.throws(() => validateStrudelWav(bad, snapshot()));
  }
  assert.throws(() => validateStrudelWav(bytes.subarray(0, -1), snapshot()));
  assert.throws(() => validateStrudelWav(Buffer.concat([bytes, Buffer.from([0])]), snapshot()));
});
test("query_snapshot_retains_only_onsets_and_rejects_unsupported_authored_semantics", () => {
  const { queryStrudelSnapshot } = load();
  const fraction = (value) => ({ valueOf: () => value });
  const event = (value, onset = true) => ({ whole: { begin: fraction(0), end: fraction(0.25) }, value, hasOnset: () => onset });
  let arc;
  const types = { State: class { constructor(span) { this.span = span; } }, TimeSpan: class { constructor(begin, end) { this.begin = begin; this.end = end; } } };
  const pattern = { query(state) {
    arc = [state.span.begin, state.span.end];
    return [event({ note: "c4", s: "tri", gain: 0.3, attack: 0.01, release: 0.05 }), event({ unsupported: 1 }, false)];
  } };
  const params = { bpm: 120, volume: 0.5, patternVersion: 1 };
  const s = queryStrudelSnapshot(pattern, params, 1, "d".repeat(64), types);
  assert.deepEqual(arc, [0, 1]);
  assert.equal(s.events[0].midiNote, 60);
  assert.equal(s.events[0].gain, 0.15);
  assert.equal(s.events[0].durationSeconds, 0.5);
  for (const value of [{ note: "c4", s: "sine", room: 1 }, { note: "c4", s: "sine", duration: 1 }, { note: "c4", s: "sine", clip: 0.5 }, { note: ["c4"], s: "sine" }, { note: "c4", s: "sine", gain: () => 1 }]) assert.throws(() => queryStrudelSnapshot({ query: () => [event(value)] }, params, 1, "d".repeat(64), types), /unsupported|finite|note/i);
});
module.exports = { snapshot };

async function pinnedCore() {
  const [{ pure, silence }, { State }, { TimeSpan }] = await Promise.all([
    import('../node_modules/@strudel/core/pattern.mjs'), import('../node_modules/@strudel/core/state.mjs'), import('../node_modules/@strudel/core/timespan.mjs'),
  ]);
  return { pure, silence, State, TimeSpan };
}
test('pinned_trigger_context_rejects_dominant_and_nondominant_callbacks_but_keeps_locations', async () => {
  const core = await pinnedCore(); const { queryStrudelSnapshot } = load(); const params = { bpm: 120, volume: 1 };
  const p = core.pure({ note: 'c4', s: 'sine', gain: 0.3, attack: 0.01, release: 0.05 });
  for (const dominant of [true, false]) assert.throws(() => queryStrudelSnapshot(p.onTrigger(() => {}, dominant), params, 1, 'd'.repeat(64), core), /context|callback/i);
  const safe = queryStrudelSnapshot(p.withLoc(1, 9), params, 1, 'd'.repeat(64), core); assert.equal(safe.events.length, 1);
  assert.throws(() => queryStrudelSnapshot(p.setContext({ locations: [{ start: () => 1, end: 2 }] }), params, 1, 'd'.repeat(64), core), /context|location|callback/i);
  let executed = 0; const location = Object.create({ get start() { executed++; return 1; } }); location.end = 2;
  assert.throws(() => queryStrudelSnapshot(p.setContext({ locations: [location] }), params, 1, 'd'.repeat(64), core), /context|location/i); assert.equal(executed, 0);
  const inherited = Object.assign(Object.create({ gain: 1 }), { note: 'c4', s: 'sine' });
  assert.throws(() => queryStrudelSnapshot(core.pure(inherited), params, 1, 'd'.repeat(64), core), /unsupported/i);
});
test('pinned_missing_gain_matches_native_point_eight_and_supplied_null_controls_reject', async () => {
  const core = await pinnedCore(); const { queryStrudelSnapshot } = load(); const params = { bpm: 120, volume: 0.5 };
  const value = { note: 'c4', s: 'sine', attack: 0.01, release: 0.05 };
  const absent = queryStrudelSnapshot(core.pure(value), params, 1, 'd'.repeat(64), core);
  const explicit = queryStrudelSnapshot(core.pure({ ...value, gain: 0.8 }), params, 1, 'd'.repeat(64), core);
  assert.equal(absent.events[0].gain, 0.4); assert.deepEqual(absent.events, explicit.events);
  for (const control of ['gain', 'attack', 'release']) for (const invalid of [null, undefined, NaN, '0.1']) assert.throws(() => queryStrudelSnapshot(core.pure({ ...value, [control]: invalid }), params, 1, 'd'.repeat(64), core), /finite|control/i);
});
test('plain_envelope_discriminator_preserves_native_default_and_explicit_branches', async () => {
  const core = await pinnedCore(); const { queryStrudelSnapshot, validateStrudelSnapshot } = load(); const base = { note: 'c4', s: 'sine', gain: 0.3 };
  for (const [controls, mode] of [[{}, 'native-default'], [{ attack: 0.01 }, 'explicit'], [{ release: 0.05 }, 'explicit'], [{ attack: 0.001, release: 0.01 }, 'explicit']]) {
    const s = queryStrudelSnapshot(core.pure({ ...base, ...controls }), { bpm: 120, volume: 1 }, 1, 'd'.repeat(64), core);
    assert.equal(s.events[0].envelopeMode, mode); assert.equal(s.events[0].attackSeconds, controls.attack ?? 0.001); assert.equal(s.events[0].releaseSeconds, controls.release ?? 0.01);
    assert.equal(validateStrudelSnapshot(s).events[0].envelopeMode, mode);
  }
  const e = { ...snapshot().events[0], envelopeMode: 'native-default', attackSeconds: 0.001, releaseSeconds: 0.01 };
  assert.throws(() => validateStrudelSnapshot(snapshot({ events: [{ ...e, attackSeconds: 0.02 }] })), /envelope|default/i);
  assert.throws(() => validateStrudelSnapshot(snapshot({ events: [{ ...e, envelopeMode: 'arbitrary' }] })), /envelope/i);
});
test('pinned_query_error_is_not_a_silent_snapshot_and_genuine_rests_remain_valid', async () => {
  const core = await pinnedCore(); const { queryStrudelSnapshot } = load();
  const failing = core.pure({ note: 'c4', s: 'sine' }).withValue(() => { throw new Error('authored query failed'); });
  assert.throws(() => queryStrudelSnapshot(failing, { bpm: 120, volume: 1 }, 1, 'd'.repeat(64), core), /authored query failed/);
  assert.deepEqual(queryStrudelSnapshot(core.silence, { bpm: 120, volume: 1 }, 1, 'd'.repeat(64), core).events, []);
});
test('polyphony_counts_effective_native_minimum_release_before_stop_allowance', () => {
  const { validateStrudelSnapshot } = load();
  for (const releaseSeconds of [0, 0.005, 0.01]) {
    const first = { ...snapshot().events[0], envelopeMode: 'explicit', releaseSeconds };
    const next = { ...first, timeSeconds: 0.515, absoluteCycle: 0.2575 };
    assert.throws(() => validateStrudelSnapshot(snapshot({ events: [...Array(32).fill(first), ...Array(32).fill(next)] })), /polyphony/i);
    assert.equal(validateStrudelSnapshot(snapshot({ events: [...Array(32).fill(first), ...Array(32).fill({ ...next, timeSeconds: 0.52, absoluteCycle: 0.26 })] })).events.length, 64);
  }
});
