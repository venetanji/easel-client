const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  shell,
  protocol,
} = require('electron');
protocol.registerSchemesAsPrivileged([{ scheme: 'easel-canvas', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const {
  IPC_CHANNELS,
  assertTrustedSender,
  validateCanvasBounds,
  validateCanvasKits,
  validateCanvasTitle,
  validateChatMessage,
  validateChatOptions,
  validateLiteLLMModelInput,
  validateModelSelection,
  validateOpaqueId,
  validateProjectAssetId,
  validateDocumentPath,
  validateProjectInput,
  validateProjectKits,
  validateSettingsInput,
} = require('./ipc-contract');
const { createSettingsStore } = require('./settings-store');
const { createAssetStore } = require('./asset-store');
const { createCanvasStore } = require('./canvas-store');
const { createCanvasView } = require('./canvas-view');
const { createCanvasHistory } = require('./canvas-history');
const { createChatService, defaultMcpLaunchOptions } = require('./chat-service');
const { createMediaMcpClient } = require('./media-mcp-client');
const { createAgentControl } = require('./agent-control');
const { createControlEventStore } = require('./control-event-store');
const { createControlMcpServer } = require('./control-mcp-server');
const { createEaselToolHost } = require('./easel-tool-host');
const { createAgentRouter } = require('./agent-router');
const { createCodexAppServer, resolveCodexExecutable } = require('./codex-app-server');
const { createCodexChatService, defaultInput } = require('./codex-chat-service');
const { decodeCodexImage } = require('./codex-image-output');
const { handleMcpResult } = require('./agent');
const { createChatStore } = require('./chat-store');
const { createCanvasInputStore } = require('./canvas-input-store');
const { renderCanvasInputScript, dismissCanvasInputScript } = require('./canvas-input-runtime');
const { createCanvasMediaStore } = require('./canvas-media-store');
const { createMediaJobStore, mediaJobSummary } = require('./media-job-store');
const { createMediaJobMonitor } = require('./media-job-monitor');
const { createVideoMetadataService } = require('./video-metadata');
const { createDeletionService } = require('./deletion-service');
const { validateFilePath } = require('./canvas-project');
const { createLiteLLMModelService } = require('./litellm-models');
const { readInstalledSkills, assertHarnessSkills } = require('./skill-catalog');
const { loadCanvasKitBundles } = require('./canvas-kits');
const { availableCanvasKits, assertInstalledKits } = require('./canvas-kit-catalog');

const SETTINGS = createSettingsStore({
  userDataPath: app.getPath('userData'),
  safeStorage,
});
function projectThumbnail(bytes) {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return '';
  const size = image.getSize();
  if (!size.width || !size.height) return '';
  const scale = Math.min(1, 240 / Math.max(size.width, size.height));
  return image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }).toDataURL();
}
const ASSETS = createAssetStore({
  userDataPath: app.getPath('userData'),
  thumbnailFactory: (bytes) => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return '';
    const size = image.getSize();
    if (!size.width || !size.height) return '';
    const scale = Math.min(1, 240 / Math.max(size.width, size.height));
    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good',
    }).toDataURL();
  },
});
const CANVAS_KIT_BUNDLES = loadCanvasKitBundles(path.join(app.getAppPath(), 'canvas-kits'));
const CANVAS_INPUTS = createCanvasInputStore({ userDataPath: app.getPath('userData') });
const CAPTURE_MEDIA = createCanvasMediaStore({ userDataPath: app.getPath('userData') });
const MEDIA_JOBS = createMediaJobStore({ userDataPath: app.getPath('userData') });
const MEDIA_ASSETS = {
  save: (media) => media.mimeType?.startsWith('image/') ? ASSETS.save(media) : CAPTURE_MEDIA.save(media),
  getMetadata: async (id) => {
    try { return await CAPTURE_MEDIA.getMetadata(id); } catch {}
    try { return CANVASES.getLibraryAsset(id, { thumbnail: true }); }
    catch { return null; }
  },
  get: async (id) => {
    try { return await ASSETS.get(id); } catch {}
    try { return await CAPTURE_MEDIA.get(id); } catch {}
    return CANVASES.getLibraryAsset(id);
  },
  remove: async (id) => {
    let usage;
    try { usage = CANVASES.inspectLibraryAssetDeletion(id); }
    catch (error) { if (!/Library media was not found/.test(error.message)) throw error; }
    if (usage?.ok === false) throw new Error(usage.reason);
    if (id.length === 64) return CANVASES.removeLibraryAsset(id);
    let image = false;
    try { await ASSETS.get(id); image = true; } catch {}
    let result;
    try { result = image ? await ASSETS.remove(id) : await CAPTURE_MEDIA.remove(id); }
    catch (error) { if (!usage?.asset) throw error; return CANVASES.removeLibraryAsset(id); }
    if (usage?.asset) CANVASES.removeLibraryAsset(id);
    return result;
  },
};
const CANVASES = createCanvasStore({ userDataPath: app.getPath('userData'), kitBundles: CANVAS_KIT_BUNDLES, assetStore: MEDIA_ASSETS, thumbnailFactory: projectThumbnail });
const CANVAS_HISTORY = createCanvasHistory();
let mainWindow;
let canvasView;
let canvasOperations = Promise.resolve();

function withCanvas(action) {
  const result = canvasOperations.then(() => action(requireCanvasView()));
  canvasOperations = result.catch(() => {});
  return result;
}

function projectMutation(method, options) {
  return withCanvas(async (controller) => {
    const canvasId = controller.getCurrentCanvasId();
    const before = canvasId ? CANVASES.get(canvasId).html : '';
    try { return await controller[method](options); }
    finally {
      if (canvasId && CANVASES.get(canvasId).html !== before) {
        CANVAS_HISTORY.record(canvasId, before);
        emitCanvasSaved(CANVASES.get(canvasId));
      }
    }
  });
}

function requireCanvasView() {
  if (!canvasView) throw new Error('Canvas view is not ready.');
  return canvasView;
}

function emitCanvasSaved(canvas) {
  const canvasId = canvas.id || canvas.canvasId || '';
  const current = canvasView?.getContract();
  const document = canvasId ? CANVASES.get(canvasId, { documentPath: (current?.canvasId === canvasId ? current.documentPath : canvas.documentPath) || undefined }) : canvas;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, {
      type: 'canvas',
      title: document.projectTitle || document.title,
      canvasId,
      projectId: canvasId,
      projectTitle: document.projectTitle || document.title,
      documentPath: document.documentPath,
      documentTitle: document.documentTitle,
      starterDocument: document.starterDocument === true,
      previewHidden: Boolean(current?.previewHidden),
      undoAvailable: Boolean(canvasId && CANVAS_HISTORY.canUndo(canvasId)),
    });
  }
  recordControlChange({ type: 'canvas', canvasId, projectId: canvasId, title: document.projectTitle || document.title, documentPath: document.documentPath, documentTitle: document.documentTitle });
}

async function attachProjectAssets(controller, projectId, assetIds, { kits } = {}) {
  const selected = projectId ? { id: projectId } : await controller.ensureProject({ kits });
  const id = validateOpaqueId(selected.id, 'Project ID');
  const before = CANVASES.get(id).html;
  const result = await CANVASES.attachAssets(id, { assetIds });
  if (result.changed) CANVAS_HISTORY.record(id, before);
  let runtimeAssetsUpdated = false;
  let runtimeWarning = '';
  if (controller.getCurrentCanvasId() === id) {
    try { ({ runtimeAssetsUpdated } = await controller.installProjectAssets(assetIds)); }
    catch (error) { controller.markSourcePendingReload(); runtimeWarning = error.message; }
  }
  const project = CANVASES.getProject(id);
  const metadata = { id, title: project.title, projectId: id, projectTitle: project.title, canvasId: id, documentPath: controller.getCurrentCanvasId() === id ? controller.getCurrentDocumentPath() : '', createdProject: Boolean(selected.createdProject), assetIds, attachedToProject: true, runtimeAssetsUpdated, changed: Boolean(result.changed), attachedCount: result.attachedCount, projectRevision: result.projectRevision, undoAvailable: CANVAS_HISTORY.canUndo(id), ...(runtimeWarning ? { runtimeWarning } : {}) };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'project-assets', ...metadata });
  recordControlChange({ type: 'project-assets', ...metadata });
  return metadata;
}

function publicAsset(asset) {
  return Object.fromEntries(['id', 'name', 'mimeType', 'data', 'bytes', 'width', 'height', 'duration', 'codec', 'thumbnail'].filter((key) => asset[key] !== undefined).map((key) => [key, asset[key]]));
}

function validateFileDeletion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['path', 'expectedRevision', 'expectedProjectRevision'].includes(key))) throw new Error('File deletion options are invalid.');
  for (const key of ['expectedRevision', 'expectedProjectRevision']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !/^[a-f0-9]{64}$/.test(input[key]))) throw new Error('File deletion revision is invalid.');
  return { ...input, path: validateFilePath(input.path) };
}

