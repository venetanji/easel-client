const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { listTemplates } = require('../src/template-catalog');

// The regular CI browser lane exercises the actual shell, drawer and renderer.
// No host generation, playback, credentials or user files are involved.
test('Templates remains discoverable and creation reveals the result at desktop and small-window sizes', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 45_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(entries => {
      localStorage.setItem('easel-setup-v1', 'skipped');
      let projects = [];
      const settings = { connections: [], models: [], activeConnectionId: '', litellmModel: '' };
      const result = { projectId: 'a'.repeat(32), instanceId: 'b'.repeat(32), documentPath: 'sketches/video/index.html', title: 'Video sketch', opened: true };
      const api = {
        getSettings: async () => settings,
        getModelCatalog: async () => ({ settings, catalog: [] }),
        getAgentControl: async () => ({ backend: 'builtin', busy: false, codex: {}, external: { enabled: true, connectedClients: 0 } }),
        getAvailableKits: async () => [{ id: 'canvas-2d', name: 'Canvas 2D', installed: true }],
        getCurrentChat: async () => ({ history: [], backend: 'builtin' }),
        onAgentEvent: () => () => {}, setCanvasBounds() {},
        listTemplates: async () => entries, listCanvases: async () => projects,
        createTemplateInstance: async () => { projects = [{ id: result.projectId, title: result.title }]; return result; },
        listProjectDocuments: async () => [{ path: result.documentPath, title: result.title }],
        listCanvasFiles: async () => ({ files: [] }), getProjectAssets: async () => ({ assets: [], nextOffset: null }),
      };
      window.easelClient = new Proxy(api, { get: (target, name) => target[name] || (async () => []) });
    }, listTemplates({ includePlanned: true }));
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 800, height: 700 }, { width: 600, height: 500 }]) {
      await page.setViewportSize(viewport);
      await page.goto(pathToFileURL(path.join(__dirname, '..', 'src', 'index.html')).href);
      await page.locator('#nav-templates').click();
      await page.locator('#templates-list .template-choice').first().waitFor();
      assert.equal(await page.locator('#nav-templates .activity-label').isVisible(), true);
      assert.equal(await page.locator('#nav-templates').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.template-planned').evaluate(node => node.open), false);
      assert.equal(await page.locator('.template-planned .template-entry').first().isVisible(), false);
      await page.locator('#templates-list').getByRole('button', { name: 'Video editor', exact: true }).click();
      assert.equal(await page.locator('.template-technical').evaluate(node => node.open), false);
      await page.locator('.template-actions button').first().scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const drawer = document.getElementById('templates-drawer').getBoundingClientRect();
        const action = document.querySelector('.template-actions').getBoundingClientRect();
        const details = document.querySelector('.template-technical').getBoundingClientRect();
        const button = document.querySelector('.template-actions button'); const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { drawerHeight: drawer.height, actionBottom: action.bottom, detailsTop: details.top, actionHit: hit === button || button.contains(hit), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(geometry.actionBottom <= geometry.detailsTop);
      assert.equal(geometry.actionHit, true);
      assert.equal(geometry.overflow, false);
      if (viewport.width <= 850) assert.ok(geometry.drawerHeight <= viewport.height * 0.6 + 1);
      await page.locator('#templates-detail').getByRole('button', { name: 'Create project', exact: true }).click();
      await page.locator('#templates-drawer').waitFor({ state: 'hidden' }).catch(async error => {
        console.error({ viewport, errors, status: await page.locator('#templates-status').textContent(), recovery: await page.locator('#templates-recovery').textContent() });
        throw error;
      });
      if (viewport.width <= 850) {
        assert.equal(await page.locator('.studio').getAttribute('data-sidebar'), 'closed');
        const canvas = await page.locator('.canvas-panel').evaluate(node => ({ focused: document.activeElement === node, top: node.getBoundingClientRect().top }));
        assert.equal(canvas.focused, true); assert.ok(canvas.top >= -1 && canvas.top < viewport.height / 2);
      }
      if (process.env.EASEL_UI_ARTIFACT_DIR) {
        await fs.mkdir(process.env.EASEL_UI_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.EASEL_UI_ARTIFACT_DIR, `templates-created-${viewport.width}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
