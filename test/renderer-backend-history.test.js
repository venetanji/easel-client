const test = require('node:test');
const assert = require('node:assert/strict');
const { wireRenderer } = require('../src/renderer');
const { createProjectWorkspace: realProjectWorkspace } = require('../src/project-workspace');
const { createAgentControlUi } = require('../src/agent-control-ui');

function element(tagName = 'div') {
  let text = '';
  const listeners = new Map();
  const classes = new Set();
  const node = {
    tagName, children: [], dataset: {}, attributes: {}, value: '', hidden: false, disabled: false,
    scrollHeight: 0, scrollTop: 0, clientHeight: 100,
    style: { setProperty() {} },
    classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); }, add(...names) { names.forEach((name) => classes.add(name)); }, contains(name) { return classes.has(name); } },
    get textContent() { return text + this.children.map((child) => child.textContent || '').join(''); },
    set textContent(value) { text = String(value); this.replaceChildren(); },
    append(...children) { for (const child of children) { child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1); child.parentElement = this; this.children.push(child); } },
    insertBefore(child) { this.append(child); },
    replaceChildren(...children) { this.children.forEach((child) => { child.parentElement = null; }); this.children = []; this.append(...children); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, action) { const entries = listeners.get(name) || []; entries.push(action); listeners.set(name, entries); },
    removeEventListener(name, action) { listeners.set(name, (listeners.get(name) || []).filter((entry) => entry !== action)); },
    async dispatchEvent(event) { for (const action of [...(listeners.get(event.type) || [])]) await action(event); },
    click() { return this.dispatchEvent(new Event('click')); },
    showModal() { this.open = true; },
    close() { this.open = false; return this.dispatchEvent(new Event('close')); },
    focus() {}, pause() {}, load() {},
    getBoundingClientRect: () => ({ width: 1200, height: 900, top: 0, left: 0 }),
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      return descendants.filter((child) => selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : child.tagName === selector);
    },
    querySelector(selector) { if (selector === 'svg path') return element('path'); return this.querySelectorAll(selector)[0] || null; },
  };
  return node;
}

