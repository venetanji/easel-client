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
  appendReadyMediaCards,
  appendMediaPreviewMessage,
  canAutoPreviewMedia,
  renderInstalledKitCatalog,
  renderNewProjectKits,
  renderSkillList,
  skillCompatibility,
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
    removeAttribute(name) { delete this.attributes[name]; delete this[name]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ''; this.children = [...children]; },
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((child) => [child, ...(child.querySelectorAll?.('*') || [])]);
      if (selector === '*') return descendants;
      return descendants.filter((child) => selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : child.tagName === selector);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    pause() { this.paused = true; },
    load() {},
    async play() { this.played = true; },
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

test('new projects offer installed kits and report an explicit empty selection', () => {
  const list = element();
  const changes = [];
  const catalog = [
    { id: 'canvas-2d', name: 'Canvas 2D', installed: true },
    { id: 'tone', name: 'Tone.js', description: 'Interactive audio', installed: true },
    { id: 'p5', name: 'p5.js', installed: true },
    { id: 'three', name: 'Three.js', installed: false },
  ];
  const inputs = renderNewProjectKits({ createElement: element }, list, catalog, ['canvas-2d', 'tone'], (kits) => changes.push(kits));
  assert.deepEqual(inputs.map((input) => input.value), ['canvas-2d', 'tone', 'p5']);
  assert.deepEqual(inputs.map((input) => input.checked), [true, true, false]);
  assert.equal(list.children[1].title, 'Interactive audio');
  assert.equal(list.children[2].tagName, 'label');
  assert.equal(list.children[2].children[1].textContent, 'p5.js');
  inputs[2].checked = true;
  inputs[2].listeners.change();
  assert.deepEqual(changes.at(-1), ['canvas-2d', 'tone', 'p5']);
  inputs.forEach((input) => { input.checked = false; });
  inputs[0].listeners.change();
  assert.deepEqual(changes.at(-1), []);
  assert.deepEqual(renderNewProjectKits({ createElement: element }, list, [], [], () => {}), []);
  assert.equal(list.children.length, 0);
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

test('completed video references render one playable card across ready, notification, and history events', async () => {
  const document = { createElement: (tag) => element(tag) };
  const messages = element();
  const previews = new Map();
  const objectUrls = new Set();
  const assetId = 'a'.repeat(32);
  const asset = { assetId, mimeType: 'video/mp4', name: 'Sunlit cat in motion.mp4', thumbnail: 'data:image/png;base64,YWJj', duration: 3 };
  let reads = 0;
  const seen = [];
  const options = { objectUrls, loadAsset: async () => { reads += 1; return { ...asset, data: 'YWJj' }; }, onSeen: (id) => seen.push(id) };
  assert.equal(appendReadyMediaCards({ document, messagesElement: messages, event: { assets: [asset] }, assetPreviews: previews, options }), 1);
  assert.equal(reads, 0);
  assert.equal(previews.get(assetId).image.src, undefined);
  assert.equal(previews.get(assetId).image.poster, asset.thumbnail);
  assert.equal(previews.get(assetId).image.preload, 'none');
  assert.match(messages.textContent, /New video/);
  assert.match(messages.textContent, /Sunlit cat in motion/);
  assert.equal(appendReadyMediaCards({ document, messagesElement: messages, event: { result: { assets: [asset] } }, assetPreviews: previews, options }), 0);
  assert.equal(appendReadyMediaCards({ document, messagesElement: messages, event: { job: { assets: [asset] } }, assetPreviews: previews, options }), 0);
  assert.equal(messages.children.length, 1);
  await messages.querySelector('.message-media-play').listeners.click();
  assert.equal(reads, 1);
  assert.match(previews.get(assetId).image.src, /^blob:/);
  assert.equal(previews.get(assetId).image.played, true);
  assert.deepEqual(seen, [assetId]);
  assert.equal(objectUrls.size, 1);
  await previews.get(assetId).load();
  assert.equal(reads, 1);
  previews.get(assetId).dispose();
  assert.equal(objectUrls.size, 0);
  assert.equal(previews.get(assetId).image.src, undefined);
});

test('a late video read cannot attach bytes after its chat preview is disposed', async () => {
  const document = { createElement: (tag) => element(tag) };
  const objectUrls = new Set();
  const asset = { assetId: 'a'.repeat(32), mimeType: 'video/mp4', name: 'Video.mp4' };
  let resolveAsset;
  const preview = appendMediaPreviewMessage(document, element(), asset, null, { objectUrls, loadAsset: () => new Promise((resolve) => { resolveAsset = resolve; }) });
  const pending = preview.load();
  preview.dispose();
  resolveAsset({ ...asset, data: 'YWJj' });
  await pending;
  assert.equal(objectUrls.size, 0);
  assert.equal(preview.image.src, undefined);
});

test('compact media cards keep actions independent from lazy playback and surface retrieval errors', async () => {
  const document = { createElement: (tag) => element(tag), createElementNS: (_namespace, tag) => element(tag) };
  const messages = element();
  const actions = [];
  const asset = { assetId: 'a'.repeat(32), mimeType: 'video/mp4', name: 'Video.mp4' };
  const preview = appendMediaPreviewMessage(document, messages, asset, null, {
    onOpen: () => actions.push('open'), onDownload: () => actions.push('download'), onUse: () => actions.push('use'),
    loadAsset: async () => { throw new Error('The saved media is unavailable.'); },
  });
  for (const button of messages.querySelector('.message-media-actions').children) await button.listeners.click();
  assert.deepEqual(actions, ['open', 'download', 'use']);
  await messages.querySelector('.message-media-play').listeners.click();
  assert.match(messages.querySelector('.message-media-error').textContent, /saved media is unavailable/);
  assert.equal(messages.querySelector('.message-media-error').hidden, false);
  assert.equal(preview.image.src, undefined);
});

test('automatic media preview respects originating chat and project, viewer content, drafts, and activity', () => {
  const state = { event: { chatId: 'chat-a', projectId: 'project-a' }, activeChatId: 'chat-a', projectId: 'project-a', previewKind: 'empty', busy: false };
  assert.equal(canAutoPreviewMedia(state), true);
  assert.equal(canAutoPreviewMedia({ ...state, projectId: '' }), true);
  for (const override of [{ activeChatId: 'chat-b' }, { projectId: 'project-b' }, { previewKind: 'document' }, { previewKind: 'image' }, { previewKind: 'video' }, { busy: true }, { draft: 'A pending idea' }, { attachments: 1 }]) assert.equal(canAutoPreviewMedia({ ...state, ...override }), false);
});

test('Settings kit inventory reports installation availability without selection controls', () => {
  const document = { createElement: (tag) => element(tag) };
  const list = element();
  renderInstalledKitCatalog(document, list, [{ id: 'tone', name: 'Tone.js', description: 'Offline synthesis', installed: true, version: '15' }, { id: 'other', name: 'Other kit', description: 'Not installed', installed: false }]);
  assert.match(list.textContent, /Installed 15/);
  assert.match(list.textContent, /Unavailable/);
  assert.equal(list.querySelectorAll('input').length, 0);
});

test('unsupported bundled skill copies stay editable but cannot be enabled', () => {
  const document = { createElement: (tag) => element(tag) };
  const catalog = [{ id: 'hyperframes', name: 'HyperFrames', compatibility: 'unsupported', reason: 'Requires a CLI unavailable in this client.' }, { id: 'easel-media', name: 'easel-media', compatibility: 'supported' }];
  const legacy = { id: 'pack-hyperframes', name: 'HyperFrames', instructions: 'Preserved instructions', enabled: false };
  assert.equal(skillCompatibility({ ...legacy, id: 'custom-copy', name: 'hyperframes' }, catalog).supported, false);
  assert.equal(skillCompatibility({ id: 'custom', name: 'My visual style' }, catalog).supported, true);
  const list = element();
  renderSkillList({ document, listElement: list, skills: [legacy], compatibility: (skill) => skillCompatibility(skill, catalog) });
  assert.equal(list.querySelectorAll('input')[0].disabled, true);
  assert.match(list.textContent, /removed from Easel/);
  assert.equal(list.querySelectorAll('button').find((button) => button.textContent === 'Edit').disabled, false);
});

test('chat submit forwards an exact explicit timeline selection without renderer context or bytes', async () => {
  const input = element('textarea'); input.value = 'Trim this range';
  let options;
  const selection = { projectId: 'a'.repeat(32), timelineId: 'tl', timelineRevision: 2, trackIds: ['video-1'], itemIds: ['clip'], startFrame: 10, endFrame: 20 };
  await handleChatSubmit({ client: { async sendMessage(_text, value) { options = value; return { ok: true }; } },
    document: { createElement: (tag) => element(tag) }, input, button: element('button'), statusElement: element(), messagesElement: element(), timelineSelection: selection });
  assert.deepEqual(options.timelineSelection, selection);
  assert.equal(options.timelineContext, undefined);
});

test('removed skill copies stay disabled without an installed catalog and preserve their text', () => {
  for (const name of ['hyperframes', 'HyperFrames', 'hyperframes-animation', 'orbit-card', 'talking-head-recut']) {
    const legacy = { id: 'custom-copy', name, instructions: 'Preserved instructions', enabled: true };
    assert.equal(skillCompatibility(legacy, []).supported, false, name);
    assert.equal(legacy.instructions, 'Preserved instructions');
  }
  assert.equal(skillCompatibility({ id: 'pack-installed-hyperframes', name: 'Renamed copy' }, []).supported, false);
  assert.equal(skillCompatibility({ id: 'custom', name: 'My visual style' }, []).supported, true);
});

for (const narrow of [true, false]) {
  test(`adopting a template reveals its canvas with narrow=${narrow}`, async () => {
    const { adoptCreatedTemplate } = require('../src/renderer');
    const events = [];
    const studio = { dataset: { sidebar: 'open' } };
    const canvas = { focus: () => events.push('focus'), scrollIntoView: options => events.push(['scroll', options]) };
    const document = { defaultView: { matchMedia: query => { assert.equal(query, '(max-width: 850px)'); return { matches: narrow }; } }, querySelector: selector => selector === '.studio' ? studio : canvas };
    const workspace = { changed: async result => events.push(['adopt', result]), setDrawer: (...args) => events.push(['drawer', ...args, studio.dataset.sidebar]) };
    await adoptCreatedTemplate({ document, workspace, result: { instanceId: 'saved' }, isCurrentView: () => true, isDisposed: () => false, updateCanvasBounds: () => events.push('bounds') });
    assert.deepEqual(events[0], ['adopt', { instanceId: 'saved' }]);
    assert.deepEqual(events[1], ['drawer', false, !narrow, 'templates', narrow ? 'closed' : 'open']);
    assert.equal(studio.dataset.sidebar, narrow ? 'closed' : 'open');
    assert.equal(events.includes('focus'), narrow);
    assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'scroll').length, narrow ? 1 : 0);
  });
}
for (const reason of ['navigated', 'disposed']) {
  test(`template adoption does not steal focus after ${reason}`, async () => {
    const { adoptCreatedTemplate } = require('../src/renderer');
    let changed = false, bounds = 0;
    await adoptCreatedTemplate({ document: { querySelector() { assert.fail('No UI access after the user leaves'); } }, workspace: { changed: async () => { changed = true; }, setDrawer() { assert.fail('No drawer change'); } }, result: {}, isCurrentView: () => reason !== 'navigated', isDisposed: () => reason === 'disposed', updateCanvasBounds: () => { bounds++; } });
    assert.ok(changed); assert.equal(bounds, reason === 'disposed' ? 0 : 1);
  });
}

test('workbench width limits reserve the actual rail width and 300px canvas', () => {
  const { getWorkbenchWidthLimits } = require('../src/renderer');
  assert.deepEqual(getWorkbenchWidthLimits(900, 68), { min: 280, max: 531 });
  assert.deepEqual(getWorkbenchWidthLimits(900, 44), { min: 280, max: 555 });
  assert.deepEqual(getWorkbenchWidthLimits(1600, 68), { min: 280, max: 580 });
});

test('narrow horizontal activity bars do not overwrite the saved desktop split width', () => {
  const { getWorkbenchWidthLimits } = require('../src/renderer');
  assert.deepEqual(getWorkbenchWidthLimits(800, 800), { min: 280, max: 580 });
  assert.deepEqual(getWorkbenchWidthLimits(600, 600), { min: 280, max: 580 });
});
