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
  validateSettingsInput,
} = require('./ipc-contract');
const { createSettingsStore } = require('./settings-store');
const { createAssetStore } = require('./asset-store');
const { createCanvasStore } = require('./canvas-store');
const { createCanvasView } = require('./canvas-view');
const { createCanvasHistory } = require('./canvas-history');
const { createChatService } = require('./chat-service');
const { createChatStore } = require('./chat-store');
const { createCanvasInputStore } = require('./canvas-input-store');
const { renderCanvasInputScript, dismissCanvasInputScript } = require('./canvas-input-runtime');
const { createCanvasMediaStore } = require('./canvas-media-store');
const { createLiteLLMModelService } = require('./litellm-models');
const { readInstalledSkills } = require('./skill-catalog');
const { loadCanvasKitBundles } = require('./canvas-kits');

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
const MEDIA_ASSETS = { get: async (id) => { try { return await ASSETS.get(id); } catch { return CAPTURE_MEDIA.get(id); } } };
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
      previewHidden: Boolean(current?.previewHidden),
      undoAvailable: Boolean(canvasId && CANVAS_HISTORY.canUndo(canvasId)),
    });
  }
}

async function attachProjectAssets(controller, projectId, assetIds, { kits = [] } = {}) {
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
  return metadata;
}

function publicAsset(asset) {
  return Object.fromEntries(['id', 'name', 'mimeType', 'data', 'bytes', 'width', 'height', 'duration', 'codec', 'thumbnail'].filter((key) => asset[key] !== undefined).map((key) => [key, asset[key]]));
}

async function listStoredMedia() {
  const [images, captures] = await Promise.all([ASSETS.list(), CAPTURE_MEDIA.list()]);
  return [...images, ...captures].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
}

async function readMediaReference({ assetId, projectId } = {}) {
  const id = validateProjectAssetId(assetId);
  if (projectId !== undefined) validateOpaqueId(projectId, 'Project ID');
  if (id.length === 32) {
    try { return await MEDIA_ASSETS.get(id); }
    catch (error) { if (!projectId && !canvasView?.getCurrentCanvasId()) throw error; }
  }
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
const CHAT = createChatService({
  settingsStore: SETTINGS,
  assetStore: ASSETS,
  chatStore: createChatStore({ userDataPath: app.getPath('userData') }),
  inputStore: CANVAS_INPUTS,
  mediaAssetStore: MEDIA_ASSETS,
  runtime: { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath },
  presentCanvas: (artifact) => withCanvas(async (controller) => {
    await saveCanvasBeforeSwitch(controller);
    const id = controller.getCurrentCanvasId();
    const before = id ? CANVASES.get(id).html : '';
    try { return await controller.present(artifact); }
    finally { if (id && CANVASES.get(id).html !== before) CANVAS_HISTORY.record(id, before); }
  }),
  canvasController: {
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
    getCurrentDocumentPath: () => requireCanvasView().getCurrentDocumentPath(),
    getDefaultDocumentPath: () => CANVASES.getProject(requireCanvasView().getCurrentCanvasId()).manifest.entry,
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
      if (projectId && controller.getCurrentCanvasId() !== projectId) throw new Error('The active project changed while generating media. The images remain in the library.');
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
      const assets = scope === 'project' ? CANVASES.listAssets(validateOpaqueId(projectId || requireCanvasView().getCurrentCanvasId(), 'Project ID')).assets : await listStoredMedia();
      return { scope, assets: assets.slice(0, limit).map(({ id, name, mimeType, bytes, width, height, duration, codec, projectId: owner }) => ({ assetId: id, name, mimeType, bytes, width, height, duration, codec, ...(owner ? { projectId: owner } : {}) })), truncated: assets.length > limit };
    },
    adoptCanvasDom: (options) => projectMutation('adoptCanvasDom', options),
    getCanvasSource: (options) => withCanvas((controller) => controller.getCanvasSource(options)),
    validateCanvas: (options) => withCanvas((controller) => controller.validateCanvas(options)),
    captureLiveCanvas: (options, context) => withCanvas((controller) => controller.captureLiveCanvas(options, context)),
    recordCanvasVideo: (options, context) => withCanvas((controller) => controller.recordCanvasVideo(options, context)),
    getVideoFrames: ({ assetId, maxFrames } = {}) => CAPTURE_MEDIA.getFrames(validateOpaqueId(assetId, 'Video asset ID'), { maxFrames }),
    reloadCanvas: (options) => withCanvas((controller) => controller.reloadCanvas(options)),
    listCanvasFiles: (options) => withCanvas((controller) => controller.listCanvasFiles(options)),
    readCanvasFile: (options) => withCanvas((controller) => controller.readCanvasFile(options)),
    getCanvasState: (options) => withCanvas((controller) => controller.getCanvasState(options)),
    ...Object.fromEntries(['writeCanvasFile', 'patchCanvasFile', 'applyCanvasFilePatches', 'deleteCanvasFile', 'updateCanvasProject', 'attachCanvasAsset', 'attachCanvasAssets', 'setCanvasState'].map((method) => [method, (options) => projectMutation(method, options)])),
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
  },
  onEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
  },
});

