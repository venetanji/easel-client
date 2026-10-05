const { throwIfAborted } = require('./turn-abort');

function createDeletionService({ canvasStore, mediaStore, instances, confirm, previewFile, previewMedia, recordUndo, canRecordUndo, onChanged, onEvent, onProjectDeleted }) {
  function allowed(info) {
    if (info.ok === false) throw new Error(info.reason || 'This item cannot be deleted.');
    return info;
  }

  async function refreshProject(controller, projectId) {
    if (controller.getCurrentCanvasId() !== projectId) return {};
    const hidden = controller.getContract().previewHidden;
    const documents = canvasStore.listDocuments(projectId).documents;
    const current = controller.getCurrentDocumentPath();
    const selected = documents.some((document) => document.path === current) ? current : canvasStore.getProject(projectId).manifest.entry;
    try {
      controller.markSourcePendingReload();
      const opened = await controller.openSaved(projectId, selected);
      const validation = await controller.validateCanvas?.();
      if (hidden) await controller.hide();
      onChanged?.({ ...opened, previewHidden: hidden });
      return { ...opened, previewHidden: hidden, ...(validation ? { validation } : {}) };
    } catch (error) {
      controller.markSourcePendingReload();
      return { documentPath: selected, sourcePendingReload: true, runtimeWarning: `The deletion is saved. Reopen the document to refresh its view. ${error.message}` };
    }
  }

  async function deleteProjectFile(controller, projectId, args, { preview = false, signal } = {}) {
    throwIfAborted(signal);
    const inspected = canvasStore.inspectDeletion(projectId, args);
    if (inspected.requiresProjectDeletion) {
      if (preview) await previewFile?.(controller, projectId, inspected);
      throwIfAborted(signal);
      return deleteProject(controller, projectId, { expectedProjectRevision: inspected.projectRevision }, { signal, lastFile: inspected.path, preview });
    }
    const info = allowed(inspected);
    if (preview) await previewFile?.(controller, projectId, info);
    throwIfAborted(signal);
    const confirmed = await confirm({ kind: 'file', projectId, name: info.path, info }, { signal });
    throwIfAborted(signal);
    if (!confirmed) return { ok: true, deleted: false, canceled: true, projectId, path: info.path, effects: { source: 'unchanged', runtime: preview ? 'target previewed for confirmation' : 'unchanged' } };
    const bound = instances?.list(projectId).filter((entry) => entry.documentPath === info.path) || [];
    const before = canvasStore.get(projectId).html;
    const snapshots = bound.filter(() => typeof instances.capture === 'function').map((entry) => instances.capture(projectId, entry.instanceId));
    const recovery = snapshots.length ? { instances: snapshots } : null;
    if (recovery && (typeof recordUndo !== 'function' || typeof canRecordUndo !== 'function' || !canRecordUndo(projectId, before, recovery))) throw new Error('This sketch and its complete timeline history exceed the Undo storage budget. No document was deleted.');
    const result = canvasStore.deleteFile(projectId, { path: info.path, expectedRevision: info.revision, expectedProjectRevision: info.projectRevision });
    recordUndo?.(projectId, before, recovery);
    let instanceWarning;
    try { for (const instance of bound) instances.remove(projectId, instance.instanceId); }
    catch (error) { instanceWarning = `The document is deleted, but its saved template state needs cleanup. ${error.message}`; }
    const opened = await refreshProject(controller, projectId);
    const event = { type: 'project-file-deleted', projectId, canvasId: projectId, deletedPath: info.path, ...opened, ...(instanceWarning ? { instanceWarning } : {}) };
    onEvent?.(event);
    return { ...result, ...opened, ok: true, deleted: true, projectId, deletedPath: info.path, ...(instanceWarning ? { instanceWarning } : {}), confirmation: 'user approved', effects: { source: 'file deleted from the project', runtime: opened.runtimeWarning ? 'refresh failed; reopen the document' : opened.documentPath ? 'current document reloaded' : 'unchanged; another project is open' } };
  }

  async function deleteProject(controller, projectId, args = {}, { signal, lastFile, preview = false } = {}) {
    throwIfAborted(signal);
    const info = allowed(canvasStore.inspectProjectDeletion(projectId, args));
    const answer = await confirm({ kind: 'project', projectId, name: info.title, info, ...(lastFile ? { lastFile } : {}) }, { signal });
    throwIfAborted(signal);
    const confirmed = answer === true || answer?.confirmed === true;
    if (!confirmed) return { ok: true, deleted: false, canceled: true, projectId, ...(lastFile ? { path: lastFile } : {}), effects: { source: 'unchanged', runtime: preview ? 'target previewed for confirmation' : 'unchanged' } };
    const result = canvasStore.deleteProject(projectId, { expectedProjectRevision: info.projectRevision, deleteMedia: answer?.deleteMedia === true });
    let runtimeWarning, instanceWarning;
    try { instances?.removeProject(projectId); }
    catch (error) { instanceWarning = `The project is deleted, but its saved template state needs cleanup. ${error.message}`; }
    try {
      if (onProjectDeleted) await onProjectDeleted(controller, projectId, result);
      else if (controller.getCurrentCanvasId() === projectId) await controller.closeCurrent?.({ save: false });
    } catch (error) { runtimeWarning = `The project is deleted. Close its remaining preview. ${error.message}`; }
    const mediaWarnings = [...(result.mediaWarnings || [])];
    for (const assetId of result.mediaDeletionCandidates || []) {
      try { await mediaStore.remove(assetId); }
      catch (error) { if (!/not found/i.test(error.message)) mediaWarnings.push({ assetId, message: error.message }); }
    }
    const response = { ...result, ok: true, deleted: true, projectDeleted: true, projectId, ...(lastFile ? { deletedPath: lastFile } : {}), confirmation: 'user approved', ...(mediaWarnings.length ? { mediaWarnings } : {}), ...(runtimeWarning ? { runtimeWarning } : {}), ...(instanceWarning ? { instanceWarning } : {}), effects: { ...result.effects, runtime: runtimeWarning ? 'preview cleanup failed' : 'deleted project closed if active' } };
    onEvent?.({ type: 'project-deleted', canvasId: projectId, ...response });
    return response;
  }

  async function deleteMedia(controller, { projectId, assetId, scope = 'project' }, { preview = false, signal } = {}) {
    throwIfAborted(signal);
    if (!['project', 'library'].includes(scope)) throw new Error('Choose project or library media scope.');
    const info = scope === 'project'
      ? allowed(canvasStore.inspectAssetDeletion(projectId, { assetId }))
      : { asset: await mediaStore.get(assetId) };
    if (preview) await previewMedia?.(controller, { projectId, assetId, scope, asset: info.asset });
    throwIfAborted(signal);
    const confirmed = await confirm({ kind: 'media', projectId, scope, name: info.asset?.name || `Media ${assetId.slice(0, 8)}`, info }, { signal });
    throwIfAborted(signal);
    if (!confirmed) return { ok: true, deleted: false, canceled: true, projectId, assetId, scope, effects: { source: 'unchanged', runtime: preview ? 'target previewed for confirmation' : 'unchanged' } };
    let result;
    let opened = {};
    if (scope === 'project') {
      const before = canvasStore.get(projectId).html;
      result = canvasStore.detachAsset(projectId, { assetId, expectedProjectRevision: info.projectRevision });
      recordUndo?.(projectId, before);
      opened = await refreshProject(controller, projectId);
    } else result = await mediaStore.remove(assetId);
    onEvent?.({ type: 'media-deleted', projectId, scope, assetId, ...opened });
    return { ...result, ...opened, ok: true, deleted: true, projectId, assetId, scope, confirmation: 'user approved', effects: { source: scope === 'project' ? 'project attachment removed; shared copies retained' : 'library copy deleted; project copies retained', runtime: opened.runtimeWarning ? 'refresh failed; reopen the document' : opened.documentPath ? 'current document reloaded' : preview ? 'target previewed for confirmation' : 'unchanged' } };
  }

  return { deleteProject, deleteProjectFile, deleteMedia };
}

module.exports = { createDeletionService };
