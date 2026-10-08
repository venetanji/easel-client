const MAX_HTML_BYTES = 1_048_576;
const { addCanvasLifecycle } = require('./canvas-runtime');
const { sanitizeGoogleFontsHtml } = require('./canvas-fonts');
const MAX_CANVAS_DOCUMENT_BYTES = 8 * 1_048_576;
const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
// Export/runtime may carry one asset URL in authored markup and one in the resolver.
const MAX_SNAPSHOT_BYTES = MAX_CANVAS_DOCUMENT_BYTES + 2 * MAX_BASE64_LENGTH + 4 * 1_048_576 + 65_536;
const ALLOWED_CANVAS_KITS = new Set(['canvas-2d', 'html-deck', 'three', 'phaser', 'matter', 'tone', 'p5', 'strudel']);
const BUNDLED_CANVAS_KITS = new Set(['three', 'phaser', 'matter', 'tone', 'p5', 'strudel']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'connect-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const RUNTIME_DIAGNOSTICS_SCRIPT = `<script id="easel-runtime-diagnostics">
(() => {
  const diagnostics = { images: [], webglErrors: [] };
  window.__easelRuntimeDiagnostics = diagnostics;
  const NativeImage = window.Image;
  window.Image = new Proxy(NativeImage, {
    construct(target, args, newTarget) {
      const image = Reflect.construct(target, args, newTarget);
      const record = { image, failed: false };
      diagnostics.images.push(record);
      if (diagnostics.images.length > 64) diagnostics.images.shift();
      image.addEventListener("error", () => { record.failed = true; }, { once: true });
      return image;
    },
  });
  const seenMethods = new Set();
  for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    const prototype = Context?.prototype;
    if (!prototype) continue;
    const compile = prototype.compileShader;
    if (typeof compile === "function" && !seenMethods.has(compile)) {
      seenMethods.add(compile);
      prototype.compileShader = function (shader) {
        compile.call(this, shader);
        if (!this.getShaderParameter(shader, this.COMPILE_STATUS)) {
          diagnostics.webglErrors.push((this.getShaderInfoLog(shader) || "WebGL shader compilation failed.").slice(0, 1000));
          if (diagnostics.webglErrors.length > 20) diagnostics.webglErrors.shift();
        }
      };
    }
    const link = prototype.linkProgram;
    if (typeof link === "function" && !seenMethods.has(link)) {
      seenMethods.add(link);
      prototype.linkProgram = function (program) {
        link.call(this, program);
        if (!this.getProgramParameter(program, this.LINK_STATUS)) {
          diagnostics.webglErrors.push((this.getProgramInfoLog(program) || "WebGL program link failed.").slice(0, 1000));
          if (diagnostics.webglErrors.length > 20) diagnostics.webglErrors.shift();
        }
      };
    }
  }
})();
</script>`;

function addRuntimeDiagnostics(html) {
  const clean = html.replace(/<script\s+id=["']easel-runtime-diagnostics["'][^>]*>[\s\S]*?<\/script>/gi, '');
  return addCanvasLifecycle(clean.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${RUNTIME_DIAGNOSTICS_SCRIPT}`));
}

function insertKitScripts(html, scripts) {
  if (!scripts) return html;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${scripts}`);
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${scripts}</head>`);
  }
  return `<!doctype html><html><head>${scripts}</head><body>${html}</body></html>`;
}

