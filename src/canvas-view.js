const crypto = require('node:crypto');
const { MAX_SNAPSHOT_BYTES } = require('./canvas-policy');

const MAX_SCRIPT_BYTES = 16_384;
const MAX_RESULT_BYTES = 12_000;

async function createCanvasView({ WebContentsView, sessionFactory, assetStore, canvasStore, kitBundles = {} }) {
  if (typeof WebContentsView !== 'function' || typeof sessionFactory !== 'function') {
    throw new Error('Canvas view dependencies are required.');
  }
  const partition = `easel-canvas-${crypto.randomUUID()}`;
  const isolated = await sessionFactory(partition);
  const view = new WebContentsView({
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
  const { webContents } = view;
  const { session } = isolated;
  let currentUrl = '';
  let currentCanvasId = '';
  let debuggerReady = false;
  const recentConsoleErrors = [];
  view.setVisible(false);

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
    if (target !== currentUrl) event.preventDefault();
  };
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', denyUnexpectedNavigation);
  webContents.on('will-redirect', denyUnexpectedNavigation);
  webContents.on('will-frame-navigate', denyUnexpectedNavigation);
  webContents.on('console-message', (_event, level, message, line) => {
    if (level < 2) return;
    recentConsoleErrors.push({
      level: level === 3 ? 'error' : 'warning',
      message: String(message).slice(0, 1000),
      line: Number.isInteger(line) ? line : 0,
    });
    if (recentConsoleErrors.length > 20) recentConsoleErrors.shift();
  });

  async function ensureDebugger() {
    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
    if (!debuggerReady) {
      await webContents.debugger.sendCommand('Runtime.enable');
      debuggerReady = true;
    }
  }

  async function loadHtml(html, canvasId = '') {
    if (typeof html !== 'string' || !html.trim()) throw new Error('Canvas HTML is required.');
    currentUrl = 'about:blank';
    currentCanvasId = canvasId;
    debuggerReady = false;
    recentConsoleErrors.length = 0;
    await webContents.loadURL(currentUrl);
    await ensureDebugger();
    const loaded = await webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: `document.open();document.write(${JSON.stringify(html)});document.close();`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: 10_000,
    });
    if (loaded.exceptionDetails) {
      throw new Error(loaded.exceptionDetails.exception?.description || loaded.exceptionDetails.text || 'Could not load canvas HTML.');
    }
    view.setVisible(true);
    return { id: currentCanvasId };
  }

  async function present(artifact) {
    if (!canvasStore) throw new Error('Canvas storage is unavailable.');
    const saved = canvasStore.save({ ...artifact, kitBundles });
    const document = canvasStore.get(saved.id);
    await loadHtml(document.html, saved.id);
    return saved;
  }

  async function createEmpty(title = 'Untitled Canvas', kits = []) {
    if (!canvasStore) throw new Error('Canvas storage is unavailable.');
    const saved = canvasStore.createEmpty(title, { kits, kitBundles });
    const document = canvasStore.get(saved.id);
    await loadHtml(document.html, saved.id);
    return saved;
  }

  async function embedLegacyAssetReferences(html) {
    const references = [...html.matchAll(/\basset:(?:\/\/)?([a-f0-9]{32})(?![a-f0-9])/gi)];
    const assetIds = new Set(references.map((reference) => reference[1].toLowerCase()));
    let output = html;
    for (const assetId of assetIds) {
      const asset = await assetStore.get(assetId);
      const source = `data:${asset.mimeType};base64,${asset.data}`;
      output = output.replace(new RegExp(`\\basset:(?:\\/\\/)?${assetId}(?![a-f0-9])`, 'gi'), source);
    }
    return output;
  }

  async function openSaved(id) {
    if (!canvasStore) throw new Error('Canvas storage is unavailable.');
    let saved = canvasStore.get(id);
    const migratedHtml = await embedLegacyAssetReferences(saved.html);
    if (migratedHtml !== saved.html) {
      canvasStore.update(saved.id, migratedHtml);
      saved = canvasStore.get(id);
    }
    await loadHtml(saved.html, saved.id);
    return { id: saved.id, title: saved.title };
  }

  async function evaluate(expression, maxResultBytes = MAX_RESULT_BYTES, truncateLargeResult = false) {
    if (!currentUrl) throw new Error('Open a canvas before operating on it.');
    await ensureDebugger();
    const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: 2_000,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Canvas script failed.');
    }
    const value = result.result?.value;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > maxResultBytes) {
      if (!truncateLargeResult) throw new Error('Canvas result is too large.');
      return JSON.stringify({ truncated: true, byteLength, preview: serialized.slice(0, 2_000) });
    }
    return serialized;
  }

  async function saveCurrent() {
    if (!currentCanvasId || !canvasStore) throw new Error('Open a saved canvas before saving edits.');
    const html = await evaluate('document.documentElement.outerHTML', MAX_SNAPSHOT_BYTES);
    return canvasStore.update(currentCanvasId, html);
  }

  async function inspect() {
    const snapshot = JSON.parse(await evaluate(`(() => JSON.stringify({
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 4000),
      runtime: {
        toneAvailable: typeof window.Tone === 'object',
        webAudioAvailable: typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function',
      },
      images: Array.from(document.images).slice(0, 32).map((image) => ({
        alt: image.alt,
        loaded: image.complete && image.naturalWidth > 0,
        width: image.naturalWidth,
        height: image.naturalHeight,
        assetId: image.dataset.easelAssetId || '',
      })),
      scriptImages: (window.__easelRuntimeDiagnostics?.images || []).slice(-32).map(({ image, failed }) => ({
        loaded: image.complete && image.naturalWidth > 0,
        failed,
        width: image.naturalWidth,
        height: image.naturalHeight,
        sourceType: !image.src ? 'empty' : image.src.startsWith('data:') ? 'embedded' : image.src.startsWith('blob:') ? 'blob' : 'other',
      })),
      webglErrors: (window.__easelRuntimeDiagnostics?.webglErrors || []).slice(-20),
    }))()`));
    snapshot.consoleErrors = [...recentConsoleErrors];
    return JSON.stringify(snapshot);
  }

  async function isEmpty() {
    const snapshot = JSON.parse(await evaluate(`(() => JSON.stringify({
      text: (document.body?.innerText || '').trim(),
      images: document.images.length,
      media: document.querySelectorAll('audio, video, canvas, svg, iframe, object').length,
    }))()`));
    return !snapshot.text && snapshot.images === 0 && snapshot.media === 0;
  }

  async function execute(script) {
    if (typeof script !== 'string' || !script.trim()) throw new Error('Canvas JavaScript is required.');
    if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('Canvas JavaScript exceeds 16 KiB.');
    return evaluate(script, MAX_RESULT_BYTES, true);
  }

  async function addImage({ assetId, alt = '', maxWidth = 80 } = {}) {
    if (!assetStore) throw new Error('Media storage is unavailable.');
    if (typeof alt !== 'string' || alt.length > 240) throw new Error('Image alt text is invalid.');
    if (!Number.isInteger(maxWidth) || maxWidth < 10 || maxWidth > 100) throw new Error('Image width must be between 10 and 100 percent.');
    const asset = await assetStore.get(assetId);
    const source = `data:${asset.mimeType};base64,${asset.data}`;
    const expression = `(() => {
      const image = document.createElement('img');
      image.src = ${JSON.stringify(source)};
      image.alt = ${JSON.stringify(alt)};
      image.dataset.easelAssetId = ${JSON.stringify(asset.id)};
      image.style.display = 'block';
      image.style.maxWidth = '${maxWidth}%';
      image.style.height = 'auto';
      image.style.objectFit = 'contain';
      image.style.margin = '12px auto';
      (document.querySelector('[data-easel-canvas]') || document.body).append(image);
      return JSON.stringify({ assetId: image.dataset.easelAssetId, alt: image.alt });
    })()`;
    return evaluate(expression);
  }

  function setBounds(bounds) {
    const x = Math.max(0, Math.floor(bounds.x));
    const y = Math.max(0, Math.floor(bounds.y));
    const width = Math.max(0, Math.floor(bounds.width));
    const height = Math.max(0, Math.floor(bounds.height));
    view.setBounds({ x, y, width, height });
    view.setVisible(width > 0 && height > 0 && Boolean(currentUrl));
  }

  function hide() {
    view.setVisible(false);
  }

  function destroy() {
    if (webContents.debugger.isAttached()) webContents.debugger.detach();
    if (!webContents.isDestroyed()) webContents.close();
  }

  return {
    addImage,
    createEmpty,
    destroy,
    evaluate,
    execute,
    getCurrentCanvasId: () => currentCanvasId,
    hide,
    inspect,
    isEmpty,
    openSaved,
    present,
    saveCurrent,
    setBounds,
    view,
  };
}

module.exports = { MAX_RESULT_BYTES, MAX_SCRIPT_BYTES, createCanvasView };