const DELETIONS = createDeletionService({
  canvasStore: CANVASES,
  mediaStore: MEDIA_ASSETS,
  recordUndo: (id, snapshot) => CANVAS_HISTORY.record(id, snapshot),
  onChanged: emitCanvasSaved,
  onProjectDeleted: async (controller, id) => {
    CANVAS_HISTORY.clear(id);
    for (const job of MEDIA_JOBS.list({ projectId: id, raw: true })) {
      MEDIA_JOBS.update(job.id, { projectId: '', notification: 'interrupted' });
    }
    if (controller.getCurrentCanvasId() === id) return controller.closeCurrent({ save: false });
    return { closed: false };
  },
  onEvent: (event) => emitAgentEvent(event),
  previewFile: async (controller, id, info) => {
    if (info.isDocument) emitCanvasSaved(await controller.openSaved(id, info.path));
    else {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'canvas-file-preview', projectId: id, path: info.path });
    }
  },
  previewMedia: async (controller, { projectId, scope, asset }) => {
    await controller.hide();
    const { data, ...metadata } = asset;
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'canvas-media-preview', projectId, scope, asset: metadata, previewHidden: true });
  },
  confirm: async ({ kind, projectId, scope, name, info }, { signal } = {}) => {
    const projectTitle = projectId ? CANVASES.getProject(projectId).title : '';
    if (kind === 'project') {
      const result = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Delete project', message: `Delete ${projectTitle}?`,
        detail: 'This deletes every file in the project. You can keep its media in All media, or delete media that no other project uses. Media shared with other projects is kept. Pending generation jobs continue in All media. This cannot be undone.',
        buttons: ['Delete project, keep media', 'Delete project and media', 'Cancel'], defaultId: 2, cancelId: 2, noLink: true, ...(signal ? { signal } : {}) });
      return { confirmed: result.response !== 2, deleteMedia: result.response === 1 };
    }
    const action = kind === 'media' && scope === 'project' ? 'Remove' : 'Delete';
    const detail = kind === 'file'
      ? `This deletes ${name} from ${projectTitle}.${info.isEntry ? ` The new default document will be ${info.nextEntry}.` : ''}`
      : scope === 'project'
        ? `This removes the attachment from ${projectTitle}. The shared library and other project copies are kept.`
        : 'This deletes the saved library copy and any recorded frame samples. Existing project copies are kept.';
    const result = await dialog.showMessageBox(mainWindow, { type: 'warning', title: `${action} ${kind === 'file' ? 'file' : 'media'}`, message: `${action} ${name}?`, detail, buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, ...(signal ? { signal } : {}) });
    return result.response === 0;
  },
});

async function listStoredMedia() {
  const [images, captures] = await Promise.all([ASSETS.list(), CAPTURE_MEDIA.list()]);
  const shared = CANVASES.listLibraryAssets({ thumbnail: true });
  const assets = new Map(shared.map((asset) => [asset.id, asset]));
  for (const asset of [...images, ...captures]) assets.set(asset.id, { ...assets.get(asset.id), ...asset });
  return [...jobCards(), ...assets.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
}

function jobCards(projectId) {
  return MEDIA_JOBS.list({ ...(projectId ? { projectId } : {}) }).filter((job) => job.status !== 'ready').map((job) => ({ id: job.id, name: job.name, mimeType: job.mediaType === 'video' ? 'video/mp4' : job.mediaType === 'audio' ? 'audio/wav' : 'image/png', updatedAt: job.updatedAt, projectId: job.projectId, kind: 'job', job }));
}

async function forgetMediaJob(id, { signal } = {}) {
  const job = MEDIA_JOBS.get(validateOpaqueId(id, 'Media job ID'));
  const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Remove generation job', message: `Remove ${job.name}?`,
    detail: `This removes the saved job ID and stops monitoring. It does not cancel generation on the server. Media cannot be retrieved without its job ID; keep a copy before removing it. Any files already downloaded are kept.\n\nJob ID: ${job.remoteId}`,
    buttons: ['Remove job', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, ...(signal ? { signal } : {}) });
  return answer.response === 0 ? JOB_MONITOR.forget(job.id) : { deleted: false, canceled: true };
}

async function readMediaReference({ assetId, projectId } = {}) {
  const id = validateProjectAssetId(assetId);
  if (projectId !== undefined) validateOpaqueId(projectId, 'Project ID');
  try { return await MEDIA_ASSETS.get(id); }
  catch (error) { if (!projectId && !canvasView?.getCurrentCanvasId()) throw error; }
  const owner = projectId || canvasView?.getCurrentCanvasId();
  if (!owner) throw new Error('Specify the project containing this saved media reference.');
  return CANVASES.getAsset(owner, id);
}

async function saveAssetDownload(asset) {
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'video/webm': 'webm', 'video/mp4': 'mp4' })[asset.mimeType];
  if (!extension) throw new Error('This media format cannot be downloaded.');
  const name = String(asset.name || asset.id || 'Easel media').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\.[A-Za-z0-9]{1,8}$/, '').slice(0, 100) || 'Easel media';
  const selected = await dialog.showSaveDialog(mainWindow, { defaultPath: `${name}.${extension}`, filters: [{ name: 'Media', extensions: [extension] }] });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  fs.writeFileSync(selected.filePath, Buffer.from(asset.data, 'base64'));
  return { canceled: false, fileName: path.basename(selected.filePath) };
}

async function projectMedia(projectId, assetId) {
  const asset = await CANVASES.getAsset(projectId, assetId);
  if (/^(video|audio)\//.test(asset.mimeType)) {
    try { Object.assign(asset, await CAPTURE_MEDIA.getMetadata(asset.id)); } catch {}
  }
  return asset;
}

async function saveCanvasBeforeSwitch(controller) {
  if (controller.getCurrentCanvasId()) await controller.saveCurrent();
}

async function checkpointCanvasForUndo(controller) {
  const canvasId = controller.getCurrentCanvasId();
  if (!canvasId) return '';
  await controller.saveCurrent();
  CANVAS_HISTORY.record(canvasId, CANVASES.get(canvasId).html);
  return canvasId;
}

const LITELLM_MODELS = createLiteLLMModelService({ settingsStore: SETTINGS });
let CHAT;
let TOOL_HOST;
let MCP_SERVER;
let suppressControlEvents = false;
let codexRuntimeError = '';
let refreshingCodex;
const CHAT_STORE = createChatStore({ userDataPath: app.getPath('userData') });
const registerTrackedMediaJob = async (input) => {
    const settings = SETTINGS.loadPublic();
    const connection = settings.connections.find((entry) => input.modelId?.startsWith(entry.id + ':'));
    if (!connection) throw new Error(`Job ${input.job.id} was accepted, but its endpoint could not be saved. Keep its ID; do not generate a replacement.`);
    let projectId = input.projectId;
    const projectDeleted = projectId && !CANVASES.list().some((project) => project.id === projectId);
    if (projectDeleted) projectId = '';
    else if (!projectId) {
      try { projectId = await withCanvas(async (controller) => (await controller.ensureProject({ kits: input.turnOptions?.kits })).id); }
      catch { /* An accepted job must remain retrievable even if its project cannot be created. */ }
    }
    try {
      const tracked = JOB_MONITOR.track({ ...input, origin: input.origin || { backend: 'builtin', ...(input.chatId ? { chatId: input.chatId } : {}) }, projectId, baseUrl: connection.baseUrl });
      if (projectDeleted) MEDIA_JOBS.update(tracked.id, { notification: 'interrupted' });
      return tracked;
    } catch (error) {
      throw new Error(`Job ${input.job.id} was accepted, but its receipt could not be saved: ${error.message}. Keep this remote ID to retrieve it; do not resubmit generation.`);
    }
  };
const presentToolCanvas = (artifact) => withCanvas(async (controller) => {
    await saveCanvasBeforeSwitch(controller);
    const id = controller.getCurrentCanvasId();
    const before = id ? CANVASES.get(id).html : '';
    try { return await controller.present(artifact); }
    finally { if (id && CANVASES.get(id).html !== before) CANVAS_HISTORY.record(id, before); }
  });
