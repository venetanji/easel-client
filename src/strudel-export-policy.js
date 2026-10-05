// Shared, plain-data policy. These functions are also copied into editable
// starter source; they require no Node, live audio, callbacks or Strudel globals.
function validateStrudelSnapshot(input) {
  const record = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) throw new Error(`${label} contains unsupported fields or executable values.`);
    if (keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} is incomplete.`);
  };
  const finite = (value, min, max, label) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be finite and between ${min} and ${max}.`);
    return value;
  };
  record(input, ["bpm", "cycles", "tailSeconds", "parameterDigest", "events"], "Strudel snapshot");
  const bpm = finite(input.bpm, 30, 240, "Tempo");
  if (!Number.isInteger(input.cycles) || input.cycles < 1 || input.cycles > 16) throw new Error("Export between 1 and 16 cycles.");
  if (input.tailSeconds !== 0.5) throw new Error("Export requires the bounded 0.5-second tail.");
  if (typeof input.parameterDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.parameterDigest)) throw new Error("Parameter digest is invalid.");
  const loopSeconds = input.cycles * 240 / bpm;
  const frames = Math.ceil((loopSeconds + 0.5) * 48000);
  if (frames > 30 * 48000 || 44 + frames * 4 >= 6 * 1024 * 1024) throw new Error("Export including its tail must fit 30 seconds and 6 MiB. Reduce cycles or raise tempo.");
  if (!Array.isArray(input.events) || input.events.length > 4096) throw new Error("Export supports at most 4096 onset events.");
  const aliases = { sin: "sine", sine: "sine", tri: "triangle", triangle: "triangle", sqr: "square", square: "square", saw: "sawtooth", sawtooth: "sawtooth" };
  const points = [];
  const events = input.events.map((event) => {
    record(event, ["timeSeconds", "durationSeconds", "absoluteCycle", "midiNote", "waveform", "gain", "attackSeconds", "releaseSeconds", "envelopeMode"], "Strudel event");
    const timeSeconds = finite(event.timeSeconds, 0, loopSeconds, "Event onset");
    if (timeSeconds >= loopSeconds) throw new Error("Event onset is outside the selected cycles.");
    const durationSeconds = finite(event.durationSeconds, Number.MIN_VALUE, loopSeconds, "Event duration");
    const absoluteCycle = finite(event.absoluteCycle, 0, input.cycles, "Event cycle");
    if (Math.abs(absoluteCycle * 240 / bpm - timeSeconds) > 1e-8 || timeSeconds + durationSeconds > loopSeconds + 1e-8) throw new Error("Event cycle/duration does not match the selected loop.");
    const midiNote = finite(event.midiNote, 24, 96, "MIDI note");
    const waveform = typeof event.waveform === "string" && Object.hasOwn(aliases, event.waveform) ? aliases[event.waveform] : "";
    if (!waveform) throw new Error("Unsupported waveform. Export uses native sine, triangle, square or sawtooth only.");
    const gain = finite(event.gain, 0, 1, "Event gain");
    const attackSeconds = finite(event.attackSeconds, 0, 0.5, "Attack");
    const releaseSeconds = finite(event.releaseSeconds, 0, 0.5, "Release");
    const envelopeMode = event.envelopeMode;
    if (!["native-default", "explicit"].includes(envelopeMode) || (envelopeMode === "native-default" && (attackSeconds !== 0.001 || releaseSeconds !== 0.01))) throw new Error("The native envelope discriminator/default fields are invalid.");
    // Native synth stops 0.01s after its release. Voices are conservatively
    // budgeted through that allowance; output is cropped at the fixed tail.
    points.push([timeSeconds, 1], [timeSeconds + durationSeconds + Math.max(releaseSeconds, 0.01) + 0.01, -1]);
    return Object.freeze({ timeSeconds, durationSeconds, absoluteCycle, midiNote, waveform, gain, attackSeconds, releaseSeconds, envelopeMode });
  });
  let voices = 0;
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, change] of points) {
    voices += change;
    if (voices > 32) throw new Error("Export exceeds the 32-voice polyphony budget.");
  }
  events.sort((a, b) => a.timeSeconds - b.timeSeconds || a.midiNote - b.midiNote || a.waveform.localeCompare(b.waveform) || a.durationSeconds - b.durationSeconds || a.gain - b.gain || a.attackSeconds - b.attackSeconds || a.releaseSeconds - b.releaseSeconds || a.envelopeMode.localeCompare(b.envelopeMode));
  return Object.freeze({ bpm, cycles: input.cycles, tailSeconds: 0.5, parameterDigest: input.parameterDigest, events: Object.freeze(events) });
}
function snapshotTiming(snapshot) {
  const frames = Math.ceil((snapshot.cycles * 240 / snapshot.bpm + 0.5) * 48000);
  return { frames, duration: frames / 48000, channels: 2, sampleRate: 48000, bytes: 44 + frames * 4 };
}
function queryStrudelSnapshot(pattern, params, cycles, parameterDigest, { State, TimeSpan } = {}) {
  // Reject huge selections before invoking authored query code.
  const empty = validateStrudelSnapshot({ bpm: params.bpm, cycles, tailSeconds: 0.5, parameterDigest, events: [] });
  if (!Number.isFinite(params.volume) || params.volume < 0 || params.volume > 1) throw new Error("Export volume is invalid.");
  if (typeof pattern?.query !== "function" || typeof State !== "function" || typeof TimeSpan !== "function") throw new Error("The pinned native pattern query API is unavailable.");
  // The pinned queryArc catches/logs errors and returns the same [] as a rest.
  // Query the same bounded native State directly so authored errors propagate.
  const haps = pattern.query(new State(new TimeSpan(0, cycles)));
  if (!Array.isArray(haps) || haps.length > 8192) throw new Error("The queried pattern exceeds the event budget.");
  const events = [];
  for (const hap of haps) {
    if (hap.stateful || typeof hap.value === "function" || !hap.whole || typeof hap.hasOnset !== "function") throw new Error("Unsupported continuous or stateful pattern event.");
    const context = hap.context ?? {};
    if (!context || typeof context !== "object" || Array.isArray(context) || ![Object.prototype, null].includes(Object.getPrototypeOf(context)) || Reflect.ownKeys(context).some(key => key !== "locations" || !Object.hasOwn(Object.getOwnPropertyDescriptor(context, key), "value"))) throw new Error("Unsupported callback or executable Hap context.");
    if (context.locations !== undefined && (!Array.isArray(context.locations) || context.locations.some(location => !location || typeof location !== "object" || Array.isArray(location) || ![Object.prototype, null].includes(Object.getPrototypeOf(location)) || Reflect.ownKeys(location).some(key => !["start", "end"].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(location, key), "value")) || !Number.isFinite(location.start) || !Number.isFinite(location.end)))) throw new Error("Unsupported executable source-location context.");
    if (!hap.hasOnset()) continue;
    const value = hap.value;
    const keys = ["note", "s", "gain", "attack", "release"];
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) throw new Error("Unsupported pattern fields. Export excludes samples, effects, callbacks, duration and clip overrides.");
    let midiNote = value.note;
    if (typeof midiNote === "string") {
      // Matches the pinned native note spelling/default-octave semantics.
      const match = /^([a-gA-G])([#bsf]*)(-?[0-9]*)$/.exec(midiNote);
      if (!match) throw new Error("Unsupported note spelling.");
      const chroma = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[match[1].toLowerCase()];
      const accidentals = [...match[2]].reduce((sum, accidental) => sum + { "#": 1, s: 1, b: -1, f: -1 }[accidental], 0);
      midiNote = ((match[3] ? Number(match[3]) : 3) + 1) * 12 + chroma + accidentals;
    }
    const absoluteCycle = Number(hap.whole.begin), end = Number(hap.whole.end);
    if (!Number.isFinite(absoluteCycle) || !Number.isFinite(end)) throw new Error("Event timing must be finite.");
    for (const control of ["gain", "attack", "release"]) if (Object.hasOwn(value, control) && (typeof value[control] !== "number" || !Number.isFinite(value[control]))) throw new Error(`Supplied ${control} control must be a finite number.`);
    const gain = Object.hasOwn(value, "gain") ? value.gain : 0.8;
    if (typeof gain !== "number" || !Number.isFinite(gain) || gain < 0 || gain > 1) throw new Error("Event gain must be finite and between 0 and 1 before volume.");
    events.push({
      timeSeconds: absoluteCycle * 240 / params.bpm,
      durationSeconds: (end - absoluteCycle) * 240 / params.bpm,
      absoluteCycle,
      midiNote,
      waveform: value.s,
      gain: gain * params.volume,
      attackSeconds: Object.hasOwn(value, "attack") ? value.attack : 0.001,
      releaseSeconds: Object.hasOwn(value, "release") ? value.release : 0.01,
      envelopeMode: Object.hasOwn(value, "attack") || Object.hasOwn(value, "release") ? "explicit" : "native-default"
    });
    if (events.length > 4096) throw new Error("Export supports at most 4096 onset events.");
  }
  return validateStrudelSnapshot({ ...empty, events });
}
function validateStrudelWav(input, snapshot) {
  const bytes = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input) : null;
  if (!bytes || bytes.length < 44 || bytes.length >= 6 * 1024 * 1024 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) !== bytes.length - 8) throw new Error("Export WAV RIFF length or format is invalid.");
  let offset = 12, fmt, data;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Export WAV has a truncated chunk.");
    const type = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4), end = offset + 8 + length;
    if (end > bytes.length || end + length % 2 > bytes.length) throw new Error("Export WAV chunk length is invalid.");
    if (type === "fmt " && !fmt && length === 16) fmt = bytes.subarray(offset + 8, end);
    else if (type === "data" && !data) data = bytes.subarray(offset + 8, end);
    else throw new Error("Export WAV has duplicate or unsupported chunks.");
    offset = end + length % 2;
  }
  if (!fmt || !data || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 2 || fmt.readUInt32LE(4) !== 48000 || fmt.readUInt32LE(8) !== 192000 || fmt.readUInt16LE(12) !== 4 || fmt.readUInt16LE(14) !== 16 || data.length % 4) throw new Error("Export must be complete stereo 48 kHz PCM16 WAV.");
  const timing = snapshotTiming(validateStrudelSnapshot(snapshot));
  if (data.length !== timing.frames * 4 || bytes.length !== timing.bytes) throw new Error("Export WAV frames do not match the frozen loop.");
  return { ...timing, bitsPerSample: 16 };
}
module.exports = { validateStrudelSnapshot, snapshotTiming, queryStrudelSnapshot, validateStrudelWav };
