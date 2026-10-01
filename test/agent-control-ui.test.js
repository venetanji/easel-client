const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentControlUi } = require('../src/agent-control-ui');
const { renderStreamingAgentEvent } = require('../src/renderer');

function element(tagName = 'div') {
  const listeners = new Map();
  const classes = new Set();
  let text = '';
  return {
    tagName, children: [], attributes: {}, dataset: {}, value: '', hidden: false, disabled: false,
    get textContent() { return text + this.children.map((child) => child.textContent || '').join(''); },
    set textContent(value) { text = String(value); this.children = []; },
    classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); }, add(...names) { names.forEach((name) => classes.add(name)); }, contains(name) { return classes.has(name); } },
    addEventListener(name, action) { const actions = listeners.get(name) || []; actions.push(action); listeners.set(name, actions); },
    removeEventListener(name, action) { listeners.set(name, (listeners.get(name) || []).filter((listener) => listener !== action)); },
    async dispatchEvent(event) { for (const action of [...(listeners.get(event.type) || [])]) await action(event); },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { text = ''; this.children = [...children]; },
    querySelector(selector) { return this.children.find((child) => child.className?.split(' ').includes(selector.slice(1))) || null; },
    querySelectorAll() { return []; },
  };
}

function fixture() {
  const nodes = new Map();
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element,
    createElementNS: (_namespace, tag) => element(tag),
    createTextNode: (text) => { const node = element(); node.textContent = text; return node; },
  };
  const composer = element(); composer.className = 'composer';
  document.getElementById('chat-form').append(composer);
  const calls = [];
  const copied = [];
  let state = { backend: 'builtin', busy: false, external: { enabled: true, url: 'http://127.0.0.1:4100/mcp', connectedClients: 0 }, codex: {} };
  const client = {
    async getAgentControl() { calls.push(['getAgentControl']); return state; },
    async setAgentBackend(backend) { calls.push(['setAgentBackend', backend]); state = { ...state, backend }; return state; },
    async getMcpConnection() { calls.push(['getMcpConnection']); return { url: state.external.url, bearerToken: 'explicit-secret' }; },
    async codexLogin(options) { calls.push(['codexLogin', options]); state = { ...state, codex: { ...state.codex, login: { loginId: 'login-1', type: options.type, verificationUrl: 'https://example.com/device', userCode: 'ABCD-1234' } } }; return state; },
    async codexCancelLogin(loginId) { calls.push(['codexCancelLogin', loginId]); state = { ...state, codex: { ...state.codex, login: undefined } }; return state; },
    async codexLogout() { calls.push(['codexLogout']); state = { ...state, codex: { ...state.codex, authenticated: false, model: '' } }; return state; },
    async selectCodexModel(model) { calls.push(['selectCodexModel', model]); state = { ...state, codex: { ...state.codex, model } }; return state; },
    async stopAgent() { calls.push(['stopAgent']); state = { ...state, busy: false, external: { ...state.external, connectedClients: 0 } }; return { stopping: true }; },
    async openExternal(url) { calls.push(['openExternal', url]); },
  };
  const ui = createAgentControlUi({ document, client, copyText: async (text) => copied.push(text) });
  const apply = (next) => { state = { ...state, ...next }; ui.applyState(state); };
  const click = (id) => document.getElementById(id).dispatchEvent(new Event('click'));
  const change = async (id, value) => {
    const input = document.getElementById(id);
    input.checked = true;
    if (value !== undefined) input.value = value;
    await input.dispatchEvent(new Event('change'));
    await new Promise(setImmediate);
  };
  return { ui, document, nodes, composer, calls, copied, client, apply, click, change };
}

test('keeps send unready until state loads and never requests a token when rendering', () => {
  const f = fixture();
  assert.equal(f.ui.isReady(), false);
  f.apply({});
  assert.equal(f.ui.isReady(), true);
  f.apply({ backend: 'external' });
  assert.deepEqual(f.calls, []);
  assert.equal(f.ui.isReady(), false);
  assert.equal(f.ui.isExternal(), true);
  assert.equal(f.document.getElementById('composer-external').hidden, false);
  assert.equal(f.composer.hidden, true);
  assert.match(f.document.getElementById('agent-mcp-command').textContent, /--bearer-token-env-var EASEL_MCP_TOKEN/);
  assert.doesNotMatch(f.document.getElementById('agent-mcp-command').textContent, /explicit-secret/);
});