const CANVAS_CONTROLLER = {
    createEmpty: (title, kits) => withCanvas(async (controller) => {
      await saveCanvasBeforeSwitch(controller);
      const id = controller.getCurrentCanvasId();
      if (!id) return controller.createEmpty(title, kits);
      const before = CANVASES.get(id).html;
      const result = await controller.createDocument({ title, kits });
      CANVAS_HISTORY.record(id, before);
      return { ...result, undoAvailable: CANVAS_HISTORY.canUndo(id) };
    }),
    inspect: () => withCanvas((controller) => controller.inspect()),
    getCurrentCanvasId: () => requireCanvasView().getCurrentCanvasId(),
    getCurrentKits: () => {
      const id = canvasView?.getCurrentCanvasId();
      return id ? CANVASES.getProjectKits(id).kits : undefined;
    },
    getCurrentDocumentPath: () => requireCanvasView().getCurrentDocumentPath(),
    getDefaultDocumentPath: () => CANVASES.getProject(requireCanvasView().getCurrentCanvasId()).manifest.entry,
    listMediaJobs: () => ({ jobs: MEDIA_JOBS.list(), polling: 'The host polls and downloads pending jobs across restarts. Do not resubmit.' }),
    forgetMediaJob: ({ jobId }, context) => forgetMediaJob(jobId, context),
    listCanvasDocuments: () => withCanvas((controller) => controller.listCanvasDocuments()),
    openCanvasDocument: (args) => withCanvas(async (controller) => {
      const result = await controller.openCanvasDocument({ path: validateDocumentPath(args.path) });
      emitCanvasSaved(result);
      return result;
    }),
    createCanvasDocument: (args) => withCanvas(async (controller) => {
      const id = controller.getCurrentCanvasId();
      const before = id ? CANVASES.get(id).html : '';
      const result = await controller.createDocument(args);
      if (id) CANVAS_HISTORY.record(id, before);
      emitCanvasSaved(result);
      return result;
    }),
    attachGeneratedAssets: ({ projectId, assetIds, kits }) => withCanvas(async (controller) => {
      if (projectId && controller.getCurrentCanvasId() !== projectId) throw new Error('The active project changed while generating media. The media remains in the library.');
      return attachProjectAssets(controller, projectId, assetIds, { kits });
    }),
    requestCanvasInput: (args, context) => withCanvas(async (controller) => {
      const canvasId = controller.getCurrentCanvasId();
      if (!canvasId || !controller.getCurrentDocumentPath()) throw new Error('Open a project document before requesting input.');
      const request = CANVAS_INPUTS.create({ ...args, ...context, canvasId, documentPath: controller.getCurrentDocumentPath() });
      try { await controller.evaluate(renderCanvasInputScript(request)); }
      catch (error) { CANVAS_INPUTS.cancel(request.id, 'The input view could not be rendered.'); throw error; }
      mainWindow?.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'canvas-input', request, status: 'pending' });
      return request;
    }),
    getCanvasInputs: ({ canvasId, limit = 20 } = {}, context = {}) => {
      const chatId = context.chatId;
      if (!chatId) throw new Error('Canvas responses require an active agent conversation.');
      const entries = CANVAS_INPUTS.list({ chatId, ...(canvasId ? { canvasId } : {}), limit });
      const inputs = [];
      let bytes = 0;
      for (const entry of entries) {
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > 24_000) break;
        inputs.push(entry);
        bytes += size;
      }
      return { inputs, truncated: inputs.length < entries.length };
    },
    completeCanvasInput: (request) => withCanvas(async (controller) => {
      if (controller.getCurrentCanvasId() !== request.canvasId || (request.documentPath && controller.getCurrentDocumentPath() !== request.documentPath)) throw new Error('Open the original project document to complete this input.');
      await controller.evaluate(dismissCanvasInputScript(request.id));
      if (request.afterSubmit === 'resetState') await controller.reloadCanvas({ preserveState: false });
    }),
    dismissCanvasInput: (request) => withCanvas(async (controller) => {
      if (controller.getCurrentCanvasId() !== request.canvasId || (request.documentPath && controller.getCurrentDocumentPath() !== request.documentPath)) return;
      await controller.evaluate(dismissCanvasInputScript(request.id));
    }),
    isEmpty: () => withCanvas((controller) => controller.isEmpty()),
    getContract: () => ({ ...requireCanvasView().getContract(), hostAutoSavesRuntimeDom: false }),
    readMediaAsset: readMediaReference,
    listMediaAssets: async ({ scope = 'library', projectId, limit = 30 } = {}) => {
      if (!['library', 'project'].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Choose library/project scope and a limit from 1 to 100.');
      const assets = scope === 'project' ? CANVASES.listAssets(validateOpaqueId(projectId || requireCanvasView().getCurrentCanvasId(), 'Project ID')).assets : (await listStoredMedia()).filter((asset) => asset.kind !== 'job');
      return { scope, assets: assets.slice(0, limit).map(({ id, name, mimeType, bytes, width, height, duration, codec, projectId: owner }) => ({ assetId: id, name, mimeType, bytes, width, height, duration, codec, ...(owner ? { projectId: owner } : {}) })), truncated: assets.length > limit };
    },
    adoptCanvasDom: (options) => projectMutation('adoptCanvasDom', options),
    getCanvasSource: (options) => withCanvas((controller) => controller.getCanvasSource(options)),
    validateCanvas: (options) => withCanvas((controller) => controller.validateCanvas(options)),
    captureLiveCanvas: (options, context) => withCanvas((controller) => controller.captureLiveCanvas(options, context)),
    recordCanvasVideo: (options, context) => withCanvas((controller) => controller.recordCanvasVideo(options, context)),
    getVideoFrames: ({ assetId, maxFrames } = {}) => CAPTURE_MEDIA.getFrames(validateOpaqueId(assetId, 'Video asset ID'), { maxFrames }),
    deleteCanvasFile: (args, context) => withCanvas((controller) => DELETIONS.deleteProjectFile(controller, validateOpaqueId(controller.getCurrentCanvasId(), 'Project ID'), validateFileDeletion(args), { ...context, preview: true })),
    deleteMediaAsset: (args, context) => withCanvas((controller) => {
      const scope = args.scope || 'project';
      const projectId = scope === 'project' ? validateOpaqueId(args.projectId || controller.getCurrentCanvasId(), 'Project ID') : undefined;
      const assetId = scope === 'library' ? validateOpaqueId(args.assetId, 'Asset ID') : validateProjectAssetId(args.assetId);
      return DELETIONS.deleteMedia(controller, { projectId, assetId, scope }, { ...context, preview: true });
    }),
    reloadCanvas: (options) => withCanvas((controller) => controller.reloadCanvas(options)),
    listCanvasFiles: (options) => withCanvas((controller) => controller.listCanvasFiles(options)),
    readCanvasFile: (options) => withCanvas((controller) => controller.readCanvasFile(options)),
    getCanvasState: (options) => withCanvas((controller) => controller.getCanvasState(options)),
    ...Object.fromEntries(['writeCanvasFile', 'patchCanvasFile', 'applyCanvasFilePatches', 'updateCanvasProject', 'attachCanvasAsset', 'attachCanvasAssets', 'setCanvasState'].map((method) => [method, (options) => projectMutation(method, options)])),
    applyCanvasPatch: (options) => withCanvas(async (controller) => {
      const canvasId = controller.getCurrentCanvasId();
      const before = canvasId ? CANVASES.get(canvasId).html : '';
      try {
        return await controller.applyCanvasPatch(options);
      } finally {
        if (canvasId && CANVASES.get(canvasId).html !== before) {
          CANVAS_HISTORY.record(canvasId, before);
          emitCanvasSaved(CANVASES.get(canvasId));
        }
      }
    }),
    execute: (code) => withCanvas(async (controller) => {
      return controller.execute(code);
    }),
    addImage: (options) => projectMutation('addImage', options),
  };
const emitAgentEvent = (event) => {
    if (event.type === 'control-settled') { emitControlState(); return; }
    if (['canvas', 'project-assets', 'project-deleted'].includes(event.type)) recordControlChange(event);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
  };
const CONTROL_EVENTS = createControlEventStore({ userDataPath: app.getPath('userData') });
function publishControlEvent(event) {
  const stored = CONTROL_EVENTS.append(event);
  MCP_SERVER?.publishEvent(stored);
  return stored;
}
function recordControlChange(event) {
  try { publishControlEvent(event); }
  catch { emitAgentEvent({ type: 'error', message: 'The change is saved, but its external agent notification could not be saved. Inspect the project before continuing.' }); }
}
const AGENT_CONTROL = createAgentControl({
  userDataPath: app.getPath('userData'),
  isAgentBusy: () => Boolean(CHAT?.isRunning() || TOOL_HOST?.isBusy()),
  onChanged: () => { if (!suppressControlEvents) emitControlState(); },
});
const BUILTIN_CHAT = createChatService({
  settingsStore: SETTINGS,
  assetStore: ASSETS,
  chatStore: CHAT_STORE.forBackend('builtin'),
  inputStore: CANVAS_INPUTS,
  mediaJobStore: MEDIA_JOBS,
  registerMediaJob: registerTrackedMediaJob,
  mediaAssetStore: MEDIA_ASSETS,
  runtime: { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath },
  presentCanvas: presentToolCanvas,
  canvasController: CANVAS_CONTROLLER,
  onEvent: emitAgentEvent,
});

