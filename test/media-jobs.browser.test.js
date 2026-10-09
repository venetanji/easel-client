const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

test('restored audio downloads resolve tool call names and show every saved track with controls', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 30_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easel-setup-v1', 'skipped');
      const settings = { connections: [], models: [], activeConnectionId: '', litellmModel: '' };
      const assets = [1, 2].map(index => ({ assetId: String(index).repeat(32), name: `Song ${index}.m4a`, mimeType: 'audio/mp4' }));
      const api = {
        getSettings: async () => settings, getModelCatalog: async () => ({ settings, catalog: [] }),
        getAgentControl: async () => ({ backend: 'builtin', busy: false, codex: {}, external: { connectedClients: 0 } }),
        getCurrentChat: async () => ({ id: 'a'.repeat(32), images: [], media: assets, history: [
          { role: 'assistant', tool_calls: assets.map((asset, index) => ({ id: `download_${index}`, type: 'function', function: { name: 'download_audio', arguments: '{}' } })) },
          ...assets.map((asset, index) => ({ role: 'tool', tool_call_id: `download_${index}`, content: JSON.stringify({ audio: { trackId: `track-${index}` }, assets: [asset] }) })),
          { role: 'assistant', content: 'Both tracks are saved.' },
        ] }),
        onAgentEvent: () => () => {}, setCanvasBounds() {},
      };
      window.easelClient = new Proxy(api, { get: (target, name) => target[name] || (async () => []) });
    });
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'src/index.html')).href);
    await page.locator('#messages .message-media').nth(1).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#messages audio').count(), 2);
    assert.equal(await page.locator('#messages .message-media-actions [aria-label="Download"]').count(), 2);
    assert.deepEqual(await page.locator('#messages .message-media').evaluateAll(nodes => nodes.map(node => node.dataset.assetId)), ['1'.repeat(32), '2'.repeat(32)]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Jobs separates generation from saved media, keeps cancel usable when busy, and shows completion', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 45_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easel-setup-v1', 'skipped');
      localStorage.removeItem('easel-studio.media-notices.v1');
      localStorage.removeItem('easel-studio.media-seen.v1');
      const chatId = 'e'.repeat(32);
      const settings = { connections: [], models: [], activeConnectionId: '', litellmModel: '' };
      const asset = { id: 'a'.repeat(32), assetId: 'a'.repeat(32), name: 'Pixel Haze.m4a', mimeType: 'audio/mp4', duration: 120 };
      const jobs = ['queued', 'generating', 'downloading', 'ready', 'cancelled'].map((status, index) => ({
        id: String(index + 1).repeat(32), remoteId: `22222222-2222-4222-8222-${String(index + 1).repeat(12)}`,
        name: `Song ${index + 1}`, mediaType: 'audio', status, chatId, createdAt: index,
        assets: status === 'ready' ? [asset] : [],
      }));
      const callbacks = [];
      window.emitJob = (event) => { for (const callback of callbacks) callback(event); };
      window.completeJob = () => {
        jobs[1].status = 'ready'; jobs[1].assets = [asset];
        window.emitJob({ type: 'media-job', job: jobs[1] });
        window.emitJob({ type: 'media-job-ready', job: jobs[1], assets: [asset], chatId });
      };
      const api = {
        getSettings: async () => settings,
        getModelCatalog: async () => ({ settings, catalog: [] }),
        getAgentControl: async () => ({ backend: 'builtin', busy: true, codex: {}, external: { connectedClients: 0 } }),
        getCurrentChat: async () => ({ id: chatId, history: [], backend: 'builtin' }),
        onAgentEvent: callback => { callbacks.push(callback); return () => {}; },
        setCanvasBounds() {}, listMediaJobs: async () => jobs,
        listAssets: async () => [asset], getLibraryAsset: async () => ({ ...asset, data: 'AAAA' }),
        cancelMediaJob: async id => {
          const job = jobs.find(job => job.id === id); job.status = 'cancelled';
          return { canceled: true, job };
        },
      };
      window.easelClient = new Proxy(api, { get: (target, name) => target[name] || (async () => []) });
    });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 600, height: 600 }]) {
      await page.setViewportSize(viewport);
      await page.goto(pathToFileURL(path.join(__dirname, '..', 'src/index.html')).href);
      await page.locator('#nav-media').click();
      await page.locator('#all-media-list .project-media-item').waitFor();
      assert.equal(await page.locator('#media-generating').isVisible(), true);
      assert.equal(await page.locator('#media-jobs-count').textContent(), '3');
      assert.equal(await page.locator('#all-media-list .media-job').count(), 0);
      await page.locator('#media-tab-assets').focus(); await page.keyboard.press('End');
      assert.equal(await page.locator('#media-tab-jobs').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#media-assets-panel').isVisible(), false);
      assert.equal(await page.locator('#media-jobs-list .media-job').count(), 5);
      const queued = page.locator('[data-job-id="' + '1'.repeat(32) + '"]');
      assert.equal(await queued.locator('.media-job-cancel').isEnabled(), true);
      assert.equal(await queued.locator('.media-job-cog').isVisible(), true);
      assert.match(await queued.textContent(), /Queued/);
      await queued.locator('.media-job-cancel').click();
      assert.match(await queued.textContent(), /Tracking canceled/);
      assert.equal(await queued.locator('.media-job-cog').isVisible(), false);
      assert.equal(await queued.locator('.media-job-cancel').isVisible(), false);
      assert.equal(await page.locator('#media-jobs-count').textContent(), '2');
      await page.evaluate(() => window.completeJob());
      const completed = page.locator('[data-job-id="' + '2'.repeat(32) + '"]');
      await completed.locator('.media-job-view').waitFor();
      assert.equal(await page.locator('#media-tab-jobs').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#media-unread').textContent(), '1');
      assert.equal(await page.locator('#media-unread').isVisible(), true);
      assert.equal(await page.locator('#messages .message-media-actions [aria-label="Download"]').count(), 1);
      const geometry = await completed.evaluate(card => ({
        cardWidth: card.getBoundingClientRect().width, contentWidth: card.scrollWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.contentWidth <= geometry.cardWidth + 1);
      await page.locator('#media-tab-jobs').focus(); await page.keyboard.press('Home');
      assert.equal(await page.locator('#media-assets-panel').isVisible(), true);
      assert.equal(await page.locator('#media-jobs-panel').isVisible(), false);
      assert.equal(await page.locator('#media-unread').isVisible(), false);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