test('switches mode without replacing the draft or composer and locks choices during runs', async () => {
  const f = fixture(); f.apply({});
  f.document.getElementById('message').value = 'Keep this draft';
  await f.change('agent-backend-external');
  assert.equal(f.ui.isExternal(), true);
  assert.equal(f.document.getElementById('message').value, 'Keep this draft');
  assert.equal(f.document.getElementById('chat-form').children[0], f.composer);
  f.apply({ busy: true });
  await f.change('agent-backend-codex');
  assert.deepEqual(f.calls, [['setAgentBackend', 'external']]);
  assert.equal(f.document.getElementById('agent-backend-external').checked, true);
  assert.equal(f.document.getElementById('agent-backend-codex').disabled, true);
  f.apply({ busy: false }); f.ui.setBusy(true);
  await f.change('agent-backend-builtin');
  assert.equal(f.calls.length, 1);
});

test('reveals and copies the bearer token only after explicit actions and clears it when leaving', async () => {
  const f = fixture(); f.apply({ backend: 'external' });
  await f.click('agent-mcp-reveal');
  assert.equal(f.document.getElementById('agent-mcp-token').value, 'explicit-secret');
  assert.equal(f.document.getElementById('agent-mcp-token-field').hidden, false);
  await f.click('agent-mcp-reveal');
  assert.equal(f.document.getElementById('agent-mcp-token').value, '');
  await f.click('agent-mcp-copy');
  assert.deepEqual(f.copied, ['explicit-secret']);
  assert.equal(f.document.getElementById('agent-mcp-token-field').hidden, true);
  await f.click('agent-mcp-reveal');
  f.apply({ backend: 'builtin' });
  assert.equal(f.document.getElementById('agent-mcp-token').value, '');
  assert.equal(f.calls.filter(([name]) => name === 'getMcpConnection').length, 3);
});

test('ignores a token response after leaving external mode', async () => {
  const f = fixture(); f.apply({ backend: 'external' });
  let resolve;
  f.client.getMcpConnection = () => new Promise((done) => { resolve = done; });
  const reveal = f.click('agent-mcp-reveal');
  f.apply({ backend: 'builtin' });
  resolve({ bearerToken: 'late-secret' });
  await reveal;
  assert.equal(f.document.getElementById('agent-mcp-token').value, '');
  assert.equal(f.document.getElementById('agent-mcp-token-field').hidden, true);
});

test('can disconnect an external controller during a run and clears its revealed token', async () => {
  const f = fixture(); f.apply({ backend: 'external', busy: true, external: { enabled: true, connectedClients: 1, url: 'http://127.0.0.1:4100/mcp' } });
  await f.click('agent-mcp-reveal');
  assert.equal(f.document.getElementById('agent-backend-builtin').disabled, true);
  assert.equal(f.document.getElementById('agent-mcp-disconnect').disabled, false);
  await f.click('agent-mcp-disconnect');
  assert.ok(f.calls.some(([name]) => name === 'stopAgent'));
  assert.equal(f.document.getElementById('agent-mcp-token').value, '');
  assert.equal(f.document.getElementById('agent-mcp-disconnect').disabled, true);
  assert.match(f.document.getElementById('agent-control-status').textContent, /Accepted media jobs continue/);
});

test('shows missing Codex runtime and supports explicit device sign-in, cancellation, and shared sign-out', async () => {
  const f = fixture(); f.apply({ backend: 'codex', codex: { available: false } });
  assert.equal(f.ui.isReady(), false);
  assert.equal(f.document.getElementById('agent-codex-install').hidden, false);
  assert.equal(f.document.getElementById('agent-codex-login-actions').hidden, true);
  f.apply({ codex: { available: true, connected: true, authenticated: false } });
  await f.click('agent-codex-device');
  assert.deepEqual(f.calls[0], ['codexLogin', { type: 'chatgptDeviceCode' }]);
  assert.equal(f.document.getElementById('agent-codex-user-code').textContent, 'ABCD-1234');
  assert.equal(f.document.getElementById('agent-codex-login-panel').hidden, false);
  await f.click('agent-codex-cancel');
  assert.deepEqual(f.calls[1], ['codexCancelLogin', 'login-1']);
  assert.equal(f.document.getElementById('agent-codex-login-panel').hidden, true);
  f.apply({ codex: { available: true, connected: true, authenticated: true, accountLabel: 'Studio account', model: 'model-a', models: [{ id: 'model-a', displayName: 'Model A' }] } });
  assert.equal(f.ui.isReady(), true);
  assert.equal(f.document.getElementById('agent-codex-account').textContent, 'Studio account');
  assert.equal(f.document.getElementById('agent-codex-signout-section').hidden, false);
  await f.click('agent-codex-signout');
  assert.deepEqual(f.calls[2], ['codexLogout']);
  assert.equal(f.ui.isReady(), false);
});

