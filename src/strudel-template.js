const { validateOpaqueId } = require('./ipc-contract');
const { validateStrudelSnapshot, queryStrudelSnapshot } = require('./strudel-export-policy');
const { highlightStrudel } = require('./strudel-score');

const DEFAULT_LIVE_CODE = `stack(
  note("<bb2 ~ bb2 bb2>").s("sine").gain(.52).release(.08),
  note("<d4 f4 ab4 c5>").s("triangle").gain(.18).attack(.02).release(.16),
  note("<f2 ab2 c3 eb3>").s("sawtooth").gain(.09).attack(.04).release(.2)
)`;
const EXAMPLES = [
  { title: 'Melody', description: 'Four notes on a triangle synth.', code: 'note("c4 e4 g4 b4").s("triangle").gain(.2)' },
  { title: 'Kick', description: 'A local kick sample on every beat.', code: 's("bd*4").gain(.3)' },
  { title: 'Snare', description: 'A local snare on the backbeat.', code: 's("~ sd ~ sd").gain(.25)' },
  { title: 'Hi-hats', description: 'Closed hats with an open hat at the end.', code: 's("hh hh hh hh hh hh hh oh").gain(.15)' },
  { title: 'Bass', description: 'A low note that changes each cycle.', code: 'note("<c2 a1 f1 g1>").s("sine").gain(.25)' },
  { title: 'Chords', description: 'Three notes played together.', code: 'note("c4,e4,g4").s("triangle").gain(.1).release(.3)' },
];