const CODEX_CWD = path.join(app.getPath('userData'), 'codex-workspace');
fs.mkdirSync(CODEX_CWD, { recursive: true, mode: 0o700 });
const CODEX_SERVER = createCodexAppServer({ cwd: CODEX_CWD,
  getMcpConnection: () => AGENT_CONTROL.getBackend() === 'codex' ? MCP_SERVER?.getConnectionInfo() : undefined,
});
const CODEX_CHAT = createCodexChatService({
  appServer: CODEX_SERVER, cwd: CODEX_CWD, chatStore: CHAT_STORE.forBackend('codex'),
  getContext: (options) => {
    const projectKits = CANVAS_CONTROLLER.getCurrentKits() || options.kits || [];
    const skills = options.skills || [];
    const model = CODEX_CHAT.getState().model;
    if (!model) throw new Error('Choose an available Codex model in chat before sending.');
    return { model, kits: projectKits, origin: { model, projectId: canvasView?.getCurrentCanvasId() || '' },
      instructions: [TOOL_HOST.instructions, `Enabled offline kits: ${projectKits.join(', ') || 'none'}.`,
        ...skills.map((skill) => `Skill: ${skill.name}\n${skill.instructions}`)].join('\n\n') };
  },
  hydrateChat: hydrateCodexChat,
  getImageGenerationContext: () => ({ origin: { projectId: canvasView?.getCurrentCanvasId() || '' }, kits: CANVAS_CONTROLLER.getCurrentKits() || [] }),
  importGeneratedImage: async ({ item, origin, kits }) => {
    const image = decodeCodexImage(item, { cwd: CODEX_CWD });
    if (nativeImage.createFromBuffer(Buffer.from(image.data, 'base64')).isEmpty()) throw new Error('Codex returned an image that could not be decoded.');
    const events = [];
    const output = JSON.parse(await handleMcpResult({ content: [{ type: 'image', ...image }] }, MEDIA_ASSETS, (event) => events.push(event), {
      generated: true, projectId: origin.projectId || '', kits, attachGeneratedAssets: CANVAS_CONTROLLER.attachGeneratedAssets,
    }));
    return { output, events };
  },
  prepareInput: async ({ text, attachments, options }) => {
    const input = defaultInput({ text, attachments });
    if (!options.attachmentRefs?.length && attachments.length) {
      options.attachmentRefs = await Promise.all(attachments.map(async (attachment) => {
        const assetId = await (attachment.type === 'image' ? ASSETS : CAPTURE_MEDIA).save(attachment);
        return { assetId, type: attachment.type, name: attachment.name, mimeType: attachment.mimeType };
      }));
    }
    return input;
  },
  onServerRequest: async ({ method, params, signal }) => {
    if (method === 'item/mcpToolCall/requestApproval' && params.server === 'easel') {
      const approval = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Codex tool request',
        message: `Allow Codex to use ${String(params.tool || 'an Easel tool').slice(0, 120)}?`,
        buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, ...(signal ? { signal } : {}) });
      return { decision: approval.response === 0 ? 'accept' : 'decline' };
    }
    throw new Error('Easel supports canvas MCP tools. Native command, file, and network approval requests are unavailable.');
  },
  onEvent: (event) => {
    if (event.type === 'codex-state') emitControlState();
    else if (event.type === 'codex-login-completed') {
      if (event.success) refreshCodexState().catch(() => {});
      emitControlState();
    } else emitAgentEvent(event);
  },
});
TOOL_HOST = createEaselToolHost({
  canvasController: CANVAS_CONTROLLER, presentCanvas: presentToolCanvas,
  assetStore: ASSETS, mediaAssetStore: MEDIA_ASSETS,
  createMediaClient: (signal) => {
    const settings = SETTINGS.loadPublic();
    const secrets = SETTINGS.loadSecrets(settings.activeConnectionId);
    secrets.connectionKeys = Object.fromEntries(settings.connections.filter((connection) => settings.models.some((model) => model.connectionId === connection.id && model.enabled && model.roles.includes('media')))
      .map((connection) => [connection.id, SETTINGS.loadSecrets(connection.id).litellmApiKey]));
    return createMediaMcpClient({ ...defaultMcpLaunchOptions(settings, secrets, { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }), signal });
  },
  getKits: () => CANVAS_CONTROLLER.getCurrentKits() || (CANVAS_KIT_BUNDLES.tone ? ['tone'] : []),
  getOrigin: () => CHAT.getToolOrigin(),
  beforeTool: () => AGENT_CONTROL.getBackend() === 'codex' ? CODEX_CHAT.waitForMediaImports() : undefined,
  registerMediaJob: registerTrackedMediaJob, control: AGENT_CONTROL,
  eventStore: { read: (...args) => CONTROL_EVENTS.read(...args) },
  onEvent: emitAgentEvent,
  onWaiting: ({ request, origin }) => { if (origin.backend === 'codex') CODEX_CHAT.pauseForCanvasInput(request); },
  workspace: {
    list: () => ({ projects: CANVASES.list(), currentProjectId: canvasView?.getCurrentCanvasId() || '' }),
    open: ({ projectId, documentPath }, { signal }) => withCanvas(async (controller) => {
      signal?.throwIfAborted();
      await saveCanvasBeforeSwitch(controller);
      const result = await controller.openSaved(validateOpaqueId(projectId, 'Project ID'), documentPath ? validateDocumentPath(documentPath) : undefined);
      emitCanvasSaved(result);
      publishControlEvent({ type: 'project-opened', projectId, documentPath: result.documentPath, title: result.title });
      return { ok: true, projectId, title: result.title, documentPath: result.documentPath };
    }),
    create: ({ title, kits }, { signal }) => withCanvas(async (controller) => {
      signal?.throwIfAborted();
      if (kits) assertInstalledKits(kits, CANVAS_KIT_BUNDLES);
      await saveCanvasBeforeSwitch(controller);
      const created = CANVASES.createProject({ title: validateCanvasTitle(title), kits });
      const result = await controller.openSaved(created.id);
      emitCanvasSaved(result);
      publishControlEvent({ type: 'project-created', projectId: result.id, title: result.title, documentPath: result.documentPath });
      return { ok: true, projectId: result.id, title: result.title, documentPath: result.documentPath };
    }),
    delete: ({ projectId }, context) => withCanvas((controller) => DELETIONS.deleteProject(controller, validateOpaqueId(projectId, 'Project ID'), {}, context)),
  },
});
function createControlServer() {
  return createControlMcpServer({ userDataPath: app.getPath('userData'), toolHost: TOOL_HOST,
    control: AGENT_CONTROL, getEventCursor: CONTROL_EVENTS.getCursor, onEvent: () => emitControlState() });
}
MCP_SERVER = createControlServer();
CHAT = createAgentRouter({ builtin: BUILTIN_CHAT, codex: CODEX_CHAT, control: AGENT_CONTROL,
  chatStore: CHAT_STORE, inputStore: CANVAS_INPUTS, mediaJobStore: MEDIA_JOBS, mediaAssetStore: MEDIA_ASSETS,
  canvasController: CANVAS_CONTROLLER, eventStore: { append: publishControlEvent }, onEvent: emitAgentEvent,
  disconnectControllers: (reason) => MCP_SERVER.disconnectAll(reason),
  shutdownTools: async () => { await TOOL_HOST.shutdown(); await MCP_SERVER.close(); },
  resumeTools: async () => {
    TOOL_HOST.cancelShutdown();
    if (!MCP_SERVER.getConnectionInfo().url) {
      MCP_SERVER = createControlServer();
      await MCP_SERVER.start();
    }
  },
  onBackendChanged: async (reason) => {
    if (AGENT_CONTROL.getBackend() === 'codex' && reason) {
      suppressControlEvents = true;
      try { await refreshCodexState(); }
      finally { suppressControlEvents = false; }
    }
    emitControlState(reason);
  },
});

function publicControlState() {
  const connection = MCP_SERVER?.getConnectionInfo() || {};
  const codex = CODEX_CHAT.getState();
  let available = false;
  try { resolveCodexExecutable(); available = true; } catch {}
  return { backend: AGENT_CONTROL.getBackend(), busy: AGENT_CONTROL.getState().busy,
    external: { url: connection.url || '', enabled: Boolean(connection.url && AGENT_CONTROL.canConnect()), connectedClients: connection.connectedClients?.length || 0 },
    codex: { available, connected: codex.connected === true, authenticated: codex.authenticated,
      accountLabel: codex.account?.email || codex.account?.planType || (codex.account ? 'Codex account' : ''),
      model: codex.model,
      models: codex.models.map((model) => ({ id: model.model || model.id, displayName: model.displayName || model.model || model.id })),
      login: codex.login, error: codexRuntimeError || codex.error || '' } };
}
function emitControlState(reason) {
  if (suppressControlEvents || CHAT?.isSwitching()) return;
  emitAgentEvent({ type: 'agent-control', state: publicControlState(), ...(reason ? { reason } : {}) });
}
async function refreshCodexState() {
  if (refreshingCodex) return refreshingCodex;
  refreshingCodex = (async () => {
    try {
      await CODEX_CHAT.readAccount();
      await CODEX_CHAT.listModels();
      const model = AGENT_CONTROL.getCodexModel();
      if (model && CODEX_CHAT.getState().models.some((entry) => (entry.model || entry.id) === model)) CODEX_CHAT.selectModel(model);
      codexRuntimeError = '';
    } catch (error) { codexRuntimeError = error.message; }
    finally { emitControlState(); }
    return publicControlState();
  })().finally(() => { refreshingCodex = undefined; });
  return refreshingCodex;
}

