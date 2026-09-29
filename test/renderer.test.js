const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleChatSubmit,
  handleSettingsSubmit,
  renderAgentEvent,
  renderAssetLibrary,
  renderCanvasLibrary,
  submitChatWithShortcut,
  createCanvas,
} = require('../src/renderer');

function element(tagName = 'div') {
  const listeners = {};
  const classes = new Set();
  return {
    tagName,
    listeners,
    children: [],
    attributes: {},
    value: '',
    textContent: '',
    className: '',
    disabled: false,
    placeholder: '',
    classList: {
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(name, callback) { listeners[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
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
  const result = await createCanvas({
    client: { async createCanvas(title) { return { id: 'c'.repeat(32), title }; } },
    title: 'Campaign board',
    statusElement: status,
  });
  assert.equal(result.title, 'Campaign board');
  assert.equal(status.textContent, 'Created Campaign board.');
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

test('renders untrusted agent text literally and accepts only image data URLs', () => {
  const document = { createElement: (tagName) => element(tagName) };
  const messages = element();
  const images = element();
  renderAgentEvent({
    document,
    messagesElement: messages,
    imagesElement: images,
    event: { type: 'assistant', text: '<img src=x onerror=alert(1)>' },
    statusElement: element(),
  });
  assert.equal(messages.children[0].textContent, '<img src=x onerror=alert(1)>');
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
