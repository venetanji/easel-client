const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetStore } = require('../src/asset-store');
const { createCanvasMediaStore } = require('../src/canvas-media-store');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-media-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imageStore = createAssetStore({ userDataPath: root });
  const mediaStore = createCanvasMediaStore({ userDataPath: root });
  function file(name, bytes) {
    const filename = path.join(root, name);
    fs.writeFileSync(filename, bytes);
    return filename;
  }
  return { root, imageStore, mediaStore, file };
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+XkAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
const webp = Buffer.from('RIFF\x0c\x00\x00\x00WEBPVP8 \x00\x00\x00\x00', 'binary');
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom0000payload')]);
const wav = Buffer.alloc(44);
wav.write('RIFF', 0); wav.write('WAVE', 8);
const mp3 = Buffer.from('ID3test audio');

test('imports original video bytes into the media library without frame conversion', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const result = await importMediaFiles({ ...fixture, filenames: [fixture.file('Trip.MP4', mp4)] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.assets.length, 1);
  const [asset] = result.assets;
  assert.equal(asset.name, 'Trip.MP4');
  assert.equal(asset.mimeType, 'video/mp4');
  assert.equal(asset.bytes, mp4.length);
  assert.match(asset.assetId, /^[a-f0-9]{32}$/);
  assert.deepEqual(Buffer.from((await fixture.mediaStore.get(asset.assetId)).data, 'base64'), mp4);
  const savedFolder = path.join(fixture.root, 'canvas-media', asset.assetId);
  assert.deepEqual(fs.readdirSync(savedFolder).sort(), ['media.mp4', 'metadata.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(savedFolder, 'metadata.json'))).frames, []);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
});

test('routes all supported image, video, and audio types to local stores', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const inputs = [
    ['picture.png', png, 'image/png'], ['photo.jpeg', jpeg, 'image/jpeg'],
    ['photo.jpg', jpeg, 'image/jpeg'], ['picture.webp', webp, 'image/webp'],
    ['clip.webm', webm, 'video/webm'], ['clip.mp4', mp4, 'video/mp4'],
    ['sound.wav', wav, 'audio/wav'], ['music.mp3', mp3, 'audio/mpeg'],
  ];
  const result = await importMediaFiles({ ...fixture, filenames: inputs.map(([name, bytes]) => fixture.file(name, bytes)) });
  assert.deepEqual(result.errors, []);
  assert.equal(result.assets.length, inputs.length);
  for (let index = 0; index < inputs.length; index++) {
    const [name, bytes, mimeType] = inputs[index];
    const asset = result.assets[index];
    assert.equal(asset.name, name);
    assert.equal(asset.mimeType, mimeType);
    const store = mimeType.startsWith('image/') ? fixture.imageStore : fixture.mediaStore;
    assert.deepEqual(Buffer.from((await store.get(asset.assetId)).data, 'base64'), bytes);
  }
});

test('reports invalid selections separately and continues importing valid files', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const result = await importMediaFiles({ ...fixture, filenames: [
    fixture.file('notes.txt', 'private notes'),
    fixture.file('fake.png', 'not a PNG'),
    fixture.file('fake.mp4', 'not a movie'),
    fixture.file('empty.wav', ''),
    fixture.file('good.webm', webm),
  ] });
  assert.deepEqual(result.assets.map((asset) => asset.name), ['good.webm']);
  assert.deepEqual(result.errors.map((error) => error.name), ['notes.txt', 'fake.png', 'fake.mp4', 'empty.wav']);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
  assert.equal((await fixture.imageStore.list()).length, 0);
  assert.equal((await fixture.mediaStore.list()).length, 1);
});

test('rejects a selection larger than twenty files before reading or saving any', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const filename = fixture.file('picture.png', png);
  const result = await importMediaFiles({ ...fixture, filenames: Array(21).fill(filename) });
  assert.deepEqual(result.assets, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /at most 20/i);
  assert.deepEqual(await fixture.imageStore.list(), []);
});

test('treats a cancelled dialog as an empty import and rejects invalid selection arguments', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  assert.deepEqual(await importMediaFiles({ ...fixture, filenames: [] }), { assets: [], errors: [] });
  for (const filenames of [null, undefined, 'picture.png']) {
    const result = await importMediaFiles({ ...fixture, filenames });
    assert.deepEqual(result.assets, []);
    assert.equal(result.errors.length, 1);
  }
  const result = await importMediaFiles({ ...fixture, filenames: [null, {}, 'relative.png', 'https://example.com/picture.png'] });
  assert.deepEqual(result.assets, []);
  assert.equal(result.errors.length, 4);
});

