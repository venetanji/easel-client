const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listTemplates } = require('../src/template-catalog');
const { createTemplatesDrawer } = require('../src/templates-drawer');

function fixture() {
  const document = { activeElement: null };
  function element(tagName = 'div') {
    let text = '';
    const node = {
      tagName, children: [], dataset: {}, attributes: {}, hidden: false, disabled: false, listeners: new Map(),
      get textContent() { return text + this.children.map((child) => child.textContent).join(''); },
      set textContent(value) { text = String(value); this.children = []; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { text = ''; this.children = children; },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key]; },
      removeAttribute(key) { delete this.attributes[key]; },
      addEventListener(type, callback) { this.listeners.set(type, callback); },
      removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); },
      async click() { if (!this.disabled) return this.listeners.get('click')?.(); },
      focus() { document.activeElement = this; },
      querySelectorAll(selector) {
        const all = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
        return selector === '*' ? all : all.filter((child) => selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : child.tagName === selector);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    };
    return node;
  }
  const nodes = new Map(['templates-drawer', 'templates-list', 'templates-detail', 'templates-status', 'templates-recovery', 'templates-refresh'].map((id) => [id, element(id === 'templates-refresh' ? 'button' : 'div')]));
  nodes.get('templates-drawer').append(...[...nodes.entries()].filter(([id]) => id !== 'templates-drawer').map(([, node]) => node));
  document.getElementById = (id) => nodes.get(id);
  document.createElement = element;
  let projectId = '';
  let busy = false;
  const calls = { create: [], open: [], onOpen: [], prompt: [], status: [], busy: [], send: [], generate: [], audio: [] };
  const saved = { projectId: 'a'.repeat(32), instanceId: 'b'.repeat(32), documentPath: `sketches/${'b'.repeat(32)}/index.html`, templateId: 'video-editor', opened: true };
  const client = {
    async listTemplates() { return listTemplates(); },
    async createTemplateInstance(input) { calls.create.push(input); return { ...saved }; },
    async openTemplateInstance(input) { calls.open.push(input); return { ...saved }; },
    sendMessage(input) { calls.send.push(input); }, generateMedia(input) { calls.generate.push(input); }, playAudio(input) { calls.audio.push(input); },
  };
  let openFailure = '';
  let promptFailure = '';
  const options = { document, client, getProjectId: () => projectId, isBusy: () => busy,
    onOpen: async (result) => { if (openFailure) throw Error(openFailure); calls.onOpen.push(result); }, onPrompt: (prompt) => { if (promptFailure) throw Error(promptFailure); calls.prompt.push(prompt); },
    onStatus: (...args) => calls.status.push(args), onBusy: (value) => calls.busy.push(value) };
  const drawer = createTemplatesDrawer(options);
  const buttons = (id) => nodes.get(id).querySelectorAll('button');
  const button = (id, label) => buttons(id).find((item) => item.textContent === label);
  const choose = (id) => buttons('templates-list').find((item) => item.dataset.templateId === id).click();
  return { drawer, nodes, document, client, calls, saved, failOpen: (message) => { openFailure = message; }, failPrompt: (message) => { promptFailure = message; }, buttons, button, choose, project: (value) => { projectId = value; drawer.updateBusy(); }, busy: (value) => { busy = value; drawer.updateBusy(); } };
}

// Removing the catalog selection/create wiring must break both destination assertions.
test('ready_actions_create_or_add', async () => {
  const f = fixture(); await f.drawer.refresh(); f.drawer.setOpen(true);
  await f.choose('video-editor');
  assert.equal(f.button('templates-detail', 'Add to current project').disabled, true);
  assert.match(f.nodes.get('templates-detail').textContent, /Open a project/);
  await f.button('templates-detail', 'Create project').click();
  assert.deepEqual(f.calls.create, [{ templateId: 'video-editor', target: 'new-project' }]);
  assert.equal(f.calls.onOpen[0].instanceId, f.saved.instanceId);
  f.project('c'.repeat(32));
  await f.button('templates-detail', 'Add to current project').click();
  assert.deepEqual(f.calls.create[1], { templateId: 'video-editor', target: 'current-project', projectId: 'c'.repeat(32) });
  assert.deepEqual([f.calls.send, f.calls.generate, f.calls.audio], [[], [], []]);
  assert.match(f.nodes.get('templates-detail').textContent, /60 seconds.*32 MiB/);
});