// This function is copied into ordinary editable project source, not evaluated.
function bootStrudelSketch(instanceId) {
  const id = `strudel-${instanceId}`;
  const control = (name) => document.getElementById(`${id}-${name}`);
  const playButton = control('play'), stopButton = control('stop');
  const codeEditor = control('code');
  const codeHighlight = control('highlight');
  const codeResize = typeof ResizeObserver === 'function' ? new ResizeObserver(syncCodeScroll) : null;
  const referencePanel = control('reference'), referenceButton = control('reference-toggle');
  const referenceClose = control('reference-close');
  const examples = Array.from(referencePanel.querySelectorAll?.('[data-example]') || []);
  const bpmInput = control('bpm'), volumeInput = control('volume'), status = control('status');
  const state = { bpm: 100, volume: 0.5, patternVersion: 1, playing: false };
  let context, controller, repl, disposed = false, pending = false, epoch = 0, startingEpoch = -1;
  let initializationFailed = false, disposal, preparedPattern;
  let activeCode = DEFAULT_LIVE_CODE, executedBuffer = DEFAULT_LIVE_CODE, evaluationTail = Promise.resolve(), needsApply = false;
  let sourceNeedsApply = true, restoredCodeNeedsApply = false;
  const exportButton = control('export'), cancelExportButton = control('cancel-export');
  const cyclesInput = control('cycles'), exportStatus = control('export-status');
  let exportContext, exportPending = false, exportId, cancelRequested = false;
  const reportExport = (message, error = false, visible = true) => {
    if (disposed) return;
    exportStatus.textContent = message;
    exportStatus.setAttribute('role', error ? 'alert' : 'status');
    exportStatus.hidden = !visible;
  };
  function syncExportControls() {
    exportButton.disabled = disposed || !preparedPattern || needsApply || !exportContext?.exportReady || exportPending;
    cyclesInput.disabled = disposed || exportPending;
    cancelExportButton.disabled = disposed || !exportPending || cancelRequested;
    cancelExportButton.hidden = !exportPending;
    exportButton.textContent = exportPending ? 'Exporting...' : 'Export WAV';
    exportButton.setAttribute('aria-busy', String(exportPending));
  }
  function receiveExportContext(value) {
    exportContext = value;
    syncExportControls();
    reportExport(value?.exportReady ? (needsApply ? 'Run code before saving a loop.' : 'Ready to save the executed pattern to Media.') : value?.reason || 'Waiting for the loaded source context before exporting WAV.', false, !value?.exportReady);
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
    reportExport('Exporting WAV...');
    try {
      const { params, pattern } = snapshotPattern();
      const cycles = Number(cyclesInput.value);
      const frozen = queryStrudelSnapshot(pattern, params, cycles, '0'.repeat(64), window.strudel, window.EaselStrudelSamples);
      const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(params)));
      const parameterDigest = [...new Uint8Array(digestBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (disposed || cancelRequested) return;
      const snapshot = Object.freeze({ ...frozen, parameterDigest });
      const receipt = await window.EaselHost.strudelExport({ action: 'export', input: { exportId, expectedSourceRevision, snapshot } });
      reportExport(receipt.warning || 'Loop saved in Media. Open Media to play, attach or download it.');
      return receipt;
    } catch (error) { reportExport(`Export failed: ${error.message.replace(/[.\s]+$/, '')}. Edit the pattern or reduce cycles, then try again.`, true); }
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
    playButton.disabled = disposed || pending;
    for (const button of examples) button.disabled = disposed || pending;
  }
  function refreshApplyState() {
    needsApply = sourceNeedsApply || restoredCodeNeedsApply || codeEditor.value !== executedBuffer;
    syncControls();
    syncExportControls();
  }
  function stop(message = 'Stopped. Run code to listen.') {
    epoch++;
    state.playing = false;
    setGain(0); // hush alone does not silence already scheduled synth tails.
    if (repl) window.strudel.hush();
    if (!disposed) { playButton.disabled = pending; report(message); }
  }
  function getState() {
    // Playback is deliberately never restored, including preserved-state reloads.
    return { bpm: state.bpm, volume: state.volume, patternVersion: state.patternVersion,
      code: codeEditor.value, sourceCode: DEFAULT_LIVE_CODE, referenceOpen: !referencePanel.hidden, playing: false };
  }
  function restoreState(previous) {
    if (!previous || typeof previous !== 'object' || disposed) return;
    stop('Ready. Press Play to listen.');
    state.bpm = bounded(previous.bpm, 30, 240, state.bpm);
    state.volume = bounded(previous.volume, 0, 1, state.volume);
    // Source owns patternVersion; persisted state must not undo a source edit.
    if ((previous.sourceCode === undefined || previous.sourceCode === DEFAULT_LIVE_CODE) &&
      typeof previous.code === 'string' && new TextEncoder().encode(previous.code).length <= 8192) {
      activeCode = previous.code;
      executedBuffer = previous.code;
      restoredCodeNeedsApply = activeCode !== DEFAULT_LIVE_CODE;
      codeEditor.value = activeCode;
      paintCode();
    }
    if (typeof previous.referenceOpen === 'boolean') setReferenceOpen(previous.referenceOpen);
    repl?.setCps(state.bpm / 240);
    refreshApplyState();
  }
  function patternChanged() {
    if (disposed) return;
    state.patternVersion++;
    preparedPattern = undefined;
    sourceNeedsApply = true;
    refreshApplyState();
    stop('Pattern changed. Run the updated code to listen.');
  }
  function snapshotPattern() {
    if (disposed || !repl || !preparedPattern) throw new Error('The sound sketch is not ready.');
    // Four beats per cycle. Event gain belongs to the pattern; volume is a
    // separate output multiplier. Future export applies it exactly once.
    const params = Object.freeze({ bpm: state.bpm, volume: state.volume, patternVersion: state.patternVersion });
    return { params, pattern: preparedPattern };
  }
  function validateCode(source) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Enter Strudel code to run.');
    if (new TextEncoder().encode(source).length > 8192) throw new Error('Strudel code is limited to 8 KiB.');
  }
  function setCode(source) {
    if (disposed) return { ok: false, error: 'This editor is closed.' };
    try { validateCode(source); }
    catch (error) { return { ok: false, error: error.message }; }
    codeEditor.value = source;
    codeEdited();
    return { ok: true };
  }
  async function applyCode(source, buffer) {
    try {
      if (disposed || !repl) throw new Error('The sound sketch is not ready.');
      validateCode(source);
      report('Running code…');
      const nextPattern = await repl.evaluate(source, false);
      if (disposed) return { ok: false, error: 'This editor is closed.' };
      const evalError = repl.state?.evalError;
      if (evalError || !nextPattern) throw evalError || new Error('Strudel did not produce a pattern.');
      preparedPattern = nextPattern;
      activeCode = source;
      executedBuffer = buffer;
      const cps = repl.scheduler?.cps;
      if (typeof cps === 'number' && Number.isFinite(cps)) state.bpm = cps * 240;
      state.patternVersion++;
      sourceNeedsApply = false;
      restoredCodeNeedsApply = false;
      refreshApplyState();
      if (exportContext?.exportReady) reportExport('Ready to save the executed pattern to Media.', false, false);
      report(state.playing ? 'Playing. Code updated.' : 'Code ready. Run or Ctrl+Enter to listen.');
      return { ok: true, playing: state.playing, patternVersion: state.patternVersion };
    } catch (error) {
      report(`Code error: ${error.message}. The last good pattern is unchanged.`, true);
      return { ok: false, error: error.message };
    }
  }
  function queueEvaluation(source, buffer) {
    const task = evaluationTail.then(() => applyCode(source, buffer), () => applyCode(source, buffer));
    evaluationTail = task.catch(() => {});
    return task;
  }
  function evaluateCode(source = codeEditor.value) {
    const written = setCode(source);
    if (!written.ok) { report(written.error, true); return Promise.resolve(written); }
    return queueEvaluation(source, source);
  }
  async function play(event) {
    if (disposed || pending) return;
    if (!event.isTrusted || !navigator.userActivation.isActive) { report('Use Run or Ctrl+Enter yourself to enable sound.', true); return; }
    if (initializationFailed) { window.location.reload(); return; }
    const token = ++epoch;
    const buffer = codeEditor.value;
    const selected = codeEditor.selectionStart !== codeEditor.selectionEnd;
    const source = selected ? buffer.slice(codeEditor.selectionStart, codeEditor.selectionEnd) : buffer;
    pending = true;
    syncControls();
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
      const result = await queueEvaluation(source, buffer);
      if (disposed || token !== epoch || !result.ok) return;
      if (state.playing) { report(selected ? 'Playing selection.' : 'Playing. Code updated.'); return; }
      const { pattern } = snapshotPattern();
      // Keep old voices disconnected when starting again, even if authored notes
      // have long releases. This is the pinned public SuperDough reset API.
      controller.reset();
      setGain(0);
      await repl.setPattern(pattern, false);
      if (disposed || token !== epoch) return;
      startingEpoch = token;
      await repl.start();
      if (disposed || token !== epoch) { window.strudel.hush(); setGain(0); return; }
      state.playing = true;
      setGain(state.volume);
      playButton.textContent = 'Run';
      report(selected ? 'Playing selection.' : 'Playing. Ctrl+Enter to update; Escape to stop.');
    } catch (error) {
      if (!disposed && token === epoch) {
        stop();
        playButton.textContent = 'Retry Run';
        report(`Sound could not start: ${error.message}. Check the code, then Run again.`, true);
      }
    } finally {
      pending = false;
      syncControls();
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
  const escape = (event) => {
    if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === '.')) {
      event.preventDefault?.(); stop();
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && event.target === codeEditor) {
      event.preventDefault(); if (!event.repeat) play(event);
    } else if (event.key === 'Tab' && event.target === codeEditor && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      codeEditor.setRangeText('  ', codeEditor.selectionStart, codeEditor.selectionEnd, 'end'); codeEdited();
    }
  };
  function setReferenceOpen(open) {
    referencePanel.hidden = !open;
    referenceButton.setAttribute('aria-expanded', String(open));
  }
  function toggleReference() { setReferenceOpen(referencePanel.hidden); if (referencePanel.hidden) codeEditor.focus?.(); }
  function addExample(event) {
    if (disposed || pending) return;
    const layer = EXAMPLES[Number(event.currentTarget.dataset.example)]?.code;
    if (!layer) return;
    try {
      const source = window.EaselStrudelScore.appendLayer(codeEditor.value, layer);
      const result = setCode(source);
      if (!result.ok) throw new Error(result.error);
      codeEditor.focus();
      codeEditor.setSelectionRange(source.length, source.length);
      return play(event);
    } catch (error) {
      report(`Cannot add example: ${error.message}. Edit the score, then try again.`, true);
    }
  }
  function dispose() {
    if (disposal) return disposal;
    if (exportPending && !cancelRequested) cancelExport();
    disposed = true;
    unsubscribeExport?.();
    syncExportControls();
    codeEditor.removeEventListener('input', codeEdited);
    codeEditor.removeEventListener('scroll', syncCodeScroll);
    codeResize?.disconnect();
    referenceButton.removeEventListener('click', toggleReference);
    referenceClose.removeEventListener('click', toggleReference);
    for (const button of examples) button.removeEventListener('click', addExample);
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
      playButton.textContent = 'Retry Run';
      report(`Sound error: ${message.slice(0, 240)}. Use a sound from Reference, then Run again.`, true);
    }
  }
  const api = { getState, restoreState, stop, patternChanged, snapshotPattern, setCode, evaluate: evaluateCode, exportLoop, cancelExport };
  window.EaselStrudel = api;
  setReferenceOpen((window.innerWidth || 1280) > 760);
  codeEditor.value = DEFAULT_LIVE_CODE;
  syncControls();
  restoreState(window.__easelProjectState?.strudel?.[instanceId]);
  window.EaselCanvas?.registerApp({ id, dispose, getState, restoreState });
  codeEditor.value = activeCode;
  paintCode();
  refreshApplyState();
  function codeEdited() {
    paintCode();
    refreshApplyState();
    if (needsApply) report('Edited. Ctrl+Enter to run the selection or all code.');
    else report('Code matches the active pattern.');
  }
  codeEditor.addEventListener('input', codeEdited);
  codeEditor.addEventListener('scroll', syncCodeScroll);
  codeResize?.observe(codeEditor);
  function syncCodeScroll() {
    codeHighlight.style.width = `${codeEditor.clientWidth}px`;
    codeHighlight.style.height = `${codeEditor.clientHeight}px`;
    codeHighlight.scrollTop = codeEditor.scrollTop;
    codeHighlight.scrollLeft = codeEditor.scrollLeft;
  }
  function paintCode() {
    codeHighlight.innerHTML = window.EaselStrudelScore.highlight(codeEditor.value) + '\n';
    syncCodeScroll();
  }
  referenceButton.addEventListener('click', toggleReference);
  referenceClose.addEventListener('click', toggleReference);
  for (const button of examples) button.addEventListener('click', addExample);
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
      await window.EaselStrudelSamples?.prepare();
      if (disposed) { window.strudel.hush(); return; }
      repl.setCps(state.bpm / 240);
      syncExportControls();
      syncControls();
      report('Ready. Run or Ctrl+Enter to listen.');
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
  const exampleHtml = EXAMPLES.map((example, index) => {
    const code = highlightStrudel('$: ' + example.code);
    return `<section class="example" aria-label="${example.title} example"><h4>${example.title}</h4><p>${example.description}</p><pre><code>${code}</code></pre><button type="button" data-example="${index}" aria-label="Add ${example.title} and run">Add &amp; run</button></section>`;
  }).join('');
  const html = `<!doctype html><html lang="en" data-easel-strudel-repl="v1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="easel-strudel-repl" content="v1"><title>Strudel sound</title><style>
:root{color-scheme:light;font-family:"Segoe UI","Helvetica Neue",sans-serif;background:#fbfaf6;color:#202d27;--paper:#fbfaf6;--line:#d4d9d0;--green:#174d3a;--muted:#58675f;--editor:#18231f;--code:#e6f0e8}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0}button,input{font:inherit;accent-color:var(--green)}button{min-height:36px;padding:7px 14px;border:1px solid var(--line);border-radius:5px;color:inherit;background:var(--paper);cursor:pointer;font-weight:600;white-space:nowrap}button:hover{background:#e9eee6}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--green);outline-offset:3px}::selection{background:#c5ddcb;color:#172b20}main{height:100dvh;min-height:360px;display:flex;flex-direction:column}.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}h1{font-size:16px;letter-spacing:-.02em;margin:0 12px 0 0}.run{background:var(--green);color:white;border-color:var(--green)}.run:hover{background:#236047}.setting{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);margin-left:8px}.setting input[type=number]{width:65px;padding:6px;border:1px solid var(--line);border-radius:4px;background:var(--paper);color:#202d27;font-variant-numeric:tabular-nums}.setting input[type=range]{width:72px;min-height:30px}.setting output{font-variant-numeric:tabular-nums;min-width:3ch}.reference-toggle{margin-left:auto}.workspace{display:flex;flex:1;min-height:0;position:relative}.editor-pane{display:flex;flex:1;min-width:0;flex-direction:column;background:var(--editor);color:var(--code)}.editor-help{margin:0;padding:12px 22px;color:#adc5b6;font-size:12px;border-bottom:1px solid #34483e}.code-editor{display:block;flex:1;width:100%;min-height:0;resize:none;border:0;border-radius:0;padding:24px 22px;background:transparent;color:var(--code);font:15px/1.7 "Cascadia Code","Consolas",monospace;tab-size:2;caret-color:#b7e8c8;outline-offset:-3px}.code-editor:focus-visible{outline:2px solid #90c5a2}.status{margin:0;padding:10px 16px;min-height:38px;border-top:1px solid #34483e;font-size:12px;color:#adc5b6;overflow-wrap:anywhere}.status[role=alert]{color:#ffb7a4}.reference{flex:0 0 280px;padding:18px 20px;overflow:auto;border-left:1px solid var(--line);background:var(--paper);scrollbar-color:#9eafa0 var(--paper);scrollbar-width:thin}.reference-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:22px}.reference h2{font-size:15px;margin:0}.reference h3{font-size:13px;margin:24px 0 10px}.reference p{font-size:12px;line-height:1.6;color:var(--muted);margin:8px 0}.close{width:32px;min-height:32px;padding:6px;display:grid;place-items:center}.close svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6}.reference dl{margin:0;font-size:12px}.reference dt{margin-top:10px;font-family:"Consolas",monospace}.reference dd{margin:3px 0 0;color:var(--muted);line-height:1.5}.example{padding:16px 0;border-bottom:1px solid var(--line)}.example h4{font-size:13px;margin:0}.sample-code{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 "Cascadia Code","Consolas",monospace;color:var(--green)}.example pre{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 "Cascadia Code","Consolas",monospace;color:var(--green)}.example button{font-size:12px;min-height:32px;padding:6px 10px}details{border-top:1px solid var(--line);margin-top:24px;padding-top:14px}summary{font-size:13px;font-weight:600;cursor:pointer}details label{display:flex;align-items:center;gap:8px;font-size:12px;margin:14px 0}details input{width:58px;padding:6px;background:var(--paper);border:1px solid var(--line);border-radius:4px;color:inherit}details button{font-size:12px;margin:0 4px 8px 0}details [role=alert]{color:#9d3425}.code-editor{scrollbar-color:#586d60 var(--editor);scrollbar-width:thin}@media(max-width:760px){.toolbar{padding:10px;gap:6px}h1{margin-right:4px}.setting{margin-left:0}.reference{position:absolute;right:0;top:0;bottom:0;width:min(280px,85vw);z-index:1;box-shadow:-8px 0 20px #18231f26}.code-editor{font-size:14px;padding:18px 16px}.editor-help{padding:10px 16px}.reference-toggle{margin-left:auto}}@media(max-width:420px){.setting{order:1}.toolbar h1{flex:1}.reference-toggle{margin-left:0}.editor-help{font-size:11px}}
.code-surface{position:relative;display:flex;flex:1;min-height:0;min-width:0}.code-highlight,.code-editor{margin:0;font:15px/1.7 "Cascadia Code","Consolas",monospace;tab-size:2}.code-highlight{position:absolute;top:0;left:0;width:100%;height:100%;padding:24px 22px;white-space:pre;overflow:hidden;pointer-events:none;color:var(--code)}.code-editor{position:relative;color:transparent;-webkit-text-fill-color:transparent;background:transparent}.code-editor::selection{background:#40685380;color:transparent}.token-comment{color:#8ca99a}.token-keyword{color:#d8b4db}.token-string{color:#a6d6b0}.token-number{color:#f0b78e}.token-function{color:#e4d08a}.token-label{color:#9dcee8}.reference .token-comment{color:#58675f}.reference .token-keyword{color:#74516e}.reference .token-string{color:#2a6146}.reference .token-number{color:#8f4b26}.reference .token-function{color:#785e20}.reference .token-label{color:#28617d}@media(max-width:760px){.code-highlight,.code-editor{font-size:14px;padding:18px 16px}}
.export-controls{display:flex;align-items:center;gap:8px;margin-left:8px;padding-left:16px;border-left:1px solid var(--line);flex-wrap:wrap}.export-controls .setting{margin-left:0}.export-status{margin:0;padding:9px 16px;font-size:12px;line-height:1.5;color:var(--muted);border-bottom:1px solid var(--line);overflow-wrap:anywhere}.export-status[role=alert]{color:#9d3425}@media(max-width:760px){.export-controls{margin-left:0;padding-left:10px}}@media(max-width:420px){.export-controls{order:2;flex-basis:100%;border-left:0;border-top:1px solid var(--line);padding:8px 0 0}.export-controls .setting{order:0}}
</style></head><body><main><header class="toolbar"><h1>Strudel</h1><button type="button" class="run" id="${id}-play">Run</button><button type="button" id="${id}-stop">Stop</button><label class="setting" for="${id}-bpm">BPM<input id="${id}-bpm" data-easel-managed-state type="number" min="30" max="240" step="1" value="100"></label><label class="setting" for="${id}-volume">Volume<input id="${id}-volume" data-easel-managed-state type="range" min="0" max="1" step="0.01" value="0.5"><output id="${id}-volume-value" for="${id}-volume">50%</output></label><div class="export-controls" role="group" aria-label="WAV export"><label class="setting" for="${id}-cycles">Cycles<input id="${id}-cycles" type="number" min="1" max="16" step="1" value="1"></label><button type="button" id="${id}-export" title="Save the executed pattern as a WAV in Media" disabled>Export WAV</button><button type="button" id="${id}-cancel-export" hidden disabled>Cancel export</button></div><button type="button" class="reference-toggle" id="${id}-reference-toggle" aria-controls="${id}-reference" aria-expanded="true">Reference</button></header><p class="export-status" id="${id}-export-status" role="status" aria-live="polite" hidden>Run code before saving.</p>
<div class="workspace"><section class="editor-pane" aria-label="Strudel editor"><p class="editor-help" id="${id}-code-help">Ctrl+Enter: run selection or all code &nbsp; / &nbsp; Ctrl+. or Escape: stop</p><div class="code-surface"><pre class="code-highlight" id="${id}-highlight" aria-hidden="true"></pre><textarea class="code-editor" data-easel-managed-state id="${id}-code" aria-label="Strudel code" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-describedby="${id}-code-help"></textarea></div><p class="status" id="${id}-status" role="status" aria-live="polite">Preparing sound…</p></section>
<aside class="reference" id="${id}-reference" aria-label="References and examples"><div class="reference-heading"><h2>Reference &amp; examples</h2><button class="close" id="${id}-reference-close" type="button" aria-label="Hide reference"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></div><h3>Add a layer</h3><p>Add &amp; run appends an example to your score and plays it. Your existing layers keep playing.</p>${exampleHtml}
<h3>Pattern basics</h3><dl><dt>note("c4 e4 g4")</dt><dd>A sequence of pitches.</dd><dt>.s("triangle")</dt><dd>Choose the sound.</dd><dt>.gain(.3)</dt><dd>Set a pattern's loudness.</dd><dt>.fast(2) / .slow(2)</dt><dd>Double or halve the speed.</dd><dt>stack(a, b)</dt><dd>Play patterns together.</dd><dt>$: note("c4")</dt><dd>Give each line its own pattern.</dd><dt>setcpm(30)</dt><dd>30 cycles per minute = 120 BPM.</dd></dl><h3>Mini notation</h3><dl><dt>~ &nbsp; *4 &nbsp; &lt;c4 e4&gt;</dt><dd>Rest, repeat, alternate each cycle.</dd><dt>[c4 e4] &nbsp; c4,e4</dt><dd>Subdivide a beat, play together.</dd></dl><h3>Sounds available here</h3><p><code>sine · triangle · square · sawtooth<br>sbd · supersaw · pulse<br>white · pink · brown</code></p><p>These synths work offline. Local drums: <code>bd</code> kick, <code>sd</code> snare, <code>hh</code> closed hat, <code>oh</code> open hat, <code>cp</code> clap, <code>tom</code> and <code>rim</code>. Use <code>s("bd sd hh")</code>.</p>
<h3>Your samples</h3><p>Attach a short WAV or MP3 from Media, then name it in your score. Suno one-shots and loops work too.</p><pre class="sample-code">await window.EaselStrudelSamples.add(
  'suno_snare', 'MEDIA_ASSET_ID'
)
s("suno_snare*4").gain(.25)</pre><p>Up to 10 seconds and 4 MiB per sample. Keep the registration line in your score so it works again after reopening. Adding a sample keeps the current audio playing.</p><h3>WAV export</h3><p>Choose Cycles in the top bar, then Export WAV to save the executed pattern to Media. 1–16 cycles, up to 30 seconds. WAV export supports sine, triangle, square, sawtooth, sbd and white, pink or brown noise with note, gain, attack, decay, sustain and release. Local drums and registered samples also export. Other synths, remote banks, effects, sample pitch, speed and slicing are not supported for export.</p></aside></div></main><script id="easel-runtime-strudel-export-policy">
// Plain-data export policy, shared with the host. No executable events cross the bridge.
${validateStrudelSnapshot.toString()}
${queryStrudelSnapshot.toString()}
</script><script>
const STRUDEL_INSTANCE_ID = ${JSON.stringify(instanceId)};
// Edit this code to change the authored default. Run always evaluates the editor.
const DEFAULT_LIVE_CODE = ${JSON.stringify(DEFAULT_LIVE_CODE)};
const EXAMPLES = ${JSON.stringify(EXAMPLES)};
(${bootStrudelSketch.toString()})(STRUDEL_INSTANCE_ID);
</script></body></html>`;
  return { files: { 'index.html': html }, entry: 'index.html' };
}

module.exports = { createStrudelTemplate };
