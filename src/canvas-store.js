const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildCanvasDocument, buildCanvasSnapshotDocument } = require('./canvas-policy');

const ID_PATTERN = /^[a-f0-9]{32}$/;
const EMPTY_CANVAS_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body { padding: 24px; background: #f0e9df; color: #292820; font-family: Georgia, serif; }
    [data-easel-canvas] { min-height: calc(100vh - 48px); display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); align-content: start; align-items: start; gap: 20px; }
    [data-easel-canvas] img { display: block; width: 100%; height: auto; max-height: 78vh; object-fit: contain; background: #faf7f1; box-shadow: 0 12px 32px #2928201c; }
  </style></head>
  <body><main data-easel-canvas aria-label="Image canvas"></main></body>
</html>`;

function escapeAttribute(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function unescapeAttribute(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  })[entity]);
}

function addCanvasMetadata(html, id, title) {
  const metadata = `<meta name="easel-canvas-id" content="${id}"><meta name="easel-canvas-title" content="${escapeAttribute(title)}"><title>${escapeAttribute(title)}</title>`;
  const clean = html
    .replace(/<meta\s+name="easel-canvas-id"[^>]*>/i, '')
    .replace(/<meta\s+name="easel-canvas-title"[^>]*>/i, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '');
  return clean.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${metadata}`);
}

function createCanvasStore({ userDataPath, fileSystem = fs, idFactory = () => crypto.randomUUID().replaceAll('-', '') }) {
  const canvasesPath = path.join(userDataPath, 'canvases');

  function getFilename(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Canvas ID is invalid.');
    return path.join(canvasesPath, `${id}.html`);
  }

  function writeHtml(id, html) {
    fileSystem.mkdirSync(canvasesPath, { recursive: true, mode: 0o700 });
    const filename = getFilename(id);
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    fileSystem.writeFileSync(temporary, html, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fileSystem.renameSync(temporary, filename);
    } catch (error) {
      fileSystem.rmSync(temporary, { force: true });
      throw error;
    }
    return fileSystem.statSync(filename).mtimeMs;
  }

  function save(artifact = {}) {
    const id = idFactory();
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Canvas ID generator returned an invalid ID.');
    const title = typeof artifact.title === 'string' && artifact.title.trim()
      ? artifact.title.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120)
      : 'Easel Canvas';
    const html = addCanvasMetadata(buildCanvasDocument(artifact), id, title);
    return { id, title, updatedAt: writeHtml(id, html) };
  }

  function createEmpty(title = 'Untitled Canvas') {
    return save({ title, html: EMPTY_CANVAS_HTML });
  }

  function update(id, snapshotHtml) {
    const existing = get(id);
    const document = buildCanvasSnapshotDocument(snapshotHtml);
    const html = addCanvasMetadata(document, id, existing.title);
    return { id, title: existing.title, updatedAt: writeHtml(id, html) };
  }

  function list() {
    if (!fileSystem.existsSync(canvasesPath)) return [];
    return fileSystem.readdirSync(canvasesPath)
      .filter((filename) => /^[a-f0-9]{32}\.html$/.test(filename))
      .map((filename) => {
        const id = filename.slice(0, -5);
        const file = path.join(canvasesPath, filename);
        const html = fileSystem.readFileSync(file, 'utf8');
        const match = html.match(/<meta\s+name="easel-canvas-title"\s+content="([^"]*)"\s*\/?\s*>/i);
        return { id, title: match ? unescapeAttribute(match[1]) : 'Easel Canvas', updatedAt: fileSystem.statSync(file).mtimeMs };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  function get(id) {
    const filename = getFilename(id);
    if (!fileSystem.existsSync(filename)) throw new Error('Canvas was not found.');
    const html = fileSystem.readFileSync(filename, 'utf8');
    const match = html.match(/<meta\s+name="easel-canvas-title"\s+content="([^"]*)"\s*\/?\s*>/i);
    return {
      id,
      title: match ? unescapeAttribute(match[1]) : 'Easel Canvas',
      html,
      updatedAt: fileSystem.statSync(filename).mtimeMs,
    };
  }

  return { createEmpty, get, list, save, update };
}

module.exports = { EMPTY_CANVAS_HTML, createCanvasStore };