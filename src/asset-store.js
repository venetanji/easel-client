const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
    const filename = path.join(assetsPath, `${id}.${FORMATS[mimeType]}`);
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    fileSystem.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try {
      fileSystem.renameSync(temporary, filename);
    } catch (error) {
      fileSystem.rmSync(temporary, { force: true });
      throw error;
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
    return { id, deleted: true };
  }

  async function list() {
    if (!fileSystem.existsSync(assetsPath)) return [];
    const mimeTypes = new Map(Object.entries(FORMATS).map(([mimeType, extension]) => [extension, mimeType]));
    const filenames = fileSystem.readdirSync(assetsPath)
      .filter((filename) => /^[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(filename))
      .map((filename) => ({ filename, updatedAt: fileSystem.statSync(path.join(assetsPath, filename)).mtimeMs }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ASSET_LIST_ITEMS);
    return filenames.flatMap(({ filename, updatedAt }) => {
      const match = filename.match(/^([a-f0-9]{32})\.(png|jpg|webp)$/);
      const mimeType = mimeTypes.get(match?.[2]);
      if (!match || !mimeType) return [];
      const bytes = fileSystem.readFileSync(path.join(assetsPath, filename));
      const thumbnail = thumbnailFactory(bytes, mimeType);
      if (typeof thumbnail !== 'string' || !thumbnail.startsWith('data:image/')) return [];
      return [{ id: match[1], mimeType, thumbnail, updatedAt }];
    });
  }

  return { save, get, list, remove };
}

module.exports = { MAX_ASSET_BYTES, MAX_ASSET_LIST_ITEMS, createAssetStore };
