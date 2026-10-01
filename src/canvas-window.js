const crypto = require('node:crypto');
const { buildCanvasDocument } = require('./canvas-policy');

async function createCanvasWindow({ BrowserWindow, sessionFactory, artifact }) {
  if (typeof BrowserWindow !== 'function' || typeof sessionFactory !== 'function') {
    throw new Error('Canvas window dependencies are required.');
  }
  const partition = `easel-canvas-${crypto.randomUUID()}`;
  const isolated = await sessionFactory(partition);
  const document = buildCanvasDocument(artifact);
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
  const canvasWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: artifact.title || 'Easel Canvas',
    webPreferences: {
      partition: isolated.partition || partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const { session } = isolated;
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let protocol = '';
    try {
      protocol = new URL(details.url).protocol;
    } catch {
      callback({ cancel: true });
      return;
    }
    callback({ cancel: !['data:', 'blob:', 'about:'].includes(protocol) });
  });
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);

  const denyUnexpectedNavigation = (event, target) => {
    if (target !== url) event.preventDefault();
  };
  canvasWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  canvasWindow.webContents.on('will-navigate', denyUnexpectedNavigation);
  canvasWindow.webContents.on('will-redirect', denyUnexpectedNavigation);
  canvasWindow.webContents.on('will-frame-navigate', denyUnexpectedNavigation);
  await canvasWindow.loadURL(url);

  return {
    window: canvasWindow,
    reset() {
      if (!canvasWindow.isDestroyed()) canvasWindow.destroy();
    },
  };
}

module.exports = { createCanvasWindow };
