const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleChatSubmit,
  handleSettingsSubmit,
  refreshLiteLLMModels,
  testLiteLLMConnection,
  undoCanvas,
  renderAgentEvent,
  renderAssetLibrary,
  renderCanvasLibrary,
  submitChatWithShortcut,
  createCanvas,
} = require('../src/renderer');

function element(tagName = 'div') {
  const listeners = {};
  const classes = new Set();
  let text = '';
  return {
    tagName,
    listeners,
    children: [],
    attributes: {},
    dataset: {},
    value: '',
    get textContent() { return text + this.children.map((child) => child.textContent || '').join(''); },
    set textContent(value) { text = String(value); this.children = []; },
    className: '',
    disabled: false,
    placeholder: '',
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(name, callback) { listeners[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ''; this.children = [...children]; },
    querySelectorAll() { return []; },
  };
}

const fields = () => ({
  easelBaseUrl: element('input'),
  easelApiKey: element('input'),
  litellmBaseUrl: element('input'),
  litellmModel: element('input'),
  litellmApiKey: element('input'),
  clearEaselApiKey: element('input'),
  clearLiteLLMApiKey: element('input'),
});

test('saves endpoint settings, clears entered secrets, and only receives public flags back', async () => {
  const input = fields();
  input.easelBaseUrl.value = 'https://easel.ait4x.org';
  input.easelApiKey.value = 'easel-secret';
  input.litellmBaseUrl.value = 'http://127.0.0.1:4000/v1';
  input.litellmModel.value = 'design-model';
  input.litellmApiKey.value = 'llm-secret';
  const status = element();
  let submitted;
  const result = await handleSettingsSubmit({
    client: {
      async saveSettings(value) { submitted = value; return { hasEaselApiKey: true, hasLiteLLMApiKey: true }; },
    },
    fields: input,
    statusElement: status,
  });
  assert.equal(submitted.easelApiKey, 'easel-secret');
  assert.equal(submitted.litellmApiKey, 'llm-secret');
  assert.equal(input.easelApiKey.value, '');
  assert.equal(input.litellmApiKey.value, '');
  assert.equal(result.hasEaselApiKey, true);
  assert.match(status.textContent, /saved/i);
});

test('refreshes one model catalog and preserves a saved model omitted by the server', async () => {
  const select = element('select');
  select.value = 'saved/model';
  const status = element();
  let requests = 0;
  const models = await refreshLiteLLMModels({
    client: { async listLiteLLMModels() { requests += 1; return [{ id: 'new/model', name: 'New Model' }]; } },
    select,
    statusElement: status,
  });
  assert.equal(requests, 1);
  assert.deepEqual(models, [{ id: 'new/model', name: 'New Model' }]);
  assert.equal(select.children.length, 2);
  assert.equal(select.children[0].value, 'saved/model');
  assert.equal(select.children[0].textContent, 'saved/model (saved; not in catalog)');
  assert.equal(select.value, 'saved/model');
  assert.match(status.textContent, /1 LiteLLM model/i);
});

test('keeps the saved model and reports a useful status when catalog refresh fails', async () => {
  const select = element('select');
  select.value = 'saved/model';
  const status = element();
  await assert.rejects(refreshLiteLLMModels({
    client: { async listLiteLLMModels() { throw new Error('server unavailable'); } },
    select,
    statusElement: status,
  }), /server unavailable/);
  assert.equal(select.value, 'saved/model');
  assert.match(status.textContent, /could not load.*server unavailable/i);
});

test('keeps settings loaded while the model catalog request is pending', async () => {
  const select = element('select');
  let complete;
  const request = refreshLiteLLMModels({
    client: { listLiteLLMModels: () => new Promise((resolve) => { complete = resolve; }) },
    select, statusElement: element(),
  });
  select.value = 'saved/model';
  complete([{ id: 'first/model', name: 'First model' }]);
  await request;
  assert.equal(select.value, 'saved/model');
  assert.equal(select.children[0].value, 'saved/model');
});

test('runs only the explicitly selected text or image connection probe', async () => {
  const status = element();
  const selected = element('select');
  selected.value = 'provider/model-a';
  const calls = [];
  const verified = [];
  const client = {
    async testLiteLLMChat(model) { calls.push(['chat', model]); return { ok: true, message: 'Text response received.' }; },
    async testLiteLLMImage(model) { calls.push(['image', model]); return { ok: true, message: 'Image generation response received.' }; },
  };
  await testLiteLLMConnection({
    client, modelSelect: selected, kind: 'chat', statusElement: status,
    onSuccess: (kind, model) => verified.push([kind, model]),
  });
  assert.match(status.textContent, /text response received/i);
  await testLiteLLMConnection({
    client, modelSelect: selected, kind: 'image', statusElement: status,
    onSuccess: (kind, model) => verified.push([kind, model]),
  });
  assert.match(status.textContent, /image generation response received/i);
  assert.deepEqual(calls, [['chat', 'provider/model-a'], ['image', 'provider/model-a']]);
  assert.deepEqual(verified, [['chat', 'provider/model-a'], ['image', 'provider/model-a']]);
});

test('clears a prior capability result when a later probe fails', async () => {
  const status = element();
  const failures = [];
  await assert.rejects(testLiteLLMConnection({
    client: { async testLiteLLMChat() { throw new Error('endpoint unavailable'); } },
    modelSelect: Object.assign(element('select'), { value: 'provider/model-a' }),
    kind: 'chat',
    statusElement: status,
    onFailure: (kind, model) => failures.push([kind, model]),
  }), /endpoint unavailable/);
  assert.deepEqual(failures, [['chat', 'provider/model-a']]);
});

test('submits chat messages and always re-enables the send button', async () => {
  const input = element('textarea');
  input.value = '  make a paper crane  ';
  const button = element('button');
  const status = element();
  const messages = element();
  const document = { createElement: (tagName) => element(tagName) };
  let submitted;
  const result = await handleChatSubmit({
    client: { async sendMessage(value) { submitted = value; return { ok: true }; } },
    document,
    input,
    button,
    statusElement: status,
    messagesElement: messages,
  });
  assert.equal(submitted, 'make a paper crane');
  assert.equal(button.disabled, false);
  assert.equal(result.ok, true);
  assert.equal(status.textContent, '');
});

test('creates a named canvas through the client and reports its title', async () => {
  const status = element();
  let selectedKits;
  const result = await createCanvas({
    client: { async createCanvas(title, kits) { selectedKits = kits; return { id: 'c'.repeat(32), title }; } },
    title: 'Campaign board',
    kits: ['canvas-2d', 'tone'],
    statusElement: status,
  });
  assert.equal(result.title, 'Campaign board');
  assert.deepEqual(selectedKits, ['canvas-2d', 'tone']);
  assert.equal(status.textContent, 'Created Campaign board.');
});

test('undoes a canvas change and updates the active canvas state', async () => {
  const status = element();
  const updated = [];
  const result = await undoCanvas({
    client: { async undoCanvas(id) { return { id, title: 'Board', undone: true, undoAvailable: false }; } },
    canvasId: 'c'.repeat(32),
    statusElement: status,
    onCanvasChange: (canvas) => updated.push(canvas),
  });
  assert.equal(result.undone, true);
  assert.equal(status.textContent, 'Undid last change to Board.');
  assert.deepEqual(updated, [result]);
});

test('reports when there is no canvas change to undo', async () => {
  const status = element();
  let requests = 0;
  let updated;
  const result = await undoCanvas({
    client: { async undoCanvas(id) { requests += 1; return { id, title: 'Board', undone: false, undoAvailable: false }; } },
    canvasId: 'c'.repeat(32),
    statusElement: status,
    onCanvasChange: (canvas) => { updated = canvas; },
  });
  assert.equal(requests, 1);
  assert.equal(result.undone, false);
  assert.equal(updated.undoAvailable, false);
  assert.equal(status.textContent, 'Nothing to undo.');
});

test('Enter submits chat while Ctrl+Enter remains multiline', () => {
  let submitted = 0;
  let prevented = 0;
  const form = { requestSubmit() { submitted += 1; } };
  const button = element('button');
  assert.equal(submitChatWithShortcut({ key: 'Enter', ctrlKey: false, preventDefault() { prevented += 1; } }, form, button), true);
  assert.equal(submitChatWithShortcut({ key: 'Enter', ctrlKey: true, preventDefault() {} }, form, button), false);
  assert.equal(submitted, 1);
  assert.equal(prevented, 1);
  button.disabled = true;
  assert.equal(submitChatWithShortcut({ key: 'Enter', ctrlKey: false, preventDefault() {} }, form, button), true);
  assert.equal(submitted, 1);
});

test('renders safe Markdown, escapes untrusted HTML, and accepts only image data URLs', (t) => {
  const previousMarkdownIt = globalThis.markdownit;
  globalThis.markdownit = require('markdown-it');
  t.after(() => {
    if (previousMarkdownIt === undefined) delete globalThis.markdownit;
    else globalThis.markdownit = previousMarkdownIt;
  });
  const document = {
    createElement: (tagName) => element(tagName),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  };
  const messages = element();
  const images = element();
  renderAgentEvent({
    document,
    messagesElement: messages,
    imagesElement: images,
    event: { type: 'assistant', text: '**Safe formatting**\n\n<img src=x onerror=alert(1)>\n\n[Run](javascript:alert(1))\n\n![Remote image](https://example.org/a.png)' },
    statusElement: element(),
  });
  const content = messages.children[0].children[0];
  assert.match(content.innerHTML, /<strong>Safe formatting<\/strong>/);
  assert.match(content.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(content.innerHTML, /Remote image/);
  assert.doesNotMatch(content.innerHTML, /<img\b|href=["']javascript:/i);
  assert.equal(content.classList.contains('markdown'), true);
  renderAgentEvent({
    document,
    messagesElement: messages,
    imagesElement: images,
    event: { type: 'image', assetId: 'asset-1', mimeType: 'image/png', data: 'YWJj' },
    statusElement: element(),
  });
  assert.equal(images.children[0].children[0].src, 'data:image/png;base64,YWJj');
  renderAgentEvent({
    document,
    messagesElement: messages,
    imagesElement: images,
    event: { type: 'image', mimeType: 'image/png', data: 'https://example.org/a.png' },
    statusElement: element(),
  });
  assert.equal(images.children.length, 1);
});

test('renders only managed media thumbnails and calls the add-to-canvas action', () => {
  const document = { createElement: (tagName) => element(tagName) };
  const list = element();
  const empty = element();
  let added;
  renderAssetLibrary({
    document,
    listElement: list,
    emptyElement: empty,
    assets: [
      { id: 'a'.repeat(32), mimeType: 'image/png', thumbnail: 'data:image/png;base64,YWJj' },
      { id: 'b'.repeat(32), mimeType: 'image/png', thumbnail: 'https://example.org/image.png' },
    ],
    onAdd: (id) => { added = id; },
  });
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].children[0].src, 'data:image/png;base64,YWJj');
  assert.equal(empty.hidden, true);
  list.children[0].children[2].listeners.click();
  assert.equal(added, 'a'.repeat(32));
});

test('disables adding media when no canvas is active', () => {
  const document = { createElement: (tagName) => element(tagName) };
  const list = element();
  renderAssetLibrary({
    document,
    listElement: list,
    emptyElement: element(),
    assets: [{ id: 'a'.repeat(32), mimeType: 'image/png', thumbnail: 'data:image/png;base64,YWJj' }],
    canAdd: false,
  });
  assert.equal(list.children[0].children[2].disabled, true);
  assert.match(list.children[0].children[2].title, /open or create/i);
});

test('renders saved canvas rows with separate open and export actions', () => {
  const document = { createElement: (tagName) => element(tagName) };
  const list = element();
  const empty = element();
  const actions = [];
  renderCanvasLibrary({
    document,
    listElement: list,
    emptyElement: empty,
    canvases: [{ id: 'c'.repeat(32), title: 'Poster' }],
    onOpen: (canvas) => actions.push(['open', canvas.id]),
    onExport: (id) => actions.push(['export', id]),
  });
  list.children[0].children[0].listeners.click();
  list.children[0].children[1].listeners.click();
  assert.deepEqual(actions, [['open', 'c'.repeat(32)], ['export', 'c'.repeat(32)]]);
  assert.equal(empty.hidden, true);
});
