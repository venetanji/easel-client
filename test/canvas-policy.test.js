const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCanvasDocument } = require('../src/canvas-policy');

test('builds a local-JS canvas document with a no-network CSP and local image data', () => {
  const html = buildCanvasDocument({
    html: '<h1>My canvas</h1><img src="{{asset:hero}}"><script>document.body.dataset.ready = "yes";</script>',
    assets: [{ name: 'hero', data: 'YWJj', mimeType: 'image/png' }],
  });
  assert.match(html, /script-src 'unsafe-inline'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src data: blob:/);
  assert.match(html, /data:image\/png;base64,YWJj/);
  assert.match(html, /document\.body\.dataset\.ready/);
  assert.doesNotMatch(html, /allow-same-origin/);
});

test('rejects unknown assets, external sources, unsupported formats, and oversized documents', () => {
  assert.throws(() => buildCanvasDocument({ html: '<img src="{{asset:missing}}">' }), /unknown local asset/i);
  assert.throws(() => buildCanvasDocument({ html: '<img src="https://example.org/a.png">' }), /external URL/i);
  assert.throws(() => buildCanvasDocument({
    html: '<p>x</p>',
    assets: [{ name: 'bad', data: 'YWJj', mimeType: 'image/svg+xml' }],
  }), /unsupported image type/i);
  assert.throws(() => buildCanvasDocument({ html: 'x'.repeat(1_048_577) }), /1 MiB/i);
});