test('planned_has_no_open and unavailable Strudel explains its real gate', async () => {
  const f = fixture(); await f.drawer.refresh();
  assert.match(f.nodes.get('templates-list').textContent, /Planned/);
  assert.deepEqual(f.buttons('templates-list').map((node) => node.dataset.templateId), ['video-editor', 'strudel-sound']);
  await f.choose('strudel-sound');
  assert.match(f.nodes.get('templates-detail').textContent, /sketch and audio runtime compatibility gate have not passed/);
  assert.equal(f.button('templates-detail', 'Create project').disabled, true);
  f.project('c'.repeat(32));
  assert.equal(f.button('templates-detail', 'Add to current project').disabled, true);
  await f.button('templates-detail', 'Create project').click();
  assert.equal(f.calls.create.length, 0);
});

test('busy_prevents_duplicate_create, including a second event on the old button', async () => {
  const f = fixture(); await f.drawer.refresh(); await f.choose('video-editor');
  let resolve; f.client.createTemplateInstance = (input) => { f.calls.create.push(input); return new Promise((done) => { resolve = done; }); };
  const create = f.button('templates-detail', 'Create project');
  f.busy(true); await create.click(); assert.equal(f.calls.create.length, 0);
  f.busy(false); const pending = create.click(); await create.listeners.get('click')();
  assert.equal(f.calls.create.length, 1);
  assert.equal(create.disabled, true);
  assert.equal(f.nodes.get('templates-drawer').attributes['aria-busy'], 'true');
  resolve(f.saved); await pending;
  assert.deepEqual(f.calls.busy, [true, false]);
});

test('durable_creation_open_failure_retries_identity_without_repeating_create', async () => {
  const f = fixture(); await f.drawer.refresh(); await f.choose('video-editor');
  f.client.createTemplateInstance = async (input) => { f.calls.create.push(input); return { ...f.saved, opened: false, openError: 'Preview failed' }; };
  await f.button('templates-detail', 'Create project').click();
  assert.match(f.nodes.get('templates-recovery').textContent, /saved|Saved/);
  assert.match(f.nodes.get('templates-recovery').textContent, /Preview failed/);
  assert.equal(f.calls.onOpen.length, 0);
  assert.equal(f.button('templates-detail', 'Create project').disabled, true);
  await f.drawer.refresh(); await f.choose('strudel-sound');
  f.client.openTemplateInstance = async (input) => { f.calls.open.push(input); throw Error('Still unavailable'); };
  await f.button('templates-recovery', 'Retry Open').click();
  assert.match(f.nodes.get('templates-recovery').textContent, /Still unavailable/);
  f.client.openTemplateInstance = async (input) => { f.calls.open.push(input); return f.saved; };
  await f.button('templates-recovery', 'Retry Open').click();
  assert.deepEqual(f.calls.open, [1, 2].map(() => ({ projectId: f.saved.projectId, instanceId: f.saved.instanceId })));
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.onOpen.length, 1);
  assert.equal(f.nodes.get('templates-recovery').hidden, true);
});

test('workspace_refresh_failure_also_preserves_saved_identity', async () => {
  const f = fixture(); await f.drawer.refresh(); await f.choose('video-editor');
  // The callback can fail after host creation/open has committed.
  f.failOpen('File listing unavailable');
  await f.button('templates-detail', 'Create project').click();
  assert.match(f.nodes.get('templates-recovery').textContent, /File listing unavailable/);
  assert.ok(f.button('templates-recovery', 'Retry Open'));
});

test('refresh errors are visible, retryable and stale catalog responses are ignored', async () => {
  const f = fixture(); f.client.listTemplates = async () => { throw Error('Catalog unavailable'); };
  await f.drawer.refresh();
  assert.match(f.nodes.get('templates-status').textContent, /Catalog unavailable/);
  const resolves = []; f.client.listTemplates = () => new Promise((resolve) => resolves.push(resolve));
  const old = f.drawer.refresh(); const fresh = f.drawer.refresh();
  resolves[1]([listTemplates()[0]]); await fresh;
  resolves[0](listTemplates()); await old;
  assert.equal(f.buttons('templates-list').length, 1);
});