function buildCanvasDocument({ html, assets = [], kits = [], kitBundles = {} } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('Canvas HTML is required.');
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('Canvas HTML exceeds 1 MiB.');
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) throw new Error(`Canvas supports at most ${MAX_ASSETS} image assets.`);
  if (!Array.isArray(kits) || kits.length > ALLOWED_CANVAS_KITS.size) throw new Error('Canvas kits are invalid.');
  html = sanitizeGoogleFontsHtml(html);
  if (/\b(?:src|href|poster|action)\s*=\s*["']?\s*(?:https?:|file:|\/\/)/i.test(html)) {
    throw new Error('Canvas cannot reference external URLs.');
  }

  let totalBytes = 0;
  let output = html;
  const names = new Set();
  const mediaContents = new Set();
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
    if (!mediaContents.has(asset.data)) {
      mediaContents.add(asset.data);
      totalBytes += Buffer.byteLength(asset.data, 'base64');
    }
    output = output.split(`{{asset:${asset.name}}}`).join(`data:${asset.mimeType};base64,${asset.data}`);
  }
  if (totalBytes > MAX_ASSET_BYTES) throw new Error('Canvas assets exceed 32 MiB total.');
  if (/\{\{asset:[^}]+\}\}/.test(output)) throw new Error('Canvas references an unknown local asset.');

  let totalKitBytes = 0;
  const kitScripts = [...new Set(kits)].map((kit) => {
    if (typeof kit !== 'string' || !ALLOWED_CANVAS_KITS.has(kit)) throw new Error('Canvas kit is unsupported.');
    if (!BUNDLED_CANVAS_KITS.has(kit)) return '';
    const source = kitBundles[kit];
    if (typeof source !== 'string' || !source) throw new Error(`The ${kit} canvas kit is unavailable. Rebuild the client and try again.`);
    const safeSource = source.replace(/<\/script/gi, '<\\/script');
    totalKitBytes += Buffer.byteLength(safeSource, 'utf8');
    if (totalKitBytes > MAX_CANVAS_DOCUMENT_BYTES) throw new Error(`Selected kit bundles use ${totalKitBytes} bytes; limit ${MAX_CANVAS_DOCUMENT_BYTES} bytes. Media size is counted separately.`);
    return `<script data-easel-canvas-kit="${kit}">${safeSource}</script>`;
  }).join('');
  output = insertKitScripts(output, kitScripts);
  const assembledBytes = Buffer.byteLength(output, 'utf8');
  if (assembledBytes > MAX_SNAPSHOT_BYTES) {
    const contributions = assets.map((asset) => ({ name: asset.name, bytes: Buffer.byteLength(asset.data, 'base64'), embeddedBytes: asset.data.length }));
    throw new Error(`Canvas assembly uses ${assembledBytes} bytes; limit ${MAX_SNAPSHOT_BYTES} bytes. Source ${Buffer.byteLength(html)} bytes; kit bundles ${totalKitBytes} bytes; unique media budget ${MAX_ASSET_BYTES} bytes. Asset contributions: ${JSON.stringify(contributions)}. Attach existing assets incrementally instead of rebuilding embedded media.`);
  }

  const policy = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  if (/<head(?:\s[^>]*)?>/i.test(output)) {
    return addRuntimeDiagnostics(output.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<meta charset="utf-8">${policy}`));
  }
  if (/<html(?:\s[^>]*)?>/i.test(output)) {
    return addRuntimeDiagnostics(output.replace(/<html(?:\s[^>]*)?>/i, (htmlTag) => `${htmlTag}<head><meta charset="utf-8">${policy}</head>`));
  }
  return addRuntimeDiagnostics(`<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${output}</body></html>`);
}

function buildCanvasSnapshotDocument(html, { maxBytes = MAX_SNAPSHOT_BYTES } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('Canvas HTML is required.');
  if (Buffer.byteLength(html, 'utf8') > maxBytes) throw new Error(`Canvas assembly uses ${Buffer.byteLength(html, 'utf8')} bytes; limit ${maxBytes} bytes. Source files and media have separate limits; inspect list_canvas_files for asset contributions.`);
  html = sanitizeGoogleFontsHtml(html);
  if (/\b(?:src|href|poster|action)\s*=\s*["']?\s*(?:https?:|file:|\/\/)/i.test(html)) {
    throw new Error('Canvas cannot reference external URLs.');
  }

  const policy = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const output = html.replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?)[^>]*>/gi, '');
  if (/<head(?:\s[^>]*)?>/i.test(output)) {
    return addRuntimeDiagnostics(output.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<meta charset="utf-8">${policy}`));
  }
  if (/<html(?:\s[^>]*)?>/i.test(output)) {
    return addRuntimeDiagnostics(output.replace(/<html(?:\s[^>]*)?>/i, (htmlTag) => `${htmlTag}<head><meta charset="utf-8">${policy}</head>`));
  }
  return addRuntimeDiagnostics(`<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${output}</body></html>`);
}

module.exports = {
  buildCanvasDocument,
  buildCanvasSnapshotDocument,
  CSP,
  MAX_CANVAS_DOCUMENT_BYTES,
  MAX_SNAPSHOT_BYTES,
};
