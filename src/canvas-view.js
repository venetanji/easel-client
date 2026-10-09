const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');
const { MAX_SNAPSHOT_BYTES } = require('./canvas-policy');
const { repairLegacyToneBundle } = require('./canvas-kits');
const { getSource, patchSource, revision, sourceBlocks } = require('./canvas-source');
const { addCanvasLifecycle } = require('./canvas-runtime');
const { createCanvasMediaPermissions } = require('./canvas-media-permissions');
const { MAX_FRAME_BYTES, MAX_MEDIA_BYTES, MAX_VIDEO_FRAMES } = require('./canvas-media-store');
const { MAX_RECORDING_SECONDS, captureOperationScript, captureStartScript, validateRecordingOptions } = require('./canvas-output-capture');
const { repairWebmDuration } = require('./canvas-webm-duration');
const { abortError, combinedSignal, throwIfAborted } = require('./turn-abort');

const MAX_SCRIPT_BYTES = 16_384;
const MAX_RESULT_BYTES = 12_000;
const MAX_INSPECTION_BYTES = 24_000;

function boundInspection(snapshot) {
  const summary = snapshot.runtime?.summary;
  const arrays = [
    ['images', snapshot, 'images'], ['scriptImages', snapshot, 'scriptImages'],
    ['consoleErrors', snapshot, 'consoleErrors'], ['webglErrors', snapshot, 'webglErrors'],
    ['canvases', summary, 'canvases'], ['apps', summary, 'apps'], ['runtimeErrors', summary, 'errors'],
    ['assetManifest', summary?.assets, 'manifest'], ['debugStates', summary?.debug, 'states'],
  ].filter(([, owner, key]) => Array.isArray(owner?.[key]));
  const counts = Object.fromEntries(arrays.map(([name, owner, key]) => [name, owner[key].length]));
  const omitted = {};
  const size = () => Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  const setMetadata = () => {
    for (const [name, owner, key] of arrays) if (owner[key].length < counts[name]) omitted[name] = counts[name] - owner[key].length;
    if (omitted.assetManifest) summary.assets.truncated = true;
    if (omitted.debugStates) summary.debug.truncated = true;
    snapshot.truncation = { truncated: Object.keys(omitted).length > 0, omitted, limitBytes: MAX_INSPECTION_BYTES };
  };
  setMetadata();
  while (size() > MAX_INSPECTION_BYTES) {
    const longest = arrays.filter(([name, owner, key]) => owner[key].length > 1 || (['assetManifest', 'debugStates'].includes(name) && owner[key].length))
      .sort((first, second) => JSON.stringify(second[1][second[2]]).length - JSON.stringify(first[1][first[2]]).length)[0];
    if (!longest) {
      snapshot.text = String(snapshot.text || '').slice(0, 256);
      snapshot.title = String(snapshot.title || '').slice(0, 240);
      omitted.text = true;
      break;
    }
    const [, owner, key] = longest;
    owner[key] = owner[key].length === 1 ? [] : owner[key].slice(-Math.ceil(owner[key].length / 2));
    setMetadata();
  }
  setMetadata();
  if (size() > MAX_INSPECTION_BYTES) throw new Error('Canvas inspection exceeds its 24 KiB response budget. Reduce registered metadata and inspect specific source files.');
  return snapshot;
}

