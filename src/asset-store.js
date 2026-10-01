const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertStorageSpace, storageWriteError } = require('./storage-space');

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
const FORMATS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});
const ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_ASSET_LIST_ITEMS = 200;

function createAssetStore({
  userDataPath,
  fileSystem = fs,
  idFactory = () => crypto.randomUUID().replaceAll('-', ''),
  thumbnailFactory = (bytes, mimeType) => `data:${mimeType};base64,${bytes.toString('base64')}`,
}) {
  const assetsPath = path.join(userDataPath, 'assets');
  const thumbnails = new Map();

  async function save({ data, mimeType } = {}) {
    if (!Object.hasOwn(FORMATS, mimeType)) throw new Error('Unsupported image type.');
    if (typeof data !== 'string' || !data) {
      throw new Error('Image data must be base64.');
    }
    if (data.length > MAX_BASE64_LENGTH) throw new Error('Image asset exceeds 32 MiB.');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error('Image data must be base64.');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_ASSET_BYTES) throw new Error('Image asset exceeds 32 MiB.');
    const id = idFactory();
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Asset ID generator returned an invalid ID.');

    fileSystem.mkdirSync(assetsPath, { recursive: true, mode: 0o700 });
    assertStorageSpace(assetsPath, bytes.length, fileSystem);
    const filename = path.join(assetsPath, `${id}.${FORMATS[mimeType]}`);
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
      fileSystem.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      fileSystem.renameSync(temporary, filename);
    } catch (error) {
      try { fileSystem.rmSync(temporary, { force: true }); } catch { /* Keep the original storage failure. */ }
      throw storageWriteError(error);
    }
    return id;
  }

  async function get(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Asset ID is invalid.');
    for (const [mimeType, extension] of Object.entries(FORMATS)) {
      const filename = path.join(assetsPath, `${id}.${extension}`);
      if (fileSystem.existsSync(filename)) {
        return { id, data: fileSystem.readFileSync(filename).toString('base64'), mimeType };
      }
    }
    throw new Error('Asset was not found.');
  }

  async function remove(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Asset ID is invalid.');
    const root = path.resolve(assetsPath);
    const filenames = [];
    for (const extension of Object.values(FORMATS)) {
      const filename = path.resolve(root, `${id}.${extension}`);
      if (path.dirname(filename) !== root) throw new Error('Asset path is outside the image library.');
      let stat;
      try { stat = fileSystem.lstatSync(filename); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Image library asset is not a file.');
      filenames.push(filename);
    }
    if (!filenames.length) throw new Error('Asset was not found.');
    for (const filename of filenames) fileSystem.unlinkSync(filename);
    for (const filename of filenames) thumbnails.delete(path.basename(filename));
    return { id, deleted: true };
  }

  async function list() {
    if (!fileSystem.existsSync(assetsPath)) return [];
    const mimeTypes = new Map(Object.entries(FORMATS).map(([mimeType, extension]) => [extension, mimeType]));
    const filenames = fileSystem.readdirSync(assetsPath)
      .filter((filename) => /^[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(filename))
      .map((filename) => {
        const stat = fileSystem.statSync(path.join(assetsPath, filename));
        return { filename, updatedAt: stat.mtimeMs, bytes: stat.size };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ASSET_LIST_ITEMS);
    const visible = new Set(filenames.map((entry) => entry.filename));
    for (const filename of thumbnails.keys()) if (!visible.has(filename)) thumbnails.delete(filename);
    return filenames.flatMap(({ filename, updatedAt, bytes: size }) => {
      const match = filename.match(/^([a-f0-9]{32})\.(png|jpg|webp)$/);
      const mimeType = mimeTypes.get(match?.[2]);
      if (!match || !mimeType) return [];
      const cached = thumbnails.get(filename);
      const thumbnail = cached?.updatedAt === updatedAt && cached.bytes === size ? cached.thumbnail
        : thumbnailFactory(fileSystem.readFileSync(path.join(assetsPath, filename)), mimeType);
      if (typeof thumbnail !== 'string' || !thumbnail.startsWith('data:image/')) return [];
      thumbnails.set(filename, { thumbnail, updatedAt, bytes: size });
      return [{ id: match[1], mimeType, thumbnail, updatedAt }];
    });
  }

  return { save, get, list, remove };
}

module.exports = { MAX_ASSET_BYTES, MAX_ASSET_LIST_ITEMS, createAssetStore };
