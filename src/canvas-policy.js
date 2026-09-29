const MAX_HTML_BYTES = 1_048_576;
const MAX_CANVAS_DOCUMENT_BYTES = 8 * 1_048_576;
const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
const MAX_SNAPSHOT_BYTES = MAX_CANVAS_DOCUMENT_BYTES + MAX_BASE64_LENGTH + 65_536;
const ALLOWED_CANVAS_KITS = new Set(['canvas-2d', 'html-deck', 'three', 'phaser', 'matter', 'tone']);
const BUNDLED_CANVAS_KITS = new Set(['three', 'phaser', 'matter', 'tone']);
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
  return clean.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${RUNTIME_DIAGNOSTICS_SCRIPT}`);
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

  let totalKitBytes = 0;
  const kitScripts = [...new Set(kits)].map((kit) => {
    if (typeof kit !== 'string' || !ALLOWED_CANVAS_KITS.has(kit)) throw new Error('Canvas kit is unsupported.');
    if (!BUNDLED_CANVAS_KITS.has(kit)) return '';
    const source = kitBundles[kit];
    if (typeof source !== 'string' || !source) throw new Error(`The ${kit} canvas kit is unavailable. Rebuild the client and try again.`);
    const safeSource = source.replace(/<\/script/gi, '<\\/script');
    totalKitBytes += Buffer.byteLength(safeSource, 'utf8');
    if (totalKitBytes > MAX_CANVAS_DOCUMENT_BYTES) throw new Error('Selected canvas kits exceed the offline bundle size limit.');
    return `<script data-easel-canvas-kit="${kit}">${safeSource}</script>`;
  }).join('');
  output = insertKitScripts(output, kitScripts);
  if (Buffer.byteLength(output, 'utf8') > MAX_CANVAS_DOCUMENT_BYTES) {
    throw new Error('Canvas document exceeds the offline canvas size limit.');
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

function buildCanvasSnapshotDocument(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('Canvas HTML is required.');
  if (Buffer.byteLength(html, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('Canvas snapshot exceeds the stored asset limit.');
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