async function fixture(t, { deferInitial = false, realWorkspace = false } = {}) {
  const originals = {};
  let workspaceOptions;
  let workspace;
  const documentListeners = {};
  const creations = [];
  const openedProjects = [];
  const templateChanges = [];
  const templateCreates = [];
  let selectedProjectId = '';
  const catalog = [{ id: 'canvas-2d', name: 'Canvas 2D', installed: true }, { id: 'tone', name: 'Tone.js', installed: true }, { id: 'p5', name: 'p5.js', installed: true }];
  const dependencies = {
    createAgentControlUi,
    createConnectionSettings: () => ({ load() {}, refresh: async () => [], selectedValue: () => '' }),
    createThemedDropdown: () => ({ isOpen: () => false }),
    createProjectWorkspace: (options) => { workspaceOptions = options;
      if (realWorkspace) {
        workspace = realProjectWorkspace(options);
        const changed = workspace.changed;
        workspace.changed = async (result) => { templateChanges.push(result); return changed(result); };
        return workspace;
      }
      return {
      isOperating: () => false, updateBusy() {}, setDrawer() {}, getProjectId: () => selectedProjectId,
      async changed(result) { templateChanges.push(result); }, refreshProjects: async () => {}, refreshAssets: async () => {},
      getKits: () => ['canvas-2d', 'p5'], getKitCatalog: () => catalog,
      async create(...args) { creations.push(args); return { title: args[1] }; },
      async openProject(...args) { openedProjects.push(args); },
    }; },
  };
  for (const [key, value] of Object.entries(dependencies)) { originals[key] = global[key]; global[key] = value; }
  t.after(() => { for (const key of Object.keys(dependencies)) originals[key] === undefined ? delete global[key] : global[key] = originals[key]; });
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) { const node = element(); node.id = id; node.focus = () => { document.activeElement = node; }; nodes.set(id, node); } return nodes.get(id); };
  const document = {
    getElementById: get, createElement: element, createElementNS: (_namespace, tag) => element(tag), createTextNode: (text) => { const node = element(); node.textContent = text; return node; },
    querySelector: (selector) => selector === 'dialog[open]' ? null : get(realWorkspace && selector === '.library' ? 'project-drawer' : realWorkspace && selector === '.conversation' ? 'conversation-panel' : selector), querySelectorAll: () => [],
    addEventListener(name, callback) { documentListeners[name] = callback; }, removeEventListener() {}, hasFocus: () => true,
  };
  if (realWorkspace) {
    for (const id of ['nav-templates', 'nav-explorer', 'nav-media', 'templates-collapse', 'library-collapse', 'media-collapse']) get(id).tagName = 'button';
    for (const [id, children] of Object.entries({ 'templates-drawer': ['templates-collapse', 'templates-refresh', 'templates-list', 'templates-detail', 'templates-recovery'], 'project-drawer': ['library-collapse', 'canvases-list', 'project-source-files', 'project-kit-list'], 'media-drawer': ['media-collapse', 'media-list', 'all-media-list'] })) get(id).append(...children.map(get));
  }
  const composer = element(); composer.className = 'composer'; get('chat-form').append(composer);
  const kitSection = element(); kitSection.className = 'new-canvas-kits'; get('new-canvas-dialog').append(kitSection);
  let backend = 'builtin';
  let listener;
  let deferredInitial;
  const snapshots = [];
  const acknowledgements = [];
  const state = () => ({ backend, busy: false, external: { enabled: true, connectedClients: 0 }, codex: { available: true, connected: true, authenticated: true, model: 'codex', models: [{ id: 'codex' }] } });
  const client = {
    listCanvases: async () => [{ id: 'b'.repeat(32), title: 'Template project' }],
    listProjectDocuments: async () => ({ documents: [{ path: 'index.html', title: 'Existing work' }, { path: 'sketches/test/index.html', title: 'Video sketch' }] }),
    listCanvasFiles: async () => ({ files: [{ path: 'index.html' }, { path: 'sketches/test/index.html' }] }),
    getProjectAssets: async () => ({ assets: [] }), listAssets: async () => [],
    getProjectKits: async () => ({ kits: ['canvas-2d'], projectRevision: 'one' }),
    listTemplates: async () => require('../src/template-catalog').listTemplates(),
    createTemplateInstance: async (input) => { templateCreates.push(input); return { projectId: 'b'.repeat(32), instanceId: 'c'.repeat(32), documentPath: 'sketches/test/index.html', opened: true }; },
    onAgentEvent(action) { listener = action; return () => {}; },
    getAgentControl: async () => state(),
    getSettings: async () => ({ connections: [], activeConnectionId: 'connection', litellmModel: 'model' }),
    getAvailableKits: async () => catalog, listInstalledSkills: async () => [], setCanvasBounds() {},
    getCurrentChat() {
      if (deferInitial && !deferredInitial) return new Promise((resolve) => { deferredInitial = resolve; });
      if (!snapshots.length && backend === 'builtin') return Promise.resolve({ id: 'builtin-chat', history: [{ role: 'user', content: 'Original built-in message' }] });
      return new Promise((resolve) => snapshots.push(resolve));
    },
    acknowledgeChat: async (id) => acknowledgements.push(id),
    listChats: async () => [],
  };
  const renderer = wireRenderer({ document, client }); t.after(() => renderer.dispose());
  await new Promise(setImmediate);
  return { renderer, workspace, document, documentListeners, nodes, get, templateChanges, templateCreates,
    openTemplates: () => realWorkspace ? workspace.setDrawer(true, true, 'templates') : workspaceOptions.onDrawerChange(true, 'templates'),
    setTemplateProject: (id) => { selectedProjectId = id; workspaceOptions.onSelection({ projectId: id, previewKind: 'document', documentPath: 'index.html' }); },
    acknowledgements, snapshots, client, creations, openedProjects,
    openCreate: (...args) => workspaceOptions.onCreate(...args),
    selectCanvas: (value) => workspaceOptions.onSelection(value),
    emit: (event) => listener(event),
    switch(backendValue, reason = 'backend-switch') { backend = backendValue; listener({ type: 'agent-control', state: state(), reason }); },
    resolveInitial: (value) => deferredInitial(value),
    settle: () => new Promise(setImmediate),
  };
}

test('backend switching restores its conversation once and preserves draft attachments', async (t) => {
  const f = await fixture(t);
  f.get('message').value = 'Unsent draft';
  f.get('media-files').files = [new File(['image-bytes'], 'Reference.png', { type: 'image/png' })];
  await f.get('media-files').dispatchEvent(new Event('change'));
  const previewUrl = f.get('attachment-strip').children[0].children[0].src;
  f.switch('codex');
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.get('send').disabled, true);
  f.snapshots[0]({ id: 'codex-chat', history: [{ role: 'user', content: 'Original Codex message' }] });
  await f.settle();
  assert.match(f.get('messages').textContent, /Original Codex message/);
  assert.doesNotMatch(f.get('messages').textContent, /Original built-in message/);
  assert.equal(f.get('message').value, 'Unsent draft');
  assert.equal(f.get('attachment-strip').children[0].children[0].src, previewUrl);
  assert.equal(f.get('send').disabled, false);
  f.switch('codex');
  assert.equal(f.snapshots.length, 1);
  assert.ok(f.acknowledgements.includes('codex-chat'));
});

