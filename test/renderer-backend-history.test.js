const test = require('node:test');
const assert = require('node:assert/strict');
const { wireRenderer } = require('../src/renderer');
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
    focus() {},
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

async function fixture(t, { deferInitial = false } = {}) {
  const originals = {};
  let workspaceOptions;
  const creations = [];
  const catalog = [{ id: 'canvas-2d', name: 'Canvas 2D', installed: true }, { id: 'tone', name: 'Tone.js', installed: true }, { id: 'p5', name: 'p5.js', installed: true }];
  const dependencies = {
    createAgentControlUi,
    createConnectionSettings: () => ({ load() {}, refresh: async () => [], selectedValue: () => '' }),
    createThemedDropdown: () => ({ isOpen: () => false }),
    createProjectWorkspace: (options) => { workspaceOptions = options; return {
      isOperating: () => false, updateBusy() {}, setDrawer() {}, refreshProjects: async () => {}, refreshAssets: async () => {},
      getKits: () => ['canvas-2d', 'p5'], getKitCatalog: () => catalog,
      async create(...args) { creations.push(args); return { title: args[1] }; },
    }; },
  };
  for (const [key, value] of Object.entries(dependencies)) { originals[key] = global[key]; global[key] = value; }
  t.after(() => { for (const key of Object.keys(dependencies)) originals[key] === undefined ? delete global[key] : global[key] = originals[key]; });
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const document = {
    getElementById: get, createElement: element, createElementNS: (_namespace, tag) => element(tag), createTextNode: (text) => { const node = element(); node.textContent = text; return node; },
    querySelector: (selector) => selector === 'dialog[open]' ? null : get(selector), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, hasFocus: () => true,
  };
  const composer = element(); composer.className = 'composer'; get('chat-form').append(composer);
  const kitSection = element(); kitSection.className = 'new-canvas-kits'; get('new-canvas-dialog').append(kitSection);
  let backend = 'builtin';
  let listener;
  let deferredInitial;
  const snapshots = [];
  const acknowledgements = [];
  const state = () => ({ backend, busy: false, external: { enabled: true, connectedClients: 0 }, codex: { available: true, connected: true, authenticated: true, model: 'codex', models: [{ id: 'codex' }] } });
  const client = {
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
  return { nodes, get, acknowledgements, snapshots, client, creations,
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