async function createCanvasView({ WebContentsView, sessionFactory, assetStore, mediaAssetStore, canvasStore, kitBundles = {}, requestMediaPermission, onCanvasReady, onMediaSaved, onRuntimeInvalidated }) {
  if (typeof WebContentsView !== 'function' || typeof sessionFactory !== 'function') {
    throw new Error('Canvas view dependencies are required.');
  }
  const partition = `easel-canvas-${crypto.randomUUID()}`;
  const isolated = await sessionFactory(partition);
  const view = new WebContentsView({
    webPreferences: {
      partition: isolated.partition || partition,
      sandbox: true,
      preload: path.join(__dirname, 'canvas-preload.js'),
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
  let currentDocumentPath = '';
  let previewHidden = false;
  let hasVisibleBounds = false;
  let debuggerReady = false;
  let sourcePendingReload = false;
  let runtimeGeneration = 0;
  let loading = false;
  let loadedSourceValid = false;
  let hostNavigationActive = false;
  let errorSequence = 0;
  let generationStartedAt = 0;
  let scriptLocations = [];
  let activeOutputCapture = null;
  const recentConsoleErrors = [];
  view.setVisible(false);
  session.protocol.handle('easel-canvas', (request) => {
    if (request.url !== currentUrl) return new Response('Canvas resource not found.', { status: 404 });
    return new Response('<!doctype html><html><head></head><body></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });

  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let protocol = '';
    try {
      protocol = new URL(details.url).protocol;
    } catch {
      callback({ cancel: true });
      return;
    }
    callback({ cancel: !['data:', 'blob:', 'about:'].includes(protocol) && details.url !== currentUrl });
  });
  const mediaPermissions = createCanvasMediaPermissions({ session, webContents, getCanvasId: () => currentCanvasId, getGeneration: () => runtimeGeneration, isReady: () => !loading && !previewHidden, requestPermission: requestMediaPermission });

  const denyUnexpectedNavigation = (event, target) => {
    if (target !== currentUrl) event.preventDefault();
  };
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', denyUnexpectedNavigation);
  webContents.on('will-redirect', denyUnexpectedNavigation);
  webContents.on('will-frame-navigate', denyUnexpectedNavigation);
  function errorLocation(source = '', line = 0) {
    if (source.startsWith('easel-source:///')) return { provenance: 'app', sourceFile: source.slice('easel-source:///'.length), sourceLine: line };
    if (source.startsWith('node:') || source.includes('electron/js2c')) return { provenance: 'host', sourceFile: null, sourceLine: line };
    const block = (!source || source === currentUrl) && scriptLocations.find((item) => line >= item.start && line <= item.end);
    if (block) return { provenance: block.provenance, sourceFile: block.file, sourceLine: Math.max(1, line - block.start + 1), ...(block.kit ? { kit: block.kit } : {}) };
    return { provenance: 'unknown', sourceFile: null, sourceLine: line || null };
  }

  webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (!['warning', 'error'].includes(level)) return;
    recentConsoleErrors.push({
      level,
      message: String(message).slice(0, 1000),
      line: Number.isInteger(lineNumber) ? lineNumber : 0,
      ...errorLocation(sourceId || '', lineNumber || 0),
      sequence: ++errorSequence,
      generation: runtimeGeneration,
      timestamp: Date.now(),
    });
    if (recentConsoleErrors.length > 20) recentConsoleErrors.shift();
  });

  function invalidateRuntime(reason) {
    try { onRuntimeInvalidated?.(reason); } catch { /* Optional export cleanup cannot block canvas cleanup. */ }
  }

  function markSourcePendingReload() {
    sourcePendingReload = true;
    invalidateRuntime('The sound source changed; reload before exporting.');
  }

  webContents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
    const topLevel = details.isMainFrame ?? isMainFrame;
    const sameDocument = details.isSameDocument ?? isInPlace;
    if (!topLevel || sameDocument || hostNavigationActive) return;
    // Renderer-initiated reload can replace a document without changing its URL.
    // Only a subsequent host source load restores a valid loaded-source context.
    loadedSourceValid = false;
    sourcePendingReload = true;
    runtimeGeneration += 1;
    invalidateRuntime('The loaded canvas document was replaced; reload its saved source.');
  });

  async function loadHostUrl(url) {
    hostNavigationActive = true;
    try { await webContents.loadURL(url); }
    finally { hostNavigationActive = false; }
  }

  webContents.on('render-process-gone', () => invalidateRuntime('The canvas renderer stopped.'));
  webContents.on('destroyed', () => invalidateRuntime('The canvas renderer was destroyed.'));

  async function ensureDebugger() {
    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
    if (!debuggerReady) {
      await webContents.debugger.sendCommand('Runtime.enable');
      debuggerReady = true;
    }
  }

  async function loadHtml(html, canvasId = '', preservedState, disposePrevious = true, documentPath = currentDocumentPath, showPreview = !previewHidden) {
    if (typeof html !== 'string' || !html.trim()) throw new Error('Canvas HTML is required.');
    loadedSourceValid = false;
    invalidateRuntime('The canvas document is being replaced.');
    await cancelOutputCapture('The canvas document is being replaced.');
    html = addCanvasLifecycle(html);
    if (preservedState) {
      const state = JSON.stringify(preservedState).replace(/</g, '\\u003c');
      html = html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<script id="easel-runtime-state">window.__easelPreservedState=${state};</script>`);
    }
    // Separate generated script locations so document line numbers identify their owner.
    for (const block of sourceBlocks(html).filter((item) => item.type === 'script').reverse()) {
      html = `${html.slice(0, block.start)}\n${html.slice(block.start, block.end)}\n${html.slice(block.end)}`;
    }
    if (currentUrl && disposePrevious) await cleanupForReload();
    else if (currentUrl) await evaluate('window.EaselCanvas?.stopMedia() || 0');
    if (currentCanvasId !== canvasId || currentDocumentPath !== documentPath) mediaPermissions.revoke();
    mediaPermissions.invalidatePending();
    loading = true;
    currentCanvasId = canvasId;
    currentDocumentPath = documentPath || '';
    previewHidden = !showPreview;
    debuggerReady = false;
    sourcePendingReload = false;
    runtimeGeneration += 1;
    currentUrl = `easel-canvas://document/${canvasId || 'preview'}?generation=${runtimeGeneration}`;
    generationStartedAt = Date.now();
    recentConsoleErrors.length = 0;
    scriptLocations = sourceBlocks(html).filter((block) => block.type === 'script').map((block) => {
      const opening = html.slice(block.start, block.contentStart);
      const kit = /data-easel-canvas-kit=["']([^"']+)["']/i.exec(opening)?.[1];
      return { start: html.slice(0, block.contentStart).split('\n').length, end: html.slice(0, block.contentEnd).split('\n').length, provenance: kit ? 'kit' : block.protected ? 'host' : 'app', file: /data-easel-project-file=["']([^"']+)["']/i.exec(opening)?.[1] || null, kit };
    });
    try {
      await loadHostUrl(currentUrl);
      await ensureDebugger();
      const loaded = await webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `document.open();document.write(${JSON.stringify(html)});document.close();`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
        timeout: 10_000,
      });
      if (loaded.exceptionDetails) {
        throw new Error(loaded.exceptionDetails.exception?.description || loaded.exceptionDetails.text || 'Could not load canvas HTML.');
      }
      view.setVisible(showPreview && hasVisibleBounds);
      await waitForRuntime(2, 500);
      if (preservedState) await evaluate('window.EaselCanvas?.restoreControls()');
      loading = false;
      loadedSourceValid = true;
      if (onCanvasReady) await onCanvasReady(canvasId, currentDocumentPath);
      return { id: currentCanvasId, projectId: currentCanvasId, documentPath: currentDocumentPath };
    } finally { loading = false; }
  }

  async function present(artifact) {
    if (!canvasStore) throw new Error('Canvas storage is unavailable.');
    const saved = currentCanvasId
      ? await canvasStore.createDocument(currentCanvasId, { ...artifact, kitBundles })
      : canvasStore.save({ ...artifact, kitBundles });
    const document = canvasStore.get(saved.id, { documentPath: saved.documentPath });
    await loadHtml(document.html, saved.id, undefined, true, document.documentPath, true);
    return { ...saved, ...documentIdentity(document) };
  }

  async function createEmpty(title = 'Untitled Canvas', kits) {
    if (!canvasStore) throw new Error('Canvas storage is unavailable.');
    const saved = canvasStore.createProject({ title, kits, kitBundles });
    const document = canvasStore.get(saved.id);
    await loadHtml(document.html, saved.id, undefined, true, document.documentPath, true);
    return { ...saved, ...documentIdentity(document) };
  }

  function documentIdentity(document) {
    return { id: document.id, projectId: document.id, title: document.projectTitle || document.title, projectTitle: document.projectTitle || document.title, documentPath: document.documentPath || '', documentTitle: document.documentTitle || document.title, starterDocument: document.starterDocument === true, ...(document.documents ? { documents: document.documents } : {}) };
  }

  function mutationIdentity(result) {
    const selected = canvasStore.listDocuments(result.id).documents.find((document) => document.path === currentDocumentPath);
    return { ...result, projectId: result.id, projectTitle: result.title, documentPath: currentDocumentPath, documentTitle: selected?.title || result.documentTitle };
  }

  async function ensureProject({ title = 'Untitled project', kits } = {}) {
    if (currentCanvasId) return documentIdentity(canvasStore.get(currentCanvasId, { documentPath: currentDocumentPath || undefined }));
    const saved = canvasStore.createProject({ title, kits, kitBundles });
    currentCanvasId = saved.id;
    currentDocumentPath = '';
    return { ...saved, ...documentIdentity(canvasStore.get(saved.id)), documentPath: '', createdProject: true };
  }

  async function createDocument(args = {}) {
    if (!currentCanvasId) await ensureProject();
    const saved = await canvasStore.createDocument(currentCanvasId, args);
    const document = canvasStore.get(saved.id, { documentPath: saved.documentPath });
    await loadHtml(document.html, saved.id, undefined, true, document.documentPath, true);
    return { ...saved, ...documentIdentity(document) };
  }

  async function installProjectAssets(assetIds) {
    if (!currentUrl || !currentDocumentPath) return { runtimeAssetsUpdated: false };
    const projectId = currentCanvasId, documentPath = currentDocumentPath, generation = runtimeGeneration, url = currentUrl;
    const check = () => {
      if (currentCanvasId !== projectId || currentDocumentPath !== documentPath || runtimeGeneration !== generation || currentUrl !== url || loading || webContents.isDestroyed()) throw new Error('The canvas changed while updating attached media. Reopen the original project to load its samples.');
    };
    const assets = {};
    for (const id of assetIds) {
      check();
      const asset = await canvasStore.getAsset(projectId, id);
      const { data, ...metadata } = asset;
      assets[id] = { ...metadata, url: `data:${asset.mimeType};base64,${data}` };
    }
    check();
    const installed = await evaluate(`(() => {if(location.href.split('#')[0]!==${JSON.stringify(url.split('#')[0])})throw new Error('The canvas changed before attached media could be installed.');const added=${JSON.stringify(assets).replace(/</g, '\\u003c')};window.__easelProjectAssets=Object.freeze({...window.__easelProjectAssets,...Object.fromEntries(Object.entries(added).map(([id,asset])=>[id,Object.freeze(asset)]))});window.__easelProjectAssetsReady=Promise.resolve(window.__easelProjectAssets);return true;})()`);
    check();
    if (installed !== 'true') throw new Error('The attached media resolver did not confirm its update. Reload the project.');
    return { runtimeAssetsUpdated: true };
  }

  async function embedLegacyAssetReferences(html) {
    const pieces = html.split(/(<script\b[^>]*\bid=["']easel-project-snapshot["'][^>]*>[\s\S]*?<\/script\s*>)/gi);
    const references = pieces.filter((_, index) => index % 2 === 0).flatMap((piece) => [...piece.matchAll(/(?<!\{)\basset:(?:\/\/)?([a-f0-9]{32})(?![a-f0-9])/gi)]);
    const assetIds = new Set(references.map((reference) => reference[1].toLowerCase()));
    for (const assetId of assetIds) {
      const asset = await assetStore.get(assetId);
      const source = `data:${asset.mimeType};base64,${asset.data}`;
      for (let index = 0; index < pieces.length; index += 2) pieces[index] = pieces[index].replace(new RegExp(`(?<!\\{)\\basset:(?:\\/\\/)?${assetId}(?![a-f0-9])`, 'gi'), source);
    }
    return pieces.join('');
  }

  async function openSaved(id, documentPath) {
    if (!canvasStore) throw new Error('Canvas storage is unavailable.');
    if (typeof canvasStore.migrateAssetReferences === 'function') await canvasStore.migrateAssetReferences(id);
    let saved = canvasStore.get(id, { documentPath: documentPath || (id === currentCanvasId ? currentDocumentPath || undefined : undefined) });
    // A failed host load can select the document before injecting its source.
    // Reuse only a valid runtime owned by this document; Retry Open must load
    // its durable source again without resetting another healthy preview.
    if (currentUrl && currentCanvasId === id && currentDocumentPath === saved.documentPath && loadedSourceValid && !sourcePendingReload) {
      previewHidden = false;
      view.setVisible(hasVisibleBounds);
      return documentIdentity(saved);
    }
    const migratedHtml = await embedLegacyAssetReferences(repairLegacyToneBundle(saved.html));
    if (migratedHtml !== saved.html) {
      canvasStore.update(saved.id, migratedHtml, { documentPath: saved.documentPath });
      saved = canvasStore.get(id, { documentPath: saved.documentPath });
    }
    await loadHtml(saved.html, saved.id, undefined, true, saved.documentPath, true);
    return documentIdentity(saved);
  }

  async function evaluate(expression, maxResultBytes = MAX_RESULT_BYTES, truncateLargeResult = false) {
    if (!currentUrl) throw new Error('Open a canvas before operating on it.');
    await ensureDebugger();
    const result = await webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
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

  async function waitForRuntime(frames = 3, deadline = 1500) {
    return JSON.parse(await evaluate(`(async () => {
      let timer;
      try { return await Promise.race([
        (async () => { try { await window.EaselCanvas?.whenReady?.(); for (let i=0;i<${frames};i++) await new Promise(resolve => requestAnimationFrame(resolve)); return {ready:true,frames:${frames}}; } catch(error) { return {ready:false,error:String(error.message)}; } })(),
        new Promise(resolve => { timer=setTimeout(() => resolve({ready:false,timedOut:true,frames:${frames}}), ${deadline}); })
      ]); } finally { clearTimeout(timer); }
    })()`));
  }

  async function saveCurrent() {
    if (!currentCanvasId || !canvasStore) throw new Error('Open a saved canvas before saving edits.');
    const saved = requireSavedCanvas();
    return { ...documentIdentity(saved), updatedAt: saved.updatedAt, sourcePendingReload, message: 'Authored project source is saved. Runtime DOM is not adopted by Save.' };
  }

  async function adoptCanvasDom({ expectedProjectRevision } = {}) {
    const saved = requireSavedCanvas();
    if (sourcePendingReload) throw new Error('Reload saved source before adopting runtime DOM; there are pending source edits.');
    if (expectedProjectRevision !== saved.projectRevision) throw new Error('Read list_canvas_files and supply the current expectedProjectRevision before adopting runtime DOM.');
    const generation = runtimeGeneration;
    const html = (await snapshotHtml()).replace(/<script\b[^>]*\bid=["']easel-project-snapshot["'][^>]*>[\s\S]*?<\/script\s*>/gi, '');
    if (currentCanvasId !== saved.id || runtimeGeneration !== generation || sourcePendingReload || canvasStore.get(saved.id).projectRevision !== expectedProjectRevision) throw new Error('Canvas changed while adopting runtime DOM. Read the current project and retry.');
    const updated = canvasStore.update(saved.id, html, { documentPath: currentDocumentPath || undefined });
    return { ...mutationIdentity(updated), ok: true, effects: { source: 'live DOM explicitly adopted', runtime: 'unchanged' }, warning: 'Renderer-created canvases and controls may now be part of authored HTML. Runtime variables/audio are not serialized.' };
  }

  async function inspect() {
    const snapshot = JSON.parse(await evaluate(`(() => JSON.stringify({
      title: document.title.slice(0, 240),
      text: (document.body?.innerText || '').slice(0, 4000),
      runtime: {
        toneAvailable: typeof window.Tone === 'object',
        webAudioAvailable: typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function',
        summary: window.EaselCanvas?.inspect() || { managed: false, canvasCount: document.querySelectorAll('canvas').length, limits: 'Legacy document has no lifecycle tracking.' },
      },
      images: Array.from(document.images).slice(0, 32).map((image) => ({
        alt: image.alt.slice(0, 240),
        loaded: image.complete && image.naturalWidth > 0,
        width: image.naturalWidth,
        height: image.naturalHeight,
        assetId: (image.dataset.easelAssetId || '').slice(0, 64),
      })),
      scriptImages: (window.__easelRuntimeDiagnostics?.images || []).slice(-32).map(({ image, failed }) => ({
        loaded: image.complete && image.naturalWidth > 0,
        failed,
        width: image.naturalWidth,
        height: image.naturalHeight,
        sourceType: !image.src ? 'empty' : image.src.startsWith('data:') ? 'embedded' : image.src.startsWith('blob:') ? 'blob' : 'other',
      })),
      webglErrors: (window.__easelRuntimeDiagnostics?.webglErrors || []).slice(-20),
    }))()`, 128_000));
    snapshot.consoleErrors = [...recentConsoleErrors];
    snapshot.contract = canvasContract();
    const runtimeErrors = (snapshot.runtime?.summary?.errors || []).map((error) => ({
      ...error, ...errorLocation(error.filename || error.source || '', error.lineno || error.line || 0),
    }));
    if (snapshot.runtime?.summary) snapshot.runtime.summary.errors = runtimeErrors;
    snapshot.observedErrors = {
      appRuntime: runtimeErrors.filter((error) => !['kit', 'host'].includes(error.provenance)).length,
      kit: [...runtimeErrors, ...recentConsoleErrors].filter((error) => error.provenance === 'kit' && (error.level === 'error' || error.kind === 'runtime')).length,
      webgl: snapshot.webglErrors?.length || 0,
    };
    return JSON.stringify(boundInspection(snapshot));
  }

  function canvasContract() {
    return {
      canvasId: currentCanvasId, projectId: currentCanvasId, documentPath: currentDocumentPath, previewHidden, runtimeGeneration, loading, loadedSourceValid, url: currentUrl, errorCursor: errorSequence, sourcePendingReload,
      sandbox: { network: false, filesystem: false, applicationAccess: false, workers: false, externalScripts: false, mediaSources: ['data:', 'blob:'], cameraAndMicrophone: 'Available after user permission scoped to this canvas.', deviceGrants: mediaPermissions.inspect(), inputBridge: 'Declared canvas inputs and explicitly shared media only.', audioRequiresUserGesture: true },
      persistence: { source: 'Authored project files are authoritative. Save, asset attachment and runtime probes never adopt live DOM. HTML export assembles an offline document.', runtime: 'JS variables, generated DOM, WebGL state and audio nodes do not persist. adopt_canvas_runtime_dom explicitly adopts DOM when needed.', patches: 'reload:false saves source only. reload:true also replaces the document. Existing runtime-only edits can be lost on reload.' },
      lifecycle: { api: 'window.EaselCanvas.registerApp({ id, root, renderer, scene, camera, audio, dispose, getState, restoreState })', state: 'getState must return JSON data (combined limit 16 KiB); restoreState receives it on reload. Controls restore values without firing events.', limits: 'Tracked frames, timers, listeners and audio contexts plus registered app disposal. Unregistered scene objects, library animation loops and resources cannot all be identified.' },
    };
  }

  function requireSavedCanvas() {
    if (!currentCanvasId || !canvasStore) throw new Error('Open a saved canvas before reading or patching source.');
    return canvasStore.get(currentCanvasId, { documentPath: currentDocumentPath || undefined });
  }

  function compactCanvasContract() {
    return { projectId: currentCanvasId, documentPath: currentDocumentPath, runtimeGeneration, sourcePendingReload };
  }

  async function getCanvasSource(args = {}) {
    if (!['stored', 'live'].includes(args.origin || 'stored')) throw new Error('Source origin must be stored or live.');
    const saved = requireSavedCanvas();
    const html = args.origin === 'live' ? await snapshotHtml() : saved.html;
    return JSON.stringify({ ...getSource(html, args), origin: args.origin || 'stored', contract: canvasContract(), guidance: 'Prefer list_canvas_files and read_canvas_file for original source. Compiled module wrappers are protected; use patch_canvas_file for modules. Section patches target saved HTML; use exact text and revision from origin:stored. Live DOM is an inspection snapshot. Script/style indices are zero-based and exclude protected scripts. Large sections can be read with nextOffset; omitted asset placeholders are not patch targets.' });
  }

  async function cleanupForReload() {
    invalidateRuntime('The canvas runtime is being cleaned up.');
    await cancelOutputCapture('The canvas runtime is being cleaned up.');
    return JSON.parse(await evaluate(`(async () => {
      if (!window.EaselCanvas) return { managed: false, limits: 'No lifecycle bootstrap. Reload discards the old document.' };
      return await window.EaselCanvas.cleanup();
    })()`, MAX_RESULT_BYTES, true));
  }

  async function applyCanvasPatch(args = {}) {
    for (const name of ['reload', 'cleanup', 'preserveState', 'validate']) {
      if (args[name] !== undefined && typeof args[name] !== 'boolean') throw new Error(`${name} must be a boolean.`);
    }
    const reload = args.reload === true;
    if (!reload && (args.cleanup === true || args.preserveState === true)) throw new Error('Cleanup and state preservation require reload:true. A source-only patch cannot replace live functions.');
    const saved = requireSavedCanvas();
    const patched = patchSource(saved.html, args);
    // Validate storage policy before touching the running document.
    const updated = canvasStore.update(saved.id, patched.html, { documentPath: currentDocumentPath || undefined });
    const next = canvasStore.get(saved.id, { documentPath: currentDocumentPath || undefined });
    markSourcePendingReload();
    let cleanup = null;
    let state;
    if (reload) {
      if (args.preserveState) {
        state = JSON.parse(await evaluate('window.EaselCanvas ? window.EaselCanvas.captureState() : null', 20_000));
        if (!state) throw new Error('Source saved, but this legacy canvas cannot capture managed state. Retry reload without preserveState.');
      }
      if (args.cleanup !== false) cleanup = await cleanupForReload();
      await loadHtml(next.html, saved.id, state, false, next.documentPath);
    }
    return JSON.stringify({
      ok: true, ...mutationIdentity(updated), revision: revision(next.html), effects: { source: 'saved', runtime: reload ? 'replaced' : 'unchanged' }, cleanup,
      validation: args.validate === false ? null : await validateCanvas({ since: reload ? undefined : errorSequence }),
      contract: canvasContract(),
    });
  }

  async function reloadCanvas({ cleanup = true, preserveState = false } = {}) {
    if (typeof cleanup !== 'boolean' || typeof preserveState !== 'boolean') throw new Error('Reload options must be booleans.');
    const saved = requireSavedCanvas();
    const state = preserveState ? JSON.parse(await evaluate('window.EaselCanvas ? window.EaselCanvas.captureState() : null', 20_000)) : null;
    if (preserveState && !state) throw new Error('This legacy canvas cannot capture managed state. Reload without preserveState.');
    const disposed = cleanup ? await cleanupForReload() : null;
    await loadHtml(saved.html, saved.id, state, false, saved.documentPath);
    return JSON.stringify({ ok: true, effects: { source: 'unchanged', runtime: 'replaced' }, cleanup: disposed, validation: await validateCanvas(), contract: canvasContract() });
  }

  function readProject(method, args = {}) {
    if (!currentCanvasId || !canvasStore) throw new Error('Select a project before reading source files.');
    const result = canvasStore[method](currentCanvasId, args);
    return { ...result, contract: compactCanvasContract() };
  }

  async function mutateProject(method, args = {}) {
    for (const name of ['reload', 'preserveState', 'validate']) {
      if (args[name] !== undefined && typeof args[name] !== 'boolean') throw new Error(`${name} must be a boolean.`);
    }
    if (args.preserveState && !args.reload) throw new Error('State preservation requires reload:true.');
    const saved = requireSavedCanvas();
    if (method === 'deleteFile' && args.path === currentDocumentPath) throw new Error('Open another project document before deleting the current HTML document.');
    const generation = runtimeGeneration;
    const updated = await canvasStore[method](saved.id, args);
    if (saved.id !== currentCanvasId || generation !== runtimeGeneration) throw new Error('Source saved, but the canvas changed. Reopen it to apply the edits.');
    const liveAttachment = ['attachAsset', 'attachAssets'].includes(method) && !args.reload;
    let runtimeAssetsUpdated = false, runtimeWarning;
    if (liveAttachment) {
      try { ({ runtimeAssetsUpdated } = await installProjectAssets(method === 'attachAsset' ? [args.assetId] : args.assetIds)); }
      catch (error) { markSourcePendingReload(); runtimeWarning = 'Media is attached; reload to refresh its runtime URL. ' + error.message; }
    } else markSourcePendingReload();
    let cleanup = null;
    let state;
    async function rollbackBatch(reason, attemptedValidation = null) {
      const restored = canvasStore.update(saved.id, saved.html, { documentPath: currentDocumentPath || undefined, restoreMetadata: true });
      let restoreError = '';
      try {
        await cleanupForReload();
        await loadHtml(canvasStore.get(saved.id, { documentPath: currentDocumentPath || undefined }).html, saved.id, state, false, saved.documentPath);
      } catch (error) { restoreError = error.message; }
      return { ...mutationIdentity(restored), ok: false, rolledBack: true, attemptedRevision: updated.projectRevision, attemptedValidation, effects: { source: 'previous project restored', runtime: restoreError ? 'restore failed; reopen the saved canvas' : 'previous document restored; prior runtime state only if preserveState was requested' }, error: `Batch initialization failed: ${reason}`, ...(restoreError ? { restoreError } : { validation: await validateCanvas() }), contract: canvasContract() };
    }
    if (args.reload) {
      try {
        if (args.preserveState) {
          state = JSON.parse(await evaluate('window.EaselCanvas?.captureState() || null', 20_000));
          if (!state) throw new Error('Source saved. Reload without preserveState for this legacy canvas.');
        }
        cleanup = await cleanupForReload();
        await loadHtml(canvasStore.get(saved.id, { documentPath: currentDocumentPath || undefined }).html, saved.id, state, false, saved.documentPath);
      } catch (error) {
        if (method === 'patchFiles') return rollbackBatch(error.message);
        throw error;
      }
    }
    const validation = args.validate === false ? null : await validateCanvas({ since: args.reload ? 0 : errorSequence });
    if (method === 'patchFiles' && args.reload && validation && (!validation.sourceStatus.ok || !validation.appRuntimeStatus.ok)) {
      return rollbackBatch('Observed source or app runtime errors.', validation);
    }
    return {
      ...mutationIdentity(updated), ok: true, effects: { source: 'saved', runtime: args.reload ? 'replaced' : runtimeAssetsUpdated ? 'attached media URLs refreshed' : 'unchanged' }, cleanup,
      ...(liveAttachment ? { runtimeAssetsUpdated, ...(runtimeWarning ? { runtimeWarning } : {}) } : {}),
      validation,
      contract: compactCanvasContract(),
    };
  }

  async function validateCanvas({ since = 0 } = {}) {
    if (!Number.isInteger(since) || since < 0) throw new Error('Error cursor must be a non-negative integer.');
    const saved = requireSavedCanvas();
    const syntaxErrors = [];
    let checkedScripts = 0;
    let skippedScripts = 0;
    const scripts = sourceBlocks(saved.html).filter((block) => block.type === 'script' && !block.protected);
    for (const [scriptIndex, block] of scripts.entries()) {
      if (scriptIndex >= 128) { skippedScripts += 1; continue; }
      const opening = saved.html.slice(block.start, block.contentStart);
      const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(opening)?.[1]?.toLowerCase() || '';
      if (type && !['text/javascript', 'application/javascript'].includes(type)) { skippedScripts += 1; continue; }
      const sourceFile = /data-easel-project-file=["']([^"']+)["']/i.exec(opening)?.[1] || `script-${scriptIndex}.js`;
      try { new vm.Script(saved.html.slice(block.contentStart, block.contentEnd), { filename: sourceFile }); checkedScripts += 1; }
      catch (error) { if (syntaxErrors.length < 20) syntaxErrors.push({ scriptIndex, sourceFile, sourceLine: Number(error.stack?.split('\n')[0]?.split(':').at(-1)) || null, message: error.message.slice(0, 1000) }); }
    }
    const snapshot = JSON.parse(await inspect());
    const runtimeErrors = snapshot.runtime?.summary?.errors || [];
    const consoleErrors = recentConsoleErrors.filter((error) => error.sequence > since);
    const webglErrors = snapshot.webglErrors || [];
    const warnings = [];
    if (snapshot.runtime?.summary?.canvasCount > 1) warnings.push('Multiple canvas elements are present. Check whether they are intended layers or stale renderers.');
    if (sourcePendingReload) warnings.push('Saved source has not been applied to this runtime. Validation describes the current open document separately.');
    if (snapshot.runtime?.summary?.audio?.tone?.state === 'suspended') warnings.push('Audio is suspended. A real Play click must call await Tone.start().');
    if (snapshot.runtime?.summary?.audio?.tone?.clockSource === 'worker') warnings.push('Tone is using a worker clock, which is blocked in this canvas. Set Tone.getContext().clockSource="timeout" before starting a sequence, or reopen the canvas to repair its bundled kit.');
    const appErrors = runtimeErrors.filter((error) => !['kit', 'host'].includes(error.provenance));
    const appConsole = consoleErrors.filter((error) => !['kit', 'host'].includes(error.provenance));
    const kitErrors = [...runtimeErrors, ...consoleErrors].filter((error) => error.provenance === 'kit');
    const appRuntimeOk = (snapshot.observedErrors?.appRuntime || 0) === 0 && !appConsole.some((error) => error.level === 'error');
    const renderOk = (snapshot.observedErrors?.webgl || 0) === 0;
    const audio = snapshot.runtime?.summary?.audio;
    return {
      ok: syntaxErrors.length === 0 && appRuntimeOk && renderOk,
      sourceStatus: { ok: syntaxErrors.length === 0, pendingReload: sourcePendingReload, syntaxErrors },
      appRuntimeStatus: { ok: appRuntimeOk, errorCount: snapshot.observedErrors?.appRuntime || 0, errors: appErrors, consoleErrors: appConsole },
      renderStatus: { ok: renderOk, canvasCount: snapshot.runtime?.summary?.canvasCount, webglErrors, visualCorrectness: 'Use the live screenshot; observed errors alone cannot establish visual correctness.' },
      kitStatus: { ok: (snapshot.observedErrors?.kit || 0) === 0, entries: kitErrors },
      audioStatus: { contextState: audio?.tone?.state || audio?.contexts?.[0]?.state || 'none', clockSource: audio?.tone?.clockSource || null, diagnostics: audio?.diagnostics || null, audibility: 'Unverified; signal measurements do not establish that the user heard sound.' },
      scope: { canvasId: currentCanvasId, runtimeGeneration, generationStartedAt, consoleAfterCursor: since, runtimeErrors: 'current document generation', screenshot: 'Use capture_live_canvas to inspect pixels from this exact open view.' },
      source: { revision: revision(saved.html), checkedScripts, skippedScripts, syntaxErrors, appliedToRuntime: !sourcePendingReload },
      consoleErrors, runtimeErrors, webglErrors, warnings, runtime: snapshot.runtime?.summary || snapshot.runtime, truncation: snapshot.truncation,
      limits: 'Syntax and observed runtime checks do not prove visual correctness, audio audibility, or the absence of unobserved errors. Module/data scripts are not compiled by the classic JS syntax check.',
    };
  }

  function captureIdentity() {
    const saved = requireSavedCanvas();
    return { canvasId: saved.id, documentPath: currentDocumentPath, runtimeGeneration, url: currentUrl };
  }

  async function updateProjectKits(projectId, { kits, expectedProjectRevision } = {}) {
    if (!canvasStore) throw new Error('Canvas storage is unavailable.');
    if (!Array.isArray(kits)) throw new Error('Project kit selection must be an array.');
    const active = currentCanvasId === projectId && !!currentUrl && !!currentDocumentPath;
    const identity = { documentPath: currentDocumentPath, generation: runtimeGeneration };
    const updated = canvasStore.updateManifest(projectId, { kits, expectedProjectRevision });
    const result = { ...(active ? mutationIdentity(updated) : updated), projectId, kits: updated.manifest.kits.map((kit) => kit.name), ok: true, applied: false, sourcePendingReload: active ? sourcePendingReload : false };
    if (!updated.changed || !active) return { ...result, effects: { source: updated.changed ? 'project kits saved for every HTML document' : 'unchanged', runtime: 'unchanged' } };
    markSourcePendingReload();
    let cleanup = null;
    let state = null;
    let applied = false;
    try {
      state = JSON.parse(await evaluate('window.EaselCanvas?.captureState() || null', 20_000));
      if (currentCanvasId !== projectId || currentDocumentPath !== identity.documentPath || runtimeGeneration !== identity.generation) throw new Error('The open canvas changed before its kit update could reload.');
      cleanup = await cleanupForReload();
      if (currentCanvasId !== projectId || currentDocumentPath !== identity.documentPath || runtimeGeneration !== identity.generation) throw new Error('The open canvas changed during lifecycle cleanup.');
      const saved = canvasStore.get(projectId, { documentPath: identity.documentPath });
      await loadHtml(saved.html, projectId, state, false, identity.documentPath);
      applied = true;
      const validation = await validateCanvas();
      return { ...result, applied: true, sourcePendingReload: false, preservedState: !!state, cleanup, validation, contract: canvasContract(), ...(validation.appRuntimeStatus.ok ? {} : { runtimeWarning: 'Project kits are saved and loaded. The app reports runtime errors; it may still use a kit that was disabled.' }), effects: { source: 'project kits saved for every HTML document', runtime: 'current document replaced once with managed lifecycle cleanup' } };
    } catch (error) {
      if (!applied && currentCanvasId === projectId && currentDocumentPath === identity.documentPath) markSourcePendingReload();
      return { ...result, applied, sourcePendingReload: currentCanvasId === projectId ? sourcePendingReload : false, preservedState: applied && !!state, cleanup, runtimeWarning: applied ? `Project kits are saved and loaded, but validation failed. ${error.message}` : `Project kits are saved. Reopen the canvas to apply them. ${error.message}`, contract: canvasContract(), effects: { source: 'project kits saved for every HTML document', runtime: applied ? 'current document replaced; validation unavailable' : cleanup ? 'reload failed after lifecycle cleanup' : 'unchanged; reload still required' } };
    }
  }

  function sameCaptureRuntime(identity) {
    return currentCanvasId === identity.canvasId && currentDocumentPath === identity.documentPath && runtimeGeneration === identity.runtimeGeneration && currentUrl === identity.url;
  }

  function assertCaptureRuntime(identity, signal) {
    throwIfAborted(signal);
    if (!sameCaptureRuntime(identity) || previewHidden || !hasVisibleBounds || loading || webContents.isDestroyed()) throw new Error('The canvas view changed or was hidden during capture. Open the intended document and retry.');
  }

  async function persistCapture(store, payload, identity, signal) {
    assertCaptureRuntime(identity, signal);
    // Once a local save starts, finish attachment and report its durable ID even if Stop arrives.
    const assetId = await store.save(payload);
    let attachment;
    try {
      const attached = await canvasStore.attachAsset(identity.canvasId, { assetId });
      attachment = { ok: true, reference: attached.reference, path: attached.asset.path, projectRevision: attached.projectRevision, runtimeAssetsUpdated: false };
      if (sameCaptureRuntime(identity) && !webContents.isDestroyed()) {
        try { Object.assign(attachment, await installProjectAssets([assetId])); }
        catch (error) { attachment.runtimeWarning = 'The media is saved and attached; reload to update its runtime resolver. ' + error.message; }
      }
    } catch (error) {
      attachment = { ok: false, warning: 'The capture is saved in the shared library, but project attachment failed. Attach this asset ID later. ' + error.message };
    }
    let notificationWarning;
    if (onMediaSaved) {
      try { await onMediaSaved({ assetId, canvasId: identity.canvasId, documentPath: identity.documentPath, mimeType: payload.mimeType, attachment }); }
      catch (error) { notificationWarning = 'Media is saved; the library refresh failed. ' + error.message; }
    }
    return { assetId, reference: `{{asset:${assetId}}}`, attachment, ...(notificationWarning ? { notificationWarning } : {}) };
  }

  async function cancelOutputCapture(reason = 'Canvas output recording was stopped.') {
    const capture = activeOutputCapture;
    if (!capture) return;
    capture.controller.abort(reason);
    await capture.done;
  }

  function waitForCaptureTick(milliseconds, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(abortError(signal)); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, milliseconds);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
  }

  async function recordCanvasVideo(args = {}, { signal: externalSignal } = {}) {
    const options = validateRecordingOptions(args);
    if (!mediaAssetStore) throw new Error('Canvas recording storage is unavailable.');
    if (!currentUrl || previewHidden || !hasVisibleBounds || loading) throw new Error('Open a visible HTML document before recording its canvas output.');
    if (activeOutputCapture) throw new Error('Another canvas output capture is running.');
    const identity = captureIdentity();
    const capture = { id: crypto.randomUUID(), controller: new AbortController(), identity };
    let resolveDone;
    capture.done = new Promise((resolve) => { resolveDone = resolve; });
    activeOutputCapture = capture;
    const signal = combinedSignal(externalSignal, capture.controller.signal);
    const stopRuntime = () => {
      if (sameCaptureRuntime(identity) && !webContents.isDestroyed()) evaluate(captureOperationScript(capture.id, 'cancel'), 90_000).catch(() => {});
    };
    signal.addEventListener('abort', stopRuntime, { once: true });
    const readOperation = async (method, values = [], budget = 90_000) => {
      assertCaptureRuntime(identity, signal);
      const result = JSON.parse(await evaluate(captureOperationScript(capture.id, method, values), budget));
      assertCaptureRuntime(identity, signal);
      return result;
    };
    try {
      assertCaptureRuntime(identity, signal);
      const readiness = await waitForRuntime(2);
      assertCaptureRuntime(identity, signal);
      let status = JSON.parse(await evaluate(captureStartScript(options, capture.id), 90_000));
      const deadline = Date.now() + (options.seconds + 12) * 1000;
      while (['starting', 'recording', 'finalizing'].includes(status.status)) {
        if (Date.now() > deadline) throw new Error('Canvas recording exceeded its setup/encoding deadline. Reduce its duration or dimensions.');
        await waitForCaptureTick(150, signal);
        status = await readOperation('inspect');
      }
      if (status.status !== 'done') throw new Error(status.error || 'Canvas recording did not complete.');
      if (!Number.isInteger(status.bytes) || status.bytes < 1 || status.bytes > MAX_MEDIA_BYTES || !Number.isInteger(status.sampleCount) || status.sampleCount < 1 || status.sampleCount > MAX_VIDEO_FRAMES) throw new Error('Canvas recording returned invalid media metadata.');
      const pieces = [];
      const expectedCharacters = Math.ceil(status.bytes / 3) * 4;
      let offset = 0;
      do {
        const piece = await readOperation('read', [offset, 1_048_576], 1_049_000);
        if (piece.totalCharacters !== expectedCharacters || typeof piece.data !== 'string' || piece.data.length < 1 || piece.data.length > 1_048_576 || (piece.nextOffset !== null && piece.nextOffset !== offset + piece.data.length)) throw new Error('Canvas recording data chunks are inconsistent.');
        pieces.push(piece.data);
        offset += piece.data.length;
        if (offset > expectedCharacters) throw new Error('Canvas recording exceeded its declared size.');
        if (piece.nextOffset === null) break;
      } while (offset < expectedCharacters);
      if (offset !== expectedCharacters) throw new Error('Canvas recording data is incomplete.');
      const frames = [];
      for (let index = 0; index < status.sampleCount; index += 1) frames.push(await readOperation('frame', [index], Math.ceil(MAX_FRAME_BYTES / 3) * 4 + 1024));
      let bytes = Buffer.from(pieces.join(''), 'base64');
      if (bytes.length !== status.bytes) throw new Error('Canvas recording byte count is inconsistent.');
      if (status.mimeType === 'video/webm') bytes = repairWebmDuration(bytes, status.duration);
      if (bytes.length > MAX_MEDIA_BYTES) throw new Error('Final video metadata exceeded the recording size limit. Reduce its dimensions or duration.');
      const scope = { canvasId: identity.canvasId, documentPath: identity.documentPath, runtimeGeneration: identity.runtimeGeneration, canvasIndex: options.canvasIndex, source: 'selected canvas bitmap', includesAudio: false, includesAppUI: false, includesDOMOverlays: false, transparentBackground: 'flattened to black' };
      const name = options.name || `Canvas recording.${status.mimeType === 'video/mp4' ? 'mp4' : 'webm'}`;
      const persisted = await persistCapture(mediaAssetStore, { data: bytes.toString('base64'), mimeType: status.mimeType, name, width: status.width, height: status.height, duration: status.duration, codec: status.codec, thumbnail: status.thumbnail, frames, scope }, identity, signal);
      return { ...persisted, name, mimeType: status.mimeType, bytes: bytes.length, width: status.width, height: status.height, duration: status.duration, codec: status.codec, supportedCodecs: status.supportedCodecs, canvasId: identity.canvasId, documentPath: identity.documentPath, runtimeGeneration: identity.runtimeGeneration, frames, scope, includesAudio: false, live: true, sampled: true, readiness, limits: { maxSeconds: MAX_RECORDING_SECONDS, maxBytes: MAX_MEDIA_BYTES, maxFrames: MAX_VIDEO_FRAMES, requestedFPS: options.fps, output: 'Fixed recording dimensions; CSS transforms and surrounding controls are excluded. Actual frame cadence depends on scene rendering.' }, contract: { ...canvasContract(), capture: 'Media bytes and JPEG samples persist locally. The video is attached to the project for export when attachment.ok=true; source and scene behavior are unchanged. Samples are temporary visual observations and contain no sound.' } };
    } finally {
      signal.removeEventListener('abort', stopRuntime);
      if (sameCaptureRuntime(identity) && !webContents.isDestroyed()) {
        try { await evaluate(captureOperationScript(capture.id, 'release'), 90_000); } catch {}
      }
      if (activeOutputCapture === capture) activeOutputCapture = null;
      resolveDone();
    }
  }

  async function captureLiveCanvas({ maxWidth = 1600, frames = 3 } = {}, { signal } = {}) {
    if (!currentUrl) throw new Error('Open a canvas before capturing it.');
    if (previewHidden) throw new Error('The document preview is hidden. Open its HTML document tab before capturing the live canvas.');
    if (!assetStore) throw new Error('Media storage is unavailable.');
    if (!Number.isInteger(maxWidth) || maxWidth < 320 || maxWidth > 2400) throw new Error('Screenshot width must be between 320 and 2400 pixels.');
    if (!Number.isInteger(frames) || frames < 0 || frames > 8) throw new Error('Capture frames must be between 0 and 8.');
    const identity = captureIdentity();
    assertCaptureRuntime(identity, signal);
    const readiness = await waitForRuntime(frames);
    assertCaptureRuntime(identity, signal);
    let data;
    let size;
    try {
      let image = await webContents.capturePage();
      if (image.isEmpty()) throw new Error('Empty view capture.');
      if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth });
      data = image.toPNG().toString('base64');
      size = image.getSize();
    } catch {
      // Some WebContentsView configurations have no Viz surface for capturePage; CDP captures its actual viewport.
      await ensureDebugger();
      const layout = await webContents.debugger.sendCommand('Page.getLayoutMetrics');
      const viewport = layout.cssVisualViewport || layout.visualViewport;
      if (!viewport?.clientWidth || !viewport?.clientHeight) throw new Error('The canvas has no visible viewport to capture.');
      const captured = await webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: false, captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight, scale: Math.min(1, maxWidth / viewport.clientWidth) },
      });
      if (!captured.data) throw new Error('The live canvas screenshot is empty. Make the canvas visible and try again.');
      data = captured.data;
      const bytes = Buffer.from(data, 'base64');
      size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    assertCaptureRuntime(identity, signal);
    const validation = await validateCanvas();
    const persisted = await persistCapture(assetStore, { data, mimeType: 'image/png' }, identity, signal);
    return { ...persisted, mimeType: 'image/png', data, ...size, canvasId: identity.canvasId, documentPath: identity.documentPath, runtimeGeneration: identity.runtimeGeneration, live: true, readiness, validation, scope: { source: 'current canvas view viewport', includesDOMOverlays: true, includesAppUI: false, includesAudio: false }, contract: compactCanvasContract() };
  }

  async function isEmpty() {
    const snapshot = JSON.parse(await evaluate(`(() => JSON.stringify({
      text: (document.body?.innerText || '').trim(),
      images: document.images.length,
      media: document.querySelectorAll('audio, video, canvas, svg, iframe, object').length,
    }))()`));
    return !snapshot.text && snapshot.images === 0 && snapshot.media === 0;
  }

  async function snapshotHtml() {
    return evaluate(`(() => { const clone = document.documentElement.cloneNode(true); for (const node of clone.querySelectorAll('[data-easel-transient]')) node.remove(); return clone.outerHTML; })()`, MAX_SNAPSHOT_BYTES);
  }

  async function revokeMediaAccess() {
    mediaPermissions.revoke();
    const stopped = currentUrl ? await evaluate('window.EaselCanvas?.stopMedia() || 0') : '0';
    return { ...mediaPermissions.inspect(), stoppedTracks: Number(stopped) };
  }

  async function closeCurrent({ save = true } = {}) {
    if (save && currentCanvasId) await saveCurrent();
    if (currentUrl) await cleanupForReload();
    mediaPermissions.revoke();
    runtimeGeneration += 1;
    loadedSourceValid = false;
    currentCanvasId = '';
    currentDocumentPath = '';
    previewHidden = false;
    currentUrl = '';
    sourcePendingReload = false;
    view.setVisible(false);
    await loadHostUrl('about:blank');
    return { closed: true };
  }

  async function execute(script) {
    if (typeof script !== 'string' || !script.trim()) throw new Error('Canvas JavaScript is required.');
    if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('Canvas JavaScript exceeds 16 KiB.');
    return evaluate(`(async () => {\n${script}\n})()`, MAX_RESULT_BYTES, true);
  }

  async function addImage({ assetId, alt = '', maxWidth = 80 } = {}) {
    if (typeof alt !== 'string' || alt.length > 240) throw new Error('Image alt text is invalid.');
    if (!Number.isInteger(maxWidth) || maxWidth < 10 || maxWidth > 100) throw new Error('Image width must be between 10 and 100 percent.');
    const saved = requireSavedCanvas();
    const inserted = await canvasStore.insertImage(saved.id, { assetId, alt, maxWidth, expectedProjectRevision: saved.projectRevision, documentPath: currentDocumentPath || undefined });
    markSourcePendingReload();
    const asset = await canvasStore.getAsset(saved.id, assetId);
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
      const target = ${inserted.target === 'grid' ? "document.querySelector('[data-easel-canvas]')" : 'document.body'};
      if (!target) throw new Error('Image is saved in authored source, but its container is missing from the runtime. Reload the canvas.');
      const before = ${inserted.target === 'grid' ? 'null' : "[...target.children].find((child) => child.tagName === 'SCRIPT')"};
      target.insertBefore(image, before || null);
      return JSON.stringify({ assetId: image.dataset.easelAssetId, alt: image.alt });
    })()`;
    return evaluate(expression);
  }

  function setBounds(bounds) {
    const x = Math.max(0, Math.floor(bounds.x));
    const y = Math.max(0, Math.floor(bounds.y));
    const width = Math.max(0, Math.floor(bounds.width));
    const height = Math.max(0, Math.floor(bounds.height));
    hasVisibleBounds = width > 0 && height > 0;
    if (!hasVisibleBounds) activeOutputCapture?.controller.abort('The canvas view has no visible bounds.');
    view.setBounds({ x, y, width, height });
    view.setVisible(!previewHidden && hasVisibleBounds && Boolean(currentUrl));
  }

  async function hide() {
    invalidateRuntime('The canvas preview was hidden.');
    await cancelOutputCapture('The canvas preview was hidden.');
    previewHidden = true;
    view.setVisible(false);
    mediaPermissions.invalidatePending();
    if (currentUrl) await evaluate('window.EaselCanvas?.stopMedia() || 0');
    return { id: currentCanvasId, projectId: currentCanvasId, documentPath: currentDocumentPath, hidden: true };
  }

  function destroy() {
    invalidateRuntime('The application window was closed.');
    activeOutputCapture?.controller.abort('The application window was closed.');
    if (webContents.debugger.isAttached()) webContents.debugger.detach();
    if (!webContents.isDestroyed()) webContents.close();
  }

  return {
    addImage,
    adoptCanvasDom,
    applyCanvasPatch,
    captureLiveCanvas,
    recordCanvasVideo,
    cancelCanvasRecording: cancelOutputCapture,
    closeCurrent,
    createEmpty,
    createDocument,
    ensureProject,
    destroy,
    evaluate,
    execute,
    getContract: canvasContract,
    getMediaAccess: mediaPermissions.inspect,
    allowMediaAccess: (types) => { mediaPermissions.grant(types); return mediaPermissions.inspect(); },
    getCanvasSource,
    getCurrentCanvasId: () => currentCanvasId,
    getCurrentDocumentPath: () => currentDocumentPath,
    installProjectAssets,
    listCanvasDocuments: () => ({ ...canvasStore.listDocuments(currentCanvasId), contract: compactCanvasContract() }),
    openCanvasDocument: ({ path }) => openSaved(currentCanvasId, path),
    markSourcePendingReload,
    listCanvasFiles: (args = {}) => readProject('listFiles', { includeAssets: false, ...args }),
    readCanvasFile: (args) => readProject('readFile', args),
    writeCanvasFile: (args) => mutateProject('writeFile', args),
    patchCanvasFile: (args) => mutateProject('patchFile', args),
    applyCanvasFilePatches: (args) => mutateProject('patchFiles', args),
    deleteCanvasFile: (args) => mutateProject('deleteFile', args),
    updateCanvasProject: (args) => mutateProject('updateManifest', args),
    updateProjectKits,
    attachCanvasAsset: (args) => mutateProject('attachAsset', args),
    attachCanvasAssets: (args) => mutateProject('attachAssets', args),
    getCanvasState: (args) => readProject('readProjectState', args),
    setCanvasState: (args) => mutateProject('saveProjectState', args),
    hide,
    inspect,
    isEmpty,
    openSaved,
    present,
    reloadCanvas,
    revokeMediaAccess,
    saveCurrent,
    setBounds,
    view,
    validateCanvas,
  };
}

module.exports = { MAX_RESULT_BYTES, MAX_SCRIPT_BYTES, createCanvasView };
