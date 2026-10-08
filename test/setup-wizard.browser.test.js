const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

test('first-run setup saves an endpoint, enables a chat model and respects dismissal in the real UI', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 45_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(/^https?:/, (route) => route.abort());
    await page.addInitScript(() => {
      let settings = { connections: [], models: [], activeConnectionId: '', litellmModel: '' };
      let control = { backend: 'builtin', busy: false, codex: {}, external: { enabled: true, connectedClients: 0 } };
      const calls = [];
      const api = {
        getSettings: async () => settings, getAgentControl: async () => control,
        getAvailableKits: async () => [{ id: 'canvas-2d', name: 'Canvas 2D', installed: true }],
        getCurrentChat: async () => ({ history: [], backend: control.backend }),
        onAgentEvent: () => () => {}, setCanvasBounds() {},
        setAgentBackend: async (backend) => (control = { ...control, backend }),
        saveConnection: async (input) => {
          calls.push('saveConnection');
          settings = { ...settings, connections: [{ id: 'example', name: input.name, baseUrl: input.baseUrl, hasApiKey: Boolean(input.apiKey) }] };
          return settings;
        },
        getModelCatalog: async () => {
          if (settings.connections.length && !settings.models.length) settings = { ...settings, models: [
            { connectionId: 'example', model: 'example-chat', name: 'Example chat model', enabled: false, roles: ['agent'] },
            { connectionId: 'example', model: 'minimax/H3', name: 'MiniMax H3', enabled: false, roles: ['media'], mediaTypes: ['video'] },
          ] };
          return { settings, catalog: settings.connections.map((connection) => ({ connectionId: connection.id, models: [{ id: 'example-chat' }] })) };
        },
        updateModel: async (input) => { calls.push(`updateModel:${input.model}`); return (settings = { ...settings, models: settings.models.map((model) => model.model === input.model ? { ...model, enabled: input.enabled } : model) }); },
        selectModel: async (input) => { calls.push('selectModel'); return (settings = { ...settings, activeConnectionId: input.connectionId, litellmModel: input.model }); },
      };
      window.setupTestCalls = calls;
      window.easelClient = new Proxy(api, { get: (target, name) => target[name] || (async () => []) });
    });
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'src', 'index.html')).href);
    await page.locator('#setup-progress').filter({ hasText: 'Step 1 of 4' }).waitFor();
    const capture = async (name) => {
      if (process.env.EASEL_SETUP_SCREENSHOTS !== '1') return;
      const directory = path.join(__dirname, '..', '.impeccable', 'review');
      await fs.mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, name), fullPage: true });
    };
    const assertWizardFits = async () => {
      for (const viewport of [{ width: 960, height: 540 }, { width: 800, height: 450 }, { width: 600, height: 400 }]) {
        await page.setViewportSize(viewport);
        const geometry = await page.evaluate(() => {
          const bounds = (id) => {
            const node = document.getElementById(id);
            const rect = node.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, clickable: node === hit || node.contains(hit) };
          };
          return { dialog: bounds('settings-dialog'), next: bounds('setup-next'), back: bounds('setup-back'), skip: bounds('setup-skip') };
        });
        for (const [name, bounds] of Object.entries(geometry)) {
          assert.ok(bounds.top >= 0 && bounds.bottom <= viewport.height && bounds.left >= 0 && bounds.right <= viewport.width,
            `${name} must fit the ${viewport.width}x${viewport.height} viewport: ${JSON.stringify(bounds)}`);
          if (name !== 'dialog') assert.equal(bounds.clickable, true, `${name} must remain reachable without scrolling`);
        }
      }
      await page.setViewportSize({ width: 960, height: 540 });
    };
    await capture('setup-desktop.png');
    await page.setViewportSize({ width: 960, height: 720 });
    await capture('setup-small-desktop.png');
    await assertWizardFits();
    await page.locator('#setup-next').click();
    assert.equal(await page.locator('#setup-next').isDisabled(), true);
    await assertWizardFits();
    await page.locator('#connection-url').fill('https://example.test/v1');
    await page.locator('#connection-name').fill('Example endpoint');
    await page.locator('#connection-key').fill('synthetic-test-key');
    await page.locator('#connection-save').click();
    await page.waitForFunction(() => !document.getElementById('setup-next').disabled);
    assert.equal(await page.locator('#connection-key').inputValue(), '');
    assert.match(await page.locator('#connection-status').textContent(), /Continue to Chat model/);
    await capture('setup-credentials.png');
    await page.locator('#setup-next').click();
    assert.equal(await page.locator('#setup-next').isDisabled(), true);
    await assertWizardFits();
    await capture('setup-model.png');
    await page.locator('#setup-model-trigger').click();
    await page.locator('#setup-model-options').getByRole('option', { name: 'Example endpoint / Example chat model', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('setup-next').disabled).catch(async (error) => {
      console.error(await page.evaluate(() => ({ calls: window.setupTestCalls,
        status: document.getElementById('setup-status').textContent,
        ready: document.getElementById('setup-ready').textContent,
        value: document.getElementById('setup-model').value,
      })));
      throw error;
    });
    await page.locator('#setup-next').click();
    assert.equal(await page.locator('#setup-media-panel').isVisible(), true);
    assert.match(await page.locator('#setup-media-models').textContent(), /MiniMax H3.*Video/);
    await page.locator('#setup-media-models input[type=checkbox]').check();
    await page.locator('#setup-next').click();
    assert.equal(await page.locator('#settings-dialog').evaluate((dialog) => dialog.open), false);
    assert.deepEqual(await page.evaluate(() => window.setupTestCalls), ['saveConnection', 'updateModel:example-chat', 'selectModel', 'updateModel:minimax/H3']);
    assert.equal(await page.evaluate(() => localStorage.getItem('easel-setup-v1')), 'complete');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('synthetic-test-key')), false);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('agent-backend-builtin').disabled);
    assert.equal(await page.locator('#settings-dialog').evaluate((dialog) => dialog.open), false);
    await page.locator('#settings-open').click();
    await page.locator('#setup-open').click();
    await page.locator('#agent-backend-external').check();
    await assertWizardFits();
    await page.locator('#setup-next').click();
    await page.locator('#setup-next').click();
    assert.equal(await page.locator('#setup-model-field').isVisible(), false);
    assert.equal(await page.locator('#setup-next').isDisabled(), true);
    await page.locator('#setup-skip').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('easel-setup-v1')), 'skipped');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
