const { validateOpaqueId } = require('./ipc-contract');
const { validateStrudelSnapshot, queryStrudelSnapshot } = require('./strudel-export-policy');

// This function is copied into ordinary editable project source, not evaluated.
function bootStrudelSketch(instanceId) {
  const id = `strudel-${instanceId}`;
  const control = (name) => document.getElementById(`${id}-${name}`);
  const playButton = control('play'), stopButton = control('stop');
  const codeEditor = control('code'), evaluateButton = control('evaluate');
  const bpmInput = control('bpm'), volumeInput = control('volume'), status = control('status');
  const state = { bpm: 100, volume: 0.5, patternVersion: 1, playing: false };
  let context, controller, repl, disposed = false, pending = false, epoch = 0, startingEpoch = -1;
  let initializationFailed = false, disposal, preparedPattern;
  let activeCode = DEFAULT_LIVE_CODE, evaluationTail = Promise.resolve(), needsApply = false;
  let sourceNeedsApply = false, restoredCodeNeedsApply = false;
  const exportButton = control('export'), cancelExportButton = control('cancel-export');
  const cyclesInput = control('cycles'), exportStatus = control('export-status');
  let exportContext, exportPending = false, exportId, cancelRequested = false;
  const reportExport = (message, error = false) => {
    if (disposed) return;
    exportStatus.textContent = message;
    exportStatus.setAttribute('role', error ? 'alert' : 'status');
  };
  function syncExportControls() {
    exportButton.disabled = disposed || !repl || needsApply || !exportContext?.exportReady || exportPending;
    cyclesInput.disabled = disposed || exportPending;
    cancelExportButton.disabled = disposed || !exportPending || cancelRequested;
  }
  function receiveExportContext(value) {
    exportContext = value;
    syncExportControls();
    reportExport(value?.exportReady ? 'Export a bounded loop straight to Media.' : value?.reason || 'Waiting for the loaded source context before exporting WAV.');
  }
  const unsubscribeExport = window.EaselHost?.onStrudelExportContext?.(receiveExportContext);
  async function exportLoop() {
    if (disposed || exportPending || !repl || needsApply || !exportContext?.exportReady) return;
    exportPending = true;
    cancelRequested = false;
    exportId = crypto.randomUUID();
    // Capture loaded source, local parameters and queried score before any await.
    const expectedSourceRevision = exportContext.sourceRevision;
    syncExportControls();
    reportExport('Rendering loop… Cancel disposes the separate export renderer.');
    try {
      const { params, pattern } = snapshotPattern();
      const cycles = Number(cyclesInput.value);
      const frozen = queryStrudelSnapshot(pattern, params, cycles, '0'.repeat(64), window.strudel);
      const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(params)));
      const parameterDigest = [...new Uint8Array(digestBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (disposed || cancelRequested) return;
      const snapshot = Object.freeze({ ...frozen, parameterDigest });
      const receipt = await window.EaselHost.strudelExport({ action: 'export', input: { exportId, expectedSourceRevision, snapshot } });
      reportExport(receipt.warning || 'Loop saved in Media. Open Media to play, attach or download it.');
      return receipt;
    } catch (error) { reportExport(`Export failed: ${error.message}. Edit the pattern or reduce cycles, then try again.`, true); }
    finally { exportPending = false; exportId = undefined; syncExportControls(); }
  }
  async function cancelExport() {
    if (!exportPending || cancelRequested) return;
    cancelRequested = true;
    syncExportControls();
    reportExport('Cancelling… If saving has started, a successful loop will remain in Media.');
    try { await window.EaselHost.strudelExport({ action: 'cancel', input: { exportId } }); }
    catch (error) { reportExport(`Cancellation could not reach this runtime: ${error.message}`, true); }
  }
  const bounded = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  function report(message, error = false) {
    status.textContent = message;
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  function setGain(value) {
    const gain = controller?.output.destinationGain?.gain;
    if (!gain || context.state === 'closed') return;
    gain.cancelScheduledValues(context.currentTime);
    // The setter updates the current-value slot even while suspended, and
    // schedules the same value at currentTime for the next render quantum.
    gain.value = value;
  }
  function syncControls() {
    bpmInput.value = String(state.bpm);
    volumeInput.value = String(state.volume);
    control('volume-value').textContent = `${Math.round(state.volume * 100)}%`;
    playButton.disabled = disposed || pending || needsApply;
  }
  function refreshApplyState() {
    needsApply = sourceNeedsApply || restoredCodeNeedsApply || codeEditor.value !== activeCode;
    syncControls();
    syncExportControls();
  }
  function stop(message = 'Stopped. Press Play to restart.') {
    epoch++;
    state.playing = false;
    setGain(0); // hush alone does not silence already scheduled synth tails.
    if (repl) window.strudel.hush();
    if (!disposed) { playButton.disabled = pending || needsApply; report(message); }
  }
  function getState() {
    // Playback is deliberately never restored, including preserved-state reloads.
    return { bpm: state.bpm, volume: state.volume, patternVersion: state.patternVersion, code: activeCode, playing: false };
  }
  function restoreState(previous) {
    if (!previous || typeof previous !== 'object' || disposed) return;
    stop('Ready. Press Play to listen.');
    state.bpm = bounded(previous.bpm, 30, 240, state.bpm);
    state.volume = bounded(previous.volume, 0, 1, state.volume);
    // Source owns patternVersion; persisted state must not undo a source edit.
    if (typeof previous.code === 'string' && new TextEncoder().encode(previous.code).length <= 8192) {
      activeCode = previous.code;
      restoredCodeNeedsApply = activeCode !== DEFAULT_LIVE_CODE;
      codeEditor.value = activeCode;
    }
    repl?.setCps(state.bpm / 240);
    refreshApplyState();
  }
  function patternChanged() {
    if (disposed) return;
    state.patternVersion++;
    preparedPattern = undefined;
    sourceNeedsApply = true;
    refreshApplyState();
    stop('Pattern changed. Push the updated code before Play.');
  }
  function snapshotPattern() {
    if (disposed || !repl || !preparedPattern) throw new Error('The sound sketch is not ready.');
    // Four beats per cycle. Event gain belongs to the pattern; volume is a
    // separate output multiplier. Future export applies it exactly once.
    const params = Object.freeze({ bpm: state.bpm, volume: state.volume, patternVersion: state.patternVersion });
    return { params, pattern: preparedPattern };
  }
  async function applyCode(source) {
    try {
      if (disposed || !repl) throw new Error('The sound sketch is not ready.');
      if (typeof source !== 'string' || !source.trim()) throw new Error('Enter Strudel code before pushing it.');
      if (new TextEncoder().encode(source).length > 8192) throw new Error('Strudel code is limited to 8 KiB.');
      evaluateButton.disabled = true;
      report('Evaluating code… Playback continues on the current clock.');
      const nextPattern = await repl.evaluate(source, false);
      const evalError = repl.state?.evalError;
      if (evalError || !nextPattern) throw evalError || new Error('Strudel did not produce a pattern.');
      preparedPattern = nextPattern;
      activeCode = source;
      codeEditor.value = source;
      state.patternVersion++;
      sourceNeedsApply = false;
      restoredCodeNeedsApply = false;
      refreshApplyState();
      report(state.playing ? 'Pattern updated live on the running clock.' : 'Pattern ready. Press Play yourself to listen.');
      return { ok: true, playing: state.playing, patternVersion: state.patternVersion };
    } catch (error) {
      report(`Code error: ${error.message}. The last good pattern is unchanged.`, true);
      return { ok: false, error: error.message };
    } finally {
      if (!disposed) evaluateButton.disabled = false;
    }
  }
  function evaluateCode(source = codeEditor.value) {
    const task = evaluationTail.then(() => applyCode(source), () => applyCode(source));
    evaluationTail = task.catch(() => {});
    return task;
  }
  async function play(event) {
    if (disposed || pending || state.playing || needsApply) return;
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
      await window.strudel.initAudio({ disableWorklets: false });
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
        report(`Sound could not start: ${error.message}. Check the Strudel code in the scratchpad, then Retry Play.`, true);
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
    if (exportPending && !cancelRequested) cancelExport();
    disposed = true;
    unsubscribeExport?.();
    syncExportControls();
    codeEditor.removeEventListener('input', codeEdited);
    evaluateButton.removeEventListener('click', evaluateClick);
    exportButton.removeEventListener('click', exportLoop);
    cancelExportButton.removeEventListener('click', cancelExport);
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
    if (detail?.type === 'error' && /^\[eval\] error:/.test(message)) {
      report(`Code error: ${message.slice(13)}. The last good pattern is unchanged.`, true);
      return;
    }
    // Pinned core and SuperDough errorLogger emit an untyped, prefixed message.
    // Query/trigger failures are logged rather than rejecting repl.start().
    const runtimeError = detail?.type === 'error' ||
      (detail?.type === undefined && /^\[(?:cyclist|getTrigger|superdough)\] error:/.test(message));
    if (!disposed && runtimeError) {
      stop();
      playButton.textContent = 'Retry Play';
      report(`Pattern error: ${message.slice(0, 240)}. Edit the Strudel code, then Retry Play.`, true);
    }
  }
  const api = { getState, restoreState, stop, patternChanged, snapshotPattern, evaluate: evaluateCode, exportLoop, cancelExport };
  window.EaselStrudel = api;
  syncControls();
  restoreState(window.__easelProjectState?.strudel?.[instanceId]);
  window.EaselCanvas?.registerApp({ id, dispose, getState, restoreState });
  codeEditor.value = activeCode;
  refreshApplyState();
  const evaluateClick = () => evaluateCode();
  const codeEdited = () => {
    refreshApplyState();
    if (needsApply) report('Code edited. Push live to apply before restarting or exporting.');
    else report('Code matches the active pattern.');
  };
  codeEditor.addEventListener('input', codeEdited);
  evaluateButton.addEventListener('click', evaluateClick);
  exportButton.addEventListener('click', exportLoop);
  cancelExportButton.addEventListener('click', cancelExport);
  reportExport(window.EaselHost?.strudelExport ? 'WAV export is awaiting its loaded runtime check.' : 'Open this project in Easel to export loops to Media.');
  syncExportControls();
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
      preparedPattern = createPattern({ bpm: state.bpm, volume: state.volume });
      if (!preparedPattern) throw new Error('The starter pattern could not be prepared.');
      await repl.setPattern(preparedPattern, false);
      syncExportControls();
      syncControls();
      report(needsApply ? 'Restored code needs Push live before you can play.' : 'Ready. Press Play to listen.');
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
  const html = `<!doctype html><html lang="en" data-easel-strudel-repl="v1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="easel-strudel-repl" content="v1"><title>Strudel sound</title><style>
:root{color-scheme:light;font-family:"Segoe UI","Helvetica Neue",sans-serif;background:#fbfaf6;color:#202d27;--line:#d4d9d0;--green:#174d3a;--muted:#58675f}*{box-sizing:border-box}body{margin:0;padding:clamp(20px,5vw,56px)}main{max-width:720px;margin:auto}h1{font-size:clamp(28px,5vw,42px);letter-spacing:-.025em;margin:0 0 12px}p{line-height:1.6;max-width:65ch}button,input{font:inherit;accent-color:var(--green)}button{padding:11px 22px;border:1px solid var(--line);border-radius:6px;color:inherit;background:#fbfaf6;cursor:pointer;font-weight:600}button:first-child{background:var(--green);color:white}button:hover{filter:brightness(.94)}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,.code-editor:focus-visible{outline:2px solid var(--green);outline-offset:4px}::selection{background:#d4e6d9}.transport{display:flex;gap:12px;flex-wrap:wrap;margin:28px 0 16px}.controls{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin:28px 0;padding:24px 0;border-block:1px solid var(--line)}label{display:grid;gap:12px;font-weight:600}.code-editor{width:100%;min-height:250px;resize:vertical;background:#18231f;color:#e6f0e8;border:1px solid #34483e;border-radius:8px;padding:16px;font:13px/1.55 ui-monospace,monospace;tab-size:2}input[type=number]{width:100%;max-width:150px;background:white;border:1px solid var(--line);border-radius:6px;padding:10px;color:inherit;caret-color:var(--green)}input[type=range]{width:100%;min-height:36px}output{font-variant-numeric:tabular-nums;font-weight:400}h2{font-size:19px;margin:32px 0 8px}.muted{color:var(--muted)}[role=alert]{color:#9d3425}code{font-size:.94em}footer{margin-top:32px;font-size:13px;color:var(--muted)}@media(max-width:420px){.controls{grid-template-columns:1fr;gap:22px}}
</style></head><body><main><h1>Strudel sound</h1><p class="muted">A small melody, ready to make your own. Sound starts only when you press Play.</p>
<div class="transport" aria-label="Playback"><button type="button" id="${id}-play">Play</button><button type="button" id="${id}-stop">Stop</button></div>
<p id="${id}-status" role="status" aria-live="polite">Preparing sound…</p><p class="muted">Press Escape to stop, including while a canvas question is open.</p>
<div class="controls"><label for="${id}-bpm">Tempo · BPM<input id="${id}-bpm" type="number" min="30" max="240" step="1" value="100"></label><label for="${id}-volume">Volume <output id="${id}-volume-value" for="${id}-volume">50%</output><input id="${id}-volume" type="range" min="0" max="1" step="0.01" value="0.5"></label></div>
<section aria-label="Loop export"><h2>Save a loop</h2><label for="${id}-cycles">Cycles · four beats each<input id="${id}-cycles" type="number" min="1" max="16" step="1" value="1"></label><div class="transport"><button type="button" id="${id}-export" disabled>Export loop</button><button type="button" id="${id}-cancel-export" disabled>Cancel export</button></div><p id="${id}-export-status" role="status" aria-live="polite">Waiting for the loaded source context before exporting WAV.</p><p class="muted">Up to 16 cycles and 30 seconds including a 0.5-second tail. Stereo 48 kHz WAV saves to Media. Export supports only note, s, gain, attack and release fields: native sine/triangle/square/saw aliases, MIDI notes 24–96, gain 0–1 and envelopes up to 0.5 seconds. Samples, effects, callbacks, continuous controls, duration and clip overrides receive an error. The fixed tail crops the native synth’s final 0.01-second stop allowance.</p></section>
<h2>Live Strudel scratchpad</h2><p>Edit code here, then push it into the running Strudel evaluator. If playback is active, the pattern changes on Strudel’s scheduler without waiting for a bar; a code error leaves the last good pattern playing.</p><label for="${id}-code">Strudel code<textarea class="code-editor" id="${id}-code" spellcheck="false" aria-describedby="${id}-code-help"></textarea></label><div class="transport"><button type="button" id="${id}-evaluate">Push live</button></div><p class="muted" id="${id}-code-help">Code is evaluated locally in the isolated canvas. Network access stays blocked. Keep .play() out of pushes; use Play to start sound.</p>
<footer>Bounded native-synth WAV export saves directly to Media in Easel. Settings restore on preserved-state reload; playback never restores. Saved project settings, when supplied, belong under strudel → this instance ID.</footer></main><script id="easel-runtime-strudel-export-policy">
// Plain-data export policy, shared with the host. No executable events cross the bridge.
${validateStrudelSnapshot.toString()}
${queryStrudelSnapshot.toString()}
</script><script>
const STRUDEL_INSTANCE_ID = ${JSON.stringify(instanceId)};
// This compact example stays local and uses Strudel's normal JavaScript REPL.
const DEFAULT_LIVE_CODE = "stack(\\n  note(\\"<bb2 ~ bb2 bb2>\\").s(\\"sine\\").gain(.52).release(.08),\\n  note(\\"<d4 f4 ab4 c5>\\").s(\\"triangle\\").gain(.18).attack(.02).release(.16),\\n  note(\\"<f2 ab2 c3 eb3>\\").s(\\"sawtooth\\").gain(.09).attack(.04).release(.2)\\n)";
function createPattern() {
  const note = window.strudel.note;
  return window.strudel.stack(
    note('<bb2 ~ bb2 bb2>').s('sine').gain(.52).release(.08),
    note('<d4 f4 ab4 c5>').s('triangle').gain(.18).attack(.02).release(.16),
    note('<f2 ab2 c3 eb3>').s('sawtooth').gain(.09).attack(.04).release(.2)
  );
}
(${bootStrudelSketch.toString()})(STRUDEL_INSTANCE_ID);
</script></body></html>`;
  return { files: { 'index.html': html }, entry: 'index.html' };
}

module.exports = { createStrudelTemplate };
