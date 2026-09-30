const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectWorkspace } = require('../src/project-workspace');

function element(tagName = 'div', id = '') {
  let text = '';
  const item = {
    tagName, id, className: '', dataset: {}, attributes: {}, children: [], listeners: {}, value: '', disabled: false,
    get textContent() { return text + this.children.map((child) => child.textContent || '').join(''); },
    set textContent(value) { text = String(value); this.children = []; },
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); },
    removeAttribute(name) { delete this.attributes[name]; delete this[name]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ''; this.children = [...children]; },
    addEventListener(name, action) { this.listeners[name] = action; },
    querySelectorAll(selector) {
      const matches = (child, query) => {
        if (query.startsWith('#')) return child.id === query.slice(1);
        const [tag, ...classes] = query.split('.');
        return (!tag || child.tagName === tag) && classes.every((name) => child.className.split(' ').includes(name));
      };
      const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      return descendants.filter((child) => selector.split(',').some((query) => matches(child, query.trim().split(' ').at(-1))));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    focus() { this.focused = true; },
    pause() { this.paused = true; },
    load() {},
  };
  return item;
}

function fixture() {
  const projectId = 'c'.repeat(32);
  const assetId = 'a'.repeat(32);
  const ids = [
    'project-select', 'nav-explorer', 'nav-media', 'project-drawer', 'media-drawer', 'media-collapse', 'media-list', 'all-media-list', 'all-media-empty', 'all-media-count', 'canvases-list', 'open-canvas-tabs', 'image-viewer',
    'image-viewer-image', 'media-viewer-video', 'media-viewer-audio', 'image-viewer-info', 'image-size-toggle', 'media-empty',
    'project-image-count', 'canvases-empty', 'project-rename', 'project-delete', 'project-source-files', 'image-use-chat', 'library-collapse',
    'project-new', 'drawer-new-document',
  ];
  const nodes = new Map(ids.map((id) => [id, element('div', id)]));
  const drawer = nodes.get('project-drawer');
  drawer.className = 'library';
  drawer.append(nodes.get('canvases-list'), nodes.get('project-source-files'));
  const mediaDrawer = nodes.get('media-drawer');
  mediaDrawer.className = 'media-drawer';
  mediaDrawer.append(nodes.get('media-collapse'), nodes.get('media-list'), nodes.get('all-media-list'));
  const conversation = element();
  const root = element();
  root.append(drawer, mediaDrawer, conversation, ...[...nodes.values()].filter((node) => node !== drawer && node !== mediaDrawer && !drawer.children.includes(node) && !mediaDrawer.children.includes(node)));
  const document = {
    getElementById: (id) => nodes.get(id),
    createElement: (tag) => element(tag),
    createElementNS: (_namespace, tag) => element(tag),
    querySelector: (selector) => selector === '.library' ? drawer : selector === '.conversation' ? conversation : null,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener() {},
  };
  const stored = new Map();
  const documents = [{ path: 'index.html', title: 'First' }, { path: 'extra.html', title: 'Extra' }];
  const files = [{ path: 'index.html', bytes: 40 }, { path: 'extra.html', bytes: 20 }, { path: 'app.js', bytes: 12 }];
  const asset = { id: assetId, name: 'Reference.png', mimeType: 'image/png', data: 'YWJj' };
  const projectAssets = [asset];
  const libraryAssets = [asset];
  const projects = [{ id: projectId, title: 'Project' }];
  const selections = [];
  const statuses = [];
  const calls = [];
  const drawerChanges = [];
  let busy = false;
  let confirm = false;
  const opened = (path) => ({ id: projectId, documentPath: path, documentTitle: documents.find((entry) => entry.path === path)?.title || path });
  const client = {
    async listCanvases() { return [...projects]; },
    async listProjectDocuments() { return { documents: [...documents] }; },
    async listCanvasFiles() { return { files: [...files] }; },
    async openProjectDocument(_id, path) { return opened(path); },
    async getProjectAssets() { return { assets: [...projectAssets] }; },
    async listAssets() { return [...libraryAssets]; },
    async getProjectAsset() { return asset; },
    async getLibraryAsset() { return asset; },
    async attachProjectAsset(id, reference) {
      calls.push(['attach', id, reference]);
      if (!projectAssets.some((entry) => entry.id === reference)) projectAssets.push(libraryAssets.find((entry) => entry.id === reference));
    },
    async hideCanvasPreview() { calls.push(['hide']); },
    setCanvasBounds() {},
    async deleteProjectFile(id, { path }) {
      calls.push(['file', id, path]);
      if (!confirm) return { deleted: false, canceled: true };
      files.splice(files.findIndex((file) => file.path === path), 1);
      const index = documents.findIndex((entry) => entry.path === path);
      if (index >= 0) documents.splice(index, 1);
      return { deleted: true, ...opened('index.html') };
    },
    async deleteProjectAsset(id, reference) {
      calls.push(['project-media', id, reference]);
      if (!confirm) return { deleted: false, canceled: true };
      projectAssets.splice(0, projectAssets.length);
      return { deleted: true };
    },
    async deleteLibraryAsset(reference) {
      calls.push(['library-media', reference]);
      if (!confirm) return { deleted: false, canceled: true };
      libraryAssets.splice(0, libraryAssets.length);
      return { deleted: true };
    },
    async deleteProject(id) {
      calls.push(['project', id]);
      if (!confirm) return { deleted: false, canceled: true };
      projects.splice(0, projects.length);
      projectAssets.splice(0, projectAssets.length);
      return { deleted: true, projectDeleted: true };
    },
  };
  const workspace = createProjectWorkspace({
    document, client,
    storage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    onSelection: (value) => selections.push(value), onStatus: (...args) => statuses.push(args), onBounds() {}, onFiles() {},
    onDrawerChange: (...args) => drawerChanges.push(args),
    isBusy: () => busy,
  });
  return { workspace, nodes, projectId, assetId, asset, client, calls, selections, statuses, stored, projectAssets, libraryAssets, projects, drawerChanges,
    confirm: (value) => { confirm = value; }, busy: (value) => { busy = value; } };
}

