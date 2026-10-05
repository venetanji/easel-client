const { validateOpaqueId } = require('./ipc-contract');

// This function is copied into ordinary editable project source, not evaluated.
function bootStrudelSketch(instanceId) {
  const id = `strudel-${instanceId}`;
  const control = (name) => document.getElementById(`${id}-${name}`);
  const playButton = control('play'), stopButton = control('stop');
  const bpmInput = control('bpm'), volumeInput = control('volume'), status = control('status');
  const state = { bpm: 100, volume: 0.5, patternVersion: 1, playing: false };
  let context, controller, repl, disposed = false, pending = false, epoch = 0, startingEpoch = -1;
  let initializationFailed = false, disposal, preparedPattern;
  const bounded = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  function report(message, error = false) {
    status.textContent = message;
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  function setGain(value) {
    const gain = controller?.output.destinationGain?.gain;
    if (!gain || context.state === 'closed') return;
    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(value, context.currentTime);
  }
  function syncControls() {
    bpmInput.value = String(state.bpm);
    volumeInput.value = String(state.volume);
    control('volume-value').textContent = `${Math.round(state.volume * 100)}%`;
  }
  function stop(message = 'Stopped. Press Play to restart.') {
    epoch++;
    state.playing = false;
    setGain(0); // hush alone does not silence already scheduled synth tails.
    if (repl) window.strudel.hush();
    if (!disposed) { playButton.disabled = pending; report(message); }
  }
  function getState() {
    // Playback is deliberately never restored, including preserved-state reloads.
    return { bpm: state.bpm, volume: state.volume, patternVersion: state.patternVersion, playing: false };
  }
  function restoreState(previous) {
    if (!previous || typeof previous !== 'object' || disposed) return;
    stop('Ready. Press Play to listen.');
    state.bpm = bounded(previous.bpm, 30, 240, state.bpm);
    state.volume = bounded(previous.volume, 0, 1, state.volume);
    // Source owns patternVersion; persisted state must not undo a source edit.
    repl?.setCps(state.bpm / 240);
    syncControls();
  }
  function patternChanged() {
    if (disposed) return;
    state.patternVersion++;
    preparedPattern = undefined;
    stop('Pattern changed. Press Play to hear the new pattern.');
  }
  function snapshotPattern() {
    if (disposed || !repl) throw new Error('The sound sketch is not ready.');
    // Four beats per cycle. Event gain belongs to createPattern; volume is a
    // separate output multiplier. Future export applies it exactly once.
    const params = Object.freeze({ bpm: state.bpm, volume: state.volume, patternVersion: state.patternVersion });
    preparedPattern ||= createPattern(params);
    return { params, pattern: preparedPattern };
  }
  async function play(event) {
    if (disposed || pending || state.playing) return;
    if (!event.isTrusted || !navigator.userActivation.isActive) { report('Press Play yourself to enable sound.', true); return; }
    if (initializationFailed) { window.location.reload(); return; }
    const token = ++epoch;
    pending = true;
    playButton.disabled = true;
    report('Starting sound…');
    try {
      // Resume synchronously inside the trusted click, before any await. Native
      // button Enter/Space activation follows the same gesture path as a mouse.
      const resumed = context.resume();
      await resumed;
      await ready;
      if (disposed || token !== epoch) return;
      await window.strudel.initAudio({ disableWorklets: true });
      if (disposed || token !== epoch) return;
      const { pattern } = snapshotPattern();
      // Keep old voices disconnected when starting again, even if authored notes
      // have long releases. This is the pinned public SuperDough reset API.
      controller.reset();
      setGain(0);
      repl.setCps(state.bpm / 240);
      await repl.setPattern(pattern, false);
      if (disposed || token !== epoch) return;
      startingEpoch = token;
      await repl.start();
      if (disposed || token !== epoch) { window.strudel.hush(); setGain(0); return; }
      state.playing = true;
      setGain(state.volume);
      playButton.textContent = 'Play';
      report('Playing. Stop or press Escape for silence.');
    } catch (error) {
      if (!disposed && token === epoch) {
        stop();
        playButton.textContent = 'Retry Play';
        report(`Sound could not start: ${error.message}. Check createPattern in app.js, then Retry Play.`, true);
      }
    } finally {
      pending = false;
      if (!disposed) playButton.disabled = state.playing;
    }
  }
  function updateBpm() {
    state.bpm = bounded(Number(bpmInput.value), 30, 240, state.bpm);
    repl?.setCps(state.bpm / 240);
    syncControls();
  }
  function updateVolume() {
    state.volume = bounded(Number(volumeInput.value), 0, 1, state.volume);
    if (state.playing) setGain(state.volume);
    syncControls();
  }
  const stopClick = () => stop();
  const escape = (event) => { if (event.key === 'Escape') stop(); };
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    stop();
    playButton.disabled = true;
    playButton.removeEventListener('click', play);
    stopButton.removeEventListener('click', stopClick);
    bpmInput.removeEventListener('input', updateBpm);
    volumeInput.removeEventListener('input', updateVolume);
    document.removeEventListener('keydown', escape, true);
    document.removeEventListener('strudel.log', audioLog);
    window.removeEventListener('pagehide', dispose);
    // Close immediately rather than awaiting a pending resume/start operation.
    // Guarded beforeStart/onToggle also stop a late scheduler completion.
    controller?.output.disconnect();
    disposal = Promise.resolve(context && context.state !== 'closed' ? context.close() : undefined);
    if (window.EaselStrudel === api) delete window.EaselStrudel;
    return disposal;
  }
  function audioLog(event) {
    const detail = event.detail;
    const message = typeof detail?.message === 'string' ? detail.message : 'Unknown audio error';
    // Pinned core and SuperDough errorLogger emit an untyped, prefixed message.
    // Query/trigger failures are logged rather than rejecting repl.start().
    const runtimeError = detail?.type === 'error' ||
      (detail?.type === undefined && /^\[(?:cyclist|getTrigger|superdough)\] error:/.test(message));
    if (!disposed && runtimeError) {
      stop();
      playButton.textContent = 'Retry Play';
      report(`Pattern error: ${message.slice(0, 240)}. Edit app.js, then Retry Play.`, true);
    }
  }
  const api = { getState, restoreState, stop, patternChanged, snapshotPattern };
  window.EaselStrudel = api;
  syncControls();
  restoreState(window.__easelProjectState?.strudel?.[instanceId]);
  window.EaselCanvas?.registerApp({ id, dispose, getState, restoreState });
  playButton.addEventListener('click', play);
  stopButton.addEventListener('click', stopClick);
  bpmInput.addEventListener('input', updateBpm);
  volumeInput.addEventListener('input', updateVolume);
  // Capture Escape before the existing question overlay handles its own dismissal.
  // This listener never submits or cancels an answer, and does not trap focus.
  document.addEventListener('keydown', escape, true);
  document.addEventListener('strudel.log', audioLog);
  window.addEventListener('pagehide', dispose);
  playButton.disabled = true;
  const ready = (async () => {
    try {
      context = window.strudel.getAudioContext();
      controller = window.strudel.getSuperdoughAudioController();
      setGain(0);
      repl = await window.strudel.initStrudel({ sync: false,
        beforeStart() { if (disposed || startingEpoch !== epoch) throw new Error('Playback was stopped.'); },
        onToggle(started) { if (started && (disposed || startingEpoch !== epoch)) { window.strudel.hush(); setGain(0); } },
      });
      if (disposed) { window.strudel.hush(); return; }
      repl.setCps(state.bpm / 240);
      playButton.disabled = false;
      report('Ready. Press Play to listen.');
    } catch (error) {
      if (disposed) return;
      initializationFailed = true;
      setGain(0);
      playButton.disabled = false;
      playButton.textContent = 'Retry setup';
      report(`Initialization failed: ${error.message}. Retry setup reloads this sketch silently.`, true);
    }
  })();
}