test('new project kit selection is submitted and an empty selection stays explicit', async (t) => {
  const f = await fixture(t);
  for (const expected of [['p5'], []]) {
    await f.openCreate('project');
    assert.equal(f.get('new-canvas-submit').disabled, false);
    const inputs = f.get('new-canvas-kits').querySelectorAll('input');
    assert.deepEqual(inputs.map((input) => input.checked), [true, true, false]);
    inputs.forEach((input) => { input.checked = expected.includes(input.value); });
    f.get('new-canvas-name').value = 'Planets';
    await f.get('new-canvas-form').dispatchEvent(new Event('submit'));
    assert.deepEqual(f.creations.at(-1), ['project', 'Planets', expected]);
  }
});

test('kit inventory loading and failure cannot submit fallback project defaults', async (t) => {
  const f = await fixture(t);
  let finish;
  f.client.getAvailableKits = () => new Promise((resolve, reject) => { finish = reject; });
  const opening = f.openCreate('project');
  assert.equal(f.get('new-canvas-submit').disabled, true);
  await f.get('new-canvas-form').dispatchEvent(new Event('submit'));
  assert.equal(f.creations.length, 0);
  finish(new Error('Inventory unavailable'));
  await opening;
  assert.equal(f.get('new-canvas-submit').disabled, true);
  assert.match(f.get('new-canvas-status').textContent, /Inventory unavailable.*reopen/);
  await f.get('new-canvas-form').dispatchEvent(new Event('submit'));
  assert.equal(f.creations.length, 0);
});

test('late kit inventory does not overwrite a reopened creation dialog', async (t) => {
  const f = await fixture(t);
  let finish;
  f.client.getAvailableKits = () => new Promise((resolve) => { finish = resolve; });
  const opening = f.openCreate('project');
  await f.get('new-canvas-dialog').close();
  await f.openCreate('rename', 'Current');
  finish([{ id: 'three', name: 'Three.js', installed: true }]);
  await opening;
  assert.equal(f.get('new-canvas-kits').querySelectorAll('input').length, 0);
  assert.equal(f.get('new-canvas-submit').disabled, false);
  assert.equal(f.get('new-canvas-name').value, 'Current');
});

test('additional HTML documents display inherited kits without overriding project selection', async (t) => {
  const f = await fixture(t);
  f.selectCanvas({ id: 'a'.repeat(32), title: 'Planets', kits: ['canvas-2d', 'p5'] });
  await f.openCreate('document');
  assert.equal(f.get('new-canvas-kits').textContent, 'Canvas 2D, p5.js');
  assert.equal(f.get('new-canvas-kits').querySelectorAll('input').length, 0);
  f.get('new-canvas-name').value = 'Another orbit';
  await f.get('new-canvas-form').dispatchEvent(new Event('submit'));
  assert.deepEqual(f.creations.at(-1), ['document', 'Another orbit', undefined]);
});

test('an older backend snapshot cannot replace the newest conversation', async (t) => {
  const f = await fixture(t);
  f.switch('codex'); f.switch('external');
  f.snapshots[1]({ id: 'external-chat', history: [{ role: 'user', content: 'External message' }] });
  await f.settle();
  f.snapshots[0]({ id: 'codex-chat', history: [{ role: 'user', content: 'Stale Codex message' }] });
  await f.settle();
  assert.match(f.get('messages').textContent, /External message/);
  assert.doesNotMatch(f.get('messages').textContent, /Stale Codex message/);
  assert.equal(f.acknowledgements.includes('codex-chat'), false);
});

test('explicit history opens do not trigger an additional backend restore', async (t) => {
  const f = await fixture(t);
  f.switch('codex', 'chat-opened');
  assert.equal(f.snapshots.length, 0);
});

test('delayed startup and switch snapshots cannot overwrite a new live turn', async (t) => {
  const f = await fixture(t, { deferInitial: true });
  f.switch('codex');
  f.emit({ type: 'tool-start', name: 'inspect_canvas' });
  f.emit({ type: 'assistant', text: 'Live reply' });
  f.resolveInitial({ id: 'builtin-chat', history: [{ role: 'user', content: 'Stale startup history' }] });
  f.snapshots[0]({ id: 'codex-chat', history: [{ role: 'user', content: 'Stale switch history' }] });
  await f.settle();
  assert.match(f.get('messages').textContent, /Live reply/);
  assert.doesNotMatch(f.get('messages').textContent, /Stale/);
});


