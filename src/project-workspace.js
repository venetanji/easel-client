function createDeleteButton(document, label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'delete-control';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'dialog');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3.5 5.5h13M7.5 5.5v-2h5v2M5 5.5l.8 11h8.4l.8-11M8 8.5v5M12 8.5v5');
  svg.append(path);
  button.append(svg);
  button.addEventListener('click', action);
  return button;
}

function createProjectWorkspace({ document, client, storage, onSelection, onStatus, onBounds, onAttach, onCreate, onFiles, onBusy, onDrawerChange, isBusy }) {
  const picker = document.getElementById('project-select');
  const drawer = document.querySelector('.library');
  const drawerToggle = document.getElementById('nav-explorer');
  const scope = document.getElementById('project-media-scope');
  const mediaList = document.getElementById('media-list');
  const documentsList = document.getElementById('canvases-list');
  const tabsElement = document.getElementById('open-canvas-tabs');
  const preview = document.getElementById('image-viewer');
  const previewImage = document.getElementById('image-viewer-image');
  const previewVideo = document.getElementById('media-viewer-video');
  const previewAudio = document.getElementById('media-viewer-audio');
  const previewInfo = document.getElementById('image-viewer-info');
  const tabStorageKey = 'easel-studio.project-tabs.v1';
  const activeStorageKey = 'easel-studio.active-project.v1';
  let projects = [];
  let projectId = '';
  let documents = [];
  let assets = [];
  let activeTab = null;
  let restored = false;
  let operation = false;
  let reportedOperation = false;
  let selectionVersion = 0;
  let mediaVersion = 0;
  let mediaUrl = '';
  let zoomed = false;
  let deletionQueue = Promise.resolve();
  const tabs = new Map();
  function read(key, fallback) { try { return JSON.parse(storage?.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
  for (const tab of read(tabStorageKey, [])) {
    if (tab && /^[a-f0-9]{32}$/.test(tab.projectId) && ['document', 'image', 'video', 'audio'].includes(tab.kind) && typeof tab.resource === 'string' && typeof tab.title === 'string') tabs.set(keyFor(tab), tab);
  }
  function keyFor(tab) { return `${tab.projectId}:${tab.kind}:${tab.resource}`; }
  function writeState() {
    try {
      storage?.setItem(tabStorageKey, JSON.stringify([...tabs.values()].slice(-100)));
      storage?.setItem(activeStorageKey, JSON.stringify(projectId));
    } catch {}
  }
  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function button(text, className, action, label = text) {
    const item = node('button', className, text);
    item.type = 'button';
    item.setAttribute('aria-label', label);
    item.addEventListener('click', () => run(action));
    item.disabled = operation || Boolean(isBusy?.());
    return item;
  }
  function report(error) { onStatus(error?.message || String(error), true); }
  function deleteButton(label, action) {
    const item = createDeleteButton(document, label, () => run(action));
    item.disabled = operation || Boolean(isBusy?.());
    return item;
  }
  async function run(action) {
    if (operation) return;
    try { await action(); } catch (error) { report(error); }
  }
  function guard() { if (isBusy?.()) throw new Error('Wait for the current reply before changing the project or viewer.'); }
  function title() { return projects.find((item) => item.id === projectId)?.title || 'Untitled project'; }
  function mediaKind(asset) { return /^(image|video|audio)\//.exec(asset.mimeType || '')?.[1] || ''; }
  function isMediaTab(tab = activeTab) { return ['image', 'video', 'audio'].includes(tab?.kind); }
  function durationLabel(duration) {
    if (!Number.isFinite(duration) || duration < 0) return '';
    return `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`;
  }
  function mediaIcon(kind, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', kind === 'video' ? 'm7 4 8 6-8 6V4Z' : kind === 'audio' ? 'M3 8v4M6.5 5v10M10 2.5v15M13.5 5v10M17 8v4' : 'M3 3h14v14H3V3Zm2 11 4-4 3 3 2-2 2 3M7 6h.1');
    svg.append(path);
    return svg;
  }
  function setDrawer(open, focus = true) {
    drawer.hidden = !open;
    document.querySelector('.conversation').inert = open;
    drawerToggle.setAttribute('aria-expanded', String(open));
    drawerToggle.setAttribute('aria-pressed', String(open));
    drawerToggle.setAttribute('aria-label', open ? 'Hide project drawer' : 'Show project drawer');
    onDrawerChange?.(open);
    if (focus) {
      if (open) drawer.querySelector('select, button')?.focus();
      else drawerToggle.focus();
    }
  }
  function hideMedia() {
    previewImage.onload = null;
    previewImage.onerror = null;
    preview.hidden = true;
    previewImage.removeAttribute('src');
    previewImage.hidden = false;
    for (const player of [previewVideo, previewAudio]) {
      player.pause();
      player.removeAttribute('src');
      player.load();
      player.hidden = true;
      player.onloadedmetadata = null;
      player.onerror = null;
    }
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    mediaUrl = '';
    zoomed = false;
    preview.dataset.zoom = 'fit';
    document.getElementById('image-size-toggle').textContent = 'Actual size';
  }
  function select(tab, metadata = {}) {
    activeTab = tab;
    if (tab) tabs.set(keyFor(tab), tab);
    writeState();
    renderTabs();
    onSelection({ ...metadata, id: projectId, projectId, projectTitle: title(),
      documentPath: tab?.kind === 'document' ? tab.resource : metadata.documentPath,
      title: tab?.title || title(), documentTitle: tab?.title || title(), previewKind: tab?.kind || 'empty',
      assetId: isMediaTab(tab) ? tab.resource : undefined });
    onBounds();
  }
  async function openDocument(path) {
    guard();
    const owner = projectId;
    const version = ++selectionVersion;
    operation = true;
    updateBusy();
    try {
      const opened = await client.openProjectDocument(owner, path);
      if (version !== selectionVersion || owner !== projectId) return;
      hideMedia();
      const entry = documents.find((item) => (item.path || item.documentPath) === path);
      select({ projectId: owner, kind: 'document', resource: path, title: opened.documentTitle || entry?.title || path }, opened);
      renderDocuments();
      onStatus('');
    } finally { operation = false; updateBusy(); }
  }
  function mediaBlob(asset) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav'].includes(asset.mimeType) || typeof asset.data !== 'string') throw new Error('This media format cannot be previewed.');
    const bytes = Uint8Array.from(atob(asset.data), (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: asset.mimeType });
  }
  async function openMedia(asset, library = false, { trustedPreview = false } = {}) {
    if (!trustedPreview) guard();
    const owner = projectId;
    const version = ++selectionVersion;
    operation = true;
    updateBusy();
    try {
      const full = library ? await client.getLibraryAsset(asset.id) : await client.getProjectAsset(owner, asset.id);
      if (version !== selectionVersion || owner !== projectId) return;
      if (!trustedPreview) await client.hideCanvasPreview();
      hideMedia();
      mediaUrl = URL.createObjectURL(mediaBlob(full));
      const kind = mediaKind(full);
      preview.setAttribute('aria-label', `Full ${kind} preview`);
      preview.hidden = false;
      previewInfo.textContent = `Loading ${kind}...`;
      const sizeToggle = document.getElementById('image-size-toggle');
      sizeToggle.hidden = kind !== 'image';
      sizeToggle.disabled = true;
      previewImage.hidden = kind !== 'image';
      if (kind === 'image') {
        previewImage.alt = full.name || asset.name || 'Project image';
        previewImage.onload = () => {
          previewInfo.textContent = `${previewImage.naturalWidth} x ${previewImage.naturalHeight} px`;
          sizeToggle.disabled = false;
        };
        previewImage.onerror = () => { previewInfo.textContent = 'The image could not be decoded.'; };
        previewImage.src = mediaUrl;
      } else {
        const player = kind === 'video' ? previewVideo : previewAudio;
        player.hidden = false;
        player.setAttribute('aria-label', full.name || asset.name || `Project ${kind}`);
        if (kind === 'video') player.poster = full.thumbnail || asset.thumbnail || '';
        player.onloadedmetadata = () => {
          previewInfo.textContent = [kind === 'video' ? `${player.videoWidth} x ${player.videoHeight} px` : 'Audio', durationLabel(Number.isFinite(player.duration) ? player.duration : full.duration)].filter(Boolean).join(' / ');
        };
        player.onerror = () => { previewInfo.textContent = `This ${kind} could not be decoded. Download it to open in another player.`; };
        player.src = mediaUrl;
      }
      select({ projectId: owner, kind, resource: asset.id, title: full.name || asset.name || `${kind[0].toUpperCase()}${kind.slice(1)} ${asset.id.slice(0, 8)}`, library });
      renderDocuments();
      onStatus('');
    } finally { operation = false; updateBusy(); }
  }
  async function refreshAssets() {
    const owner = projectId;
    const library = scope.value === 'library';
    const version = ++mediaVersion;
    const current = owner ? await client.getProjectAssets(owner) : [];
    if (version !== mediaVersion || owner !== projectId) return;
    assets = Array.isArray(current) ? current : current.assets || [];
    const all = library ? await client.listAssets() : assets;
    if (version !== mediaVersion || owner !== projectId) return;
    const attached = new Set(assets.map((asset) => asset.id));
    mediaList.replaceChildren(...all.filter((asset) => mediaKind(asset)).map((asset) => {
      const inProject = attached.has(asset.id);
      const kind = mediaKind(asset);
      const figure = node('article', 'project-media-item');
      const thumbnail = button('', 'project-thumbnail', () => openMedia(asset, !inProject), `Open ${asset.name || kind} in viewer`);
      const poster = asset.thumbnail || asset.thumbnailDataUrl;
      if (poster) {
        const image = node('img');
        image.src = poster;
        image.alt = '';
        image.loading = 'lazy';
        thumbnail.append(image);
      } else thumbnail.append(mediaIcon(kind, 'project-thumbnail-placeholder'));
      if (kind !== 'image') {
        const badge = node('span', 'project-thumbnail-kind');
        badge.append(mediaIcon(kind), node('span', '', durationLabel(asset.duration) || (kind === 'video' ? 'Video' : 'Audio')));
        thumbnail.append(badge);
      }
      const label = node('p', 'project-media-name', asset.name || `Media ${asset.id.slice(0, 8)}`);
      label.title = label.textContent;
      const actions = node('div', 'project-media-actions');
      if (!inProject) actions.append(button('Add to project', 'button quiet small', () => addToProject(asset)));
      actions.append(button('Use in chat', 'button quiet small', () => attachMedia(asset, !inProject)));
      actions.append(button('Download', 'button quiet small', () => downloadMedia(asset.id, !inProject)));
      const heading = node('div', 'project-media-heading');
      heading.append(label, deleteButton(`${library ? 'Delete from library' : 'Remove from project'}: ${label.textContent}`, () => deleteMedia(asset.id, library)));
      figure.append(thumbnail, heading, actions);
      return figure;
    }));
    const empty = document.getElementById('media-empty');
    empty.hidden = mediaList.children.length > 0;
    empty.textContent = scope.value === 'library' ? 'No saved media yet.' : owner ? 'Generated media and captures appear here. Browse All media to add an existing asset.' : 'Open or create a project to collect its files and media.';
    document.getElementById('project-image-count').textContent = String(assets.filter((asset) => mediaKind(asset)).length);
  }
  async function addToProject(asset) {
    guard();
    if (!projectId) throw new Error('Create or open a project first.');
    const owner = projectId;
    operation = true;
    updateBusy();
    try {
      await client.attachProjectAsset(owner, asset.id);
      if (owner === projectId) await refreshAssets();
      onStatus('Media added to project.');
    } finally { operation = false; updateBusy(); }
  }
  async function attachMedia(asset, library = false) {
    guard();
    const owner = projectId;
    const full = library ? await client.getLibraryAsset(asset.id) : await client.getProjectAsset(owner, asset.id);
    if (owner !== projectId) throw new Error('The project changed. Choose the media again.');
    guard();
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }[full.mimeType];
    const name = full.name || asset.name || `Media-${asset.id.slice(0, 8)}.${extension}`;
    setDrawer(false);
    onAttach(new File([mediaBlob(full)], name, { type: full.mimeType }));
  }
  async function downloadMedia(id, library = false) {
    const result = library ? await client.saveLibraryAsset(id) : await client.saveProjectAsset(projectId, id);
    if (!result?.canceled) onStatus('Media downloaded.');
  }
  async function deleteFile(path) {
    guard();
    const owner = projectId;
    if (!owner) return;
    operation = true;
    updateBusy();
    let deleted = false;
    try {
      const result = await client.deleteProjectFile(owner, { path });
      if (!result?.deleted) return;
      deleted = true;
      await acceptDeletion({ ...result, type: 'project-file-deleted', projectId: owner, deletedPath: path });
      onStatus(`Deleted ${path}.`);
    } finally {
      operation = false;
      updateBusy();
      if (deleted && owner === projectId && !drawer.hidden) documentsList.querySelector('button')?.focus();
    }
  }
  async function deleteMedia(assetId, library) {
    guard();
    const owner = projectId;
    operation = true;
    updateBusy();
    let deleted = false;
    try {
      const result = library ? await client.deleteLibraryAsset(assetId) : await client.deleteProjectAsset(owner, assetId);
      if (!result?.deleted) return;
      deleted = true;
      await acceptDeletion({ ...result, type: 'media-deleted', scope: library ? 'library' : 'project', projectId: owner, assetId });
      onStatus(library ? 'Deleted media from the library. Project copies are kept.' : 'Removed media from this project. The library copy is kept.');
    } finally {
      operation = false;
      updateBusy();
      if (deleted && owner === projectId && !drawer.hidden) (mediaList.querySelector('button') || scope).focus();
    }
  }
  function renderDocuments() {
    documentsList.replaceChildren(...documents.map((entry) => {
      const path = entry.path || entry.documentPath;
      const item = button(entry.title || path, 'project-document', () => openDocument(path));
      item.title = path;
      item.setAttribute('aria-current', String(activeTab?.kind === 'document' && activeTab.resource === path));
      const detail = node('small', '', path);
      item.append(detail);
      const row = node('div', 'project-file-row');
      row.append(item, deleteButton(`Delete ${path}`, () => deleteFile(path)));
      return row;
    }));
    document.getElementById('canvases-empty').hidden = documents.length > 0;
    document.getElementById('canvases-empty').textContent = projectId ? 'Create an HTML canvas in this project.' : 'Select a project above to browse its documents.';
  }
  function renderPicker() {
    const placeholder = node('option', '', 'Select a project');
    placeholder.value = '';
    picker.replaceChildren(placeholder, ...projects.map((project) => {
      const option = node('option', '', project.title);
      option.value = project.id;
      return option;
    }));
    picker.value = projectId;
    document.getElementById('project-rename').disabled = !projectId || operation || Boolean(isBusy?.());
  }
  function renderTabs() {
    const visible = [...tabs.values()].filter((tab) => tab.projectId === projectId);
    tabsElement.replaceChildren(...visible.map((tab) => {
      const group = node('div', 'canvas-tab');
      group.dataset.active = String(activeTab && keyFor(tab) === keyFor(activeTab));
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', tab.title);
      const selectButton = button(tab.title, 'canvas-tab-select', () => tab.kind === 'document' ? openDocument(tab.resource) : openMedia({ id: tab.resource, name: tab.title }, tab.library));
      selectButton.setAttribute('aria-pressed', group.dataset.active);
      selectButton.title = tab.kind === 'document' ? tab.resource : tab.title;
      const close = button('', 'canvas-tab-close', () => closeTab(tab), `Close ${tab.title}`);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm4 4 8 8M12 4l-8 8');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      svg.append(path);
      close.append(svg);
      group.append(selectButton, close);
      return group;
    }));
    tabsElement.hidden = visible.length === 0;
  }
  async function closeTab(tab) {
    guard();
    const remaining = [...tabs.values()].filter((entry) => entry.projectId === projectId && keyFor(entry) !== keyFor(tab));
    if (activeTab && keyFor(tab) === keyFor(activeTab)) {
      const next = remaining.at(-1);
      if (next) {
        if (next.kind === 'document') await openDocument(next.resource);
        else await openMedia({ id: next.resource, name: next.title }, next.library);
      } else {
        await client.hideCanvasPreview();
        hideMedia();
        select(null);
      }
    }
    tabs.delete(keyFor(tab));
    writeState();
    renderTabs();
  }
  async function loadProjectContents(owner) {
    const [result, source] = await Promise.all([client.listProjectDocuments(owner), client.listCanvasFiles(owner)]);
    if (owner !== projectId) return;
    documents = Array.isArray(result) ? result : result.documents || [];
    const paths = new Set(documents.map((entry) => entry.path || entry.documentPath));
    for (const [key, tab] of tabs) if (tab.projectId === owner && tab.kind === 'document' && !paths.has(tab.resource)) tabs.delete(key);
    renderDocuments();
    const files = (source.files || []).filter((file) => !/\.html?$/i.test(file.path));
    document.getElementById('project-source-files').replaceChildren(...files.map((file) => {
      const item = button(file.path, 'project-source-file', () => onFiles(file.path));
      item.title = `${file.path} - ${Number(file.bytes || 0).toLocaleString()} bytes`;
      const row = node('div', 'project-file-row');
      row.append(item, deleteButton(`Delete ${file.path}`, () => deleteFile(file.path)));
      return row;
    }));
    if (!files.length) document.getElementById('project-source-files').append(node('p', 'empty-library', 'Shared scripts and styles appear here.'));
    await refreshAssets();
  }
  async function openProject(id, documentPath) {
    guard();
    if (!id) return;
    const version = ++selectionVersion;
    operation = true;
    updateBusy();
    try {
      if (!projects.some((project) => project.id === id)) projects = await client.listCanvases();
      if (version !== selectionVersion) return;
      const listing = await client.listProjectDocuments(id);
      const entries = Array.isArray(listing) ? listing : listing.documents || [];
      const saved = [...tabs.values()].filter((tab) => tab.projectId === id).at(-1);
      const path = documentPath || (saved?.kind === 'document' ? saved.resource : '') || entries[0]?.path || entries[0]?.documentPath;
      if (!path) throw new Error('This project has no HTML document to open.');
      // Select the host project before displaying its media, so chat targets the same folder.
      client.setCanvasBounds({ x: 0, y: 0, width: 0, height: 0 });
      const opened = await client.openProjectDocument(id, path);
      if (version !== selectionVersion) return;
      projectId = id;
      hideMedia();
      documents = entries;
      renderPicker();
      select({ projectId: id, kind: 'document', resource: path, title: opened.documentTitle || path }, opened);
      await loadProjectContents(id);
      if (version !== selectionVersion || id !== projectId) return;
      if (!documentPath && isMediaTab(saved)) await openMedia({ id: saved.resource, name: saved.title }, saved.library);
    } finally { operation = false; updateBusy(); onBounds(); }
  }
  async function refreshProjects(restore = true) {
    projects = await client.listCanvases();
    renderPicker();
    if (projectId) await loadProjectContents(projectId);
    if (restore && !restored) {
      restored = true;
      const legacy = read('easel-studio.open-canvases.v1', []).at(-1);
      const saved = read(activeStorageKey, '') || legacy;
      if (projects.some((project) => project.id === saved)) await openProject(saved);
    }
  }
  async function changed(metadata) {
    const id = metadata.projectId || metadata.canvasId || metadata.id;
    if (!id) return refreshProjects(false);
    const version = ++selectionVersion;
    projects = await client.listCanvases();
    if (version !== selectionVersion) return;
    if (id === projectId && metadata.previewHidden && activeTab?.kind !== 'document') {
      renderPicker();
      await loadProjectContents(id);
      select(activeTab, metadata);
      return;
    }
    projectId = id;
    hideMedia();
    renderPicker();
    await loadProjectContents(id);
    if (version !== selectionVersion || id !== projectId) return;
    const path = metadata.documentPath || documents[0]?.path || documents[0]?.documentPath;
    select(path ? { projectId: id, kind: 'document', resource: path, title: metadata.documentTitle || metadata.title || path } : null, metadata);
    renderDocuments();
  }
  async function assetsChanged(metadata) {
    const id = metadata.projectId || metadata.canvasId;
    if (!id) return refreshAssets();
    projects = await client.listCanvases();
    if (metadata.createdProject && !projectId) {
      projectId = id;
      await client.hideCanvasPreview();
      hideMedia();
      renderPicker();
      select(null);
      await loadProjectContents(id);
    } else if (id === projectId) {
      renderPicker();
      await refreshAssets();
    }
  }
  function acceptDeletion(event) {
    const update = async () => {
      const file = event.type === 'project-file-deleted';
      if (event.scope === 'library' || event.projectId === projectId) selectionVersion += 1;
      const matches = (tab) => file
        ? tab.projectId === event.projectId && tab.kind === 'document' && tab.resource === event.deletedPath
        : isMediaTab(tab) && tab.resource === event.assetId && (event.scope === 'library' ? tab.library : !tab.library && tab.projectId === event.projectId);
      const removedActive = activeTab && matches(activeTab) ? activeTab : null;
      for (const [key, tab] of tabs) if (matches(tab)) tabs.delete(key);
      if (removedActive) {
        hideMedia();
        select(null);
      } else { writeState(); renderTabs(); }
      await refreshProjects(false);
      if (!projectId) await refreshAssets();
      if (event.projectId === projectId && file) {
        const opened = event.opened || event;
        const path = opened.documentPath;
        if (path && documents.some((entry) => (entry.path || entry.documentPath) === path) && (removedActive || activeTab?.kind === 'document')) {
          hideMedia();
          select({ projectId, kind: 'document', resource: path, title: opened.documentTitle || documents.find((entry) => (entry.path || entry.documentPath) === path)?.title || path }, opened);
        } else if (!removedActive) select(activeTab, event);
        renderDocuments();
      }
      updateBusy();
      onBounds();
    };
    const result = deletionQueue.then(update);
    deletionQueue = result.catch(() => {});
    return result;
  }
  async function previewMedia(event) {
    if (!event.asset?.id) throw new Error('The media preview is missing its asset reference.');
    if (event.projectId && event.projectId !== projectId) {
      projects = await client.listCanvases();
      projectId = event.projectId;
      renderPicker();
      await loadProjectContents(projectId);
    }
    await openMedia(event.asset, event.scope === 'library', { trustedPreview: true });
  }
  async function create(kind, name, kits) {
    guard();
    operation = true;
    updateBusy();
    try {
      const result = kind === 'rename' ? await client.renameProject(projectId, { title: name })
        : kind === 'project' || !projectId ? await client.createProject({ title: name, kits })
        : await client.createProjectDocument(projectId, { title: name, kits });
      projects = await client.listCanvases();
      if (kind === 'rename') {
        renderPicker();
        select(activeTab, result);
      } else await openProject(result.projectId || result.id, result.documentPath);
      return result;
    } finally { operation = false; updateBusy(); }
  }
  async function exportCurrent() {
    if (!projectId && !isMediaTab()) throw new Error('Open a project first.');
    const result = isMediaTab()
      ? activeTab.library ? await client.saveLibraryAsset(activeTab.resource) : await client.saveProjectAsset(projectId, activeTab.resource)
      : await client.exportProject(projectId);
    if (!result?.canceled) onStatus(isMediaTab() ? 'Media downloaded.' : 'Project exported as ZIP.');
  }
  function updateBusy() {
    if (reportedOperation !== operation) {
      reportedOperation = operation;
      onBusy?.(operation);
    }
    const busy = operation || Boolean(isBusy?.());
    picker.disabled = busy;
    for (const element of document.querySelectorAll('.project-document, .project-source-file, .library .delete-control, .project-media-actions button, .project-thumbnail, .canvas-tab button, #project-new, #project-rename, #drawer-new-document')) element.disabled = busy;
    document.getElementById('project-rename').disabled = busy || !projectId;
    document.getElementById('image-use-chat').disabled = busy || !isMediaTab();
  }
  drawerToggle.addEventListener('click', () => setDrawer(drawer.hidden));
  document.getElementById('library-collapse').addEventListener('click', () => setDrawer(false));
  document.getElementById('project-new').addEventListener('click', () => onCreate('project'));
  document.getElementById('project-rename').addEventListener('click', () => onCreate('rename', title()));
  document.getElementById('drawer-new-document').addEventListener('click', () => onCreate('document'));
  picker.addEventListener('change', () => run(async () => { try { await openProject(picker.value); } finally { picker.value = projectId; } }));
  scope.addEventListener('change', () => run(refreshAssets));
  document.getElementById('image-use-chat').addEventListener('click', () => run(() => attachMedia({ id: activeTab.resource, name: activeTab.title }, activeTab.library)));
  document.getElementById('image-size-toggle').addEventListener('click', () => {
    zoomed = !zoomed;
    preview.dataset.zoom = zoomed ? 'actual' : 'fit';
    document.getElementById('image-size-toggle').textContent = zoomed ? 'Fit image' : 'Actual size';
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !drawer.hidden && !document.querySelector('dialog[open]')) setDrawer(false); });
  setDrawer(false, false);
  return { refreshProjects, refreshAssets, openProject, openDocument, changed, assetsChanged, acceptDeletion, previewMedia, create, exportCurrent, updateBusy,
    getProjectId: () => projectId, getPreviewKind: () => activeTab?.kind || 'empty', isOperating: () => operation, setDrawer };
}

if (typeof module !== 'undefined') module.exports = { createDeleteButton, createProjectWorkspace };
