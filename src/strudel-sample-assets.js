const crypto = require('node:crypto');
const { isMediaBase64 } = require('./media-base64');

function captureStrudelSamples(store, projectId, snapshot) {
  const captured = Object.create(null);
  let totalBytes = 0;
  for (const event of snapshot.events) {
    const sample = event.sample;
    if (!sample?.assetId) continue; // Bundled bytes belong to the exact pinned kit.
    if (captured[sample.assetId]) {
      if (captured[sample.assetId].digest !== sample.digest) throw new Error('Conflicting sample content digests.');
      continue;
    }
    const asset = store.getAsset(projectId, sample.assetId);
    if (!/^audio\/(?:wav|x-wav|mpeg|mp3|mp4|x-m4a)$/.test(asset.mimeType) || typeof asset.data !== 'string' || asset.data.length > Math.ceil(4 * 1048576 / 3) * 4 || !isMediaBase64(asset.data)) throw new Error('Export samples must be attached WAV, MP3 or M4A audio up to 4 MiB.');
    const bytes = Buffer.from(asset.data, 'base64');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!bytes.length || bytes.length > 4 * 1048576 || digest !== sample.digest) throw new Error('Sample content changed or its digest is invalid. Register it again before exporting.');
    totalBytes += bytes.length;
    if (totalBytes > 8 * 1048576 || Object.keys(captured).length >= 16) throw new Error('Export supports up to 16 samples and 8 MiB of sample bytes.');
    captured[sample.assetId] = Object.freeze({ digest, url: `data:${asset.mimeType};base64,${asset.data}` });
  }
  return Object.freeze(captured);
}
module.exports = { captureStrudelSamples };