test('canceling the native Video choice does not open an undefined project or report success', async (t) => {
  const f = await fixture(t);
  f.client.openVideoEditor = async () => ({ canceled: true });
  await f.get('open-video-editor').click();
  assert.deepEqual(f.openedProjects, []);
  assert.doesNotMatch(f.get('status').textContent, /Video editor ready/);
});


test('Undo explains a retained creation boundary and returns to normal for later source edits', async (t) => {
  const f = await fixture(t);
  const reason = 'Undo stops at template creation. Your earlier history is kept.';
  f.selectCanvas({ projectId: 'a'.repeat(32), documentPath: 'index.html', previewKind: 'document', undoAvailable: false, undoBlockedReason: reason });
  const button = f.get('canvas-undo');
  assert.equal(button.disabled, true);
  assert.equal(button.title, reason);
  assert.equal(button.getAttribute('aria-description'), reason);
  assert.equal(f.get('canvas-undo-status').textContent, reason);
  assert.equal(f.get('canvas-undo-status').hidden, false);
  f.selectCanvas({ projectId: 'a'.repeat(32), documentPath: 'index.html', previewKind: 'document', undoAvailable: true });
  assert.equal(button.disabled, false);
  assert.equal(button.title, 'Undo canvas changes');
  assert.equal(f.get('canvas-undo-status').hidden, true);
});


test('prompt_preserves_existing_draft and exposes editable composer without sending', async (t) => {
  const f = await fixture(t);
  const sends = []; const generated = [];
  f.client.sendMessage = (...args) => sends.push(args);
  f.client.generateMedia = (...args) => generated.push(args);
  f.get('message').value = '  My existing idea.  ';
  f.openTemplates(); await f.settle();
  const choose = f.get('templates-list').querySelectorAll('button').find((node) => node.dataset.templateId === 'video-editor');
  assert.ok(choose, 'the live catalog should populate the drawer');
  await choose.click();
  await f.get('templates-detail').querySelectorAll('button').find((node) => node.textContent === 'Explore this idea').click();
  assert.ok(f.get('message').value.startsWith('  My existing idea.  \n\n'));
  assert.match(f.get('message').value, /Video editor/);
  assert.equal(f.get('conversation-panel').inert, false);
  assert.equal(f.get('chat-form').parentElement, f.get('conversation-content'));
  assert.deepEqual([sends, generated], [[], []]);
});

test('Templates opened result refreshes workspace metadata without reopening the host document', async (t) => {
  const f = await fixture(t);
  f.setTemplateProject('a'.repeat(32));
  f.openTemplates(); await f.settle();
  await f.get('templates-list').querySelectorAll('button').find((node) => node.dataset.templateId === 'video-editor').click();
  await f.get('templates-detail').querySelectorAll('button').find((node) => node.textContent === 'Add to current project').click();
  assert.deepEqual(f.templateCreates, [{ templateId: 'video-editor', target: 'current-project', projectId: 'a'.repeat(32) }]);
  assert.equal(f.templateChanges[0].documentPath, 'sketches/test/index.html');
  assert.deepEqual(f.openedProjects, []);
});


test('pending template creation blocks composer submission and late completion after renderer teardown', async (t) => {
  const f = await fixture(t); const sends = [];
  f.client.sendMessage = (input) => sends.push(input);
  await f.get('nav-chat').click();
  let finish; f.client.createTemplateInstance = () => new Promise((resolve) => { finish = resolve; });
  f.openTemplates(); await f.settle();
  await f.get('templates-list').querySelectorAll('button').find((node) => node.dataset.templateId === 'video-editor').click();
  const pending = f.get('templates-detail').querySelectorAll('button').find((node) => node.textContent === 'Create project').click();
  f.get('message').value = 'Do not send while creating';
  assert.equal(f.get('message').disabled, true);
  await f.get('chat-form').dispatchEvent(new Event('submit', { cancelable: true }));
  assert.deepEqual(sends, []);
  f.renderer.dispose();
  finish({ projectId: 'b'.repeat(32), instanceId: 'c'.repeat(32), opened: true });
  await pending;
  assert.deepEqual(f.templateChanges, []);
});


