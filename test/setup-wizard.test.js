const test = require('node:test');
const assert = require('node:assert/strict');
const { createSetupWizard, setupReadiness, SETUP_STORAGE_KEY } = require('../src/setup-wizard');

function fixture({ stored, settings, control } = {}) {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) {
        const listeners = new Map();
        const attributes = new Map();
        const classes = new Set();
        nodes.set(id, {
          value: '', hidden: false, disabled: false, dataset: {}, children: [],
          classList: { toggle(name, value) { value ? classes.add(name) : classes.delete(name); }, contains: (name) => classes.has(name) },
          addEventListener(type, action) { listeners.set(type, [...(listeners.get(type) || []), action]); },
          removeEventListener(type, action) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== action)); },
          async dispatchEvent(event) { for (const action of listeners.get(event.type) || []) await action(event); },
          setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); },
          replaceChildren(...children) { this.children = children; }, focus() {}, close() { this.open = false; },
        });
      }
      return nodes.get(id);
    },
    createElement: () => ({ value: '', textContent: '' }),
  };
  const values = new Map(stored ? [[SETUP_STORAGE_KEY, stored]] : []);
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  let nextSettings = settings || { connections: [], models: [], activeConnectionId: '', litellmModel: '' };
  let nextControl = control || { backend: 'builtin', busy: false };
  const calls = [];
  const client = {
    async updateModel(input) {
      calls.push(['enable', input]);
      return { ...nextSettings, models: nextSettings.models.map((model) => model.model === input.model ? { ...model, enabled: true } : model) };
    },
    async selectModel(input) { calls.push(['select', input]); return { ...nextSettings, activeConnectionId: input.connectionId, litellmModel: input.model }; },
    async selectCodexModel(model) { calls.push(['codex', model]); return { ...nextControl, codex: { ...nextControl.codex, model } }; },
    async getModelCatalog() { return { settings: nextSettings, catalog: [] }; },
  };
  const update = () => ui.update(nextSettings, nextControl);
  const ui = createSetupWizard({ document, client, storage,
    onSettings: (value) => { nextSettings = value; update(); },
    onAgentState: (value) => { nextControl = value; update(); },
    onOpen: () => { calls.push(['open']); document.getElementById('settings-dialog').open = true; },
    onSection: (value) => calls.push(['section', value]),
    onClose: () => calls.push(['clearCredentials']),
  });
  const node = (id) => document.getElementById(id);
  const click = async (id) => { await node(id).dispatchEvent({ type: 'click' }); await new Promise(setImmediate); };
  return { ui, node, client, calls, values, click, update, settings: nextSettings,
    apply(value, agent = nextControl) { nextSettings = value; nextControl = agent; update(); } };
}

test('first run waits for both settings and agent state; existing installs are left in their workspace', () => {
  const fresh = fixture();
  fresh.ui.update(undefined, { backend: 'builtin' });
  assert.equal(fresh.ui.isActive(), false);
  fresh.update();
  assert.equal(fresh.ui.isActive(), true);
  assert.equal(fresh.values.get(SETUP_STORAGE_KEY), 'started');
  const existing = fixture({ settings: { connections: [{ id: 'saved' }], models: [] } });
  existing.update();
  assert.equal(existing.ui.isActive(), false);
});

