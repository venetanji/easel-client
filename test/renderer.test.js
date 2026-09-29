const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleChatSubmit,
  handleSettingsSubmit,
  renderAgentEvent,
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
