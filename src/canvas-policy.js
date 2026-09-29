const MAX_HTML_BYTES = 1_048_576;
const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;
const MAX_SNAPSHOT_BYTES = MAX_HTML_BYTES + MAX_BASE64_LENGTH + 65_536;
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

module.exports = { buildCanvasDocument, buildCanvasSnapshotDocument, CSP, MAX_SNAPSHOT_BYTES };
