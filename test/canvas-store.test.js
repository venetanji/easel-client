const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCanvasStore } = require('../src/canvas-store');

test('saves self-contained canvas HTML and lists it by title', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-canvases-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath, idFactory: () => 'c'.repeat(32) });

  const saved = store.save({
    title: 'Poster "A"',
    html: '<h1>Preview</h1><img src="{{asset:hero}}">',
    assets: [{ name: 'hero', data: 'YWJj', mimeType: 'image/png' }],
  });

  assert.equal(saved.id, 'c'.repeat(32));
  assert.equal(saved.title, 'Poster "A"');
  assert.deepEqual(store.list().map(({ id, title }) => ({ id, title })), [{ id: saved.id, title: saved.title }]);
  const loaded = store.get(saved.id);
  assert.equal(loaded.title, saved.title);
  assert.match(loaded.html, /data:image\/png;base64,YWJj/);
  assert.match(loaded.html, /Content-Security-Policy/);
  assert.deepEqual(fs.readdirSync(path.join(userDataPath, 'canvases')), [`${saved.id}.html`]);

  store.update(saved.id, '<!doctype html><html><head><title>Changed by canvas JS</title></head><body><h1>Edited</h1></body></html>');
  const updated = store.get(saved.id);
  assert.equal(updated.title, 'Poster "A"');
  assert.match(updated.html, /<h1>Edited<\/h1>/);
  assert.equal((updated.html.match(/Content-Security-Policy/g) || []).length, 1);
});

test('rejects invalid canvas IDs and canvas documents', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-canvases-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });

  assert.throws(() => store.get('..\\settings.json'), /canvas ID is invalid/i);
  assert.throws(() => store.save({ html: '<img src="https://example.com/image.png">' }), /external URLs/i);
  assert.deepEqual(store.list(), []);
});

test('creates a named empty canvas with a modifiable media grid', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-canvases-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });

  const created = store.createEmpty('Mood board');
  const saved = store.get(created.id);
  assert.equal(saved.title, 'Mood board');
  assert.match(saved.html, /data-easel-canvas/);
  assert.match(saved.html, /grid-template-columns/);
  assert.match(saved.html, /Content-Security-Policy/);
});