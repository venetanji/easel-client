const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectWorkspace } = require('../src/project-workspace');

function element(tagName = 'div', id = '') {
  let text = '';
  const item = {
    tagName, id, className: '', dataset: {}, attributes: {}, children: [], listeners: {}, value: '', disabled: false,
    get textContent() { return text + this.children.map((child) => child.textContent || '').join(''); },
    set textContent(value) { text = String(value); this.children = []; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; delete this[name]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ''; this.children = [...children]; },
    addEventListener(name, action) { this.listeners[name] = action; },
    querySelectorAll(selector) {
      const matches = (child, query) => query.startsWith('.') ? child.className.split(' ').includes(query.slice(1)) : query.startsWith('#') ? child.id === query.slice(1) : child.tagName === query;
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
    'project-select', 'nav-explorer', 'project-media-scope', 'media-list', 'canvases-list', 'open-canvas-tabs', 'image-viewer',
    'image-viewer-image', 'media-viewer-video', 'media-viewer-audio', 'image-viewer-info', 'image-size-toggle', 'media-empty',
    'project-image-count', 'canvases-empty', 'project-rename', 'project-source-files', 'image-use-chat', 'library-collapse',
    'project-new', 'drawer-new-document',
  ];
  const nodes = new Map(ids.map((id) => [id, element('div', id)]));
  const drawer = element();
  drawer.className = 'library';
  drawer.append(nodes.get('canvases-list'), nodes.get('project-source-files'), nodes.get('media-list'));
  const conversation = element();
  const root = element();
  root.append(drawer, conversation, ...[...nodes.values()].filter((node) => !drawer.children.includes(node)));
  const document = {
    getElementById: (id) => nodes.get(id),
    createElement: (tag) => element(tag),
    createElementNS: (_namespace, tag) => element(tag),
    querySelector: (selector) => selector === '.library' ? drawer : selector === '.conversation' ? conversation : null,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener() {},
  };
  nodes.get('project-media-scope').value = 'project';
  const stored = new Map();
  const documents = [{ path: 'index.html', title: 'First' }, { path: 'extra.html', title: 'Extra' }];
  const files = [{ path: 'index.html', bytes: 40 }, { path: 'extra.html', bytes: 20 }, { path: 'app.js', bytes: 12 }];
  const asset = { id: assetId, name: 'Reference.png', mimeType: 'image/png', data: 'YWJj' };
  const projectAssets = [asset];
  const libraryAssets = [asset];
  const selections = [];
  const statuses = [];
  const calls = [];
  let busy = false;
  let confirm = false;
  const opened = (path) => ({ id: projectId, documentPath: path, documentTitle: documents.find((entry) => entry.path === path)?.title || path });
  const client = {
    async listCanvases() { return [{ id: projectId, title: 'Project' }]; },
    async listProjectDocuments() { return { documents: [...documents] }; },
    async listCanvasFiles() { return { files: [...files] }; },
    async openProjectDocument(_id, path) { return opened(path); },
    async getProjectAssets() { return { assets: [...projectAssets] }; },
    async listAssets() { return [...libraryAssets]; },
    async getProjectAsset() { return asset; },
    async getLibraryAsset() { return asset; },
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
  };
  const workspace = createProjectWorkspace({
    document, client,
    storage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    onSelection: (value) => selections.push(value), onStatus: (...args) => statuses.push(args), onBounds() {}, onFiles() {},
    isBusy: () => busy,
  });
  return { workspace, nodes, projectId, assetId, asset, client, calls, selections, statuses, stored, projectAssets, libraryAssets,
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
  assert.deepEqual(state.statuses.at(-1), ['Deleted extra.html.']);
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
  await state.workspace.openProject(state.projectId);
  state.nodes.get('project-media-scope').value = 'library';
  await state.workspace.refreshAssets();
  const card = state.nodes.get('media-list').children[0];
  assert.match(card.children[1].children[1].attributes['aria-label'], /^Delete from library:/);
  await card.children[0].listeners.click();
  state.confirm(true);
  await card.children[1].children[1].listeners.click();
  assert.equal(state.libraryAssets.length, 0);
  assert.equal(state.projectAssets.length, 1);
  assert.equal(state.workspace.getPreviewKind(), 'image');
  assert.equal(state.nodes.get('media-list').children.length, 0);
  assert.deepEqual(state.calls.at(-1), ['library-media', state.assetId]);
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
