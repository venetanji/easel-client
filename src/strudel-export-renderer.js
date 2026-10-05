const crypto = require("node:crypto");
const { isMediaBase64 } = require("./media-base64");
const { buildCanvasDocument } = require("./canvas-policy");
const { validateStrudelSnapshot, validateStrudelWav } = require("./strudel-export-policy");
const MAX_RENDER_MS = 30000;
function encodePCM16Wav(buffer) {
  if (buffer.sampleRate !== 48000 || buffer.numberOfChannels !== 2 || !Number.isInteger(buffer.length) || buffer.length < 1 || buffer.length > 1440000) throw new Error("Offline buffer must be bounded stereo 48 kHz.");
  const bytes = new Uint8Array(44 + buffer.length * 4), view = new DataView(bytes.buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 192000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, buffer.length * 4, true);
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  for (let frame = 0; frame < buffer.length; frame++) for (let channel = 0; channel < 2; channel++) {
    const value = channels[channel][frame];
    if (!Number.isFinite(value)) throw new Error("Offline audio contains non-finite samples.");
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(44 + frame * 4 + channel * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
// Executed only in the host-owned disposable realm with its exact project pin.
// Never called in the authored document or against its live Strudel module.
async function renderNativeStrudelSnapshot(snapshot) {
  const frames = Math.ceil((snapshot.cycles * 240 / snapshot.bpm + 0.5) * 48000);
  const context = new OfflineAudioContext(2, frames, 48000);
  const native = window.strudel;
  try {
    native.setAudioContext(context);
    native.setSuperdoughAudioController(null);
    await native.registerSynthSounds();
    // Offline time has not advanced while scheduling: the native source map
    // counts total scheduled sources. Host policy still limits actual overlap
    // to 32; raise only this realm's native ceiling to avoid premature stealing.
    native.setMaxPolyphony(Math.max(1, snapshot.events.length));
    const controller = native.getSuperdoughAudioController();
    controller.output.destinationGain.gain.setValueAtTime(1, 0);
    for (const event of snapshot.events) {
      // superdough mutates values.duration: never pass the canonical snapshot.
      await native.superdough({ note: event.midiNote, s: event.waveform, gain: event.gain, ...(event.envelopeMode === "explicit" ? { attack: event.attackSeconds, release: event.releaseSeconds } : {}) }, event.timeSeconds, event.durationSeconds, snapshot.bpm / 240, event.absoluteCycle);
    }
    const buffer = await context.startRendering();
    const bytes = encodePCM16Wav(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return { wavBase64: btoa(binary), duration: buffer.length / 48000, channels: 2, sampleRate: 48000 };
  } finally {
    native.getSuperdoughAudioController()?.output.disconnect();
    native.setSuperdoughAudioController(null);
    native.setAudioContext(null);
    // OfflineAudioContext has no close/abort API. The host destroys this realm.
  }
}
function nativeRenderScript(snapshot) {
  return `(() => { const encodePCM16Wav=${encodePCM16Wav.toString()}; return (${renderNativeStrudelSnapshot.toString()})(${JSON.stringify(snapshot)}); })()`;
}
function createStrudelExportRenderer({ BrowserWindow, sessionFactory, timeoutMs = MAX_RENDER_MS }) {
  async function renderStrudelSnapshot(input, { signal, kitSource } = {}) {
    const snapshot = validateStrudelSnapshot(input);
    if (typeof kitSource !== "string" || !kitSource || Buffer.byteLength(kitSource) > 8 * 1048576) throw new Error("The pinned Strudel dependency is unavailable or oversized.");
    let window2, environment, finished = false, timer;
    const url = `easel-canvas://strudel-export/${crypto.randomUUID()}/index.html`;
    const aborted = () => {
      const error = new Error(typeof signal?.reason === "string" ? signal.reason : "Strudel export was cancelled.");
      error.name = "AbortError";
      return error;
    };
    const check = () => {
      if (finished || signal?.aborted) throw aborted();
    };
    const destroy = () => {
      if (window2 && !window2.isDestroyed()) window2.destroy();
    };
    let rejectStop;
    const stopped = new Promise((_resolve, reject) => {
      rejectStop = reject;
    });
    const cancel = () => {
      finished = true;
      destroy();
      rejectStop(aborted());
    };
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      finished = true;
      destroy();
      rejectStop(new Error("Strudel export timed out after its wall-clock rendering budget."));
    }, Math.max(1, Math.min(MAX_RENDER_MS, timeoutMs)));
    const cleanupEnvironment = async () => {
      if (environment) {
        const saved = environment;
        environment = undefined;
        await saved.session.protocol.unhandle("easel-canvas");
      }
    };
    // Attach handlers before setup; cancellation and watchdog cover setup too.
    const operation = (async () => {
      check();
      const partition = `easel-strudel-export-${crypto.randomUUID()}`;
      environment = await sessionFactory(partition);
      try {
        check();
        const isolated = environment.session;
        isolated.setPermissionCheckHandler(() => false);
        isolated.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
        isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => callback({ cancel: details.url !== url }));
        const html = buildCanvasDocument({ html: "<!doctype html><html><head><title>Bounded Strudel export</title></head><body></body></html>", kits: ["strudel"], kitBundles: { strudel: kitSource } });
        await isolated.protocol.handle("easel-canvas", (request) => request.url === url ? new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : new Response("Not found", { status: 404 }));
        check();
        window2 = new BrowserWindow({ show: false, webPreferences: { partition: environment.partition || partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false } });
        window2.webContents.setAudioMuted(true);
        window2.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        const deny = (event, target) => {
          if (target !== url) event.preventDefault();
        };
        for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) window2.webContents.on(name, deny);
        await window2.loadURL(url);
        check();
        const result = await window2.webContents.executeJavaScript(nativeRenderScript(snapshot));
        check();
        if (!result || result.channels !== 2 || result.sampleRate !== 48000 || typeof result.wavBase64 !== "string" || result.wavBase64.length > 8 * 1048576 || !isMediaBase64(result.wavBase64)) throw new Error("The isolated renderer returned invalid WAV data.");
        const wavBytes = Buffer.from(result.wavBase64, "base64");
        const timing = validateStrudelWav(wavBytes, snapshot);
        if (result.duration !== timing.duration) throw new Error("The isolated renderer returned inconsistent duration.");
        return { wavBytes, duration: timing.duration, channels: 2, sampleRate: 48000 };
      } finally {
        destroy();
        await cleanupEnvironment();
      }
    })();
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      destroy();
    }
  }
  return { renderStrudelSnapshot };
}
module.exports = { MAX_RENDER_MS, encodePCM16Wav, renderNativeStrudelSnapshot, nativeRenderScript, createStrudelExportRenderer };
