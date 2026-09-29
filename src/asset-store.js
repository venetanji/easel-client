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

function createAssetStore({ userDataPath, fileSystem = fs, idFactory = () => crypto.randomUUID().replaceAll('-', '') }) {
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

  return { save, get };
}

module.exports = { MAX_ASSET_BYTES, createAssetStore };
