const MAX_HTML_BYTES = 1_048_576;
const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  "connect-src 'none'",
  'media-src data: blob:',
  'font-src data:',
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join('; ');

function buildCanvasDocument({ html, assets = [] } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('Canvas HTML is required.');
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('Canvas HTML exceeds 1 MiB.');
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) throw new Error(`Canvas supports at most ${MAX_ASSETS} image assets.`);
  if (/\b(?:src|href|poster|action)\s*=\s*["']?\s*(?:https?:|file:|\/\/)/i.test(html)) {
    throw new Error('Canvas cannot reference external URLs.');
  }

  let totalBytes = 0;
  let output = html;
  const names = new Set();
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(asset.name)) {
      throw new Error('Canvas asset name is invalid.');
    }
    if (names.has(asset.name)) throw new Error('Canvas asset names must be unique.');
    names.add(asset.name);
    if (!IMAGE_TYPES.has(asset.mimeType)) throw new Error('Unsupported image type.');
    if (typeof asset.data !== 'string' || asset.data.length > MAX_BASE64_LENGTH) throw new Error('Canvas assets exceed 32 MiB total.');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) {
      throw new Error('Canvas image data must be base64.');
    }
    totalBytes += Buffer.byteLength(asset.data, 'base64');
    output = output.split(`{{asset:${asset.name}}}`).join(`data:${asset.mimeType};base64,${asset.data}`);
  }
  if (totalBytes > MAX_ASSET_BYTES) throw new Error('Canvas assets exceed 32 MiB total.');
  if (/\{\{asset:[^}]+\}\}/.test(output)) throw new Error('Canvas references an unknown local asset.');

  const policy = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  if (/<head(?:\s[^>]*)?>/i.test(output)) {
    return output.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<meta charset="utf-8">${policy}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(output)) {
    return output.replace(/<html(?:\s[^>]*)?>/i, (htmlTag) => `${htmlTag}<head><meta charset="utf-8">${policy}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${output}</body></html>`;
}

module.exports = { buildCanvasDocument, CSP };