async function hydrateCodexChat(snapshot) {
  const references = new Map();
  for (const message of snapshot.history) {
    for (const asset of message.canvasMediaRefs || []) references.set(asset.assetId, { ...asset, requestId: message.canvasInputRequestId, input: true });
    for (const asset of message.mediaJobResult?.assets || []) if (!references.has(asset.assetId)) references.set(asset.assetId, asset);
    if (message.role !== 'tool') continue;
    try {
      const output = JSON.parse(message.content);
      const values = [output, output.structuredContent, ...(output.content || []).filter((block) => block.type === 'text').map((block) => { try { return JSON.parse(block.text); } catch { return null; } })];
      for (const value of values.filter(Boolean)) for (const asset of [...(value.assets || []), ...(value.assetId ? [{ assetId: value.assetId }] : [])]) if (!references.has(asset.assetId)) references.set(asset.assetId, asset);
    } catch {}
  }
  let bytes = 0;
  for (const [assetId, reference] of [...references].slice(-20)) {
    try {
      const metadata = await MEDIA_ASSETS.getMetadata(assetId);
      if (/^(video|audio)\//.test(metadata?.mimeType)) snapshot.media.push({ ...reference, ...metadata, assetId });
      else {
        const asset = await MEDIA_ASSETS.get(assetId);
        const size = Buffer.byteLength(asset.data, 'base64');
        if (bytes + size > 64 * 1024 * 1024) continue;
        bytes += size;
        if (reference.input) snapshot.media.push({ ...reference, ...asset, assetId });
        else snapshot.images.push({ ...reference, ...asset, assetId });
      }
    } catch {}
  }
  return snapshot;
}

async function refreshMediaTools(action) {
  try { return await action(); }
  finally { TOOL_HOST.invalidateTools(); }
}

const VIDEO_METADATA = createVideoMetadataService({
  BrowserWindow,
  sessionFactory: async (partition) => ({ partition, session: session.fromPartition(partition, { cache: false }) }),
  mediaStore: CAPTURE_MEDIA,
  onChanged: async (assets) => {
    const previews = await Promise.all(assets.map(async (asset) => {
      try { return { ...asset, ...await CAPTURE_MEDIA.getMetadata(asset.assetId) }; }
      catch { return asset; }
    }));
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'media-metadata', assets: previews });
  },
});
const JOB_MONITOR = createMediaJobMonitor({
  store: MEDIA_JOBS, settingsStore: SETTINGS, mediaAssetStore: MEDIA_ASSETS,
  enrichAssets: VIDEO_METADATA.enrichAssets,
  runtime: { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, userDataPath: app.getPath('userData') },
  attachAssets: (projectId, assetIds) => withCanvas((controller) => {
    if (!CANVASES.list().some((project) => project.id === projectId)) return { projectDeleted: true };
    return attachProjectAssets(controller, projectId, assetIds);
  }),
  onEvent: (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, event); },
  onReady: (job) => CHAT.notifyMediaJob(job),
});