for (const type of ['project-file-deleted', 'project-deleted']) test(`confirmed ${type} reaches Templates recovery through the real renderer/workspace`, async (t) => {
  const f = await fixture(t, { realWorkspace: true });
  const identity = { projectId: 'b'.repeat(32), instanceId: 'c'.repeat(32), documentPath: 'sketches/test/index.html', opened: false, openError: 'Preview unavailable' };
  f.client.createTemplateInstance = async (input) => { f.templateCreates.push(input); return identity; };
  f.openTemplates(); await f.settle();
  await f.get('templates-list').querySelectorAll('button').find((node) => node.dataset.templateId === 'video-editor').click();
  const create = () => f.get('templates-detail').querySelectorAll('button').find((node) => node.textContent === 'Create project');
  await create().click();
  f.emit({ type: 'project-file-deleted', projectId: identity.projectId, deletedPath: 'another.html' }); await f.settle();
  assert.equal(create().disabled, true);
  f.emit({ type, projectId: identity.projectId, deletedPath: identity.documentPath }); await f.settle();
  assert.equal(f.get('templates-recovery').hidden, true);
  assert.equal(create().disabled, false);
  assert.match(f.get('templates-status').textContent, /deleted/);
  assert.equal(f.templateCreates.length, 1);
  assert.deepEqual(f.templateChanges, []);
});

for (const navigation of ['media', 'files', 'dismiss', 'reopen']) test(`late template completion preserves newer ${navigation} navigation and focus`, async (t) => {
  const f = await fixture(t, { realWorkspace: true });
  let finish; f.client.createTemplateInstance = () => new Promise((resolve) => { finish = resolve; });
  f.openTemplates(); await f.settle();
  await f.get('templates-list').querySelectorAll('button').find((node) => node.dataset.templateId === 'video-editor').click();
  const pending = f.get('templates-detail').querySelectorAll('button').find((node) => node.textContent === 'Create project').click();
  if (navigation === 'dismiss' || navigation === 'reopen') {
    f.documentListeners.keydown({ key: 'Escape' });
    if (navigation === 'reopen') f.workspace.setDrawer(true, true, 'templates');
    else f.get('message').focus();
  } else f.workspace.setDrawer(true, true, navigation);
  const focused = f.document.activeElement;
  finish({ projectId: 'b'.repeat(32), instanceId: 'c'.repeat(32), documentPath: 'sketches/test/index.html', opened: true });
  await pending;
  assert.equal(f.workspace.getProjectId(), 'b'.repeat(32));
  assert.equal(f.workspace.getPreviewKind(), 'document');
  assert.equal(f.templateChanges.length, 1);
  assert.equal(f.document.activeElement, focused);
  assert.equal(f.get('media-drawer').hidden, navigation !== 'media');
  assert.equal(f.get('project-drawer').hidden, navigation !== 'files');
  assert.equal(f.get('templates-drawer').hidden, navigation !== 'reopen');
});

test('a current Templates interaction still closes its drawer and returns focus after successful adoption', async (t) => {
  const f = await fixture(t, { realWorkspace: true });
  f.openTemplates(); await f.settle();
  await f.get('templates-list').querySelectorAll('button').find((node) => node.dataset.templateId === 'video-editor').click();
  await f.get('templates-detail').querySelectorAll('button').find((node) => node.textContent === 'Create project').click();
  assert.equal(f.get('templates-drawer').hidden, true);
  assert.equal(f.document.activeElement, f.get('nav-templates'));
  assert.equal(f.workspace.getProjectId(), 'b'.repeat(32));
});

test('late Retry Open adopts its existing identity without closing a newer Media drawer', async (t) => {
  const f = await fixture(t, { realWorkspace: true });
  const identity = { projectId: 'b'.repeat(32), instanceId: 'c'.repeat(32), documentPath: 'sketches/test/index.html', opened: false, openError: 'Preview unavailable' };
  f.client.createTemplateInstance = async (input) => { f.templateCreates.push(input); return identity; };
  f.openTemplates(); await f.settle();
  await f.get('templates-list').querySelectorAll('button').find((node) => node.dataset.templateId === 'video-editor').click();
  await f.get('templates-detail').querySelectorAll('button').find((node) => node.textContent === 'Create project').click();
  const opens = []; let finish;
  f.client.openTemplateInstance = (input) => { opens.push(input); return new Promise((resolve) => { finish = resolve; }); };
  const pending = f.get('templates-recovery').querySelectorAll('button').find((node) => node.textContent === 'Retry Open').click();
  f.workspace.setMediaDrawer(true);
  const focused = f.document.activeElement;
  finish({ ...identity, opened: true }); await pending;
  assert.equal(f.get('media-drawer').hidden, false);
  assert.equal(f.document.activeElement, focused);
  assert.equal(f.workspace.getProjectId(), identity.projectId);
  assert.deepEqual(opens, [{ projectId: identity.projectId, instanceId: identity.instanceId }]);
  assert.equal(f.templateCreates.length, 1);
});
