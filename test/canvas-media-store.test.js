const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCanvasMediaStore } = require('../src/canvas-media-store');

function temporaryLibrary(t) {
  const root = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(root, 'easel-canvas-media-remove-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), root);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('M4A retains its encoding through save, playback, restart, list and removal', async (t) => {
  const userDataPath = temporaryLibrary(t);
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A \0\0\0\0M4A isom')]);
  const store = createCanvasMediaStore({ userDataPath });
  const id = await store.save({ data: bytes.toString('base64'), mimeType: 'audio/mp4', name: 'Suno song.m4a' });
  const restored = createCanvasMediaStore({ userDataPath });
  const playback = await restored.getPlaybackSource(id);
  assert.equal(path.basename(playback.filename), 'media.m4a');
  assert.deepEqual(fs.readFileSync(playback.filename), bytes);
  assert.equal((await restored.get(id)).mimeType, 'audio/mp4');
  assert.equal((await restored.list())[0].id, id);
  await assert.rejects(store.save({ data: Buffer.from('not M4A').toString('base64'), mimeType: 'audio/mp4' }), /declared file format/);
  await restored.remove(id);
  assert.deepEqual(await restored.list(), []);
});

test('removes a complete capture including frame and poster metadata while preserving other media and project copies', async (t) => {
  const userDataPath = temporaryLibrary(t);
  const id = 'a'.repeat(32);
  const otherId = 'b'.repeat(32);
  let nextId = id;
  const store = createCanvasMediaStore({ userDataPath, idFactory: () => nextId });
  const video = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const thumbnail = `data:image/jpeg;base64,${jpeg}`;
  await store.save({
    data: video.toString('base64'), mimeType: 'video/webm', duration: 2, thumbnail,
    frames: [{ timestamp: 0, data: jpeg }, { timestamp: 1, data: jpeg }],
  });
  nextId = otherId;
  await store.save({ data: Buffer.from('ID3other audio').toString('base64'), mimeType: 'audio/mpeg' });
  const folder = path.join(userDataPath, 'canvas-media', id);
  assert.equal((await store.getMetadata(id)).thumbnail, thumbnail);
  assert.equal(fs.existsSync(path.join(folder, 'frame-1.jpg')), true);
  const projectDirectory = path.join(userDataPath, 'project-assets');
  fs.mkdirSync(projectDirectory);
  const projectCopy = path.join(projectDirectory, 'c'.repeat(64));
  fs.writeFileSync(projectCopy, video);

  assert.deepEqual(await store.remove(id), { id, deleted: true });
  assert.equal(fs.existsSync(folder), false);
  await assert.rejects(store.get(id), /not found/i);
  await assert.rejects(store.getFrames(id), /not found/i);
  assert.equal((await store.get(otherId)).mimeType, 'audio/mpeg');
  assert.deepEqual((await store.list()).map((asset) => asset.id), [otherId]);
  assert.deepEqual(fs.readFileSync(projectCopy), video);
});

test('removes all exact legacy media extensions without deleting similar names', async (t) => {
  const userDataPath = temporaryLibrary(t);
  const store = createCanvasMediaStore({ userDataPath });
  const directory = path.join(userDataPath, 'canvas-media');
  fs.mkdirSync(directory);
  const id = 'a'.repeat(32);
  const otherId = 'b'.repeat(32);
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0); wav.write('WAVE', 8);
  const mp4 = Buffer.alloc(12);
  mp4.write('ftyp', 4);
  const fixtures = {
    wav, mp3: Buffer.from('ID3legacy audio'),
    webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), mp4,
  };
  for (const [extension, bytes] of Object.entries(fixtures)) fs.writeFileSync(path.join(directory, `${id}.${extension}`), bytes);
  fs.writeFileSync(path.join(directory, `${otherId}.wav`), wav);
  const unrelated = path.join(directory, `${id}.webm.backup`);
  fs.writeFileSync(unrelated, 'unrelated backup');
  assert.equal((await store.get(id)).mimeType, 'audio/wav');

  assert.deepEqual(await store.remove(id), { id, deleted: true });
  for (const extension of Object.keys(fixtures)) assert.equal(fs.existsSync(path.join(directory, `${id}.${extension}`)), false);
  await assert.rejects(store.get(id), /not found/i);
  assert.equal((await store.get(otherId)).mimeType, 'audio/wav');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated backup');
});

test('rejects traversal, digest and missing capture IDs without deleting saved media', async (t) => {
  const userDataPath = temporaryLibrary(t);
  const id = 'a'.repeat(32);
  const store = createCanvasMediaStore({ userDataPath, idFactory: () => id });
  const data = Buffer.from('ID3saved audio').toString('base64');
  await store.save({ data, mimeType: 'audio/mpeg' });
  for (const invalid of ['../../project-assets', 'a'.repeat(64), id.toUpperCase(), '', undefined]) {
    await assert.rejects(store.remove(invalid), /capture ID is invalid/i);
  }
  await assert.rejects(store.remove('b'.repeat(32)), /not found/i);
  assert.equal((await store.get(id)).data, data);
});

test('refuses a capture directory link instead of recursively deleting its target', async (t) => {
  const userDataPath = temporaryLibrary(t);
  const directory = path.join(userDataPath, 'canvas-media');
  const projectDirectory = path.join(userDataPath, 'project-assets');
  fs.mkdirSync(directory);
  fs.mkdirSync(projectDirectory);
  const projectCopy = path.join(projectDirectory, 'b'.repeat(64));
  fs.writeFileSync(projectCopy, 'project media');
  const id = 'a'.repeat(32);
  const folder = path.join(directory, id);
  fs.symlinkSync(projectDirectory, folder, process.platform === 'win32' ? 'junction' : 'dir');
  const store = createCanvasMediaStore({ userDataPath });

  await assert.rejects(store.remove(id), /capture library directory is invalid/i);
  assert.equal(fs.lstatSync(folder).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(projectCopy, 'utf8'), 'project media');
});
