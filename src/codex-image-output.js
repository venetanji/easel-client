const fs = require('node:fs');
const path = require('node:path');
const { MAX_ASSET_BYTES } = require('./asset-store');

const MAX_BASE64_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeCodexImage(item, { cwd, fileSystem = fs } = {}) {
  if (item?.type !== 'imageGeneration' || item.status !== 'completed' || item.failure) {
    throw new Error(item?.failure?.type === 'usageLimitExceeded'
      ? 'Codex image generation reached your Codex usage limit.'
      : 'Codex image generation did not complete.');
  }
  let data = typeof item.result === 'string' ? item.result : '';
  const dataUrl = data.match(/^data:image\/(?:png|jpeg|webp);base64,([\s\S]*)$/);
  if (dataUrl) data = dataUrl[1];
  let bytes;
  if (data) {
    if (data.length > MAX_BASE64_LENGTH) throw new Error('Codex image exceeds 32 MiB.');
    if (!BASE64.test(data)) throw new Error('Codex returned invalid image data.');
    bytes = Buffer.from(data, 'base64');
  } else if (typeof item.savedPath === 'string' && path.isAbsolute(item.savedPath) && cwd) {
    // File fallback is confined to Easel's dedicated Codex workspace.
    const root = fileSystem.realpathSync(cwd);
    const filename = fileSystem.realpathSync(item.savedPath);
    const relative = path.relative(root, filename);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Codex image output is outside the Easel workspace.');
    }
    const stat = fileSystem.statSync(filename);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new Error('Codex image output is invalid or exceeds 32 MiB.');
    bytes = fileSystem.readFileSync(filename);
  } else {
    throw new Error('Codex did not return an image to import.');
  }
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw new Error('Codex image output is empty or exceeds 32 MiB.');
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : '';
  if (!mimeType) throw new Error('Codex output is not a supported PNG, JPEG, or WebP image.');
  return { data: bytes.toString('base64'), mimeType };
}

module.exports = { decodeCodexImage };
