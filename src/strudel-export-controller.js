const crypto = require("node:crypto");
const { validateStrudelSnapshot, validateStrudelWav } = require("./strudel-export-policy");
const EXPORT_ID = /^[A-Za-z0-9_-]{1,80}$/;
function exportKey(scope, exportId) {
  return `${scope.projectId}:${scope.instanceId}:${exportId}`;
}
function createStrudelExportController({ render, saveMedia, findExport, isAttached, attach, assertScope, captureDependency, onExport }) {
  const reservations = new Map();
  let active;
  function check(entry) {
    if (entry.abort.signal.aborted) {
      const error = new Error(typeof entry.abort.signal.reason === "string" ? entry.abort.signal.reason : "Strudel export was cancelled.");
      error.name = "AbortError";
      throw error;
    }
    assertScope(entry.scope);
  }
  function start(scope, request) {
    try {
      if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key2) => !["exportId", "expectedSourceRevision", "snapshot"].includes(key2))) throw new Error("Export request contains unsupported fields.");
      if (typeof request.exportId !== "string" || !EXPORT_ID.test(request.exportId)) throw new Error("Export receipt ID is invalid.");
      assertScope(scope);
      if (request.expectedSourceRevision !== scope.sourceRevision) throw new Error("The loaded sound source changed. Reload the sketch before export.");
      const snapshot = validateStrudelSnapshot(request.snapshot);
      scope = Object.freeze({ ...scope });
      request = Object.freeze({ exportId: request.exportId, expectedSourceRevision: request.expectedSourceRevision, snapshot });
      const dependency = captureDependency(scope);
      if (!dependency || typeof dependency.source !== "string" || !/^[a-f0-9]{64}$/.test(dependency.digest)) throw new Error("The pinned Strudel dependency is invalid.");
      const contentDigest = crypto.createHash("sha256").update(JSON.stringify({ sourceRevision: scope.sourceRevision, kitDigest: dependency.digest, snapshot })).digest("hex");
      const key = exportKey(scope, request.exportId), previous = reservations.get(key);
      if (previous) {
        if (previous.contentDigest !== contentDigest) throw new Error("This export ID was used for different content.");
        if (!previous.complete) return previous.promise;
        // Cached success is not permission to hide later corruption or deletion.
        return Promise.resolve().then(async () => {
          const saved = await findExport({ projectId: scope.projectId, instanceId: scope.instanceId, exportId: request.exportId });
          if (!saved || saved.id !== previous.receipt.assetId) throw new Error('The original saved export was removed or cannot be found in Media.');
          if (saved.scope.contentDigest !== contentDigest || saved.scope.sourceRevision !== scope.sourceRevision || saved.scope.kitDigest !== dependency.digest) throw new Error('This export ID was used for different content.');
          validateStrudelWav(saved.wavBytes, snapshot);
          return previous.receipt;
        });
      }
      if (active) throw new Error("A Strudel export is already in progress. Cancel it or wait.");
      if (reservations.size >= 32) {
        const complete = [...reservations].find(([, entry2]) => entry2.complete);
        if (complete) reservations.delete(complete[0]);
      }
      const entry = { scope: Object.freeze({ ...scope }), exportId: request.exportId, contentDigest, abort: new AbortController(), complete: false };
      // Reserve synchronously before any lookup, rendering or asynchronous save.
      reservations.set(key, entry);
      active = entry;
      entry.promise = Promise.resolve().then(async () => {
        check(entry);
        const existing = await findExport({ projectId: scope.projectId, instanceId: scope.instanceId, exportId: request.exportId });
        if (existing) {
          if (existing.scope.contentDigest !== contentDigest || existing.scope.sourceRevision !== scope.sourceRevision || existing.scope.kitDigest !== dependency.digest) throw new Error("This export ID was used for different content.");
          validateStrudelWav(existing.wavBytes, snapshot);
          let attached = false;
          try {
            attached = await isAttached(scope.projectId, existing.id);
          } catch {
            // Missing project metadata cannot undo the durable Media asset.
          }
          return { exportId: request.exportId, assetId: existing.id, projectId: scope.projectId, instanceId: scope.instanceId, mimeType: "audio/wav", attachmentStatus: attached ? "attached" : "saved-only", ...!attached ? { warning: "Loop already saved in Media. Attach it to this project manually from Media." } : {} };
        }
        check(entry);
        const output = await render(snapshot, { signal: entry.abort.signal, kitSource: dependency.source });
        check(entry);
        const timing = validateStrudelWav(output.wavBytes, snapshot);
        if (output.duration !== timing.duration || output.channels !== 2 || output.sampleRate !== 48000) throw new Error("Renderer metadata does not match the frozen WAV.");
        check(entry);
        // Do not abort-race the local save. Once admitted, its commit determines
        // success, even if Cancel, switch, storage notification or attach fails.
        const assetId = await saveMedia({ data: output.wavBytes.toString("base64"), mimeType: "audio/wav", name: "Strudel loop.wav", duration: timing.duration, codec: "pcm_s16le", scope: { kind: "strudel-export", exportId: request.exportId, projectId: scope.projectId, instanceId: scope.instanceId, documentPath: scope.documentPath, sourceRevision: scope.sourceRevision, contentDigest, kitDigest: dependency.digest, bpm: snapshot.bpm, cycles: snapshot.cycles } });
        if (typeof assetId !== "string" || !/^[a-f0-9]{32}$/.test(assetId)) throw new Error("Media save returned an invalid asset ID.");
        let attachmentStatus = "saved-only", warning;
        try {
          check(entry);
          await attach(scope.projectId, [assetId], () => check(entry));
          attachmentStatus = "attached";
        } catch (error) {
          // Attachment can commit before preview/history notification fails.
          // Inspect membership without retrying the save or attachment.
          try { if (await isAttached(scope.projectId, assetId)) attachmentStatus = "attached"; } catch { /* Media still owns the durable success. */ }
          warning = attachmentStatus === "attached"
            ? `Loop saved in Media and attached to its original project. Its preview may need refreshing. ${String(error.message || error).slice(0, 240)}`
            : `Loop saved in Media. Attach it to this project manually from Media. ${String(error.message || error).slice(0, 240)}`;
        }
        const receipt = { exportId: request.exportId, assetId, projectId: scope.projectId, instanceId: scope.instanceId, mimeType: "audio/wav", attachmentStatus, ...warning ? { warning } : {} };
        try {
          await onExport?.(receipt);
        } catch {
          // Notifications cannot undo a committed save.
        }
        return receipt;
      }).then((receipt) => {
        entry.complete = true;
        entry.receipt = receipt;
        return receipt;
      }, (error) => {
        reservations.delete(key);
        throw error;
      }).finally(() => {
        if (active === entry) active = undefined;
      });
      return entry.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  function cancel(scope, exportId) {
    if (typeof exportId !== "string" || !EXPORT_ID.test(exportId)) throw new Error("Export receipt ID is invalid.");
    const entry = reservations.get(exportKey(scope, exportId));
    if (entry && !entry.complete && ["projectId", "instanceId", "documentPath", "runtimeGeneration"].every((key) => entry.scope[key] === scope[key])) entry.abort.abort("Strudel export was cancelled.");
    return { cancelled: Boolean(entry && !entry.complete) };
  }
  function invalidate(reason = "The sound runtime changed; export was cancelled.") {
    active?.abort.abort(reason);
  }
  return { start, cancel, invalidate };
}
module.exports = { createStrudelExportController };