test('refuses symlinks and directories while preserving the original file', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const original = fixture.file('original.png', png);
  const symlink = path.join(fixture.root, 'shortcut.png');
  fs.symlinkSync(original, symlink);
  const directory = path.join(fixture.root, 'folder.mp4');
  fs.mkdirSync(directory);
  const result = await importMediaFiles({ ...fixture, filenames: [symlink, directory] });
  assert.deepEqual(result.assets, []);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(await fixture.imageStore.list(), []);
  assert.deepEqual(fs.readFileSync(original), png);
});

test('rejects files over 32 MiB before allocating or reading their content', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const filename = fixture.file('large.mp4', mp4);
  fs.truncateSync(filename, 32 * 1024 * 1024 + 1);
  let reads = 0;
  const fileSystem = { ...fs, promises: { ...fs.promises, readFile: async (...args) => { reads++; return fs.promises.readFile(...args); } } };
  const result = await importMediaFiles({ ...fixture, fileSystem, filenames: [filename] });
  assert.deepEqual(result.assets, []);
  assert.match(result.errors[0].error, /32 MiB/);
  assert.equal(reads, 0);
});

test('validates image decoding before saving and reports only safe names on validator failure', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const filename = fixture.file('broken.png', png);
  const result = await importMediaFiles({ ...fixture, filenames: [filename], validateImage: async (bytes, mimeType) => {
    assert.deepEqual(bytes, png);
    assert.equal(mimeType, 'image/png');
    throw new Error(`Cannot decode ${filename}`);
  } });
  assert.deepEqual(result.assets, []);
  assert.equal(result.errors[0].name, 'broken.png');
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
  assert.deepEqual(await fixture.imageStore.list(), []);
});

test('notifies the host after a save and preserves a successful import if the notification fails', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const saved = [];
  const result = await importMediaFiles({ ...fixture, filenames: [fixture.file('clip.mp4', mp4)], onSaved: async (asset) => {
    saved.push(await fixture.mediaStore.getMetadata(asset.assetId));
    throw new Error(`Preview failed inside ${fixture.root}`);
  } });
  assert.equal(saved.length, 1);
  assert.equal(result.assets.length, 1);
  assert.equal(saved[0].id, result.assets[0].assetId);
  assert.match(result.errors[0].error, /imported/i);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
});

test('does not expose filesystem paths from store failures or unexpected metadata fields', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const filename = fixture.file('clip.mp4', mp4);
  const metadataStore = { ...fixture.mediaStore, getMetadata: async (id) => ({ ...await fixture.mediaStore.getMetadata(id), filename, data: 'private bytes', arbitrary: fixture.root }) };
  const success = await importMediaFiles({ ...fixture, mediaStore: metadataStore, filenames: [filename] });
  assert.equal(success.assets.length, 1);
  assert.equal(JSON.stringify(success).includes(fixture.root), false);
  assert.equal(Object.hasOwn(success.assets[0], 'data'), false);
  const failure = await importMediaFiles({ ...fixture, mediaStore: { save: async () => { throw new Error(`Write failed: ${filename}`); } }, filenames: [filename] });
  assert.equal(failure.errors.length, 1);
  assert.equal(JSON.stringify(failure).includes(fixture.root), false);
});

test('bounds reads and refuses a file that grows after the initial size check', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const filename = fixture.file('growing.mp4', mp4);
  let bytesRead = 0;
  let closed = false;
  const fileSystem = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: async (...readArgs) => {
        fs.appendFileSync(filename, Buffer.alloc(1024));
        const result = await handle.read(...readArgs);
        bytesRead += result.bytesRead;
        return result;
      },
      close: async () => { closed = true; await handle.close(); },
    };
  } } };
  const result = await importMediaFiles({ ...fixture, fileSystem, filenames: [filename] });
  assert.deepEqual(result.assets, []);
  assert.match(result.errors[0].error, /changed/i);
  assert.ok(bytesRead <= mp4.length + 1);
  assert.equal(closed, true);
});

test('rejects a symlink replacement between selection inspection and opening the file', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const filename = fixture.file('chosen.png', png);
  const other = fixture.file('other.png', png);
  const fileSystem = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    fs.unlinkSync(filename);
    fs.symlinkSync(other, filename);
    return fs.promises.open(...args);
  } } };
  const result = await importMediaFiles({ ...fixture, fileSystem, filenames: [filename] });
  assert.deepEqual(result.assets, []);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(await fixture.imageStore.list(), []);
});

test('returns the saved asset even if follow-up metadata retrieval fails', async (t) => {
  const { importMediaFiles } = require('../src/media-import');
  const fixture = setup(t);
  const mediaStore = { ...fixture.mediaStore, getMetadata: async () => { throw new Error(`Failure at ${fixture.root}`); } };
  const result = await importMediaFiles({ ...fixture, mediaStore, filenames: [fixture.file('clip.mp4', mp4)] });
  assert.equal(result.assets.length, 1);
  assert.equal((await fixture.mediaStore.list()).length, 1);
  assert.match(result.errors[0].error, /imported/i);
  assert.equal(JSON.stringify(result).includes(fixture.root), false);
});