test('missing kit reason stays visible and blocks creation', async () => {
  const f = fixture(); const [video] = listTemplates();
  video.availability = { available: false, reason: 'The canvas-2d kit is not installed. Check Kits in Settings.', missingKits: ['canvas-2d'] };
  f.client.listTemplates = async () => [video]; await f.drawer.refresh(); await f.choose('video-editor');
  assert.match(f.nodes.get('templates-detail').textContent, /Check Kits in Settings/);
  assert.equal(f.button('templates-detail', 'Create project').disabled, true);
});

test('Explore prepares a creative prompt without dispatching model, media or audio calls', async () => {
  const f = fixture(); await f.drawer.refresh(); await f.choose('video-editor');
  await f.button('templates-detail', 'Explore this idea').click();
  assert.match(f.calls.prompt[0], /Video editor/);
  assert.match(f.calls.prompt[0], /feel/);
  assert.deepEqual([f.calls.create, f.calls.send, f.calls.generate, f.calls.audio], [[], [], [], []]);
});

test('destroy_suppresses_late_results_and_detached_actions', async () => {
  const f = fixture(); await f.drawer.refresh(); await f.choose('video-editor');
  let resolve; f.client.createTemplateInstance = () => new Promise((done) => { resolve = done; });
  const create = f.button('templates-detail', 'Create project'); const pending = create.click();
  f.drawer.destroy(); const before = f.nodes.get('templates-status').textContent;
  resolve(f.saved); await pending; await create.listeners.get('click')?.();
  assert.equal(f.calls.onOpen.length, 0); assert.equal(f.calls.status.length, 0);
  assert.equal(f.nodes.get('templates-status').textContent, before);
  assert.deepEqual(f.calls.busy, [true]);
  const g = fixture(); let finish; g.client.listTemplates = () => new Promise((done) => { finish = done; });
  const loading = g.drawer.refresh(); g.drawer.destroy(); finish(listTemplates()); await loading;
  assert.equal(g.buttons('templates-list').length, 0);
});

test('Templates shell has accessible regions and its script precedes renderer without disturbing removed-skills', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  assert.match(html, /id="nav-templates"[^>]+aria-controls="templates-drawer"/);
  assert.match(html, /id="templates-drawer"[^>]+aria-labelledby="templates-title"[^>]+hidden/);
  assert.match(html, /id="templates-status"[^>]+role="status"/);
  assert.ok(html.indexOf('./templates-drawer.js') >= 0);
  assert.ok(html.indexOf('./templates-drawer.js') < html.indexOf('./renderer.js'));
  assert.ok(html.indexOf('./removed-skills.js') < html.indexOf('./renderer.js'));
});


test('choosing a template shows a focused detail view with a keyboard return to the catalog', async () => {
  const f = fixture(); await f.drawer.refresh(); f.drawer.setOpen(true);
  await f.choose('video-editor');
  assert.equal(f.nodes.get('templates-list').hidden, true);
  assert.equal(f.document.activeElement.textContent, 'Video editor');
  assert.equal(f.document.activeElement.attributes.tabindex, '-1');
  await f.button('templates-detail', 'All templates').click();
  assert.equal(f.nodes.get('templates-list').hidden, false);
  assert.equal(f.nodes.get('templates-detail').hidden, true);
  assert.equal(f.document.activeElement.dataset.templateId, 'video-editor');
});

test('failed creation can be retried and saved recovery receives focus only after busy clears', async () => {
  const f = fixture(); await f.drawer.refresh(); f.drawer.setOpen(true); await f.choose('video-editor');
  f.client.createTemplateInstance = async () => { throw Error('Disk full'); };
  await f.button('templates-detail', 'Create project').click();
  assert.match(f.nodes.get('templates-status').textContent, /Disk full/);
  assert.equal(f.button('templates-detail', 'Create project').disabled, false);
  f.client.createTemplateInstance = async () => ({ ...f.saved, opened: false, openError: 'Preview failed' });
  // Real DOM buttons reject focus while disabled.
  const original = f.document.createElement;
  f.document.createElement = (tag) => { const node = original(tag); const focus = node.focus; node.focus = () => { if (!node.disabled) focus.call(node); }; return node; };
  await f.button('templates-detail', 'Create project').click();
  assert.equal(f.document.activeElement.textContent, 'Retry Open');
});


test('Explore explains an unavailable conversation inside the visible drawer', async () => {
  const f = fixture(); await f.drawer.refresh(); await f.choose('video-editor');
  f.failPrompt('Switch agents under Settings > Agent to use the editable conversation.');
  await f.button('templates-detail', 'Explore this idea').click();
  assert.match(f.nodes.get('templates-status').textContent, /Switch agents/);
  assert.equal(f.nodes.get('templates-status').attributes.role, 'alert');
  assert.deepEqual(f.calls.prompt, []);
});

