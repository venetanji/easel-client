import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOutputDirectory, saveMedia } from '../src/output.js';

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