function createStrudelTemplate({ instanceId } = {}) {
  validateOpaqueId(instanceId, 'Strudel instance ID');
  const id = `strudel-${instanceId}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Strudel sound</title><style>
:root{color-scheme:light;font-family:"Segoe UI","Helvetica Neue",sans-serif;background:#fbfaf6;color:#202d27;--line:#d4d9d0;--green:#174d3a;--muted:#58675f}*{box-sizing:border-box}body{margin:0;padding:clamp(20px,5vw,56px)}main{max-width:720px;margin:auto}h1{font-size:clamp(28px,5vw,42px);letter-spacing:-.025em;margin:0 0 12px}p{line-height:1.6;max-width:65ch}button,input{font:inherit;accent-color:var(--green)}button{padding:11px 22px;border:1px solid var(--line);border-radius:6px;color:inherit;background:#fbfaf6;cursor:pointer;font-weight:600}button:first-child{background:var(--green);color:white}button:hover{filter:brightness(.94)}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid var(--green);outline-offset:4px}::selection{background:#d4e6d9}.transport{display:flex;gap:12px;flex-wrap:wrap;margin:28px 0 16px}.controls{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin:28px 0;padding:24px 0;border-block:1px solid var(--line)}label{display:grid;gap:12px;font-weight:600}input[type=number]{width:100%;max-width:150px;background:white;border:1px solid var(--line);border-radius:6px;padding:10px;color:inherit;caret-color:var(--green)}input[type=range]{width:100%;min-height:36px}output{font-variant-numeric:tabular-nums;font-weight:400}h2{font-size:19px;margin:32px 0 8px}.muted{color:var(--muted)}[role=alert]{color:#9d3425}code{font-size:.94em}footer{margin-top:32px;font-size:13px;color:var(--muted)}@media(max-width:420px){.controls{grid-template-columns:1fr;gap:22px}}
</style></head><body><main><h1>Strudel sound</h1><p class="muted">A small melody, ready to make your own. Sound starts only when you press Play.</p>
<div class="transport" aria-label="Playback"><button type="button" id="${id}-play">Play</button><button type="button" id="${id}-stop">Stop</button></div>
<p id="${id}-status" role="status" aria-live="polite">Preparing sound…</p><p class="muted">Press Escape to stop, including while a canvas question is open.</p>
<div class="controls"><label for="${id}-bpm">Tempo · BPM<input id="${id}-bpm" type="number" min="30" max="240" step="1" value="100"></label><label for="${id}-volume">Volume <output id="${id}-volume-value" for="${id}-volume">50%</output><input id="${id}-volume" type="range" min="0" max="1" step="0.01" value="0.5"></label></div>
<h2>Change the music</h2><p>Open this sketch’s <code>app.js</code> in Files and edit <code>createPattern(params)</code>. Try changing <code>c4 e4 g4 b4</code> or choose <code>sine</code>, <code>triangle</code>, <code>square</code>, or <code>sawtooth</code>. One cycle is four beats.</p><p class="muted">Reload after editing, then press Play. Source changes stop playback; tempo and volume respond immediately. This starter uses native synths only, with no remote samples, microphone, effects or live-code console.</p>
<footer>WAV export is not available yet. Settings restore on preserved-state reload; playback never restores. Saved project settings, when supplied, belong under strudel → this instance ID.</footer></main><script>
// EDIT THIS PATTERN. Mini-notation strings are data, not executable REPL code.
// Keep event gain here; params.volume is applied separately at the final output.
function createPattern(params) {
  return window.strudel.note('c4 e4 g4 b4').s('sine').gain(0.3).attack(0.01).release(0.05);
}
(${bootStrudelSketch.toString()})(${JSON.stringify(instanceId)});
</script></body></html>`;
  return { files: { 'index.html': html }, entry: 'index.html' };
}

module.exports = { createStrudelTemplate };