test('matching confirmed deletion clears saved recovery; unrelated and canceled deletion do not', async () => {
  for (const type of ['project-file-deleted', 'project-deleted']) {
    const f = fixture(); await f.drawer.refresh(); f.drawer.setOpen(true); await f.choose('video-editor');
    f.client.createTemplateInstance = async (input) => { f.calls.create.push(input); return { ...f.saved, opened: false, openError: 'Preview failed' }; };
    await f.button('templates-detail', 'Create project').click();
    for (const event of [
      { type, projectId: 'd'.repeat(32), deletedPath: f.saved.documentPath },
      { type: 'project-file-deleted', projectId: f.saved.projectId, deletedPath: 'another.html' },
      { type: 'media-deleted', projectId: f.saved.projectId, deletedPath: f.saved.documentPath },
      { type, projectId: f.saved.projectId, deletedPath: f.saved.documentPath, deleted: false, canceled: true },
    ]) {
      f.drawer.acceptDeletion(event);
      assert.equal(f.nodes.get('templates-recovery').hidden, false);
      assert.equal(f.button('templates-detail', 'Create project').disabled, true);
    }
    f.drawer.acceptDeletion({ type, projectId: f.saved.projectId, deletedPath: f.saved.documentPath });
    assert.equal(f.nodes.get('templates-recovery').hidden, true);
    assert.match(f.nodes.get('templates-status').textContent, /deleted/);
    assert.equal(f.button('templates-detail', 'Create project').disabled, false);
    await f.drawer.refresh(); f.drawer.setOpen(false); f.drawer.setOpen(true);
    assert.equal(f.button('templates-detail', 'Create project').disabled, false);
    assert.deepEqual(f.calls.open, []);
    assert.equal(f.calls.create.length, 1);
  }
});

test('explicit retry dismissal releases creation without deleting, reopening or duplicating saved work', async () => {
  const f = fixture(); await f.drawer.refresh(); f.drawer.setOpen(true); await f.choose('video-editor');
  f.client.createTemplateInstance = async (input) => { f.calls.create.push(input); return { ...f.saved, opened: false, openError: 'Preview failed' }; };
  await f.button('templates-detail', 'Create project').click();
  f.client.openTemplateInstance = async (input) => { f.calls.open.push(input); throw Error('The template instance or its document no longer exists.'); };
  await f.button('templates-recovery', 'Retry Open').click();
  assert.equal(f.button('templates-detail', 'Create project').disabled, true);
  assert.match(f.nodes.get('templates-recovery').textContent, /does not delete or recreate/);
  const dismiss = f.button('templates-recovery', 'Dismiss Open retry');
  assert.ok(dismiss);
  f.busy(true); await dismiss.click(); assert.equal(f.nodes.get('templates-recovery').hidden, false);
  f.busy(false); await dismiss.click();
  assert.equal(f.nodes.get('templates-recovery').hidden, true);
  assert.equal(f.button('templates-detail', 'Create project').disabled, false);
  assert.equal(f.calls.create.length, 1);
  assert.deepEqual(f.calls.open, [{ projectId: f.saved.projectId, instanceId: f.saved.instanceId }]);
  assert.deepEqual(f.calls.onOpen, []);
});

test('matching deletion during a pending retry invalidates its late opened result', async () => {
  const f = fixture(); await f.drawer.refresh(); f.drawer.setOpen(true); await f.choose('video-editor');
  f.client.createTemplateInstance = async () => ({ ...f.saved, opened: false, openError: 'Preview failed' });
  await f.button('templates-detail', 'Create project').click();
  let finish; f.client.openTemplateInstance = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.button('templates-recovery', 'Retry Open').click();
  f.drawer.acceptDeletion({ type: 'project-file-deleted', projectId: f.saved.projectId, deletedPath: f.saved.documentPath });
  finish(f.saved); await pending;
  assert.equal(f.nodes.get('templates-recovery').hidden, true);
  assert.match(f.nodes.get('templates-status').textContent, /deleted/);
  assert.equal(f.button('templates-detail', 'Create project').disabled, false);
  assert.deepEqual(f.calls.onOpen, []);
});