function registerIpcHandlers() {
  const canvasHandle = (channel, handler) => ipcMain.handle(channel, (...args) => withCanvas(() => handler(...args)));
  function requireCanvasSender(event) {
    const controller = requireCanvasView();
    const contract = controller.getContract();
    if (event.sender !== controller.view.webContents || event.senderFrame !== controller.view.webContents.mainFrame || !controller.getCurrentCanvasId() || contract.loading || contract.previewHidden || event.senderFrame.url !== contract.url) throw new Error('Canvas bridge request was rejected.');
    return controller;
  }
  ipcMain.handle(IPC_CHANNELS.GET_AGENT_CONTROL, async (event) => {
    assertTrustedSender(event, mainWindow);
    if (AGENT_CONTROL.getBackend() === 'codex' && !CHAT.isBusy()) await refreshCodexState();
    return publicControlState();
  });
  ipcMain.handle(IPC_CHANNELS.SET_AGENT_BACKEND, async (event, backend) => {
    assertTrustedSender(event, mainWindow);
    if (!['builtin', 'external', 'codex'].includes(backend)) throw new Error('Choose Built-in, External MCP, or Codex.');
    await CHAT.setBackend(backend);
    return publicControlState();
  });
  ipcMain.handle(IPC_CHANNELS.GET_MCP_CONNECTION, (event) => {
    assertTrustedSender(event, mainWindow);
    if (AGENT_CONTROL.getBackend() !== 'external') throw new Error('Select External MCP to reveal its connection token.');
    const { url, bearerToken } = MCP_SERVER.getConnectionInfo();
    return { url, bearerToken, enabled: AGENT_CONTROL.canConnect() };
  });
  ipcMain.handle(IPC_CHANNELS.CODEX_LOGIN, async (event, input = {}) => {
    assertTrustedSender(event, mainWindow);
    AGENT_CONTROL.assertIdle();
    if (AGENT_CONTROL.getBackend() !== 'codex') throw new Error('Select Codex before signing in.');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'type') || !['chatgpt', 'chatgptDeviceCode'].includes(input.type)) throw new Error('Choose browser or device sign-in.');
    const login = await CODEX_CHAT.startLogin(input.type);
    if (input.type === 'chatgpt' && login.authUrl) {
      const url = new URL(login.authUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Codex returned an unsupported sign-in address.');
      await shell.openExternal(url.href);
    }
    return publicControlState();
  });
  ipcMain.handle(IPC_CHANNELS.CODEX_CANCEL_LOGIN, async (event, loginId) => {
    assertTrustedSender(event, mainWindow);
    if (AGENT_CONTROL.getBackend() !== 'codex' || typeof loginId !== 'string' || loginId !== CODEX_CHAT.getState().login?.loginId) throw new Error('This Codex sign-in is no longer pending.');
    await CODEX_CHAT.cancelLogin(loginId);
    return publicControlState();
  });
  ipcMain.handle(IPC_CHANNELS.CODEX_LOGOUT, async (event) => {
    assertTrustedSender(event, mainWindow);
    AGENT_CONTROL.assertIdle();
    if (AGENT_CONTROL.getBackend() !== 'codex') throw new Error('Select Codex before signing out.');
    await CODEX_CHAT.logout();
    return publicControlState();
  });
  ipcMain.handle(IPC_CHANNELS.SELECT_CODEX_MODEL, (event, model) => {
    assertTrustedSender(event, mainWindow);
    AGENT_CONTROL.assertIdle();
    if (AGENT_CONTROL.getBackend() !== 'codex') throw new Error('Select Codex before choosing its model.');
    CODEX_CHAT.selectModel(model);
    AGENT_CONTROL.selectCodexModel(model);
    emitControlState();
    return publicControlState();
  });
  ipcMain.handle('canvas:submit-input', (event, input) => {
    const controller = requireCanvasSender(event);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['requestId', 'value'].includes(key))) throw new Error('Canvas input is invalid.');
    return CHAT.submitCanvasInput({ ...input, canvasId: controller.getCurrentCanvasId(), documentPath: controller.getCurrentDocumentPath() });
  });
  ipcMain.handle('canvas:cancel-input', (event, input) => {
    const controller = requireCanvasSender(event);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'requestId')) throw new Error('Canvas input cancellation is invalid.');
    return CHAT.cancelCanvasInput({ requestId: input.requestId, canvasId: controller.getCurrentCanvasId(), documentPath: controller.getCurrentDocumentPath() });
  });
  ipcMain.handle('canvas:submit-media', async (event, input) => {
    const controller = requireCanvasSender(event);
    const canvasId = controller.getCurrentCanvasId();
    const generation = controller.getContract().runtimeGeneration;
    const chatId = CHAT.getActiveChatId();
    const backend = AGENT_CONTROL.getBackend();
    const destination = () => {
      if (AGENT_CONTROL.getBackend() === 'codex') return { backend: 'codex', model: CODEX_CHAT.getState().model || AGENT_CONTROL.getCodexModel() };
      if (AGENT_CONTROL.getBackend() === 'external') return { backend: 'external' };
      const settings = SETTINGS.loadPublic();
      return { connectionId: settings.activeConnectionId, model: settings.litellmModel, baseUrl: settings.litellmBaseUrl };
    };
    const selected = destination();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['media', 'prompt'].includes(key))) throw new Error('Canvas media input is invalid.');
    if (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > 20_000)) throw new Error('Canvas media prompt is invalid.');
    const media = validateChatOptions({ attachments: [input.media] }).attachments[0];
    if (!['image', 'audio'].includes(media.type)) throw new Error('Share a photo or audio recording.');
    if (backend === 'codex' && media.type === 'audio') throw new Error('Embedded Codex supports image captures. Choose an Agent model with audio input to share this recording.');
    if (backend !== 'external' && !selected.model) throw new Error('Choose an Agent model in chat before sharing a capture.');
    const destinationLabel = backend === 'external' ? AGENT_CONTROL.getState().controller?.name || 'your external agent' : selected.model;
    const consent = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Share capture with agent', message: `Send ${media.name} to ${destinationLabel}?`, detail: backend === 'external'
      ? 'The capture will be saved locally and made available to the connected controller through Easel MCP.'
      : backend === 'codex' ? 'The capture will be saved locally and sent through the signed-in Codex account.' : 'The capture will be saved locally and sent to your configured model endpoint.',
      buttons: ['Share capture', 'Cancel'], defaultId: 1, cancelId: 1 });
    if (consent.response !== 0) return { ok: false, cancelled: true, error: 'Capture was not shared.' };
    if (controller.getCurrentCanvasId() !== canvasId || controller.getContract().runtimeGeneration !== generation) throw new Error('The canvas changed before this capture could be shared.');
    if (AGENT_CONTROL.getBackend() !== backend || JSON.stringify(destination()) !== JSON.stringify(selected)) throw new Error('The selected controller or model changed. Share the capture again with the intended model.');
    const assetId = await (media.type === 'image' ? ASSETS : CAPTURE_MEDIA).save(media);
    if (controller.getCurrentCanvasId() !== canvasId || controller.getContract().runtimeGeneration !== generation) throw new Error('The canvas changed before this capture could be shared.');
    if (AGENT_CONTROL.getBackend() !== backend || JSON.stringify(destination()) !== JSON.stringify(selected) || CHAT.getActiveChatId() !== chatId) throw new Error('The selected conversation, controller or model changed while saving. The capture is saved locally; share it again to confirm its destination.');
    return CHAT.submitCanvasMedia({ canvasId, documentPath: controller.getCurrentDocumentPath(), chatId, attachments: [{ assetId, type: media.type, mimeType: media.mimeType, name: media.name }], prompt: input.prompt || '', approvedModel: selected });
  });
  ipcMain.handle(IPC_CHANNELS.LIST_CANVAS_FILES, (event, id) => {
    assertTrustedSender(event, mainWindow);
    return CANVASES.listFiles(validateOpaqueId(id, 'Canvas ID'));
  });
  ipcMain.handle(IPC_CHANNELS.READ_CANVAS_FILE, (event, id, input) => {
    assertTrustedSender(event, mainWindow);
    return CANVASES.readFile(validateOpaqueId(id, 'Canvas ID'), input);
  });
  canvasHandle(IPC_CHANNELS.CREATE_PROJECT, async (event, input) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Wait for the current reply before creating another project.');
    const options = validateProjectInput(input);
    const controller = requireCanvasView();
    await saveCanvasBeforeSwitch(controller);
    if (options.kits) assertInstalledKits(options.kits, CANVAS_KIT_BUNDLES);
    const created = await controller.createEmpty(options.title, options.kits);
    emitCanvasSaved(created);
    return { ...created, undoAvailable: false };
  });
  canvasHandle(IPC_CHANNELS.RENAME_PROJECT, async (event, id, input) => {
    assertTrustedSender(event, mainWindow);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'title')) throw new Error('Project name is invalid.');
    const projectId = validateOpaqueId(id, 'Project ID');
    const before = CANVASES.get(projectId).html;
    const result = CANVASES.renameProject(projectId, { title: validateCanvasTitle(input.title) });
    CANVAS_HISTORY.record(projectId, before);
    if (requireCanvasView().getCurrentCanvasId() === projectId) emitCanvasSaved(result);
    return { ...result, projectId, projectTitle: result.title };
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_PROJECT, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const projectId = validateOpaqueId(id, 'Project ID');
    const artifact = await withCanvas(() => CANVASES.exportProject(projectId));
    const selected = await dialog.showSaveDialog(mainWindow, { defaultPath: artifact.fileName, filters: [{ name: 'ZIP project', extensions: ['zip'] }] });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    fs.writeFileSync(selected.filePath, artifact.data);
    return { canceled: false, fileName: path.basename(selected.filePath), bytes: artifact.bytes };
  });
  ipcMain.handle(IPC_CHANNELS.LIST_PROJECT_DOCUMENTS, (event, id) => {
    assertTrustedSender(event, mainWindow);
    const result = CANVASES.listDocuments(validateOpaqueId(id, 'Project ID'));
    return { ...result, projectId: result.id, projectTitle: result.title };
  });
  ipcMain.handle(IPC_CHANNELS.GET_AVAILABLE_KITS, (event) => {
    assertTrustedSender(event, mainWindow);
    return availableCanvasKits(CANVAS_KIT_BUNDLES);
  });
  ipcMain.handle(IPC_CHANNELS.GET_PROJECT_KITS, (event, id) => {
    assertTrustedSender(event, mainWindow);
    return CANVASES.getProjectKits(validateOpaqueId(id, 'Project ID'));
  });
  canvasHandle(IPC_CHANNELS.UPDATE_PROJECT_KITS, async (event, id, input) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Stop the agent or wait for its reply before changing project kits.');
    const projectId = validateOpaqueId(id, 'Project ID');
    const options = validateProjectKits(input);
    const previousKits = CANVASES.getProjectKits(projectId).kits;
    assertInstalledKits(options.kits.filter((kit) => !previousKits.includes(kit)), CANVAS_KIT_BUNDLES);
    const result = await requireCanvasView().updateProjectKits(projectId, options);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'project-kits', ...result });
    if (requireCanvasView().getCurrentCanvasId() === projectId) emitCanvasSaved(CANVASES.get(projectId));
    return result;
  });
  canvasHandle(IPC_CHANNELS.CREATE_PROJECT_DOCUMENT, async (event, id, input) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Wait for the current reply before creating another document.');
    const projectId = validateOpaqueId(id, 'Project ID');
    const options = validateProjectInput(input, { document: true });
    const before = CANVASES.get(projectId).html;
    const saved = await CANVASES.createDocument(projectId, options);
    CANVAS_HISTORY.record(projectId, before);
    const opened = await requireCanvasView().openSaved(projectId, saved.documentPath);
    emitCanvasSaved(opened);
    return { ...saved, ...opened, undoAvailable: CANVAS_HISTORY.canUndo(projectId) };
  });
  canvasHandle(IPC_CHANNELS.OPEN_PROJECT_DOCUMENT, async (event, id, documentPath) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Wait for the current reply before switching documents.');
    const projectId = validateOpaqueId(id, 'Project ID');
    const opened = await requireCanvasView().openSaved(projectId, validateDocumentPath(documentPath));
    return { ...opened, undoAvailable: CANVAS_HISTORY.canUndo(projectId) };
  });
  ipcMain.handle(IPC_CHANNELS.GET_PROJECT_ASSETS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const projectId = validateOpaqueId(id, 'Project ID');
    const result = CANVASES.listAssets(projectId);
    const assets = await Promise.all(result.assets.map(async (asset) => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) {
        let metadata = {};
        if (asset.id.length === 32) {
          try { metadata = await CAPTURE_MEDIA.getMetadata(asset.id); }
          catch { /* A project can contain imported media without capture metadata. */ }
        }
        return { ...asset, ...metadata, thumbnail: metadata.thumbnail || '' };
      }
      const preview = await CANVASES.getAsset(projectId, asset.id, { thumbnail: true });
      return { ...asset, thumbnail: preview.thumbnail || '' };
    }));
    return { ...result, projectId, projectTitle: result.title, assets: [...jobCards(projectId), ...assets] };
  });
  ipcMain.handle(IPC_CHANNELS.GET_PROJECT_ASSET, async (event, id, assetId) => {
    assertTrustedSender(event, mainWindow);
    return publicAsset(await projectMedia(validateOpaqueId(id, 'Project ID'), validateProjectAssetId(assetId)));
  });
  ipcMain.handle(IPC_CHANNELS.GET_LIBRARY_ASSET, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    return publicAsset(await MEDIA_ASSETS.get(validateProjectAssetId(id)));
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_LIBRARY_ASSET, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    return saveAssetDownload(await MEDIA_ASSETS.get(validateProjectAssetId(id)));
  });
  canvasHandle(IPC_CHANNELS.ATTACH_PROJECT_ASSET, async (event, id, assetId) => {
    assertTrustedSender(event, mainWindow);
    const projectId = id ? validateOpaqueId(id, 'Project ID') : '';
    return attachProjectAssets(requireCanvasView(), projectId, [validateProjectAssetId(assetId)]);
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_PROJECT_ASSET, async (event, id, assetId) => {
    assertTrustedSender(event, mainWindow);
    const asset = await projectMedia(validateOpaqueId(id, 'Project ID'), validateProjectAssetId(assetId));
    return saveAssetDownload(asset);
  });
  ipcMain.handle(IPC_CHANNELS.HIDE_CANVAS_PREVIEW, async (event) => {
    assertTrustedSender(event, mainWindow);
    // Recording owns the canvas queue, so cancel it before queueing a view switch.
    await requireCanvasView().cancelCanvasRecording('The canvas preview was hidden.');
    return withCanvas((controller) => controller.hide());
  });
  canvasHandle(IPC_CHANNELS.DELETE_PROJECT_FILE, (event, id, input) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Stop the agent or wait for its reply before deleting a file.');
    return DELETIONS.deleteProjectFile(requireCanvasView(), validateOpaqueId(id, 'Project ID'), validateFileDeletion(input));
  });
  canvasHandle(IPC_CHANNELS.DELETE_PROJECT, (event, id) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Stop the agent or wait for its reply before deleting a project.');
    return DELETIONS.deleteProject(requireCanvasView(), validateOpaqueId(id, 'Project ID'));
  });
  canvasHandle(IPC_CHANNELS.DELETE_PROJECT_ASSET, (event, id, assetId) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Stop the agent or wait for its reply before removing media.');
    return DELETIONS.deleteMedia(requireCanvasView(), { projectId: validateOpaqueId(id, 'Project ID'), assetId: validateProjectAssetId(assetId), scope: 'project' });
  });
  canvasHandle(IPC_CHANNELS.DELETE_LIBRARY_ASSET, (event, assetId) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Stop the agent or wait for its reply before deleting media.');
    return DELETIONS.deleteMedia(requireCanvasView(), { assetId: validateProjectAssetId(assetId), scope: 'library' });
  });
  ipcMain.handle(IPC_CHANNELS.LIST_CANVAS_INPUTS, (event) => {
    assertTrustedSender(event, mainWindow);
    return CHAT.getCanvasInputs({ limit: 50 });
  });
  ipcMain.handle(IPC_CHANNELS.RETRY_CANVAS_INPUT, (event, id) => {
    assertTrustedSender(event, mainWindow);
    return CHAT.retryCanvasInput(validateOpaqueId(id, 'Input request ID'));
  });
  canvasHandle(IPC_CHANNELS.CLOSE_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Wait for the current reply before closing the canvas.');
    const controller = requireCanvasView();
    if (controller.getCurrentCanvasId() !== validateOpaqueId(id, 'Canvas ID')) return { closed: false };
    return controller.closeCurrent();
  });
  ipcMain.handle(IPC_CHANNELS.MANAGE_CANVAS_DEVICES, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const controller = requireCanvasView();
    const canvasId = validateOpaqueId(id, 'Canvas ID');
    if (controller.getCurrentCanvasId() !== canvasId) throw new Error('Open this canvas to manage its devices.');
    const permissions = controller.getMediaAccess();
    const generation = controller.getContract().runtimeGeneration;
    const actions = [];
    if (!permissions.microphone) actions.push({ label: 'Allow microphone', type: 'audio' });
    if (!permissions.camera) actions.push({ label: 'Allow camera', type: 'video' });
    if (permissions.camera || permissions.microphone) actions.push({ label: 'Revoke access', revoke: true });
    actions.push({ label: 'Done' });
    const choice = await dialog.showMessageBox(mainWindow, {
      title: 'Canvas devices', message: CANVASES.get(canvasId).title,
      detail: `Camera: ${permissions.camera ? 'allowed in Easel' : 'not allowed'}\nMicrophone: ${permissions.microphone ? 'allowed in Easel' : 'not allowed'}\n\nAllow a device here, then use the sketch's camera or recording control. Your computer may also ask for device access. Capture stays local until you choose to share it with chat.\n\nPlaying synthesized sound uses the sketch's Play button and does not need microphone access.`,
      buttons: actions.map((action) => action.label), cancelId: actions.length - 1, defaultId: actions.length - 1,
    });
    if (controller.getCurrentCanvasId() !== canvasId || controller.getContract().runtimeGeneration !== generation) throw new Error('The canvas changed. Open Devices again to change its permissions.');
    const action = actions[choice.response];
    if (action?.revoke) return controller.revokeMediaAccess();
    if (action?.type) return controller.allowMediaAccess([action.type]);
    return controller.getMediaAccess();
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, (event, input) => {
    assertTrustedSender(event, mainWindow);
    if (typeof input !== 'string' || input.length > 8192) throw new Error('Invalid link.');
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) links can be opened.');
    return shell.openExternal(url.href);
  });
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, (event) => {
    assertTrustedSender(event, mainWindow);
    return SETTINGS.loadPublic();
  });
  ipcMain.handle(IPC_CHANNELS.LIST_LITELLM_MODELS, (event) => {
    assertTrustedSender(event, mainWindow);
    return refreshMediaTools(() => LITELLM_MODELS.listModels());
  });
  ipcMain.handle(IPC_CHANNELS.TEST_LITELLM_CHAT, (event, model) => {
    assertTrustedSender(event, mainWindow);
    return LITELLM_MODELS.testChat(validateLiteLLMModelInput(model));
  });
  ipcMain.handle(IPC_CHANNELS.TEST_LITELLM_IMAGE, (event, model) => {
    assertTrustedSender(event, mainWindow);
    return LITELLM_MODELS.testImage(validateLiteLLMModelInput(model));
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_CONNECTION, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return refreshMediaTools(() => SETTINGS.saveConnection(input));
  });
  ipcMain.handle(IPC_CHANNELS.REMOVE_CONNECTION, (event, id) => {
    assertTrustedSender(event, mainWindow);
    return refreshMediaTools(() => SETTINGS.removeConnection(id));
  });
  ipcMain.handle(IPC_CHANNELS.SELECT_MODEL, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return SETTINGS.selectModel(input);
  });
  ipcMain.handle(IPC_CHANNELS.UPDATE_MODEL, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return refreshMediaTools(() => SETTINGS.updateModel(input));
  });
  ipcMain.handle(IPC_CHANNELS.CHECK_MODEL_CAPABILITIES, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return refreshMediaTools(() => LITELLM_MODELS.checkCapabilities(validateModelSelection(input)));
  });
  ipcMain.handle(IPC_CHANNELS.GET_MODEL_CATALOG, (event) => {
    assertTrustedSender(event, mainWindow);
    return LITELLM_MODELS.getCatalog();
  });
  ipcMain.handle(IPC_CHANNELS.LIST_INSTALLED_SKILLS, (event) => {
    assertTrustedSender(event, mainWindow);
    return readInstalledSkills(path.join(app.getAppPath(), '.agents', 'skills'), { availableKits: availableCanvasKits(CANVAS_KIT_BUNDLES) });
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_SETTINGS, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return refreshMediaTools(() => SETTINGS.save(validateSettingsInput(input)));
  });
  ipcMain.handle(IPC_CHANNELS.SEND_MESSAGE, async (event, input, options) => {
    assertTrustedSender(event, mainWindow);
    const chatOptions = validateChatOptions(options);
    if (chatOptions.skills.length) assertHarnessSkills(chatOptions.skills, readInstalledSkills(path.join(app.getAppPath(), '.agents', 'skills'), { availableKits: availableCanvasKits(CANVAS_KIT_BUNDLES) }));
    const message = typeof input === 'string' && input.trim() ? validateChatMessage(input) : '';
    if (!message && !chatOptions.attachments?.length) throw new Error('Message or attachment is required.');
    return CHAT.sendMessage(message, chatOptions);
  });
  ipcMain.handle(IPC_CHANNELS.STOP_AGENT, (event) => {
    assertTrustedSender(event, mainWindow);
    return CHAT.stopAgent();
  });
  ipcMain.handle(IPC_CHANNELS.CLEAR_CHAT, (event) => {
    assertTrustedSender(event, mainWindow);
    CHAT.clearHistory();
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.GET_CHAT, (event, options = {}) => {
    assertTrustedSender(event, mainWindow);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'deferResume') || options.deferResume !== undefined && typeof options.deferResume !== 'boolean') throw new Error('Chat restoration options are invalid.');
    const snapshot = CHAT.getCurrentChat(options);
    CHAT.recoverCanvasInputs();
    return snapshot;
  });
  ipcMain.handle(IPC_CHANNELS.ACKNOWLEDGE_CHAT, (event, id) => {
    assertTrustedSender(event, mainWindow);
    return CHAT.acknowledgeChat(id === '' ? '' : validateOpaqueId(id, 'Chat ID'));
  });
  ipcMain.handle(IPC_CHANNELS.LIST_CHATS, (event) => {
    assertTrustedSender(event, mainWindow);
    return CHAT.listChats();
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_CHAT, (event, id) => {
    assertTrustedSender(event, mainWindow);
    return CHAT.openChat(validateOpaqueId(id, 'Chat ID'));
  });
  ipcMain.handle(IPC_CHANNELS.LIST_ASSETS, (event) => {
    assertTrustedSender(event, mainWindow);
    return listStoredMedia();
  });
  ipcMain.handle(IPC_CHANNELS.LIST_MEDIA_JOBS, (event) => { assertTrustedSender(event, mainWindow); return MEDIA_JOBS.list(); });
  ipcMain.handle(IPC_CHANNELS.DELETE_MEDIA_JOB, (event, id) => { assertTrustedSender(event, mainWindow); return forgetMediaJob(id); });
  ipcMain.handle(IPC_CHANNELS.RETRY_MEDIA_JOB, (event, id) => { assertTrustedSender(event, mainWindow); return JOB_MONITOR.retry(validateOpaqueId(id, 'Media job ID')); });
  ipcMain.handle(IPC_CHANNELS.LIST_CANVASES, (event) => {
    assertTrustedSender(event, mainWindow);
    return CANVASES.list();
  });
  canvasHandle(IPC_CHANNELS.CREATE_CANVAS, async (event, title, kits) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Wait for the current reply before creating another canvas.');
    const canvasTitle = validateCanvasTitle(title);
    const selectedKits = validateCanvasKits(kits);
    const controller = requireCanvasView();
    await saveCanvasBeforeSwitch(controller);
    const canvas = await controller.createEmpty(canvasTitle, selectedKits);
    return { ...canvas, undoAvailable: CANVAS_HISTORY.canUndo(canvas.id) };
  });
  canvasHandle(IPC_CHANNELS.OPEN_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Wait for the current reply before switching canvases.');
    const canvasId = validateOpaqueId(id, 'Canvas ID');
    const controller = requireCanvasView();
    if (controller.getCurrentCanvasId() !== canvasId) await saveCanvasBeforeSwitch(controller);
    const canvas = await controller.openSaved(canvasId);
    return { ...canvas, undoAvailable: CANVAS_HISTORY.canUndo(canvasId) };
  });
  canvasHandle(IPC_CHANNELS.SAVE_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const canvasId = validateOpaqueId(id, 'Canvas ID');
    const controller = requireCanvasView();
    if (controller.getCurrentCanvasId() === canvasId) return controller.saveCurrent();
    const saved = CANVASES.get(canvasId);
    return { id: saved.id, title: saved.title, updatedAt: saved.updatedAt };
  });
  canvasHandle(IPC_CHANNELS.EXPORT_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const canvasId = validateOpaqueId(id, 'Canvas ID');
    const controller = requireCanvasView();
    if (controller.getCurrentCanvasId() === canvasId) emitCanvasSaved(await controller.saveCurrent());
    const canvas = CANVASES.get(canvasId);
    const safeTitle = canvas.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 80) || 'Easel Canvas';
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${safeTitle}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, canvas.html, 'utf8');
    return { canceled: false, fileName: path.basename(result.filePath) };
  });
  canvasHandle(IPC_CHANNELS.ADD_ASSET_TO_CANVAS, async (event, id, options = {}) => {
    assertTrustedSender(event, mainWindow);
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => !['onlyIfEmpty', 'createIfMissing', 'kits'].includes(key))
      || Object.entries(options).some(([key, value]) => key !== 'kits' && typeof value !== 'boolean')) throw new Error('Project image options are invalid.');
    const controller = requireCanvasView();
    if (!controller.getCurrentCanvasId() && options.createIfMissing !== true) throw new Error('Open or create a project before attaching an image.');
    const result = await attachProjectAssets(controller, controller.getCurrentCanvasId(), [validateProjectAssetId(id)], { kits: validateCanvasKits(options.kits) });
    return { ...result, added: true, effects: { source: 'media attached to project library', runtime: 'image was not inserted into authored or live DOM' } };
  });
  canvasHandle(IPC_CHANNELS.UNDO_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    if (CHAT.isBusy()) throw new Error('Wait for the current reply before undoing canvas edits.');
    const canvasId = validateOpaqueId(id, 'Canvas ID');
    const controller = requireCanvasView();
    if (controller.getCurrentCanvasId() !== canvasId) throw new Error('Open this canvas before undoing changes.');
    const snapshot = CANVAS_HISTORY.undo(canvasId);
    if (snapshot === null) {
      const canvas = CANVASES.get(canvasId);
      return { id: canvasId, title: canvas.title, undone: false, undoAvailable: false };
    }
    try {
      const documentPath = controller.getCurrentDocumentPath();
      const saved = CANVASES.update(canvasId, snapshot, { restoreMetadata: true });
      controller.markSourcePendingReload();
      const remaining = CANVASES.listDocuments(canvasId).documents;
      const opened = await controller.openSaved(canvasId, remaining.some((document) => document.path === documentPath) ? documentPath : CANVASES.getProject(canvasId).manifest.entry);
      const result = {
        ...opened,
        updatedAt: saved.updatedAt,
        undone: true,
        undoAvailable: CANVAS_HISTORY.canUndo(canvasId),
      };
      emitCanvasSaved(result);
      return result;
    } catch (error) {
      CANVAS_HISTORY.record(canvasId, snapshot);
      throw error;
    }
  });
  ipcMain.on(IPC_CHANNELS.SET_CANVAS_BOUNDS, (event, input) => {
    assertTrustedSender(event, mainWindow);
    if (!mainWindow || !canvasView) return;
    const bounds = validateCanvasBounds(input);
    const content = mainWindow.getContentBounds();
    const x = Math.min(bounds.x, content.width);
    const y = Math.min(bounds.y, content.height);
    canvasView.setBounds({
      x,
      y,
      width: Math.min(bounds.width, content.width - x),
      height: Math.min(bounds.height, content.height - y),
    });
  });
}

