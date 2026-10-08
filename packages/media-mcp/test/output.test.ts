import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOutputDirectory, saveMedia } from '../src/output.js';
import { generateImages } from '../src/easel.js';
import { images as imageFixtures } from './fixtures/images.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAssetStore } = require('../../../src/asset-store');
const { importMediaFiles } = require('../../../src/media-import');

test('atomic media output returns verified paths, preserves encoding and never overwrites files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'easel-output-')); t.after(() => rm(root, { recursive: true, force: true }));
  const roots = JSON.stringify([root]);
  const media = { data: Buffer.from('audio').toString('base64'), mimeType: 'audio/mp4' };
  const first = await saveMedia(join(root, 'media/outbound'), [media], roots);
  const second = await saveMedia(join(root, 'media/outbound'), [media], roots);
  assert.notEqual(first[0]!.path, second[0]!.path); assert.ok(first[0]!.path.endsWith('.m4a'));
  assert.equal(first[0]!.bytes, 5); assert.equal(first[0]!.sha256.length, 64);
  assert.equal((await readFile(first[0]!.path)).toString(), 'audio');
  assert.equal((await readdir(join(root, 'media/outbound'))).length, 2);
});
test('output rejects traversal, missing policy and symlinks outside the workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'easel-output-')); const outside = await mkdtemp(join(tmpdir(), 'easel-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const roots = JSON.stringify([root]);
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(prepareOutputDirectory(join(root, 'escape/new'), roots), /outside/);
  await assert.rejects(prepareOutputDirectory(join(root, '../other'), roots), /outside/);
  await assert.rejects(prepareOutputDirectory(root, ''), /configured/);
  await assert.rejects(prepareOutputDirectory(root, '["/"]'), /configuration/);
  await assert.rejects(saveMedia(root, [{ data: '', mimeType: 'image/png' }], roots), /32 MiB/);
  assert.deepEqual(await readdir(outside), []);
});

for (const fixture of imageFixtures) {
  test(`generated ${fixture.mimeType} output retains its extension and imports without conversion`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'easel-image-output-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const images = await generateImages({ prompt: 'a dot', baseUrl: 'https://easel.test', responseFormat: 'url',
      fetchImpl: async (_url, init) => init?.method === 'POST'
        ? Response.json({ data: [{ url: '/generated/image' }] })
        : new Response(Buffer.from(fixture.data, 'base64'), { headers: { 'Content-Type': fixture.mimeType } }),
    });
    assert.ok(Array.isArray(images));
    const [saved] = await saveMedia(join(root, 'output'), images, JSON.stringify([root]));
    assert.ok(saved!.path.endsWith('.' + fixture.extension));
    assert.equal(saved!.mimeType, fixture.mimeType);
    assert.deepEqual(await readFile(saved!.path), Buffer.from(fixture.data, 'base64'));
    const imageStore = createAssetStore({ userDataPath: root });
    const imported = await importMediaFiles({ filenames: [saved!.path], imageStore });
    assert.deepEqual(imported.errors, []);
    assert.equal(imported.assets.length, 1);
    assert.equal(imported.assets[0].mimeType, fixture.mimeType);
    assert.equal((await imageStore.get(imported.assets[0].assetId)).data, fixture.data);
  });
}
