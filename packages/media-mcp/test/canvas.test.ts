import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { captureCanvasScreenshot } from '../src/canvas.js';

function createBrowser() {
  const state: { content?: string; routeHandler?: (route: any) => Promise<void>; closed: boolean } = { closed: false };
  const page = {
    async route(_pattern: string, handler: (route: any) => Promise<void>) { state.routeHandler = handler; },
    async setContent(content: string) { state.content = content; },
    async screenshot() { return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); },
  };
  return {
    state,
    browser: {
      async newPage() { return page; },
      async close() { state.closed = true; },
    },
  };
}

test('renders offline HTML with bounded local image assets and closes the browser', async () => {
  const { browser, state } = createBrowser();
  const screenshot = await captureCanvasScreenshot({
    html: '<html><body><img src="{{asset:hero}}"><script>window.localAnimation = true;</script></body></html>',
    assets: [{ name: 'hero', data: 'YWJj', mimeType: 'image/png' }],
  }, { browserFactory: async () => browser as never });

  assert.deepEqual([...screenshot.data.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(state.content || '', /connect-src 'none'/);
  assert.match(state.content || '', /data:image\/png;base64,YWJj/);
  assert.match(state.content || '', /window\.localAnimation/);
  assert.equal(state.closed, true);

  let blocked = false;
  await state.routeHandler!({
    request: () => ({ url: () => 'https://example.com/pixel' }),
    abort: async () => { blocked = true; },
    continue: async () => assert.fail('external request must not continue'),
  });
  assert.equal(blocked, true);
});

test('rejects oversized markup and unsupported asset inputs before launching Chromium', async () => {
  let launches = 0;
  const browserFactory = async () => { launches += 1; throw new Error('should not launch'); };
  await assert.rejects(captureCanvasScreenshot({ html: 'x'.repeat(1_048_577) }, { browserFactory }), /HTML exceeds 1 MiB/i);
  await assert.rejects(captureCanvasScreenshot({
    html: '<p>x</p>',
    assets: [{ name: '../escape', data: 'YWJj', mimeType: 'image/png' }],
  }, { browserFactory }), /asset name/i);
  await assert.rejects(captureCanvasScreenshot({
    html: '<p>x</p>',
    assets: [{ name: 'bad', data: 'YWJj', mimeType: 'text/html' }],
  }, { browserFactory }), /unsupported .*asset type/i);
  assert.equal(launches, 0);
});

test('times out the render and closes Chromium', async () => {
  const { browser, state } = createBrowser();
  const hangingBrowser = {
    ...browser,
    async newPage() {
      return {
        route: async () => {},
        setContent: () => new Promise(() => {}),
        screenshot: async () => Buffer.alloc(0),
      };
    },
  };
  await assert.rejects(captureCanvasScreenshot({ html: '<p>hang</p>' }, {
    browserFactory: async () => hangingBrowser as never,
    timeoutMs: 10,
  }), /timed out/i);
  assert.equal(state.closed, true);
});

test('captures a real headless Chromium screenshot when enabled', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1',
}, async () => {
  const screenshot = await captureCanvasScreenshot({ html: '<html><body><h1>Offline canvas</h1></body></html>' });
  assert.equal(screenshot.mimeType, 'image/png');
  assert.deepEqual([...screenshot.data.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