test('uses Codex model selection for themed dropdown events and rejects switches during a run', async () => {
  const f = fixture();
  const codex = { available: true, connected: true, authenticated: true, model: 'model-a', models: [{ id: 'model-a', displayName: 'Model A' }, { id: 'model-b', displayName: 'Model B' }] };
  f.apply({ backend: 'codex', codex });
  assert.deepEqual(f.calls, []);
  assert.equal(f.document.getElementById('builtin-model-picker').hidden, true);
  assert.equal(f.document.getElementById('codex-model-picker').hidden, false);
  await f.change('codex-model', 'model-b');
  assert.deepEqual(f.calls, [['selectCodexModel', 'model-b']]);
  f.apply({ busy: true });
  await f.change('codex-model', 'model-a');
  assert.equal(f.calls.length, 1);
  assert.equal(f.document.getElementById('codex-model').value, 'model-b');
});

test('opens a pending sign-in address only after an explicit click', async () => {
  const f = fixture();
  f.apply({ backend: 'codex', codex: { available: true, connected: true, login: { loginId: 'device', type: 'chatgptDeviceCode', verificationUrl: 'https://example.com/device', userCode: 'ABCD' } } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.document.getElementById('agent-codex-open-login').disabled, false);
  await f.click('agent-codex-open-login');
  assert.deepEqual(f.calls, [['openExternal', 'https://example.com/device']]);
});

test('recovers mode selection after an action fails and removes listeners and secrets on disposal', async () => {
  const f = fixture(); f.apply({});
  f.client.setAgentBackend = async () => { throw new Error('Runtime failed to connect'); };
  await f.change('agent-backend-codex');
  assert.equal(f.ui.getState().backend, 'builtin');
  assert.equal(f.document.getElementById('agent-backend-builtin').disabled, false);
  assert.match(f.document.getElementById('agent-control-status').textContent, /Runtime failed/);
  f.apply({ backend: 'external' });
  await f.click('agent-mcp-reveal');
  f.ui.dispose();
  assert.equal(f.document.getElementById('agent-mcp-token').value, '');
  await f.click('agent-mcp-copy');
  assert.deepEqual(f.copied, []);
});

test('appends streaming tokens into one message, replaces final text, and copies the latest response', async () => {
  const f = fixture();
  const messagesElement = element();
  messagesElement.scrollHeight = 0; messagesElement.scrollTop = 0; messagesElement.clientHeight = 100;
  const streams = new Map();
  const copied = [];
  const render = (event) => renderStreamingAgentEvent({ document: f.document, messagesElement, streams, chatId: 'chat-1', copyText: async (value) => copied.push(value), event });
  render({ type: 'token', itemId: 'item-1', chatId: 'chat-1', text: 'First ' });
  render({ type: 'token', itemId: 'item-1', chatId: 'chat-1', text: 'draft' });
  assert.equal(messagesElement.children.length, 2);
  assert.equal(messagesElement.children[0].textContent, 'First draft');
  render({ type: 'assistant', itemId: 'item-1', chatId: 'chat-1', text: 'Final response' });
  render({ type: 'assistant', itemId: 'item-1', chatId: 'chat-1', text: 'Final response' });
  assert.equal(messagesElement.children.length, 2);
  assert.equal(messagesElement.children[0].textContent, 'Final response');
  assert.equal(messagesElement.children[0].dataset.streaming, 'false');
  await messagesElement.children[1].children[0].dispatchEvent(new Event('click'));
  assert.deepEqual(copied, ['Final response']);
  render({ type: 'token', itemId: 'item-2', chatId: 'another-chat', text: 'Unrelated' });
  assert.equal(messagesElement.children.length, 2);
});
