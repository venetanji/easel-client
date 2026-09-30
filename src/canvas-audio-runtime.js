// Embedded with the protected lifecycle bootstrap, before kits create audio nodes.
function installCanvasAudioRuntime({ getContexts, native }) {
  const nodePrototype = window.AudioNode?.prototype;
  const connect = nodePrototype?.connect;
  const disconnect = nodePrototype?.disconnect;
  const supported = typeof connect === 'function' && typeof disconnect === 'function';
  const edges = new Set();
  const meters = new Map();
  const MAX_EDGES = 256;
  const MAX_CONTEXTS = 8;
  const scope = 'Observed AudioNode connections to native destinations, mixed to mono before device output. Offline contexts, HTML media elements and unobserved connections are excluded. Meters do not prove speaker audibility; stereo phase cancellation can under-report signal. Full-scale samples indicate possible clipping, not measured hardware clipping.';
  let edgeLimitReached = false;
  let status = 'idle';
  let active = false;
  let frame = 0;
  let lastSampleTime = 0;
  let enabledAt = null;
  let controlsRequested = false;
  let host;
  let message;
  let enableButton;
  let stopButton;
  let resumeErrors = [];

  function meterFor(context) {
    if (meters.has(context)) return meters.get(context);
    if (!active || context.state === 'closed' || typeof context.startRendering === 'function' || meters.size >= MAX_CONTEXTS) return null;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const meter = { id: `audio-${meters.size + 1}`, context, analyser, samples: new Float32Array(analyser.fftSize), edges: new Set(), rms: 0, peak: 0, maxRms: 0, maxPeak: 0, fullScaleSamples: 0, nonFiniteSamples: 0, clippingWindows: 0, windows: 0, error: '' };
    meters.set(context, meter);
    return meter;
  }

  function tap(edge) {
    if (!active) return;
    try {
      const meter = meterFor(edge.context);
      if (!meter || meter.edges.has(edge)) return;
      // Parallel taps leave the app's original destination routing and gain untouched.
      connect.call(edge.source, meter.analyser, edge.output, 0);
      meter.edges.add(edge);
    } catch (error) {
      if (resumeErrors.length < 8) resumeErrors.push(String(error.message).slice(0, 180));
    }
  }

  function untap(edge, alreadyDisconnected = false) {
    const meter = meters.get(edge.context);
    if (!meter?.edges.delete(edge)) return;
    if (!alreadyDisconnected) {
      try { disconnect.call(edge.source, meter.analyser, edge.output, 0); } catch {}
    }
  }

  if (supported) {
    nodePrototype.connect = function (...args) {
      const result = connect.apply(this, args);
      if (args[0] === this.context?.destination) {
        const output = args[1] ?? 0;
        let edge = [...edges].find((item) => item.source === this && item.output === output);
        if (!edge && edges.size < MAX_EDGES) {
          edge = { source: this, context: this.context, output };
          edges.add(edge);
        } else if (!edge) edgeLimitReached = true;
        if (edge) tap(edge);
      }
      return result;
    };
    nodePrototype.disconnect = function (...args) {
      const result = disconnect.apply(this, args);
      const destination = this.context?.destination;
      for (const edge of [...edges]) {
        if (edge.source !== this) continue;
        const all = args.length === 0;
        const outputOnly = typeof args[0] === 'number' && edge.output === args[0];
        const destinationMatch = args[0] === destination && (args.length < 2 || edge.output === args[1]);
        if (all || outputOnly || destinationMatch) {
          untap(edge, all || outputOnly);
          edges.delete(edge);
        }
      }
      return result;
    };
  }

  function inspect() {
    return {
      supported, status, enabled: active, requested: controlsRequested, requiresTrustedClick: !active,
      enabledAt, observedDestinationEdges: edges.size, edgeLimitReached,
      contextLimit: MAX_CONTEXTS, scope,
      contexts: [...meters.values()].slice(0, MAX_CONTEXTS).map((meter) => ({
        id: meter.id, state: meter.context.state, sampleRate: meter.context.sampleRate,
        observedOutputEdges: meter.edges.size, rms: meter.rms, peak: meter.peak,
        maxRms: meter.maxRms, maxPeak: meter.maxPeak, fullScaleSamplesInLastWindow: meter.fullScaleSamples,
        nonFiniteSamplesInLastWindow: meter.nonFiniteSamples,
        clippingWindows: meter.clippingWindows, sampleWindows: meter.windows,
        possibleClipping: meter.clippingWindows > 0, ...(meter.error ? { error: meter.error } : {}),
      })),
      errors: [...resumeErrors], microphoneRequested: false, recorded: false,
    };
  }

  function updateMessage() {
    if (!message) return;
    const values = [...meters.values()];
    if (!active) return;
    if (!values.some((meter) => meter.edges.size && meter.context.state === 'running')) {
      message.textContent = 'Monitoring enabled. Press Play in your sketch to produce audio.';
      return;
    }
    const rms = Math.max(0, ...values.map((meter) => meter.rms));
    const peak = Math.max(0, ...values.map((meter) => meter.peak));
    message.textContent = `RMS ${rms.toFixed(4)} / Peak ${peak.toFixed(4)}${values.some((meter) => meter.clippingWindows > 0) ? ' / Possible clipping' : ''}`;
  }

  function sample(time) {
    if (!active) return;
    if (time - lastSampleTime >= 100) {
      lastSampleTime = time;
      for (const meter of meters.values()) {
        if (meter.context.state !== 'running' || !meter.edges.size) {
          meter.rms = 0; meter.peak = 0; meter.fullScaleSamples = 0; meter.nonFiniteSamples = 0;
          continue;
        }
        try {
          meter.analyser.getFloatTimeDomainData(meter.samples);
          let energy = 0;
          let peak = 0;
          let fullScale = 0;
          let nonFinite = 0;
          for (const value of meter.samples) {
            if (!Number.isFinite(value)) { nonFinite += 1; continue; }
            energy += value * value;
            peak = Math.max(peak, Math.abs(value));
            if (Math.abs(value) >= 1) fullScale += 1;
          }
          meter.rms = Math.sqrt(energy / meter.samples.length);
          meter.peak = peak;
          meter.maxRms = Math.max(meter.maxRms, meter.rms);
          meter.maxPeak = Math.max(meter.maxPeak, peak);
          meter.fullScaleSamples = fullScale;
          meter.nonFiniteSamples = nonFinite;
          meter.clippingWindows += Number(fullScale > 0);
          meter.windows += 1;
        } catch (error) { meter.error = String(error.message).slice(0, 180); }
      }
      updateMessage();
    }
    frame = window.requestAnimationFrame(sample);
  }

  function stop() {
    active = false;
    status = 'stopped';
    window.cancelAnimationFrame(frame);
    frame = 0;
    for (const edge of edges) untap(edge);
    for (const meter of meters.values()) {
      try { disconnect.call(meter.analyser); } catch {}
    }
    meters.clear();
    if (enableButton) { enableButton.disabled = !supported; enableButton.hidden = false; }
    if (stopButton) stopButton.hidden = true;
    if (message) message.textContent = 'Diagnostics stopped. Your sketch audio is unchanged.';
    return inspect();
  }

  function showControls() {
    if (!controlsRequested) return;
    if (host?.isConnected) return;
    if (!document.body) {
      native.add.call(document, 'DOMContentLoaded', showControls, { once: true });
      return;
    }
    document.getElementById('easel-audio-diagnostics')?.remove();
    host = document.createElement('aside');
    host.id = 'easel-audio-diagnostics';
    host.dataset.easelRuntimeUi = 'audio-testing';
    host.dataset.easelTransient = 'audio-testing';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:min(320px,calc(100vw - 24px));color:#202d27;background:#fbfaf6;border:1px solid #a6b7a7;border-radius:9px;font:12px/1.5 "Segoe UI",sans-serif;box-sizing:border-box}section{padding:11px 12px}h2{margin:0 0 5px;font:600 17px/1.2 Georgia,serif;color:#12392d}p{margin:5px 0;color:#40594a}button{min-height:32px;margin:5px 5px 0 0;padding:5px 8px;border:1px solid #a6b7a7;border-radius:6px;color:#174d3a;background:#f3f2eb;font:600 12px "Segoe UI",sans-serif;cursor:pointer}button:hover{background:#e7eee7}button:focus-visible{outline:2px solid #b84e38;outline-offset:2px}button:disabled{opacity:.6;cursor:not-allowed}[hidden]{display:none!important}';
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = 'Audio testing';
    const description = document.createElement('p');
    description.textContent = 'Enable output meters, then use your sketch\'s Play button. No microphone or recording.';
    message = document.createElement('p');
    message.textContent = supported ? 'Waiting for your click.' : 'Audio output monitoring is unavailable.';
    enableButton = document.createElement('button');
    enableButton.type = 'button';
    enableButton.textContent = 'Enable audio testing';
    enableButton.disabled = !supported;
    enableButton.hidden = active;
    stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.textContent = 'Stop diagnostics';
    stopButton.hidden = !active;
    native.add.call(enableButton, 'click', (event) => {
      if (active) return;
      if (!event.isTrusted || (navigator.userActivation && !navigator.userActivation.isActive)) {
        message.textContent = 'Click Enable audio testing yourself to begin.';
        return;
      }
      active = true;
      status = 'active';
      enabledAt = new Date().toISOString();
      lastSampleTime = 0;
      resumeErrors = [];
      enableButton.hidden = true;
      stopButton.hidden = false;
      // Resume calls happen synchronously inside the real click; no synthetic user gesture is used.
      for (const context of [...getContexts()].slice(0, 16)) {
        if (context.state === 'closed') continue;
        try { Promise.resolve(context.resume()).catch((error) => { if (resumeErrors.length < 8) resumeErrors.push(String(error.message).slice(0, 180)); }); }
        catch (error) { if (resumeErrors.length < 8) resumeErrors.push(String(error.message).slice(0, 180)); }
      }
      for (const edge of edges) tap(edge);
      updateMessage();
      frame = window.requestAnimationFrame(sample);
    });
    native.add.call(stopButton, 'click', stop);
    section.append(title, description, message, enableButton, stopButton);
    root.append(style, section);
    document.body.append(host);
  }

  function requestTest() {
    controlsRequested = true;
    if (!active) status = 'awaiting-user';
    showControls();
    return { ...inspect(), buttonLabel: 'Enable audio testing', instruction: 'A real user must click Enable audio testing, then Play in the sketch. Inspect the meters afterwards. No sound is generated by this request.' };
  }

  function cleanup() {
    stop();
    controlsRequested = false;
    edges.clear();
    host?.remove();
    host = null;
    message = null;
    enableButton = null;
    stopButton = null;
  }

  return Object.freeze({ api: Object.freeze({ inspect, requestTest, stop }), cleanup });
}

module.exports = { installCanvasAudioRuntime };