function registerIpcHandlers() {
  const canvasHandle = (channel, handler) => ipcMain.handle(channel, (...args) => withCanvas(() => handler(...args)));
  function requireCanvasSender(event) {
    const controller = requireCanvasView();
    const contract = controller.getContract();
    if (event.sender !== controller.view.webContents || event.senderFrame !== controller.view.webContents.mainFrame || !controller.getCurrentCanvasId() || contract.loading || contract.previewHidden || event.senderFrame.url !== contract.url) throw new Error('Canvas bridge request was rejected.');
    return controller;
  }
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
    const selected = SETTINGS.loadPublic();
    const modelIdentity = (settings) => JSON.stringify([settings.activeConnectionId, settings.litellmModel, settings.litellmBaseUrl]);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['media', 'prompt'].includes(key))) throw new Error('Canvas media input is invalid.');
    if (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > 20_000)) throw new Error('Canvas media prompt is invalid.');
    const media = validateChatOptions({ attachments: [input.media] }).attachments[0];
    if (!['image', 'audio'].includes(media.type)) throw new Error('Share a photo or audio recording.');
    if (!selected.litellmModel) throw new Error('Choose an Agent model in chat before sharing a capture.');
    const consent = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Share capture with chat', message: `Send ${media.name} to ${selected.litellmModel}?`, detail: 'The capture will be saved on this device and sent to your configured model endpoint.', buttons: ['Send to chat', 'Cancel'], defaultId: 0, cancelId: 1 });
    if (consent.response !== 0) return { ok: false, cancelled: true, error: 'Capture was not shared.' };
    if (controller.getCurrentCanvasId() !== canvasId || controller.getContract().runtimeGeneration !== generation) throw new Error('The canvas changed before this capture could be shared.');
    if (modelIdentity(SETTINGS.loadPublic()) !== modelIdentity(selected)) throw new Error('The selected model changed. Share the capture again with the intended model.');
    const assetId = await (media.type === 'image' ? ASSETS : CAPTURE_MEDIA).save(media);
    if (controller.getCurrentCanvasId() !== canvasId || controller.getContract().runtimeGeneration !== generation) throw new Error('The canvas changed before this capture could be shared.');
    return CHAT.submitCanvasMedia({ canvasId, documentPath: controller.getCurrentDocumentPath(), chatId, attachments: [{ assetId, type: media.type, mimeType: media.mimeType, name: media.name }], prompt: input.prompt || '', approvedModel: { connectionId: selected.activeConnectionId, model: selected.litellmModel, baseUrl: selected.litellmBaseUrl } });
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
    const created = await controller.createEmpty(options.title, options.kits || []);
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
    return { ...result, projectId, projectTitle: result.title, assets };
  });
  ipcMain.handle(IPC_CHANNELS.GET_PROJECT_ASSET, async (event, id, assetId) => {
    assertTrustedSender(event, mainWindow);
    return publicAsset(await CANVASES.getAsset(validateOpaqueId(id, 'Project ID'), validateProjectAssetId(assetId)));
  });
  ipcMain.handle(IPC_CHANNELS.GET_LIBRARY_ASSET, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    return publicAsset(await MEDIA_ASSETS.get(validateOpaqueId(id, 'Asset ID')));
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_LIBRARY_ASSET, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    return saveAssetDownload(await MEDIA_ASSETS.get(validateOpaqueId(id, 'Asset ID')));
  });
  canvasHandle(IPC_CHANNELS.ATTACH_PROJECT_ASSET, async (event, id, assetId) => {
    assertTrustedSender(event, mainWindow);
    const projectId = id ? validateOpaqueId(id, 'Project ID') : '';
    return attachProjectAssets(requireCanvasView(), projectId, [validateProjectAssetId(assetId)]);
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_PROJECT_ASSET, async (event, id, assetId) => {
    assertTrustedSender(event, mainWindow);
    const asset = await CANVASES.getAsset(validateOpaqueId(id, 'Project ID'), validateProjectAssetId(assetId));
    return saveAssetDownload(asset);
  });
  ipcMain.handle(IPC_CHANNELS.HIDE_CANVAS_PREVIEW, async (event) => {
    assertTrustedSender(event, mainWindow);
    // Recording owns the canvas queue, so cancel it before queueing a view switch.
    await requireCanvasView().cancelCanvasRecording('The canvas preview was hidden.');
    return withCanvas((controller) => controller.hide());
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
    return LITELLM_MODELS.listModels();
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
    return SETTINGS.saveConnection(input);
  });
  ipcMain.handle(IPC_CHANNELS.REMOVE_CONNECTION, (event, id) => {
    assertTrustedSender(event, mainWindow);
    return SETTINGS.removeConnection(id);
  });
  ipcMain.handle(IPC_CHANNELS.SELECT_MODEL, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return SETTINGS.selectModel(input);
  });
  ipcMain.handle(IPC_CHANNELS.UPDATE_MODEL, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return SETTINGS.updateModel(input);
  });
  ipcMain.handle(IPC_CHANNELS.CHECK_MODEL_CAPABILITIES, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return LITELLM_MODELS.checkCapabilities(validateModelSelection(input));
  });
  ipcMain.handle(IPC_CHANNELS.GET_MODEL_CATALOG, (event) => {
    assertTrustedSender(event, mainWindow);
    return LITELLM_MODELS.getCatalog();
  });
  ipcMain.handle(IPC_CHANNELS.LIST_INSTALLED_SKILLS, (event) => {
    assertTrustedSender(event, mainWindow);
    return readInstalledSkills(path.join(app.getAppPath(), '.agents', 'skills'));
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_SETTINGS, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return SETTINGS.save(validateSettingsInput(input));
  });
  ipcMain.handle(IPC_CHANNELS.SEND_MESSAGE, async (event, input, options) => {
    assertTrustedSender(event, mainWindow);
    const chatOptions = validateChatOptions(options);
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
  ipcMain.handle(IPC_CHANNELS.GET_CHAT, (event) => {
    assertTrustedSender(event, mainWindow);
    CHAT.recoverCanvasInputs();
    return CHAT.getCurrentChat();
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
  CHAT.cancelShutdown({ schedule: false });
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
      await withCanvas(async (controller) => {
        if (controller.getCurrentCanvasId()) await controller.saveCurrent();
      });
      closePrepared = true;
      if (!closingWindow.isDestroyed()) closingWindow.close();
    })().catch((error) => {
      closeTask = null;
      CHAT.cancelShutdown();
      if (!closingWindow.isDestroyed()) closingWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { type: 'error', message: `The window is still open because its work could not be saved: ${error.message}` });
    });
  });
  mainWindow.on('closed', () => {
    canvasView?.destroy();
    canvasView = null;
    mainWindow = null;
  });
  mainWindow.loadURL(entryUrl);
  return mainWindow;
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
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