test('file trash controls are accessible and cancellation keeps source and tabs', async () => {
  const state = fixture();
  await state.workspace.openProject(state.projectId);
  const documents = state.nodes.get('canvases-list');
  const trash = documents.children[1].children[1];
  assert.equal(trash.attributes['aria-label'], 'Delete extra.html');
  assert.equal(trash.attributes['aria-haspopup'], 'dialog');
  assert.equal(trash.children[0].attributes['aria-hidden'], 'true');
  assert.equal(state.nodes.get('project-source-files').children[0].children[1].attributes['aria-label'], 'Delete app.js');
  const savedTabs = state.stored.get('easel-studio.project-tabs.v1');
  await trash.listeners.click();
  assert.equal(documents.children.length, 2);
  assert.equal(state.stored.get('easel-studio.project-tabs.v1'), savedTabs);
  assert.deepEqual(state.calls, [['file', state.projectId, 'extra.html']]);
});

test('confirmed document deletion removes its tab and selects host replacement metadata', async () => {
  const state = fixture();
  await state.workspace.openProject(state.projectId);
  await state.workspace.openDocument('extra.html');
  state.confirm(true);
  await state.nodes.get('canvases-list').children[1].children[1].listeners.click();
  assert.equal(state.nodes.get('canvases-list').children.length, 1);
  assert.equal(state.selections.at(-1).documentPath, 'index.html');
  const tabs = JSON.parse(state.stored.get('easel-studio.project-tabs.v1'));
  assert.deepEqual(tabs.map((tab) => tab.resource), ['index.html']);
  assert.deepEqual(state.statuses.at(-1), ['Deleted extra.html.', false]);
});

