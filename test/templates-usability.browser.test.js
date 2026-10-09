const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { listTemplates } = require('../src/template-catalog');
const { validateCanvasBounds } = require('../src/ipc-contract');

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
        onAgentEvent: () => () => {}, setCanvasBounds(bounds) { window.lastCanvasBounds = bounds; },
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
      assert.deepEqual(await page.locator('.activity-button .activity-label').allTextContents(), ['Chat', 'History', 'Files', 'Media', 'Templates', 'Settings']);
      for (const label of await page.locator('.activity-button .activity-label').all()) {
        assert.equal(await label.isVisible(), true);
        const spacing = await label.evaluate(label => {
          const button = label.closest('button').getBoundingClientRect();
          const text = label.getBoundingClientRect();
          return { left: text.left - button.left, right: button.right - text.right };
        });
        assert.ok(spacing.left >= 5.5 && spacing.right >= 5.5, `Rail labels need padding on both sides: ${JSON.stringify(spacing)}`);
      }
      assert.equal(await page.locator('.canvas-tabs').getByRole('button', { name: 'Video editor', exact: true }).count(), 0);
      assert.equal(await page.locator('#nav-templates').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.template-planned').evaluate(node => node.open), false);
      assert.equal(await page.locator('.template-planned .template-entry').first().isVisible(), false);
      const choice = page.locator('#templates-list').getByRole('button', { name: 'Video editor', exact: true });
      assert.equal(await choice.locator('svg[aria-hidden="true"]').isVisible(), true);
      assert.equal(await page.locator('#templates-list .template-state').filter({ hasText: /^Ready$/ }).count(), 0);
      const row = await choice.boundingBox();
      await choice.click({ position: { x: row.width - 8, y: row.height - 8 } });
      assert.equal(await page.locator('.template-technical').evaluate(node => node.open), false);
      const navigation = await page.locator('#templates-detail').evaluate(detail => {
        const back = [...detail.querySelectorAll('button')].find(button => button.textContent === 'All templates');
        const explore = [...detail.querySelectorAll('button')].find(button => button.textContent === 'Explore this idea');
        return { gap: detail.querySelector('h3').getBoundingClientRect().top - back.getBoundingClientRect().bottom,
          borders: [back, explore].map(button => getComputedStyle(button).borderTopColor) };
      });
      assert.ok(navigation.gap >= 15.5, 'Back navigation needs space before the template heading.');
      assert.ok(navigation.borders.every(color => color !== 'rgba(0, 0, 0, 0)'), 'Both template controls need visible boundaries.');
      assert.equal(await page.getByRole('button', { name: 'All templates', exact: true }).locator('svg[aria-hidden="true"]').isVisible(), true);
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
      if (viewport.width > 850) {
        for (const width of [280.125, 360.875, 579.75]) {
          const { host, input } = await page.evaluate(async width => {
            document.querySelector('.studio').style.setProperty('--left-column-width', `${width}px`);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const rect = document.getElementById('canvas-host').getBoundingClientRect();
            return { host: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, input: window.lastCanvasBounds };
          }, width);
          const bounds = validateCanvasBounds(input);
          assert.ok(bounds.width > 0 && bounds.height > 0, 'The document preview must remain visible.');
          assert.ok(bounds.x >= host.left && bounds.y >= host.top,
            `Native preview covers the panel edge: ${JSON.stringify({ host, bounds })}`);
          assert.ok(bounds.x + bounds.width <= host.right && bounds.y + bounds.height <= host.bottom,
            'The native preview must stay inside its host after rounding.');
        }
      }
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

test('drawer transitions keep inactive chat covered at every animation stage', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 30_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(entries => {
      localStorage.setItem('easel-setup-v1', 'skipped');
      const settings = { connections: [], models: [], activeConnectionId: '', litellmModel: '' };
      const api = {
        getSettings: async () => settings, getModelCatalog: async () => ({ settings, catalog: [] }),
        getAgentControl: async () => ({ backend: 'builtin', busy: false, codex: {}, external: { connectedClients: 0 } }),
        getCurrentChat: async () => ({ id: 'a'.repeat(32), history: [{ role: 'user', content: 'Chat must stay covered while a drawer opens.' }], backend: 'builtin' }),
        listTemplates: async () => entries, listChats: async () => [],
        onAgentEvent: () => () => {}, setCanvasBounds() {},
      };
      window.easelClient = new Proxy(api, { get: (target, name) => target[name] || (async () => []) });
    }, listTemplates({ includePlanned: true }));
    for (const viewport of [{ width: 1440, height: 900 }, { width: 600, height: 500 }]) {
      await page.setViewportSize(viewport);
      await page.goto(pathToFileURL(path.join(__dirname, '..', 'src', 'index.html')).href);
      await page.locator('#messages .message.user').waitFor({ state: 'attached' });
      await page.locator('#nav-chat').click();
      await page.locator('#message').fill('Keep this draft');
      for (const [toggle, panel] of [['nav-explorer', 'project-drawer'], ['nav-media', 'media-drawer'], ['nav-templates', 'templates-drawer'], ['chat-history-open', 'chat-history-panel']]) {
        const stages = await page.evaluate(async ({ toggle, panel }) => {
          document.getElementById(toggle).click();
          await new Promise(resolve => requestAnimationFrame(resolve));
          const drawer = document.getElementById(panel);
          const animations = drawer.getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity);
          for (const animation of animations) animation.pause();
          const rect = drawer.getBoundingClientRect();
          return [0, .5, 1].map(progress => {
            for (const animation of animations) animation.currentTime = Number(animation.effect.getTiming().duration) * progress;
            const points = [.1, .5, .9].map(position => document.elementFromPoint(rect.left + rect.width * position, rect.top + Math.min(80, rect.height / 2)));
            return { progress, covered: points.every(element => element && drawer.contains(element)), chatHidden: getComputedStyle(document.getElementById('conversation-panel')).visibility === 'hidden' };
          });
        }, { toggle, panel });
        assert.ok(stages.every(stage => stage.covered && stage.chatHidden), `${panel} exposes chat: ${JSON.stringify(stages)}`);
      }
      await page.locator('#nav-chat').click();
      assert.equal(await page.locator('#message').inputValue(), 'Keep this draft');
      assert.equal(await page.locator('#conversation-panel').isVisible(), true);
    }
  } finally { await browser.close(); }
});