async function createWindow() {
  await CHAT.cancelShutdown({ schedule: false });
  await MCP_SERVER.start();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 960,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.platform !== 'darwin') mainWindow.removeMenu();

  canvasView = await createCanvasView({
    WebContentsView,
    sessionFactory: async (partition) => ({ partition, session: session.fromPartition(partition, { cache: false }) }),
    assetStore: ASSETS,
    mediaAssetStore: CAPTURE_MEDIA,
    onMediaSaved: (capture) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'media', ...capture });
      if (capture.attachment?.ok) mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'project-assets', projectId: capture.canvasId, assetIds: [capture.assetId] });
    },
    canvasStore: CANVASES,
    kitBundles: CANVAS_KIT_BUNDLES,
    requestMediaPermission: async ({ canvasId, types }) => {
      const devices = types.map((type) => type === 'audio' ? 'microphone' : 'camera').join(' and ');
      const result = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Canvas device access', message: `Allow ${CANVASES.get(canvasId).title} to use your ${devices}?`, detail: 'Access lasts for this app session. Use Devices to stop capture and revoke access. Sharing a capture with the model asks separately.', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1 });
      return result.response === 0;
    },
    onCanvasReady: async (canvasId, documentPath) => {
      const defaultPath = CANVASES.getProject(canvasId).manifest.entry;
      const pending = CANVAS_INPUTS.list({ canvasId, status: 'pending', limit: 200, raw: true }).find((request) => request.documentPath ? request.documentPath === documentPath : documentPath === defaultPath);
      if (pending) await canvasView.evaluate(renderCanvasInputScript({ ...pending, contextNote: pending.chatId === CHAT.getActiveChatId() ? '' : 'This question belongs to another conversation. Answer here, then open that conversation in History to continue. You can also dismiss it.' }));
      CHAT.recoverCanvasInputs();
    },
  });
  mainWindow.contentView.addChildView(canvasView.view);

  const entryUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== entryUrl) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  let closePrepared = false;
  let closeTask = null;
  mainWindow.on('close', (event) => {
    if (closePrepared) return;
    event.preventDefault();
    if (closeTask) return;
    const closingWindow = mainWindow;
    closeTask = (async () => {
      // Keep the native view alive until the stopped turn finishes its host edits.
      await CHAT.shutdown();
      await JOB_MONITOR.stop();
      await VIDEO_METADATA.close();
      await withCanvas(async (controller) => {
        if (controller.getCurrentCanvasId()) await controller.saveCurrent();
      });
      closePrepared = true;
      if (!closingWindow.isDestroyed()) closingWindow.close();
    })().catch(async (error) => {
      closeTask = null;
      await CHAT.cancelShutdown();
      JOB_MONITOR.start();
      if (!closingWindow.isDestroyed()) closingWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'error', message: `The window is still open because its work could not be saved: ${error.message}` });
    });
  });
  mainWindow.on('closed', () => {
    canvasView?.destroy();
    canvasView = null;
    mainWindow = null;
  });
  mainWindow.loadURL(entryUrl);
  JOB_MONITOR.start();
  return mainWindow;
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createWindow();
  VIDEO_METADATA.backfill({ jobs: MEDIA_JOBS.list({ raw: true }) }).catch(() => {});

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

module.exports = { assertTrustedSender, createWindow, registerIpcHandlers };