test('project media removal closes its preview while keeping the library copy', async () => {
  const state = fixture();
  await state.workspace.openProject(state.projectId);
  await state.nodes.get('media-list').children[0].children[0].listeners.click();
  assert.equal(state.workspace.getPreviewKind(), 'image');
  state.confirm(true);
  await state.nodes.get('media-list').children[0].children[1].children[1].listeners.click();
  assert.equal(state.projectAssets.length, 0);
  assert.equal(state.libraryAssets.length, 1);
  assert.equal(state.workspace.getPreviewKind(), 'empty');
  assert.equal(state.nodes.get('image-viewer').hidden, true);
  assert.equal(JSON.parse(state.stored.get('easel-studio.project-tabs.v1')).some((tab) => tab.resource === state.assetId), false);
  assert.deepEqual(state.calls.at(-1), ['project-media', state.projectId, state.assetId]);
});

test('All media deletion uses the library API and keeps the attached project preview', async () => {
  const state = fixture();
  const orphanId = 'b'.repeat(32);
  state.libraryAssets.splice(0, 1, { ...state.asset, id: orphanId, name: 'Orphan.png' });
  await state.workspace.openProject(state.projectId);
  const card = state.nodes.get('all-media-list').children[0];
  assert.match(card.children[1].children[1].attributes['aria-label'], /^Delete from library:/);
  await state.nodes.get('media-list').children[0].children[0].listeners.click();
  state.confirm(true);
  await card.children[1].children[1].listeners.click();
  assert.equal(state.libraryAssets.length, 0);
  assert.equal(state.projectAssets.length, 1);
  assert.equal(state.workspace.getPreviewKind(), 'image');
  assert.equal(state.nodes.get('all-media-list').children.length, 0);
  assert.deepEqual(state.calls.at(-1), ['library-media', orphanId]);
});

test('trusted agent media preview works during a turn without queuing another hide IPC', async () => {
  const state = fixture();
  await state.workspace.openProject(state.projectId);
  state.busy(true);
  await assert.rejects(state.workspace.openDocument('extra.html'), /Wait for the current reply/);
  await state.workspace.previewMedia({ projectId: state.projectId, scope: 'project', asset: state.asset, previewHidden: true });
  assert.equal(state.workspace.getPreviewKind(), 'image');
  assert.equal(state.calls.some(([action]) => action === 'hide'), false);
  await assert.rejects(state.workspace.previewMedia({ scope: 'library' }), /missing its asset reference/);
});

test('deletion invalidates an unfinished media preview before it can reopen the deleted asset', async () => {
  const state = fixture();
  await state.workspace.openProject(state.projectId);
  let resolveAsset;
  state.client.getLibraryAsset = () => new Promise((resolve) => { resolveAsset = resolve; });
  const pendingPreview = state.workspace.previewMedia({ scope: 'library', asset: state.asset, previewHidden: true });
  await state.workspace.acceptDeletion({ type: 'media-deleted', scope: 'library', assetId: state.assetId });
  resolveAsset(state.asset);
  await pendingPreview;
  assert.equal(state.workspace.getPreviewKind(), 'document');
  assert.equal(state.nodes.get('image-viewer').hidden, true);
});

test('pending media appears as a generating card with estimate and confirmed removal', async () => {
  const state = fixture();
  const job = { id: 'f'.repeat(32), remoteId: 'video_queued', status: 'generating', providerStatus: 'in_progress', mediaType: 'video', progress: 30, queuePosition: 1, estimatedWaitSeconds: 80 };
  state.projectAssets.push({ id: job.id, name: 'A cat in sunlight', mimeType: 'video/mp4', kind: 'job', job });
  let approved = false;
  state.client.deleteMediaJob = async (id) => {
    assert.equal(id, job.id);
    if (!approved) return { deleted: false, canceled: true };
    state.projectAssets.splice(1, 1);
    return { deleted: true };
  };
  await state.workspace.openProject(state.projectId);
  const list = state.nodes.get('media-list');
  const card = list.children[1];
  assert.match(card.textContent, /Generating/);
  assert.match(card.textContent, /About 2 min/);
  assert.equal(card.querySelectorAll('.project-media-actions').length, 0);
  await card.querySelector('.delete-control').listeners.click();
  assert.equal(list.children.length, 2);
  approved = true;
  await card.querySelector('.delete-control').listeners.click();
  assert.equal(list.children.length, 1);
});

