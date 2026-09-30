const { installCanvasMediaRuntime } = require('./canvas-media-runtime');
const { installCanvasAudioRuntime } = require('./canvas-audio-runtime');

// This bootstrap is embedded in saved/exported HTML and runs before user app code.
function installCanvasRuntime(installAudio) {
  if (window.EaselCanvas?.version === 1) return;
  const apps = new Map();
  const loops = new Set();
  const debugStates = new Map();
  const frames = new Set();
  const timers = new Map();
  const listeners = new Set();
  const contexts = new Set();
  const mediaStreams = new Set();
  let mediaEpoch = 0;
  const canvasContexts = new Map();
  const errors = [];
  const preserved = window.__easelPreservedState || {};
  delete window.__easelPreservedState;
  const native = {
    raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window),
    timeout: window.setTimeout.bind(window), interval: window.setInterval.bind(window),
    clearTimeout: window.clearTimeout.bind(window), clearInterval: window.clearInterval.bind(window),
    add: EventTarget.prototype.addEventListener, remove: EventTarget.prototype.removeEventListener,
  };
  const recordError = (message, kind = 'runtime', location = {}) => {
    errors.push({ kind, message: String(message).slice(0, 1000), timestamp: Date.now(),
      ...(location.filename ? { filename: String(location.filename).slice(0, 240) } : {}),
      ...(Number.isFinite(location.lineno) ? { lineno: location.lineno } : {}),
      ...(Number.isFinite(location.colno) ? { colno: location.colno } : {}),
    });
    if (errors.length > 20) errors.shift();
  };
  native.add.call(window, 'error', (event) => recordError(event.message || 'Uncaught error', 'runtime', event));
  native.add.call(window, 'unhandledrejection', (event) => recordError(event.reason?.message || event.reason || 'Unhandled promise rejection'));
  window.requestAnimationFrame = (callback) => {
    const id = native.raf((time) => { frames.delete(id); callback(time); });
    frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => { frames.delete(id); native.caf(id); };
  window.setTimeout = (callback, delay, ...args) => {
    const id = native.timeout(typeof callback === 'function' ? (...values) => { timers.delete(id); callback(...values); } : callback, delay, ...args);
    timers.set(id, 'timeout');
    return id;
  };
  window.setInterval = (callback, delay, ...args) => {
    const id = native.interval(callback, delay, ...args);
    timers.set(id, 'interval');
    return id;
  };
  window.clearTimeout = (id) => { timers.delete(id); native.clearTimeout(id); };
  window.clearInterval = (id) => { timers.delete(id); native.clearInterval(id); };
  const captureOption = (options) => typeof options === 'boolean' ? options : Boolean(options?.capture);
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (!callback) return native.add.call(this, type, callback, options);
    const capture = captureOption(options);
    if ([...listeners].some((item) => item.target === this && item.type === type && item.callback === callback && item.capture === capture)) return;
    const item = { target: this, type, callback, capture, wrapped: callback };
    if (options?.once) {
      item.wrapped = function (...args) {
        listeners.delete(item);
        return typeof callback === 'function' ? callback.apply(this, args) : callback.handleEvent(...args);
      };
    }
    native.add.call(this, type, item.wrapped, options);
    if (!options?.signal?.aborted) listeners.add(item);
    if (options?.signal) native.add.call(options.signal, 'abort', () => listeners.delete(item), { once: true });
  };
  EventTarget.prototype.removeEventListener = function (type, callback, options) {
    const capture = captureOption(options);
    const item = [...listeners].find((record) => record.target === this && record.type === type && record.callback === callback && record.capture === capture);
    if (item) listeners.delete(item);
    return native.remove.call(this, type, item?.wrapped || callback, options);
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const context = getContext.call(this, type, ...args);
    if (context) canvasContexts.set(this, { type: String(type), context });
    return context;
  };
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Constructor = window[name];
    if (typeof Constructor !== 'function') continue;
    window[name] = new Proxy(Constructor, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget);
        contexts.add(context);
        return context;
      },
    });
  }
  if (navigator.mediaDevices?.getUserMedia) {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const epoch = mediaEpoch;
      const stream = await getUserMedia(constraints);
      if (epoch !== mediaEpoch) {
        stream.getTracks().forEach((track) => track.stop());
        throw new DOMException('Device access was stopped while permission was pending.', 'AbortError');
      }
      mediaStreams.add(stream);
      return stream;
    };
  }
  const audioDiagnostics = typeof installAudio === 'function' ? installAudio({ getContexts: () => contexts, native }) : null;
  const domReady = document.readyState === 'loading'
    ? new Promise((resolve) => native.add.call(document, 'DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve();
  let assetReadiness;
  let assetRegistry;
  let assetMetadata = [];
  const emptyAssetRegistry = Object.freeze({});
  const readinessScope = 'Attached image assets are decoded offscreen, at most four at a time, with a combined 1200 ms deadline. Other media and resources loaded by app code are not validated.';

  function attachedAssets() {
    const registry = window.__easelProjectAssets;
    return registry && typeof registry === 'object' && !Array.isArray(registry) ? registry : emptyAssetRegistry;
  }

  function assetInfo(id, asset) {
    return {
      id, path: String(asset.path || '').slice(0, 180), mimeType: String(asset.mimeType || '').slice(0, 100),
      bytes: Number(asset.bytes) || 0,
      ...(typeof asset.digest === 'string' ? { digest: asset.digest.slice(0, 64) } : {}),
      ...(typeof asset.name === 'string' ? { name: asset.name.slice(0, 240) } : {}),
      ...(Number.isFinite(asset.width) ? { width: asset.width } : {}),
      ...(Number.isFinite(asset.height) ? { height: asset.height } : {}),
    };
  }

  function metadata(registry = attachedAssets()) {
    return Object.entries(registry).slice(0, 200).filter(([id, asset]) => /^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(id) && asset && typeof asset === 'object').map(([id, asset]) => assetInfo(id, asset));
  }

  function getAssetUrl(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(id)) throw new Error('Asset ID must be a 32- or 64-character lowercase hexadecimal ID.');
    const registry = attachedAssets();
    if (!Object.hasOwn(registry, id)) throw new Error('This asset is not attached to the current canvas project.');
    const url = registry[id]?.url;
    if (typeof url !== 'string' || !/^(?:data:|blob:)/i.test(url)) throw new Error('The attached asset has no offline URL.');
    return url;
  }

  function decodeAsset(info, deadline) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return Promise.resolve({ ...info, readiness: 'timeout' });
    return new Promise((resolve) => {
      const image = new Image();
      let timer;
      let settled = false;
      const finish = (readiness, error = '') => {
        if (settled) return;
        settled = true;
        native.clearTimeout(timer);
        image.onload = null; image.onerror = null;
        resolve({ ...info, readiness, ...(readiness === 'ready' ? { width: image.naturalWidth, height: image.naturalHeight } : {}), ...(error ? { error: error.slice(0, 180) } : {}) });
      };
      timer = native.timeout(() => finish('timeout'), remaining);
      image.onerror = () => finish('error', 'The attached image could not be decoded.');
      image.onload = () => {
        if (typeof image.decode === 'function') image.decode().then(() => finish('ready'), (error) => finish('error', String(error.message)));
        else finish('ready');
      };
      try { image.src = getAssetUrl(info.id); }
      catch (error) { finish('error', String(error.message)); }
    });
  }

  function assetsReady() {
    const registry = attachedAssets();
    if (assetReadiness && assetRegistry === registry) return assetReadiness;
    assetRegistry = registry;
    assetReadiness = Promise.resolve(window.__easelProjectAssetsReady || registry).then(async () => {
      assetMetadata = metadata().map((info) => ({ ...info, readiness: /^image\//.test(info.mimeType) ? 'pending' : 'not-inspected' }));
      const deadline = performance.now() + 1200;
      let next = 0;
      const worker = async () => {
        while (next < assetMetadata.length) {
          const index = next++;
          const info = assetMetadata[index];
          if (/^image\//.test(info.mimeType)) assetMetadata[index] = await decodeAsset(info, deadline);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, assetMetadata.length) }, worker));
      return assetMetadata.map((info) => ({ ...info }));
    });
    return assetReadiness;
  }

  const assets = Object.freeze({
    getUrl: getAssetUrl,
    get manifest() { return metadata(); },
    list() { return metadata(); },
    get ready() { return assetsReady(); },
  });

  async function whenReady() {
    await domReady;
    return { dom: 'ready', assets: await assetsReady(), scope: readinessScope };
  }

  function startLoop(callback) {
    if (typeof callback !== 'function') throw new Error('startLoop requires a function.');
    let running = true;
    let frame = 0;
    let previous;
    const stop = () => {
      if (!running) return;
      running = false;
      window.cancelAnimationFrame(frame);
      loops.delete(stop);
    };
    const tick = (time) => {
      if (!running) return;
      const deltaSeconds = previous === undefined ? 0 : Math.min(0.25, Math.max(0, (time - previous) / 1000));
      previous = time;
      try { callback(time, deltaSeconds); }
      catch (error) { recordError(error.message || error, 'loop'); stop(); }
      if (running) frame = window.requestAnimationFrame(tick);
    };
    Object.defineProperty(stop, 'stop', { value: stop });
    loops.add(stop);
    frame = window.requestAnimationFrame(tick);
    return Object.freeze(stop);
  }

  function debugSnapshot() {
    let remaining = 8192;
    let nodes = 256;
    let truncated = false;
    const seen = new WeakSet();
    function plain(value, depth = 0) {
      if (remaining <= 64 || --nodes < 0 || depth > 6) { truncated = true; return '[truncated]'; }
      if (value === null || typeof value === 'boolean') { remaining -= 8; return value; }
      if (typeof value === 'number') { remaining -= 24; return Number.isFinite(value) ? value : null; }
      if (typeof value === 'string') {
        let text = value.slice(0, Math.min(600, Math.floor(remaining / 4)));
        let bytes = new TextEncoder().encode(JSON.stringify(text)).length;
        while (text.length && bytes > remaining - 64) {
          text = text.slice(0, Math.floor(text.length / 2));
          bytes = new TextEncoder().encode(JSON.stringify(text)).length;
        }
        if (text.length !== value.length) truncated = true;
        remaining -= bytes + 4;
        return text;
      }
      if (typeof value !== 'object' || value instanceof Promise) { remaining -= 32; return '[unsupported]'; }
      if (seen.has(value)) { remaining -= 16; return '[circular]'; }
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) { remaining -= 32; return '[non-JSON object]'; }
      seen.add(value);
      const output = Array.isArray(value) ? [] : {};
      let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key) || key === '__proto__') continue;
        if (++count > 32) { truncated = true; break; }
        if (remaining <= 64 || nodes <= 0) { truncated = true; break; }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const name = key.slice(0, 120);
        remaining -= new TextEncoder().encode(JSON.stringify(name)).length + 4;
        const item = Object.hasOwn(descriptor, 'value') ? plain(descriptor.value, depth + 1) : '[getter omitted]';
        if (Array.isArray(output)) output.push(item);
        else Object.defineProperty(output, name, { value: item, enumerable: true });
      }
      return output;
    }
    const states = [];
    for (const [id, getState] of debugStates) {
      if (remaining <= 128 || nodes <= 0) { truncated = true; break; }
      try { states.push({ id, state: plain(getState()) }); }
      catch (error) { states.push({ id, error: String(error.message).slice(0, 180) }); remaining -= 240; }
    }
    const result = { states, truncated, limitBytes: 8192, scope: 'Synchronous registered getters only; bounded JSON data, depth 6, at most 256 values. Accessors and promises are omitted.' };
    while (states.length && new TextEncoder().encode(JSON.stringify(result)).length > 8192) { states.pop(); result.truncated = true; }
    return result;
  }

  function appSummary(app) {
    const scene = app.scene;
    const camera = app.camera;
    const objects = [];
    if (scene?.traverse) scene.traverse((object) => {
      if (objects.length < 24) objects.push({ name: String(object.name || '').slice(0, 120), type: String(object.type || 'Object').slice(0, 120), visible: object.visible !== false });
    });
    return {
      id: app.id, renderer: app.renderer?.isWebGLRenderer ? 'Three.WebGLRenderer' : String(app.renderer?.constructor?.name || '').slice(0, 120) || null,
      rootConnected: app.root ? Boolean(app.root.isConnected) : null,
      scene: scene ? { type: String(scene.type || scene.constructor?.name || '').slice(0, 120), objects, truncated: objects.length === 24 } : null,
      camera: camera ? { type: String(camera.type || camera.constructor?.name || '').slice(0, 120), position: camera.position ? { x: Number(camera.position.x), y: Number(camera.position.y), z: Number(camera.position.z) } : null, fov: Number(camera.fov) || null, zoom: Number(camera.zoom) || null } : null,
      hasDispose: typeof app.dispose === 'function', hasState: typeof app.getState === 'function', hasRestoreState: typeof app.restoreState === 'function',
    };
  }

  function inspect() {
    const canvases = [...document.querySelectorAll('canvas')].slice(0, 32).map((canvas) => {
      const box = canvas.getBoundingClientRect();
      return { id: canvas.id.slice(0, 120), width: canvas.width, height: canvas.height, context: canvasContexts.get(canvas)?.type || 'unknown', bounds: { x: box.x, y: box.y, width: box.width, height: box.height }, visible: box.width > 0 && box.height > 0 && getComputedStyle(canvas).visibility !== 'hidden' && getComputedStyle(canvas).display !== 'none' };
    });
    let tone = null;
    try {
      if (window.Tone?.getContext) { const context = window.Tone.getContext(); tone = { state: context.state || context.rawContext?.state || 'unknown', transport: window.Tone.getTransport?.().state || 'unknown', clockSource: context.clockSource || 'unknown', version: window.Tone.version || '' }; }
    } catch (error) { tone = { error: String(error.message).slice(0, 240) }; }
    return {
      managed: true, canvases, canvasCount: document.querySelectorAll('canvas').length,
      rendererCount: [...apps.values()].filter((app) => app.renderer).length,
      webglCanvasCount: [...canvasContexts].filter(([canvas, record]) => canvas.isConnected && /webgl/i.test(record.type)).length,
      rendererCountScope: 'registered apps; unregistered renderers may exist',
      apps: [...apps.values()].slice(0, 8).map((app) => { try { return appSummary(app); } catch (error) { return { id: app.id, error: String(error.message).slice(0, 240) }; } }),
      animation: { pendingFrames: frames.size, timers: timers.size, managedLoops: loops.size, scope: 'tracked since this document loaded; renderer-owned loops need app disposal' },
      listeners: listeners.size,
      audio: { tone, contexts: [...contexts].slice(0, 16).map((context) => ({ state: context.state, sampleRate: context.sampleRate })), userGestureRequired: true, diagnostics: audioDiagnostics?.api.inspect() || null },
      assets: { manifest: (assetMetadata.length ? assetMetadata : metadata()).slice(0, 24).map((info) => ({ ...info })), total: metadata().length, truncated: metadata().length > 24, scope: readinessScope },
      debug: debugSnapshot(),
      media: { available: Boolean(navigator.mediaDevices?.getUserMedia), tracks: [...mediaStreams].flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === 'live').slice(0, 16).map((track) => ({ kind: track.kind, enabled: track.enabled, muted: track.muted })), permissionRequired: true },
      errors: [...errors],
    };
  }

  function captureState() {
    const state = { apps: Object.create(null), controls: [] };
    for (const app of apps.values()) {
      if (typeof app.getState !== 'function') continue;
      try { state.apps[app.id] = app.getState(); } catch (error) { recordError(error.message, 'state'); }
    }
    const controls = [...document.querySelectorAll('input[id], input[name], select[id], select[name], textarea[id], textarea[name]')];
    for (const control of controls) {
      if (state.controls.length >= 64) break;
      if (['password', 'file'].includes(control.type)) continue;
      const group = controls.filter((item) => item.tagName === control.tagName && item.type === control.type && item.name === control.name);
      state.controls.push({ id: control.id, name: control.name, tag: control.tagName, type: control.type, groupIndex: group.indexOf(control), value: control.value, checked: control.checked, selected: control.multiple ? [...control.selectedOptions].map((option) => option.value) : undefined });
    }
    const serialized = JSON.stringify(state);
    if (new TextEncoder().encode(serialized).length > 16_384) throw new Error('Preserved app and control state exceeds 16 KiB.');
    return JSON.parse(serialized);
  }

  function restoreControls() {
    let restoredControls = 0;
    const controls = [...document.querySelectorAll('input, select, textarea')];
    for (const previous of preserved.controls || []) {
      const group = controls.filter((item) => item.tagName === previous.tag && item.type === previous.type && item.name === previous.name);
      const indexed = group[previous.groupIndex];
      const control = previous.id ? document.getElementById(previous.id) : ['radio', 'checkbox'].includes(previous.type)
        ? (indexed?.value === previous.value ? indexed : group.find((item) => item.value === previous.value))
        : indexed;
      if (!control || !/^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) || ['password', 'file'].includes(control.type)) continue;
      if (control.tagName !== previous.tag || control.type !== previous.type) continue;
      control.value = previous.value;
      if (typeof previous.checked === 'boolean') control.checked = previous.checked;
      if (previous.selected && control.multiple) for (const option of control.options) option.selected = previous.selected.includes(option.value);
      restoredControls += 1;
    }
    return { restoredControls, eventsDispatched: false };
  }

  async function disposeTrackedResources() {
    const report = { disposedApps: [], failures: [], framesCancelled: frames.size, timersCleared: timers.size, listenersRemoved: listeners.size, audioContextsClosed: 0, mediaTracksStopped: stopMedia() };
    const audio = new Set(contexts);
    audioDiagnostics?.cleanup();
    for (const stop of loops) stop();
    for (const app of [...apps.values()]) {
      try {
        if (typeof app.dispose === 'function') await app.dispose();
        else {
          app.renderer?.setAnimationLoop?.(null);
          app.renderer?.dispose?.();
          for (const node of app.audio || []) node?.dispose?.();
        }
        report.disposedApps.push(app.id);
      } catch (error) { report.failures.push({ app: app.id, message: String(error.message).slice(0, 240) }); }
    }
    for (const id of frames) native.caf(id);
    frames.clear();
    for (const [id, type] of timers) (type === 'interval' ? native.clearInterval : native.clearTimeout)(id);
    timers.clear();
    for (const item of listeners) native.remove.call(item.target, item.type, item.wrapped, item.capture);
    listeners.clear();
    for (const context of audio) {
      try { if (context.state !== 'closed') { await context.close(); report.audioContextsClosed += 1; } } catch (error) { report.failures.push({ audio: true, message: String(error.message).slice(0, 240) }); }
    }
    apps.clear();
    debugStates.clear();
    report.limits = 'Only registered disposal and resources observed by this bootstrap are tracked. A document reload also discards the old document and its JS realm.';
    return report;
  }

  async function cleanup() {
    let deadline;
    try {
      return await Promise.race([
        disposeTrackedResources(),
        new Promise((resolve) => { deadline = native.timeout(() => resolve({ timedOut: true, limits: 'Managed cleanup exceeded 1500 ms. Reload discards the old document.' }), 1500); }),
      ]);
    } finally { native.clearTimeout(deadline); }
  }

  function stopMedia() {
    mediaEpoch += 1;
    let stopped = 0;
    for (const stream of mediaStreams) for (const track of stream.getTracks()) {
      if (track.readyState === 'live') { track.stop(); stopped += 1; }
    }
    mediaStreams.clear();
    return stopped;
  }

  window.EaselCanvas = Object.freeze({
    version: 1, inspect, captureState, restoreControls, cleanup, stopMedia, assets, whenReady, startLoop,
    audio: audioDiagnostics?.api || null,
    registerDebugState(id, getState) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof getState !== 'function') throw new Error('registerDebugState requires an id and a synchronous JSON getter.');
      if (debugStates.has(id)) throw new Error('This debug state id is already registered. Unregister it first.');
      if (debugStates.size >= 8) throw new Error('At most eight debug state providers may be registered.');
      debugStates.set(id, getState);
      return () => { if (debugStates.get(id) === getState) debugStates.delete(id); };
    },
    registerApp(app) {
      if (!app || typeof app.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(app.id)) throw new Error('registerApp requires an app id (letters, digits, underscore or dash).');
      if (apps.has(app.id)) throw new Error('Dispose or reload the previous app before registering the same id.');
      if (apps.size >= 8) throw new Error('At most eight canvas apps can be registered.');
      apps.set(app.id, app);
      if (Object.hasOwn(preserved.apps || {}, app.id) && typeof app.restoreState === 'function') {
        try { Promise.resolve(app.restoreState(preserved.apps[app.id])).catch((error) => recordError(error.message, 'state')); } catch (error) { recordError(error.message, 'state'); }
      }
      return { id: app.id, preservedState: preserved.apps?.[app.id] ?? null };
    },
  });
}

const RUNTIME_LIFECYCLE_SCRIPT = `<script id="easel-runtime-lifecycle">(${installCanvasRuntime.toString()})(${installCanvasAudioRuntime.toString()});(${installCanvasMediaRuntime.toString()})();</script>`;

function addCanvasLifecycle(html) {
  const clean = html.replace(/<script\s+id=["']easel-runtime-(?:lifecycle|state)["'][^>]*>[\s\S]*?<\/script>/gi, '');
  return clean.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${RUNTIME_LIFECYCLE_SCRIPT}`);
}

module.exports = { addCanvasLifecycle, RUNTIME_LIFECYCLE_SCRIPT };