test('skip and Escape are remembered, while incomplete setup resumes after an endpoint was saved', async () => {
  const skipped = fixture(); skipped.update();
  await skipped.click('setup-skip');
  assert.equal(skipped.values.get(SETUP_STORAGE_KEY), 'skipped');
  assert.equal(skipped.node('settings-dialog').open, false);
  assert.ok(skipped.calls.some(([call]) => call === 'clearCredentials'));
  const restart = fixture({ stored: 'skipped' }); restart.update();
  assert.equal(restart.ui.isActive(), false);
  const resume = fixture({ stored: 'started', settings: { connections: [{ id: 'saved' }], models: [] } }); resume.update();
  assert.equal(resume.ui.isActive(), true);
  let cancelled = false;
  await resume.node('settings-dialog').dispatchEvent({ type: 'cancel', preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  assert.equal(resume.values.get(SETUP_STORAGE_KEY), 'skipped');
});

test('finishing requires an enabled active chat model on an existing endpoint', () => {
  const settings = { connections: [{ id: 'chat' }], activeConnectionId: 'chat', litellmModel: 'model', models: [{ connectionId: 'chat', model: 'model', enabled: true, roles: ['agent'] }] };
  assert.equal(setupReadiness(settings, { backend: 'builtin' }), true);
  assert.equal(setupReadiness({ ...settings, connections: [] }, { backend: 'builtin' }), false);
  assert.equal(setupReadiness({ ...settings, models: [{ ...settings.models[0], enabled: false }] }, { backend: 'builtin' }), false);
  assert.equal(setupReadiness({ ...settings, models: [{ ...settings.models[0], roles: ['media'] }] }, { backend: 'builtin' }), false);
  const codex = { available: true, connected: true, authenticated: true, model: 'chat-model', models: [{ id: 'chat-model' }] };
  assert.equal(setupReadiness(settings, { backend: 'codex', codex }), true);
  assert.equal(setupReadiness(settings, { backend: 'codex', codex: { ...codex, authenticated: false } }), false);
  assert.equal(setupReadiness(settings, { backend: 'codex', codex: { ...codex, model: 'removed-model' } }), false);
  assert.equal(setupReadiness(settings, { backend: 'external', external: { enabled: true, connectedClients: 0 } }), false);
  assert.equal(setupReadiness(settings, { backend: 'external', external: { enabled: true, connectedClients: 1 } }), true);
});

test('selecting a discovered chat model enables it and saves the active selection before finishing', async () => {
  const f = fixture(); f.update();
  await f.click('setup-next');
  assert.equal(f.node('setup-next').disabled, true);
  f.apply({ connections: [{ id: 'chat', name: 'Chat endpoint' }], models: [
    { connectionId: 'chat', model: 'chat-model', enabled: false, roles: ['agent'] },
    { connectionId: 'chat', model: 'qwen-image-2.1', enabled: true, roles: ['media'] },
  ] });
  await f.click('setup-next');
  assert.equal(f.node('setup-next').disabled, true);
  assert.equal(f.node('setup-model').children.length, 2);
  f.node('setup-model').value = JSON.stringify({ connectionId: 'chat', model: 'chat-model' });
  await f.node('setup-model').dispatchEvent({ type: 'change' });
  await new Promise(setImmediate);
  assert.deepEqual(f.calls.filter(([call]) => ['enable', 'select'].includes(call)).map(([call]) => call), ['enable', 'select']);
  assert.equal(f.node('setup-next').disabled, false);
  await f.click('setup-next');
  assert.equal(f.values.get(SETUP_STORAGE_KEY), 'complete');
});

test('failed model selection keeps setup incomplete and permits a retry', async () => {
  const f = fixture({ stored: 'started', settings: { connections: [{ id: 'chat', name: 'Chat endpoint' }], models: [{ connectionId: 'chat', model: 'model', enabled: true, roles: ['agent'] }] } });
  f.client.selectModel = async () => { throw new Error('Endpoint is unavailable.'); };
  f.update(); await f.click('setup-next'); await f.click('setup-next');
  f.node('setup-model').value = JSON.stringify({ connectionId: 'chat', model: 'model' });
  await f.node('setup-model').dispatchEvent({ type: 'change' }); await new Promise(setImmediate);
  assert.equal(f.node('setup-next').disabled, true);
  assert.equal(f.node('setup-model').disabled, false);
  assert.match(f.node('setup-status').textContent, /Endpoint is unavailable/);
  assert.equal(f.values.get(SETUP_STORAGE_KEY), 'started');
});

test('pending account or endpoint work blocks setup navigation and dismissal', async () => {
  const f = fixture(); f.update();
  f.ui.update(f.settings, { backend: 'builtin', busy: true });
  await f.click('setup-next'); await f.click('setup-skip');
  assert.equal(f.ui.isActive(), true);
  assert.equal(f.node('setup-progress').textContent, 'Step 1 of 3');
  assert.equal(f.node('setup-next').disabled, true);
});