test('project files and media have distinct drawers with exclusive rail selection', () => {
  const state = fixture();
  state.workspace.setDrawer(true, false);
  assert.equal(state.nodes.get('project-drawer').hidden, false);
  assert.equal(state.nodes.get('media-drawer').hidden, true);
  assert.equal(state.nodes.get('nav-explorer').attributes['aria-expanded'], 'true');
  state.workspace.setMediaDrawer(true, false);
  assert.equal(state.nodes.get('project-drawer').hidden, true);
  assert.equal(state.nodes.get('project-drawer').inert, true);
  assert.equal(state.nodes.get('media-drawer').hidden, false);
  assert.equal(state.nodes.get('nav-media').attributes['aria-expanded'], 'true');
  assert.equal(state.nodes.get('nav-explorer').attributes['aria-expanded'], 'false');
  assert.deepEqual(state.drawerChanges.at(-1), [true, 'media']);
  state.workspace.setDrawer(false, false);
  assert.equal(state.nodes.get('media-drawer').hidden, true);
  assert.equal(state.nodes.get('nav-media').attributes['aria-pressed'], 'false');
  state.workspace.setMediaDrawer(true, false);
  state.workspace.setMediaDrawer(false);
  assert.equal(state.nodes.get('nav-media').focused, true);
});

test('project deletion requires confirmation, clears project tabs, and keeps orphan media visible', async () => {
  const state = fixture();
  await state.workspace.openProject(state.projectId);
  await state.nodes.get('project-delete').listeners.click();
  assert.equal(state.workspace.getProjectId(), state.projectId);
  assert.equal(state.nodes.get('canvases-list').children.length, 2);
  state.confirm(true);
  await state.nodes.get('project-delete').listeners.click();
  assert.equal(state.workspace.getProjectId(), '');
  assert.equal(state.workspace.getPreviewKind(), 'empty');
  assert.equal(state.nodes.get('canvases-list').children.length, 0);
  assert.equal(state.nodes.get('project-source-files').children.length, 0);
  assert.equal(state.nodes.get('media-list').children.length, 0);
  assert.equal(state.nodes.get('all-media-list').children.length, 1);
  assert.equal(state.nodes.get('project-delete').disabled, true);
  assert.deepEqual(JSON.parse(state.stored.get('easel-studio.project-tabs.v1')), []);
  await state.nodes.get('all-media-list').children[0].children[0].listeners.click();
  assert.equal(state.workspace.getPreviewKind(), 'image');
});

test('deleting the last canvas handles project deletion and surfaces media cleanup warnings', async () => {
  const state = fixture();
  await state.workspace.openProject(state.projectId);
  state.client.deleteProjectFile = async () => {
    state.projects.splice(0, state.projects.length);
    state.projectAssets.splice(0, state.projectAssets.length);
    return { deleted: true, projectDeleted: true, deletedAssetIds: ['e'.repeat(32)], mediaWarnings: ['One saved asset could not be deleted.'] };
  };
  await state.nodes.get('canvases-list').children[0].children[1].listeners.click();
  assert.equal(state.workspace.getProjectId(), '');
  assert.equal(state.nodes.get('open-canvas-tabs').hidden, true);
  assert.match(state.statuses.at(-1)[0], /1 unshared media asset deleted/);
  assert.match(state.statuses.at(-1)[0], /One saved asset could not be deleted/);
  assert.equal(state.statuses.at(-1)[1], true);
});

test('All media adds a reference to the project with one click and shows an attached check', async () => {
  const state = fixture();
  state.projectAssets.splice(0, state.projectAssets.length);
  await state.workspace.openProject(state.projectId);
  assert.equal(state.nodes.get('media-list').children.length, 0);
  const card = state.nodes.get('all-media-list').children[0];
  const add = card.querySelector('.project-media-actions').children[0];
  assert.equal(add.textContent, 'Add to project');
  await add.listeners.click();
  assert.deepEqual(state.calls.at(-1), ['attach', state.projectId, state.assetId]);
  assert.equal(state.nodes.get('media-list').children.length, 1);
  const updated = state.nodes.get('all-media-list').children[0];
  assert.equal(updated.querySelector('.media-in-project').textContent, 'In project');
  assert.equal(updated.querySelector('.media-in-project').children[0].tagName, 'svg');
  assert.equal(updated.querySelectorAll('button').some((entry) => entry.textContent === 'Add to project'), false);
  assert.equal(updated.querySelectorAll('button').some((entry) => entry.textContent === 'Use in chat'), true);
});

