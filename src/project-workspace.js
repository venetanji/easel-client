const WorkspaceActionIcons = typeof module !== 'undefined' ? require('./ui-icons') : EaselUiIcons;
const WorkspaceTimelineMediaType = /^(?:video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|image\/(?:png|jpeg|webp|gif|avif|bmp))$/i;

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

function createProjectWorkspace({ document, client, storage, onSelection, onStatus, onBounds, onAttach, onCreate, onFiles, onDevices, onBusy, onDrawerChange, isBusy }) {
  const picker = document.getElementById('project-select');
  const drawer = document.querySelector('.library');
  const drawerToggle = document.getElementById('nav-explorer');
  const mediaDrawer = document.getElementById('media-drawer');
  const mediaDrawerToggle = document.getElementById('nav-media');
  const templatesDrawer = document.getElementById('templates-drawer');
  const templatesDrawerToggle = document.getElementById('nav-templates');
  const mediaList = document.getElementById('media-list');
  const allMediaList = document.getElementById('all-media-list');
  const mediaSearch = document.getElementById('media-search');
  const mediaTypeFilter = document.getElementById('media-type-filter');
  const mediaSort = document.getElementById('media-sort');
  const mediaFiltersReset = document.getElementById('media-filters-reset');
  const mediaNameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const mediaUnreadBadge = document.getElementById('media-unread');
  const mediaGenerationIndicator = document.getElementById('media-generating');
  const projectKitList = document.getElementById('project-kit-list');
  const projectKitStatus = document.getElementById('project-kit-status');
  const documentsList = document.getElementById('canvases-list');
  const tabsElement = document.getElementById('open-canvas-tabs');
  const preview = document.getElementById('image-viewer');
  const previewImage = document.getElementById('image-viewer-image');
  const previewVideo = document.getElementById('media-viewer-video');
  const previewAudio = document.getElementById('media-viewer-audio');
  const previewInfo = document.getElementById('image-viewer-info');
  const tabStorageKey = 'easel-studio.project-tabs.v1';
  const activeStorageKey = 'easel-studio.active-project.v1';
  const mediaNoticeStorageKey = 'easel-studio.media-notices.v1';
  const mediaSeenStorageKey = 'easel-studio.media-seen.v1';
  let projects = [];
  let projectId = '';
  let selectedProjectId = '';
  let documents = [];
  let assets = [];
  let libraryAssets = [];
  let kitCatalog = [];
  let kitCatalogPromise;
  let projectKits = ['canvas-2d', 'tone'];
  let projectRevision = '';
  let kitsVersion = 0;
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
  const mediaNotices = new Map(read(mediaNoticeStorageKey, []).filter((entry) => /^[a-f0-9]{32}$/.test(entry?.assetId) && ['image', 'video', 'audio'].includes(entry.kind)).slice(-256).map((entry) => [entry.assetId, entry]));
  const knownMedia = new Set([...read(mediaSeenStorageKey, []).filter((id) => /^[a-f0-9]{32}$/.test(id)).slice(-1024), ...mediaNotices.keys()]);
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
    item.disabled = operation || selectedProjectId !== projectId || Boolean(isBusy?.());
    return item;
  }
  function iconButton(label, icon, action) {
    return WorkspaceActionIcons.setActionIcon(document, button('', 'icon-button', action, label), icon, label);
  }
  function report(error) { onStatus(error?.message || String(error), true); }
  function deleteButton(label, action) {
    const item = createDeleteButton(document, label, () => run(action));
    item.disabled = operation || selectedProjectId !== projectId || Boolean(isBusy?.());
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
  function updateMediaActivity(unread = [...mediaNotices.values()].filter((notice) => !notice.acknowledged).length) {
    const active = new Set([...assets, ...libraryAssets]
      .filter((asset) => asset.kind === 'job' && ['queued', 'generating', 'downloading'].includes(asset.job?.status))
      .map((asset) => asset.job.id)).size;
    if (mediaGenerationIndicator) mediaGenerationIndicator.hidden = active === 0;
    const open = !mediaDrawer.hidden;
    const progress = active ? `, ${active} media ${active === 1 ? 'job' : 'jobs'} in progress` : '';
    mediaDrawerToggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} media${unread ? `, ${unread} new ${unread === 1 ? 'asset' : 'assets'}` : ''}${progress}`);
    mediaDrawerToggle.title = `Media${progress}`;
  }
  function updateMediaNotices() {
    const unread = [...mediaNotices.values()].filter((notice) => !notice.acknowledged).length;
    if (mediaUnreadBadge) {
      mediaUnreadBadge.hidden = unread === 0;
      mediaUnreadBadge.textContent = unread > 99 ? '99+' : String(unread);
    }
    updateMediaActivity(unread);
    try { storage?.setItem(mediaNoticeStorageKey, JSON.stringify([...mediaNotices.values()].slice(-256))); } catch {}
    try { storage?.setItem(mediaSeenStorageKey, JSON.stringify([...knownMedia].slice(-1024))); } catch {}
    const newest = [...mediaNotices.values()].at(-1)?.assetId;
    for (const list of [mediaList, allMediaList]) {
      for (const card of list.children) {
        const badge = card.querySelector('.project-thumbnail-new');
        if (badge) badge.hidden = card.dataset.assetId !== newest;
      }
    }
  }
  function announceMediaReady(event) {
    const job = event.job || event;
    if (job.status && job.status !== 'ready') return;
    for (const asset of event.assets || job.assets || []) {
      const assetId = asset.assetId || asset.id;
      const kind = mediaKind(asset);
      if (!/^[a-f0-9]{32}$/.test(assetId || '') || !kind || knownMedia.has(assetId)) continue;
      knownMedia.add(assetId);
      mediaNotices.set(assetId, { assetId, kind, acknowledged: !mediaDrawer.hidden });
    }
    updateMediaNotices();
  }
  function markMediaSeen(assetId) { if (/^[a-f0-9]{32}$/.test(assetId || '')) knownMedia.add(assetId); mediaNotices.delete(assetId); updateMediaNotices(); }
  function setDrawer(open, focus = true, kind = 'files') {
    const showMedia = open && kind === 'media';
    const showTemplates = open && kind === 'templates';
    const showFiles = open && kind === 'files';
    const target = kind === 'templates' ? templatesDrawer : kind === 'media' ? mediaDrawer : drawer;
    const toggle = kind === 'templates' ? templatesDrawerToggle : kind === 'media' ? mediaDrawerToggle : drawerToggle;
    drawer.hidden = !showFiles;
    drawer.inert = !showFiles;
    mediaDrawer.hidden = !showMedia;
    mediaDrawer.inert = !showMedia;
    if (templatesDrawer) { templatesDrawer.hidden = !showTemplates; templatesDrawer.inert = !showTemplates; }
    templatesDrawerToggle?.setAttribute('aria-expanded', String(showTemplates));
    templatesDrawerToggle?.setAttribute('aria-pressed', String(showTemplates));
    templatesDrawerToggle?.setAttribute('aria-label', showTemplates ? 'Hide templates' : 'Show templates');
    document.querySelector('.conversation').inert = open;
    drawerToggle.setAttribute('aria-expanded', String(showFiles));
    drawerToggle.setAttribute('aria-pressed', String(showFiles));
    drawerToggle.setAttribute('aria-label', showFiles ? 'Hide project files' : 'Show project files');
    mediaDrawerToggle.setAttribute('aria-expanded', String(showMedia));
    mediaDrawerToggle.setAttribute('aria-pressed', String(showMedia));
    mediaDrawerToggle.setAttribute('aria-label', showMedia ? 'Hide media' : 'Show media');
    if (showMedia) for (const notice of mediaNotices.values()) notice.acknowledged = true;
    updateMediaNotices();
    onDrawerChange?.(open, kind);
    if (focus) {
      if (open) (Array.from(target.querySelectorAll('button')).find((button) => !button.disabled) || target).focus();
      else toggle.focus();
    }
  }
  function setMediaDrawer(open, focus = true) { setDrawer(open, focus, 'media'); }
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
  async function openMedia(asset, library = false, { trustedPreview = false, onlyWhenEmpty = false, canOpen } = {}) {
    if (!trustedPreview) guard();
    const owner = projectId;
    const version = ++selectionVersion;
    operation = true;
    updateBusy();
    try {
      const full = library ? await client.getLibraryAsset(asset.id) : await client.getProjectAsset(owner, asset.id);
      if (version !== selectionVersion || owner !== projectId || (onlyWhenEmpty && (activeTab || isBusy?.() || canOpen?.() === false))) return false;
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
      markMediaSeen(asset.id);
      renderDocuments();
      onStatus('');
      return true;
    } finally { operation = false; updateBusy(); }
  }
  async function refreshAssets() {
    const owner = projectId;
    const version = ++mediaVersion;
    let [current, all] = await Promise.all([owner ? client.getProjectAssets(owner) : [], client.listAssets()]);
    if (version !== mediaVersion || owner !== projectId) return;
    const currentAssets = new Map();
    let offset = 0;
    while (true) {
      for (const asset of Array.isArray(current) ? current : current.assets || []) currentAssets.set(`${asset.kind || 'asset'}:${asset.id}`, asset);
      if (Array.isArray(current) || current.nextOffset == null) break;
      if (!Number.isInteger(current.nextOffset) || current.nextOffset <= offset) throw new Error('Project media pagination did not advance. Try reopening the project.');
      offset = current.nextOffset;
      current = await client.getProjectAssets(owner, { offset, limit: 200 });
      if (version !== mediaVersion || owner !== projectId) return;
    }
    assets = [...currentAssets.values()];
    libraryAssets = Array.isArray(all) ? all : all.assets || [];
    renderAssets();
  }
  function mediaFilters() {
    return {
      terms: (mediaSearch?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean),
      type: ['image', 'video', 'audio'].includes(mediaTypeFilter?.value) ? mediaTypeFilter.value : 'all',
      sort: ['oldest', 'name', 'duration', 'size'].includes(mediaSort?.value) ? mediaSort.value : 'newest',
    };
  }
  function visibleMedia(collection, filters) {
    const numericValue = (asset) => {
      if (filters.sort === 'size') return Number.isFinite(asset.bytes) && asset.bytes >= 0 ? asset.bytes : null;
      if (filters.sort === 'duration') return ['audio', 'video'].includes(mediaKind(asset)) && Number.isFinite(asset.duration) && asset.duration >= 0 ? asset.duration : null;
      return [asset.createdAt, asset.job?.createdAt, asset.updatedAt, asset.job?.updatedAt].find((value) => Number.isFinite(value) && value >= 0) ?? null;
    };
    return collection.filter((asset) => {
      if (filters.type !== 'all' && mediaKind(asset) !== filters.type) return false;
      const text = [asset.name, asset.path, asset.id, asset.mimeType, asset.codec, asset.job?.name, asset.job?.prompt]
        .filter((value) => typeof value === 'string').join(' ').toLowerCase();
      return filters.terms.every((term) => text.includes(term));
    }).map((asset, index) => ({ asset, index })).sort((left, right) => {
      if (filters.sort === 'name') return mediaNameOrder.compare(left.asset.name || left.asset.path || left.asset.id, right.asset.name || right.asset.path || right.asset.id) || left.index - right.index;
      const a = numericValue(left.asset);
      const b = numericValue(right.asset);
      // Missing metadata stays after known values for either sort direction.
      if (a === null || b === null) return (a === null) - (b === null) || left.index - right.index;
      return (filters.sort === 'oldest' ? a - b : b - a) || left.index - right.index;
    }).map(({ asset }) => asset);
  }
  function renderAssets() {
    const attached = new Set(assets.map((asset) => asset.id));
    const filters = mediaFilters();
    const filtering = filters.terms.length > 0 || filters.type !== 'all';
    const currentMedia = assets.filter((asset) => mediaKind(asset));
    const libraryMedia = libraryAssets.filter((asset) => mediaKind(asset));
    const current = visibleMedia(currentMedia, filters);
    const all = visibleMedia(libraryMedia, filters);
    mediaList.replaceChildren(...current.map((asset) => asset.kind === 'job' ? jobCard(asset) : mediaCard(asset, false, true)));
    allMediaList.replaceChildren(...all.map((asset) => asset.kind === 'job' ? jobCard(asset) : mediaCard(asset, true, attached.has(asset.id))));
    const empty = document.getElementById('media-empty');
    empty.hidden = current.length > 0;
    const noMatches = 'No media matches these filters. Try another search or reset the filters.';
    empty.textContent = !projectId ? 'Select a project to collect media. All media is available below.'
      : currentMedia.length && filtering ? noMatches : 'Generated media appears here. Add a reference from All media below.';
    const allEmpty = document.getElementById('all-media-empty');
    allEmpty.hidden = all.length > 0;
    allEmpty.textContent = libraryMedia.length && filtering ? noMatches : 'Generated media and captures will be saved here, ready to use in any project.';
    for (const [id, matched, total] of [['project-image-count', current.length, currentMedia.length], ['all-media-count', all.length, libraryMedia.length]]) {
      const count = document.getElementById(id);
      count.textContent = filtering ? `${matched} / ${total}` : String(total);
      count.setAttribute('aria-label', filtering ? `${matched} of ${total} media items` : `${total} media items`);
    }
    if (mediaFiltersReset) mediaFiltersReset.disabled = !mediaSearch?.value && !filtering && filters.sort === 'newest';
    updateMediaNotices();
    updateBusy();
  }
  function mediaCard(asset, library, inProject) {
    const kind = mediaKind(asset);
    const figure = node('article', 'project-media-item');
    figure.dataset.assetId = asset.id;
    const thumbnail = button('', 'project-thumbnail', () => openMedia(asset, library), `Open ${asset.name || kind} in viewer`);
    const poster = asset.thumbnail || asset.thumbnailDataUrl;
    if (poster) {
      const image = node('img');
      image.src = poster;
      image.alt = '';
      image.loading = 'lazy';
      image.draggable = false;
      thumbnail.append(image);
    } else thumbnail.append(mediaIcon(kind, 'project-thumbnail-placeholder'));
    if (/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(asset.id) && WorkspaceTimelineMediaType.test(asset.mimeType || '')) {
      figure.dataset.mediaDragSource = 'true';
      thumbnail.title = 'Drag to a timeline track, or click to preview';
      const grip = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of Object.entries({ class: 'project-media-drag-hint', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' })) grip.setAttribute(name, value);
      for (const [x, y] of [[5, 4], [11, 4], [5, 8], [11, 8], [5, 12], [11, 12]]) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 1);
        grip.append(dot);
      }
      thumbnail.append(grip);
      figure.addEventListener('dragstart', (event) => {
        if (!figure.draggable || operation || selectedProjectId !== projectId || isBusy?.() || !event.dataTransfer || actions.contains(event.target) || trash.contains(event.target)) {
          event.preventDefault();
          delete figure.dataset.dragging;
          return;
        }
        try {
          event.dataTransfer.clearData();
          event.dataTransfer.setData('application/x-easel-media-asset', JSON.stringify({ assetId: asset.id }));
          event.dataTransfer.effectAllowed = 'copy';
          figure.dataset.dragging = 'true';
        } catch {
          event.preventDefault();
          delete figure.dataset.dragging;
        }
      });
      figure.addEventListener('dragend', () => { delete figure.dataset.dragging; });
    }
    const fresh = node('span', 'project-thumbnail-new', `New ${kind}`);
    fresh.hidden = !mediaNotices.has(asset.id);
    thumbnail.append(fresh);
    if (kind !== 'image') {
      const badge = node('span', 'project-thumbnail-kind');
      badge.append(mediaIcon(kind), node('span', '', durationLabel(asset.duration) || (kind === 'video' ? 'Video' : 'Audio')));
      thumbnail.append(badge);
    }
    const label = node('p', 'project-media-name', asset.name || `Media ${asset.id.slice(0, 8)}`);
    label.title = label.textContent;
    const actions = node('div', 'project-media-actions');
    if (library) {
      if (inProject) {
        const attached = node('span', 'media-in-project', 'In project');
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [name, value] of Object.entries({ viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) check.setAttribute(name, value);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'm3 8 3 3 7-7');
        check.append(path);
        attached.append(check);
        actions.append(attached);
      }
      else {
        const add = button('Add to project', 'button quiet small', () => addToProject(asset));
        add.dataset.requiresProject = 'true';
        add.disabled ||= !projectId;
        if (!projectId) add.title = 'Select a project first';
        actions.append(add);
      }
    }
    actions.append(iconButton('Use in chat', 'useInChat', () => attachMedia(asset, library)));
    actions.append(iconButton('Download', 'download', () => downloadMedia(asset.id, library)));
    const heading = node('div', 'project-media-heading');
    const trash = deleteButton(`${library ? 'Delete from library' : 'Remove from project'}: ${label.textContent}`, () => deleteMedia(asset.id, library));
    if (library && (inProject || asset.referenceCount > 0 || asset.projectIds?.length)) {
      trash.dataset.referenced = 'true';
      trash.disabled = true;
      trash.title = 'Remove this media from its projects before deleting it from the library.';
    }
    heading.append(label, trash);
    figure.append(thumbnail, heading, actions);
    return figure;
  }
  function updateMediaJob(job) {
    if (!job?.id || job.status === 'ready') return false;
    let found = false;
    let updated;
    for (const collection of [assets, libraryAssets]) {
      const asset = collection.find((item) => item.kind === 'job' && item.job.id === job.id);
      if (asset) { asset.job = { ...asset.job, ...job }; updated = asset.job; found = true; }
    }
    if (!found) return false;
    for (const list of [mediaList, allMediaList]) {
      const card = [...list.children].find((item) => item.dataset.jobId === job.id);
      if (card) updateJobCard(card, updated);
    }
    updateMediaActivity();
    return true;
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
    setDrawer(false, false);
    onAttach(new File([mediaBlob(full)], name, { type: full.mimeType }));
  }
  function jobCard(asset) {
    const job = asset.job;
    const figure = node('article', 'project-media-item media-job');
    figure.dataset.jobId = job.id;
    const visual = node('div', 'project-thumbnail media-job-preview');
    const cog = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ class: 'media-job-cog', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) cog.setAttribute(name, value);
    const cogPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    cogPath.setAttribute('d', 'm9.5 2.5-.5 2.4-1.7 1-2.3-.8-2.5 4.3 1.8 1.6v2L2.5 14.5 5 18.8l2.3-.8 1.7 1 .5 2.5h5l.5-2.5 1.7-1 2.3.8 2.5-4.3-1.8-1.5v-2l1.8-1.6L19 5.1l-2.3.8-1.7-1-.5-2.4Z');
    const cogCenter = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    cogCenter.setAttribute('cx', '12');
    cogCenter.setAttribute('cy', '12');
    cogCenter.setAttribute('r', '3');
    cog.append(cogPath, cogCenter);
    const progress = node('progress', 'media-job-progress');
    progress.max = 100;
    visual.append(mediaIcon(job.mediaType, 'project-thumbnail-placeholder'), cog, node('strong', 'media-job-status'), progress);
    const heading = node('div', 'project-media-heading');
    const name = node('p', 'project-media-name', asset.name);
    name.title = asset.name;
    heading.append(name, deleteButton(`Remove generation job: ${asset.name}`, async () => {
      const result = await client.deleteMediaJob(job.id);
      if (result?.deleted) await refreshAssets();
    }));
    const detail = node('p', 'media-job-detail');
    figure.append(visual, heading, detail);
    figure.append(node('p', 'media-job-error'));
    const actions = node('div', 'media-job-recovery');
    actions.append(button('Check now', 'button quiet small', () => client.retryMediaJob(job.id)));
    figure.append(actions);
    updateJobCard(figure, job);
    return figure;
  }
  function updateJobCard(figure, job) {
    const status = job.status === 'failed' ? 'Generation failed' : job.status === 'downloading' ? 'Saving media' : job.providerStatus === 'queued' ? 'Queued' : 'Generating';
    figure.querySelector('.media-job-status').textContent = status;
    const cog = figure.querySelector('.media-job-cog');
    if (job.status === 'failed') cog.setAttribute('hidden', '');
    else cog.removeAttribute('hidden');
    const progress = figure.querySelector('.media-job-progress');
    progress.hidden = !(job.progress > 0 && job.progress < 100);
    progress.value = job.progress || 0;
    progress.setAttribute('aria-label', `${status}: ${job.progress || 0}%`);
    const details = [];
    if (Number.isInteger(job.queuePosition) && job.queuePosition > 0) details.push(`Queue position ${job.queuePosition}`);
    if (Number.isFinite(job.estimatedWaitSeconds)) details.push(job.estimatedWaitSeconds < 60 ? `About ${Math.max(1, Math.round(job.estimatedWaitSeconds))} seconds` : `About ${Math.ceil(job.estimatedWaitSeconds / 60)} min`);
    else if (job.status !== 'failed') details.push('Estimating completion');
    figure.querySelector('.media-job-detail').textContent = details.join(' / ');
    const error = figure.querySelector('.media-job-error');
    error.hidden = !job.error;
    error.textContent = job.status === 'failed' ? job.error || '' : 'Retrieval will retry. Job ID is saved.';
    error.title = job.error || '';
    figure.querySelector('.media-job-recovery').hidden = !job.error || job.status === 'failed';
  }
  async function downloadMedia(id, library = false) {
    const result = library ? await client.saveLibraryAsset(id) : await client.saveProjectAsset(projectId, id);
    if (!result?.canceled) onStatus('Media downloaded.');
  }
  async function openMediaReference(asset, { onlyWhenEmpty = false, canOpen } = {}) {
    if (onlyWhenEmpty && (activeTab || operation || isBusy?.() || canOpen?.() === false)) return false;
    return openMedia({ ...asset, id: asset.assetId || asset.id }, true, { onlyWhenEmpty, canOpen });
  }
  async function refreshKits() {
    const owner = projectId;
    const version = ++kitsVersion;
    if (!kitCatalogPromise) kitCatalogPromise = (client.getAvailableKits ? client.getAvailableKits() : Promise.resolve([])).catch((error) => { kitCatalogPromise = null; throw error; });
    const [catalog, selected] = await Promise.all([kitCatalogPromise, owner && client.getProjectKits ? client.getProjectKits(owner) : null]);
    if (version !== kitsVersion || owner !== projectId) return;
    kitCatalog = Array.isArray(catalog) ? catalog : catalog.kits || [];
    projectKits = selected?.kits || ['canvas-2d', 'tone'].filter((id) => !kitCatalog.length || kitCatalog.some((kit) => kit.id === id && kit.installed));
    projectRevision = selected?.projectRevision || '';
    renderKits();
  }
  function renderKits() {
    if (!projectKitList) return;
    projectKitList.replaceChildren(...kitCatalog.map((kit) => {
      const row = node('label', 'project-kit-option');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.projectKit = kit.id;
      checkbox.checked = projectKits.includes(kit.id);
      checkbox.dataset.unavailable = String(!kit.installed);
      checkbox.disabled = !projectId || operation || selectedProjectId !== projectId || Boolean(isBusy?.()) || (checkbox.dataset.unavailable === 'true' && !checkbox.checked);
      checkbox.addEventListener('change', () => run(async () => {
        guard();
        const owner = projectId;
        const selected = [...projectKitList.querySelectorAll('input')].filter((input) => input.checked).map((input) => input.dataset.projectKit);
        operation = true;
        updateBusy();
        projectKitStatus.textContent = 'Updating project kits...';
        try {
          const result = await client.updateProjectKits(owner, { kits: selected, expectedProjectRevision: projectRevision });
          if (owner !== projectId) return;
          projectKits = result.kits;
          projectRevision = result.projectRevision;
          renderKits();
          if (activeTab?.kind === 'document') select(activeTab, result);
          projectKitStatus.textContent = result.runtimeWarning || 'Kits saved for every HTML canvas in this project.';
          projectKitStatus.dataset.error = String(Boolean(result.runtimeWarning));
          onStatus(projectKitStatus.textContent, Boolean(result.runtimeWarning));
        } catch (error) {
          await refreshKits().catch(() => renderKits());
          projectKitStatus.textContent = error.message || 'Could not update project kits. Try again.';
          projectKitStatus.dataset.error = 'true';
          report(error);
        } finally { operation = false; updateBusy(); }
      }));
      const label = node('span', '', kit.name);
      label.title = kit.description || kit.name;
      row.append(checkbox, label);
      if (!kit.installed) row.append(node('small', '', 'Unavailable'));
      return row;
    }));
    projectKitStatus.textContent = projectId ? 'Shared by every HTML canvas in this project.' : 'Select a project to choose its kits.';
    projectKitStatus.dataset.error = 'false';
    updateBusy();
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
      await acceptDeletion({ ...result, type: result.projectDeleted ? 'project-deleted' : 'project-file-deleted', projectId: owner, deletedPath: path });
      if (result.projectDeleted) reportProjectDeletion(result);
      else onStatus([`Deleted ${path}.`, result.runtimeWarning].filter(Boolean).join(' '), Boolean(result.runtimeWarning));
    } finally {
      operation = false;
      updateBusy();
      if (deleted && owner === projectId && !drawer.hidden) documentsList.querySelector('button')?.focus();
    }
  }
  function reportProjectDeletion(result) {
    const warnings = [...(result.mediaWarnings || []), result.runtimeWarning].map((warning) => typeof warning === 'string' ? warning : warning?.message).filter(Boolean);
    const count = result.deletedAssetIds?.length || 0;
    const media = count ? `${count} unshared media ${count === 1 ? 'asset' : 'assets'} deleted. Remaining media is available in All media.` : 'Saved media is available in All media.';
    onStatus(['Project deleted.', media, ...warnings].join(' '), warnings.length > 0);
  }
  async function deleteProject() {
    guard();
    const owner = selectedProjectId;
    if (!owner) return;
    operation = true;
    updateBusy();
    try {
      const result = await client.deleteProject(owner);
      if (!result?.deleted) return;
      await acceptDeletion({ ...result, type: 'project-deleted', projectId: owner });
      reportProjectDeletion(result);
    } finally { operation = false; updateBusy(); }
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
      if (deleted && owner === projectId && !mediaDrawer.hidden) (mediaList.querySelector('button') || allMediaList.querySelector('button') || mediaDrawerToggle).focus();
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
      const devices = button('', 'fold-button project-file-device', () => onDevices?.(path, devices), `Camera and microphone for ${entry.title || path}`);
      devices.title = `Camera and microphone for ${path}`;
      devices.setAttribute('aria-haspopup', 'dialog');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of Object.entries({ viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', 'M3 6h3l1.5-2h5L14 6h3v10H3V6Zm10 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z');
      svg.append(shape);
      devices.append(svg);
      row.append(item, devices, deleteButton(`Delete ${path}`, () => deleteFile(path)));
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
    picker.value = selectedProjectId;
    updateBusy();
  }
  function renderTabs() {
    const visible = [...tabs.values()].filter((tab) => tab.projectId === projectId);
    tabsElement.replaceChildren(...visible.map((tab) => {
      const group = node('div', 'canvas-tab');
      group.dataset.active = String(activeTab && keyFor(tab) === keyFor(activeTab));
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', tab.title);
      const selectButton = button('', 'canvas-tab-select', () => {
        if (activeTab && keyFor(tab) === keyFor(activeTab)) { setDrawer(drawer.hidden, false); return; }
        return tab.kind === 'document' ? openDocument(tab.resource) : openMedia({ id: tab.resource, name: tab.title }, tab.library);
      }, tab.title);
      selectButton.append(node('span', 'canvas-tab-name', tab.title));
      if (tab.kind === 'document') {
        const dot = node('span', 'state-dot ready canvas-tab-status');
        dot.setAttribute('aria-hidden', 'true');
        selectButton.append(dot);
        selectButton.setAttribute('aria-label', `${tab.title} - Ready`);
      }
      selectButton.setAttribute('aria-pressed', group.dataset.active);
      selectButton.title = `${tab.kind === 'document' ? `${tab.resource} - Ready` : tab.title}${group.dataset.active === 'true' ? ' - Toggle project files' : ''}`;
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
    await Promise.all([refreshAssets(), refreshKits()]);
  }
  async function openProject(id, documentPath) {
    guard();
    if (!id) return;
    // The picker owns deletion; the active project changes only after the host opens it.
    selectedProjectId = id;
    const version = ++selectionVersion;
    operation = true;
    updateBusy();
    try {
      if (!projects.some((project) => project.id === id)) projects = await client.listCanvases();
      if (version !== selectionVersion) return;
      renderPicker();
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
      onStatus('');
    } catch (error) {
      if (version === selectionVersion && id !== projectId) {
        const name = projects.find((project) => project.id === id)?.title || 'selected project';
        throw new Error(`Could not open ${name}. Delete still targets this selected project. ${error.message || error}`);
      }
      throw error;
    } finally { operation = false; updateBusy(); onBounds(); }
  }
  async function refreshProjects(restore = true) {
    projects = await client.listCanvases();
    if (!projects.some((project) => project.id === selectedProjectId)) selectedProjectId = projectId;
    renderPicker();
    if (projectId) await loadProjectContents(projectId);
    else await Promise.all([refreshAssets(), refreshKits()]);
    updateBusy();
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
    selectedProjectId = id;
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
      selectedProjectId = id;
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
      if (event.type === 'project-deleted' || event.projectDeleted) {
        if (selectedProjectId === event.projectId) selectedProjectId = event.projectId === projectId ? '' : projectId;
        for (const [key, tab] of tabs) if (tab.projectId === event.projectId) tabs.delete(key);
        if (event.projectId === projectId) {
          selectionVersion += 1;
          mediaVersion += 1;
          projectId = '';
          documents = [];
          assets = [];
          hideMedia();
          document.getElementById('project-source-files').replaceChildren();
          renderDocuments();
          select(null, { projectDeleted: true, deletedProjectId: event.projectId });
        } else { writeState(); renderTabs(); }
        await refreshProjects(false);
        updateBusy();
        onBounds();
        return;
      }
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
      selectedProjectId = projectId;
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
  async function exportCurrent({ projectOnly = false } = {}) {
    if (!projectId && !isMediaTab()) throw new Error('Open a project first.');
    if (projectOnly && !projectId) throw new Error('Open a project first.');
    const media = !projectOnly && isMediaTab();
    const result = media
      ? activeTab.library ? await client.saveLibraryAsset(activeTab.resource) : await client.saveProjectAsset(projectId, activeTab.resource)
      : await client.exportProject(projectId);
    if (!result?.canceled) onStatus(media ? 'Media downloaded.' : 'Project exported as ZIP.');
  }
  function updateBusy() {
    if (reportedOperation !== operation) {
      reportedOperation = operation;
      onBusy?.(operation);
    }
    const busy = operation || Boolean(isBusy?.());
    const selectionPending = selectedProjectId !== projectId;
    for (const list of [mediaList, allMediaList]) for (const card of list.children) {
      card.draggable = card.dataset.mediaDragSource === 'true' && !busy && !selectionPending;
      if (!card.draggable) delete card.dataset.dragging;
    }
    picker.disabled = busy;
    document.getElementById('export-current').disabled = busy || selectionPending || !projectId;
    for (const element of document.querySelectorAll('.project-document, .project-file-device, .project-source-file, .library .delete-control, .media-drawer .delete-control, .project-media-actions button, .media-job-recovery button, button.project-thumbnail, .canvas-tab button, #project-new, #project-rename, #drawer-new-document')) {
      element.disabled = busy || (selectionPending && element.id !== 'project-new') || element.dataset.referenced === 'true' || (element.dataset.requiresProject === 'true' && !projectId);
    }
    for (const checkbox of projectKitList?.querySelectorAll('input') || []) checkbox.disabled = busy || selectionPending || !projectId || (checkbox.dataset.unavailable === 'true' && !checkbox.checked);
    document.getElementById('project-rename').disabled = busy || selectionPending || !projectId;
    const deleteControl = document.getElementById('project-delete');
    deleteControl.disabled = busy || !selectedProjectId;
    const deleteLabel = selectedProjectId ? `Delete ${projects.find((project) => project.id === selectedProjectId)?.title || 'selected project'}` : 'Delete project';
    deleteControl.title = deleteLabel;
    deleteControl.setAttribute('aria-label', deleteLabel);
    for (const element of [documentsList, document.getElementById('project-source-files'), projectKitList, mediaList]) element.hidden = selectionPending;
    projectKitStatus.hidden = selectionPending;
    document.getElementById('project-image-count').hidden = selectionPending;
    if (selectionPending) {
      const hint = document.getElementById('canvases-empty');
      hint.hidden = false;
      hint.textContent = operation ? 'Opening the selected project...' : 'This project could not be opened. Retry by selecting it again, or delete it above.';
    } else {
      document.getElementById('canvases-empty').hidden = documents.length > 0;
      document.getElementById('canvases-empty').textContent = projectId ? 'Create an HTML canvas in this project.' : 'Select a project above to browse its documents.';
    }
    document.getElementById('image-use-chat').disabled = busy || !isMediaTab();
    document.getElementById('image-download').disabled = busy || !isMediaTab();
  }
  drawerToggle.addEventListener('click', () => setDrawer(drawer.hidden));
  document.getElementById('library-collapse').addEventListener('click', () => setDrawer(false));
  mediaDrawerToggle.addEventListener('click', () => setMediaDrawer(mediaDrawer.hidden));
  document.getElementById('media-collapse').addEventListener('click', () => setMediaDrawer(false));
  templatesDrawerToggle?.addEventListener('click', () => setDrawer(templatesDrawer.hidden, true, 'templates'));
  document.getElementById('templates-collapse')?.addEventListener('click', () => setDrawer(false, true, 'templates'));
  mediaSearch?.addEventListener('input', renderAssets);
  mediaTypeFilter?.addEventListener('change', renderAssets);
  mediaSort?.addEventListener('change', renderAssets);
  mediaFiltersReset?.addEventListener('click', () => {
    if (mediaSearch) mediaSearch.value = '';
    if (mediaTypeFilter) mediaTypeFilter.value = 'all';
    if (mediaSort) mediaSort.value = 'newest';
    renderAssets();
    mediaSearch?.focus();
  });
  document.getElementById('project-new').addEventListener('click', () => onCreate('project'));
  document.getElementById('project-rename').addEventListener('click', () => onCreate('rename', title()));
  document.getElementById('project-delete').addEventListener('click', () => run(deleteProject));
  document.getElementById('drawer-new-document').addEventListener('click', () => onCreate('document'));
  picker.addEventListener('change', () => run(async () => {
    const id = picker.value;
    if (!id) { selectedProjectId = projectId; renderPicker(); return; }
    try { await openProject(id); } finally { picker.value = selectedProjectId; }
  }));
  document.getElementById('image-use-chat').addEventListener('click', () => run(() => attachMedia({ id: activeTab.resource, name: activeTab.title }, activeTab.library)));
  document.getElementById('image-download').addEventListener('click', () => run(exportCurrent));
  document.getElementById('image-size-toggle').addEventListener('click', () => {
    zoomed = !zoomed;
    preview.dataset.zoom = zoomed ? 'actual' : 'fit';
    document.getElementById('image-size-toggle').textContent = zoomed ? 'Fit image' : 'Actual size';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (!drawer.hidden || !mediaDrawer.hidden || templatesDrawer?.hidden === false) && !document.querySelector('dialog[open]')) setDrawer(false, true, templatesDrawer?.hidden === false ? 'templates' : drawer.hidden ? 'media' : 'files');
  });
  setDrawer(false, false);
  return { refreshProjects, refreshAssets, refreshKits, updateMediaJob, announceMediaReady, markMediaSeen, openMediaReference, openProject, openDocument, changed, assetsChanged, acceptDeletion, previewMedia, create, exportCurrent, updateBusy,
    getKits: () => [...projectKits], getKitCatalog: () => [...kitCatalog],
    isMediaNew: (assetId) => mediaNotices.has(assetId),
    getProjectId: () => projectId, getPreviewKind: () => activeTab?.kind || 'empty', isOperating: () => operation, setDrawer, setMediaDrawer };
}

if (typeof module !== 'undefined') module.exports = { createDeleteButton, createProjectWorkspace };
