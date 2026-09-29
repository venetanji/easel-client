const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetStore } = require('../src/asset-store');

test('stores image bytes under generated opaque asset IDs and resolves them locally', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-assets-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createAssetStore({ userDataPath, idFactory: () => 'a'.repeat(32) });
  const id = await store.save({ data: 'YWJj', mimeType: 'image/png' });
  assert.equal(id, 'a'.repeat(32));
  assert.deepEqual(await store.get(id), { id, data: 'YWJj', mimeType: 'image/png' });
  assert.deepEqual(fs.readdirSync(path.join(userDataPath, 'assets')), [`${id}.png`]);
});

test('rejects path traversal, unknown IDs, unsupported formats, and oversized assets', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-assets-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createAssetStore({ userDataPath });
  await assert.rejects(store.get('../../settings.json'), /asset ID/i);
  await assert.rejects(store.get('b'.repeat(32)), /not found/i);
  await assert.rejects(store.save({ data: 'YWJj', mimeType: 'text/html' }), /unsupported image type/i);
  await assert.rejects(store.save({ data: 'not base64!', mimeType: 'image/png' }), /base64/i);
  await assert.rejects(store.save({ data: 'A'.repeat(44_739_248), mimeType: 'image/png' }), /32 MiB/i);
});