test('shared library media cannot be deleted and a missing project disables Add to project', async () => {
  const state = fixture();
  state.asset.referenceCount = 2;
  state.asset.projectIds = [state.projectId, 'd'.repeat(32)];
  await state.workspace.openProject(state.projectId);
  const trash = state.nodes.get('all-media-list').children[0].querySelector('.delete-control');
  assert.equal(trash.disabled, true);
  assert.match(trash.title, /Remove this media from its projects/);
  state.busy(true);
  state.workspace.updateBusy();
  state.busy(false);
  state.workspace.updateBusy();
  assert.equal(trash.disabled, true);
  assert.equal(state.nodes.get('media-list').children[0].querySelector('.delete-control').disabled, false);

  const empty = fixture();
  await empty.workspace.refreshProjects(false);
  empty.workspace.updateBusy();
  const add = empty.nodes.get('all-media-list').children[0].querySelector('.project-media-actions').children[0];
  assert.equal(add.disabled, true);
  assert.equal(empty.nodes.get('all-media-list').children[0].querySelector('.project-thumbnail').disabled, false);
});

test('poll updates change only job status in both media sections without IPC or focus loss', async () => {
  const state = fixture();
  const job = { id: 'f'.repeat(32), remoteId: 'video_queued', status: 'generating', providerStatus: 'in_progress', mediaType: 'video', progress: 20, queuePosition: 1, estimatedWaitSeconds: 80 };
  const asset = { id: job.id, name: 'Sunlit cat', mimeType: 'video/mp4', kind: 'job', job };
  state.projectAssets.push(asset);
  state.libraryAssets.push(asset);
  await state.workspace.openProject(state.projectId);
  const projectJob = state.nodes.get('media-list').children[1];
  const libraryJob = state.nodes.get('all-media-list').children[1];
  const readyCard = state.nodes.get('all-media-list').children[0];
  const download = readyCard.querySelector('.project-media-actions').children.at(-1);
  download.focus();
  const jobTrash = projectJob.querySelector('.delete-control');
  state.client.getProjectAssets = async () => { throw new Error('Polling must not reload project thumbnails.'); };
  state.client.listAssets = async () => { throw new Error('Polling must not reload library thumbnails.'); };
  assert.equal(state.workspace.updateMediaJob({ ...job, progress: 65, estimatedWaitSeconds: 25 }), true);
  assert.equal(state.nodes.get('media-list').children[1], projectJob);
  assert.equal(state.nodes.get('all-media-list').children[1], libraryJob);
  assert.equal(projectJob.querySelector('.delete-control'), jobTrash);
  assert.equal(projectJob.querySelector('.media-job-progress').value, 65);
  assert.equal(libraryJob.querySelector('.media-job-progress').value, 65);
  assert.match(projectJob.querySelector('.media-job-detail').textContent, /About 25 seconds/);
  assert.equal(readyCard.querySelector('.project-media-actions').children.at(-1), download);
  assert.equal(download.focused, true);
  assert.equal(download.disabled, false);
  assert.equal(readyCard.querySelector('.media-job-cog'), null);
  assert.equal(projectJob.querySelector('.media-job-cog').attributes['aria-hidden'], 'true');
  assert.equal(state.workspace.updateMediaJob({ ...job, status: 'ready' }), false);
  assert.equal(state.workspace.updateMediaJob({ ...job, id: 'e'.repeat(32) }), false);
  assert.equal(state.workspace.updateMediaJob({ ...job, status: 'failed', error: 'Service failed.' }), true);
  assert.equal(projectJob.querySelector('.media-job-cog').attributes.hidden, '');
});
