const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  session,
} = require('electron');
const {
  IPC_CHANNELS,
  assertTrustedSender,
  validateChatMessage,
  validateSettingsInput,
} = require('./ipc-contract');
const { createSettingsStore } = require('./settings-store');
const { createAssetStore } = require('./asset-store');
const { createChatService } = require('./chat-service');
const { createCanvasWindow } = require('./canvas-window');

const SETTINGS = createSettingsStore({
  userDataPath: app.getPath('userData'),
  safeStorage,
});
let mainWindow;
let canvasWindow;

const ASSETS = createAssetStore({ userDataPath: app.getPath('userData') });
const CHAT = createChatService({
  settingsStore: SETTINGS,
  assetStore: ASSETS,
  runtime: { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath },
  presentCanvas: async (artifact) => {
    if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.destroy();
    const result = await createCanvasWindow({
      BrowserWindow,
      sessionFactory: async (partition) => ({ partition, session: session.fromPartition(partition, { cache: false }) }),
      artifact,
    });
    canvasWindow = result.window;
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
  ipcMain.handle(IPC_CHANNELS.SAVE_SETTINGS, (event, input) => {
    assertTrustedSender(event, mainWindow);
    return SETTINGS.save(validateSettingsInput(input));
  });
  ipcMain.handle(IPC_CHANNELS.SEND_MESSAGE, async (event, input) => {
    assertTrustedSender(event, mainWindow);
    return CHAT.sendMessage(validateChatMessage(input));
  });
}

function createWindow() {
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

  const entryUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== entryUrl) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  mainWindow.loadURL(entryUrl);
  return mainWindow;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

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
