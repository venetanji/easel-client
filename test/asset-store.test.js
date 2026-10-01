const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetStore } = require('../src/asset-store');

test('stores image bytes under generated opaque asset IDs and resolves them locally', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-assets-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createAssetStore({
    userDataPath,
    idFactory: () => 'a'.repeat(32),
    thumbnailFactory: () => 'data:image/png;base64,dGh1bWI=',
  });
  const id = await store.save({ data: 'YWJj', mimeType: 'image/png' });
  assert.equal(id, 'a'.repeat(32));
  assert.deepEqual(await store.get(id), { id, data: 'YWJj', mimeType: 'image/png' });
  const [asset] = await store.list();
  assert.equal(asset.id, id);
  assert.equal(asset.mimeType, 'image/png');
  assert.equal(asset.thumbnail, 'data:image/png;base64,dGh1bWI=');
  assert.equal(typeof asset.updatedAt, 'number');
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

test('removes only the selected image ID across recognized formats and preserves project copies', async (t) => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const userDataPath = fs.mkdtempSync(path.join(temporaryRoot, 'easel-assets-remove-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(userDataPath)), temporaryRoot);
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });
  const id = 'a'.repeat(32);
  const otherId = 'b'.repeat(32);
  let nextId = id;
  const store = createAssetStore({ userDataPath, idFactory: () => nextId });
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) await store.save({ data: 'YWJj', mimeType });
  nextId = otherId;
  await store.save({ data: 'ZGVm', mimeType: 'image/png' });
  const unrelated = path.join(userDataPath, 'assets', `${id}.png.tmp`);
  fs.writeFileSync(unrelated, 'unfinished unrelated file');
  const projectDirectory = path.join(userDataPath, 'project-assets');
  fs.mkdirSync(projectDirectory);
  const projectCopy = path.join(projectDirectory, 'c'.repeat(64));
  fs.writeFileSync(projectCopy, 'project image bytes');

  assert.deepEqual(await store.remove(id), { id, deleted: true });
  for (const extension of ['png', 'jpg', 'webp']) assert.equal(fs.existsSync(path.join(userDataPath, 'assets', `${id}.${extension}`)), false);
  await assert.rejects(store.get(id), /not found/i);
  assert.equal((await store.get(otherId)).data, 'ZGVm');
  assert.deepEqual((await store.list()).map((asset) => asset.id), [otherId]);
  assert.equal(fs.readFileSync(projectCopy, 'utf8'), 'project image bytes');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unfinished unrelated file');
});

test('rejects invalid and missing removal IDs before changing image library files', async (t) => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const userDataPath = fs.mkdtempSync(path.join(temporaryRoot, 'easel-assets-remove-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(userDataPath)), temporaryRoot);
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });
  const id = 'a'.repeat(32);
  const store = createAssetStore({ userDataPath, idFactory: () => id });
  await store.save({ data: 'YWJj', mimeType: 'image/png' });
  for (const invalid of ['../../settings.json', 'a'.repeat(64), id.toUpperCase(), '', undefined]) {
    await assert.rejects(store.remove(invalid), /asset ID is invalid/i);
  }
  await assert.rejects(store.remove('b'.repeat(32)), /not found/i);
  assert.equal((await store.get(id)).data, 'YWJj');
});

test('reuses unchanged thumbnails and refreshes only changed image files', async (t) => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const userDataPath = fs.mkdtempSync(path.join(temporaryRoot, 'easel-assets-cache-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(userDataPath)), temporaryRoot);
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });
  let thumbnailCalls = 0;
  const id = 'a'.repeat(32);
  const store = createAssetStore({ userDataPath, idFactory: () => id, thumbnailFactory: () => {
    thumbnailCalls++;
    return 'data:image/png;base64,dGh1bWI=';
  } });
  await store.save({ data: 'YWJj', mimeType: 'image/png' });
  await store.list();
  await store.list();
  assert.equal(thumbnailCalls, 1);
  fs.writeFileSync(path.join(userDataPath, 'assets', id + '.png'), 'changed');
  await store.list();
  assert.equal(thumbnailCalls, 2);
  await store.remove(id);
  assert.deepEqual(await store.list(), []);
});
