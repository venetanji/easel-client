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
} = require('electron');
const {
  IPC_CHANNELS,
  assertTrustedSender,
  validateCanvasBounds,
  validateCanvasTitle,
  validateChatMessage,
  validateChatOptions,
  validateLiteLLMModelInput,
  validateOpaqueId,
  validateSettingsInput,
} = require('./ipc-contract');
const { createSettingsStore } = require('./settings-store');
const { createAssetStore } = require('./asset-store');
const { createCanvasStore } = require('./canvas-store');
const { createCanvasView } = require('./canvas-view');
const { createCanvasHistory } = require('./canvas-history');
const { createChatService } = require('./chat-service');
const { createLiteLLMModelService } = require('./litellm-models');

const SETTINGS = createSettingsStore({
  userDataPath: app.getPath('userData'),
  safeStorage,
});
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
const CANVASES = createCanvasStore({ userDataPath: app.getPath('userData') });
const CANVAS_HISTORY = createCanvasHistory();
let mainWindow;
let canvasView;

function requireCanvasView() {
  if (!canvasView) throw new Error('Canvas view is not ready.');
  return canvasView;
}

function emitCanvasSaved(canvas) {
  const canvasId = canvas.id || canvas.canvasId || '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, {
      type: 'canvas',
      title: canvas.title,
      canvasId,
      undoAvailable: Boolean(canvasId && CANVAS_HISTORY.canUndo(canvasId)),
    });
  }
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
  runtime: { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath },
  presentCanvas: async (artifact) => {
    const controller = requireCanvasView();
    await saveCanvasBeforeSwitch(controller);
    return controller.present(artifact);
  },
  canvasController: {
    createEmpty: async (title) => {
      const controller = requireCanvasView();
      await saveCanvasBeforeSwitch(controller);
      return controller.createEmpty(title);
    },
    inspect: () => requireCanvasView().inspect(),
    execute: async (code) => {
      const controller = requireCanvasView();
      await checkpointCanvasForUndo(controller);
      const result = await controller.execute(code);
      emitCanvasSaved(await controller.saveCurrent());
      return result;
    },
    addImage: async (options) => {
      const controller = requireCanvasView();
      await checkpointCanvasForUndo(controller);
      const result = await controller.addImage(options);
      emitCanvasSaved(await controller.saveCurrent());
      return result;
    },
  },
  onEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
  },
});

function registerIpcHandlers() {
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
  ipcMain.handle(IPC_CHANNELS.SAVE_SETTINGS, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return SETTINGS.save(validateSettingsInput(input));
  });
  ipcMain.handle(IPC_CHANNELS.SEND_MESSAGE, async (event, input, options) => {
    assertTrustedSender(event, mainWindow);
    return CHAT.sendMessage(validateChatMessage(input), validateChatOptions(options));
  });
  ipcMain.handle(IPC_CHANNELS.CLEAR_CHAT, (event) => {
    assertTrustedSender(event, mainWindow);
    CHAT.clearHistory();
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.LIST_ASSETS, (event) => {
    assertTrustedSender(event, mainWindow);
    return ASSETS.list();
  });
  ipcMain.handle(IPC_CHANNELS.LIST_CANVASES, (event) => {
    assertTrustedSender(event, mainWindow);
    return CANVASES.list();
  });
  ipcMain.handle(IPC_CHANNELS.CREATE_CANVAS, async (event, title) => {
    assertTrustedSender(event, mainWindow);
    const controller = requireCanvasView();
    await saveCanvasBeforeSwitch(controller);
    const canvas = await controller.createEmpty(validateCanvasTitle(title));
    return { ...canvas, undoAvailable: CANVAS_HISTORY.canUndo(canvas.id) };
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const canvasId = validateOpaqueId(id, 'Canvas ID');
    const controller = requireCanvasView();
    if (controller.getCurrentCanvasId() !== canvasId) await saveCanvasBeforeSwitch(controller);
    const canvas = await controller.openSaved(canvasId);
    return { ...canvas, undoAvailable: CANVAS_HISTORY.canUndo(canvasId) };
  });
  ipcMain.handle(IPC_CHANNELS.SAVE_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const canvasId = validateOpaqueId(id, 'Canvas ID');
    const controller = requireCanvasView();
    if (controller.getCurrentCanvasId() === canvasId) return controller.saveCurrent();
    const saved = CANVASES.get(canvasId);
    return { id: saved.id, title: saved.title, updatedAt: saved.updatedAt };
  });
  ipcMain.handle(IPC_CHANNELS.EXPORT_CANVAS, async (event, id) => {
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
  ipcMain.handle(IPC_CHANNELS.ADD_ASSET_TO_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const controller = requireCanvasView();
    await checkpointCanvasForUndo(controller);
    const result = await controller.addImage({ assetId: validateOpaqueId(id, 'Asset ID') });
    emitCanvasSaved(await controller.saveCurrent());
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.UNDO_CANVAS, async (event, id) => {
    assertTrustedSender(event, mainWindow);
    const canvasId = validateOpaqueId(id, 'Canvas ID');
    const controller = requireCanvasView();
    if (controller.getCurrentCanvasId() !== canvasId) throw new Error('Open this canvas before undoing changes.');
    const snapshot = CANVAS_HISTORY.undo(canvasId);
    if (snapshot === null) {
      const canvas = CANVASES.get(canvasId);
      return { id: canvasId, title: canvas.title, undone: false, undoAvailable: false };
    }
    try {
      const saved = CANVASES.update(canvasId, snapshot);
      const opened = await controller.openSaved(canvasId);
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
    canvasStore: CANVASES,
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
