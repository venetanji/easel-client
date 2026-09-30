const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildCanvasDocument, buildCanvasSnapshotDocument } = require('./canvas-policy');
const { imageElement, imageInsertionLocation } = require('./canvas-html');
const { MAX_FILE_BYTES, MAX_FILES, assembleProject, digest, documentTitle, projectDocuments, projectFromDocument, readChunk, resolveDocumentPath, validateFilePath, validateJavaScriptFiles, validateProject, validateStateText } = require('./canvas-project');
const { createProjectZip } = require('./project-zip');

const ID_PATTERN = /^[a-f0-9]{32}$/;
const ATTACHED_ID_PATTERN = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const LEGACY_ASSET_REFERENCE = /(?<!\{)\basset:(?:\/\/)?([a-f0-9]{32})(?![a-f0-9])/gi;
const PROJECT_ASSET_REFERENCE = /\{\{asset:([a-f0-9]{64}|[a-f0-9]{32})\}\}/gi;
const MAX_PROJECT_EXPORT_BYTES = 256 * 1_048_576;
const MAX_DOCUMENT_EXPORT_BYTES = 128 * 1_048_576;

function imageDimensions(bytes, mimeType) {
  let width;
  let height;
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mimeType === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const format = bytes.toString('ascii', 12, 16);
    if (format === 'VP8X') {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (format === 'VP8L' && bytes[20] === 47) {
      width = 1 + ((bytes[21] | bytes[22] << 8) & 0x3fff);
      height = 1 + ((bytes[22] >> 6 | bytes[23] << 2 | bytes[24] << 10) & 0x3fff);
    } else if (format === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    }
  } else if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 8 < bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1];
      if (marker === 255) { offset += 1; continue; }
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (length >= 7 && [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  }
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : {};
}
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
  let templateDepth = 0;
  const clean = html.replace(/<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?template\b[^>]*>|<meta\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, (tag) => {
    if (/^<template\b/i.test(tag)) templateDepth += 1;
    else if (/^<\/template\b/i.test(tag)) templateDepth = Math.max(0, templateDepth - 1);
    else if (!templateDepth && (/^<title\b/i.test(tag) || /^<meta\b[^>]*\bname\s*=\s*["']?easel-canvas-(?:id|title)(?:["'\s>])/i.test(tag))) return '';
    return tag;
  });
  return clean.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${metadata}`);
}

function referencesProjectItem(content, fromFile, targetPath, assetId) {
  // Check authored references before assembly, including files outside the current document's dependency graph.
  if (assetId && new RegExp(`\\{\\{asset:${assetId}\\}\\}|\\basset:(?:\\/\\/)?${assetId}(?![a-f0-9])`, 'i').test(content)) return true;
  const references = [...content.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`/g)].map((match) => match.slice(1).find((value) => value !== undefined));
  references.push(...[...content.matchAll(/url\(\s*([^)'"\s]+)\s*\)/gi)].map((match) => match[1]));
  references.push(...[...content.matchAll(/\b(?:src|href|poster|action)\s*=\s*([^\s"'=<>`]+)/gi)].map((match) => match[1]));
  for (let reference of references) {
    reference = reference.replace(/\\u([a-f0-9]{4})|\\x([a-f0-9]{2})/gi, (_match, unicode, hex) => String.fromCharCode(parseInt(unicode || hex, 16))).replace(/\\([/'"`\\])/g, '$1');
    if (assetId && reference.toLowerCase() === assetId.toLowerCase()) return true;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(reference)) continue;
    for (const token of reference.split(/,\s*/).map((value) => value.trim().split(/\s+/)[0])) {
      let local = token.split(/[?#]/)[0];
      try { local = decodeURIComponent(local); } catch { continue; }
      if (local && path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), local)) === targetPath) return true;
    }
  }
  return false;
}

function createCanvasStore({ userDataPath, fileSystem = fs, kitBundles = {}, assetStore, thumbnailFactory = (bytes, mimeType) => `data:${mimeType};base64,${bytes.toString('base64')}`, idFactory = () => crypto.randomUUID().replaceAll('-', '') }) {
  const canvasesPath = path.join(userDataPath, 'canvases');
  const dependenciesPath = path.join(canvasesPath, '.dependencies');
  const projectAssetsPath = path.join(canvasesPath, '.assets');

  function getFilename(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Canvas ID is invalid.');
    return path.join(canvasesPath, `${id}.html`);
  }

  function writeAtomic(filename, value) {
    fileSystem.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    fileSystem.writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fileSystem.renameSync(temporary, filename);
    } catch (error) {
      fileSystem.rmSync(temporary, { force: true });
      throw error;
    }
    return fileSystem.statSync(filename).mtimeMs;
  }

  function projectFilename(id) {
    return getFilename(id).replace(/\.html$/, '.project.json');
  }

  function cacheDependency(name, source) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || typeof source !== 'string' || Buffer.byteLength(source) > 8 * 1_048_576) throw new Error('Canvas dependency is invalid or exceeds 8 MiB.');
    const hash = digest(source);
    const filename = path.join(dependenciesPath, `${hash}.js`);
    if (!fileSystem.existsSync(filename)) writeAtomic(filename, source);
    return { name, digest: hash };
  }

  function extractKits(html) {
    const kits = [];
    for (const match of html.matchAll(/<script\b[^>]*\bdata-easel-canvas-kit\s*=\s*["']([a-z][a-z0-9-]*)["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      if (!kits.some((kit) => kit.name === match[1])) kits.push(cacheDependency(match[1], match[2]));
    }
    return kits;
  }

  function saveAsset(bytes, mimeType, { id, name, assetPath, width, height, duration, codec } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1_048_576 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error('Canvas asset is invalid or exceeds 32 MiB.');
    const hash = digest(bytes);
    const filename = path.join(projectAssetsPath, hash);
    if (!fileSystem.existsSync(filename)) writeAtomic(filename, bytes);
    const extension = mimeType.split('/')[1].replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'bin';
    const dimensions = imageDimensions(bytes, mimeType);
    if (/^video\//.test(mimeType)) {
      if (Number.isInteger(width) && width > 0 && width <= 10000) dimensions.width = width;
      if (Number.isInteger(height) && height > 0 && height <= 10000) dimensions.height = height;
    }
    return { id: id || hash, digest: hash, mimeType, bytes: bytes.length, path: assetPath || `assets/${id || hash}.${extension}`, ...dimensions, ...(Number.isFinite(duration) && duration >= 0 && duration <= 3600 ? { duration } : {}), ...(typeof codec === 'string' && codec.length <= 80 ? { codec } : {}), ...(name ? { name } : {}) };
  }

  function extractAssets(content, assets) {
    return content.replace(/data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[a-z0-9=.+-]+)*;base64,([a-z0-9+/=]+)/gi, (_match, mimeType, data) => {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Embedded canvas media must be valid base64.');
      const asset = saveAsset(Buffer.from(data, 'base64'), mimeType);
      const existing = assets.find((candidate) => candidate.digest === asset.digest && candidate.mimeType === asset.mimeType);
      if (!existing) assets.push(asset);
      return `{{asset:${existing?.id || asset.id}}}`;
    });
  }

  function assemble(project, id, title, options = {}) {
    const html = assembleProject(project, {
      readKit: (kit) => fileSystem.readFileSync(path.join(dependenciesPath, `${kit.digest}.js`), 'utf8'),
      readAsset: (asset) => fileSystem.readFileSync(path.join(projectAssetsPath, asset.digest)),
      ...options,
    });
    return addCanvasMetadata(buildCanvasSnapshotDocument(html), id, title);
  }

  function titleFromHtml(html) {
    const match = html.match(/<meta\s+name="easel-canvas-title"\s+content="([^"]*)"\s*\/?\s*>/i);
    return match ? unescapeAttribute(match[1]) : 'Easel Canvas';
  }

  function loadProject(id, { readOnly = false } = {}) {
    const filename = projectFilename(id);
    if (fileSystem.existsSync(filename)) {
      const project = validateProject(JSON.parse(fileSystem.readFileSync(filename, 'utf8')));
      return { ...project, id, title: project.title || 'Easel Canvas', updatedAt: fileSystem.statSync(filename).mtimeMs };
    }
    const htmlFile = getFilename(id);
    if (!fileSystem.existsSync(htmlFile)) throw new Error('Canvas was not found.');
    if (readOnly) throw new Error('Open this legacy canvas before inspecting deletion so its project metadata can be migrated.');
    const html = fileSystem.readFileSync(htmlFile, 'utf8');
    const project = projectFromDocument(html, { extractAssets, extractKits });
    project.title = titleFromHtml(html);
    project.id = id;
    // Legacy HTML remains intact; project creation is one atomic source transaction.
    writeAtomic(filename, JSON.stringify(project));
    return { ...project, updatedAt: fileSystem.statSync(filename).mtimeMs };
  }

  function projectRevision(project) {
    return digest(JSON.stringify({ title: project.title, files: project.files, manifest: project.manifest }));
  }

  function commitProject(id, project) {
    validateProject(project);
    const html = assemble(project, id, project.title);
    const record = { ...project };
    delete record.updatedAt;
    const filename = projectFilename(id);
    const previous = fileSystem.existsSync(filename) ? validateProject(JSON.parse(fileSystem.readFileSync(filename, 'utf8'))) : null;
    const changed = !previous || projectRevision(previous) !== projectRevision(project);
    // HTML is a compatibility cache. Readers use the atomic project record as the source of truth.
    const updatedAt = changed ? writeAtomic(filename, JSON.stringify(record)) : fileSystem.statSync(filename).mtimeMs;
    if (changed) {
      try { writeAtomic(getFilename(id), html); } catch { /* A missing export cache can be regenerated from the committed project. */ }
    }
    return { id, title: project.title, updatedAt, changed, projectRevision: projectRevision(project), assembledBytes: Buffer.byteLength(html, 'utf8'), documentPath: project.manifest.entry, documentTitle: documentTitle(project.files[project.manifest.entry], project.title), documentCount: projectDocuments(project).length };
  }

  function applyArtifactAssets(project, suppliedAssets = []) {
    const remappedAssets = new Map();
    const sharedBindings = new Map();
    for (const asset of suppliedAssets) {
      if (asset.assetId !== undefined && !ATTACHED_ID_PATTERN.test(asset.assetId)) throw new Error('Canvas shared asset ID is invalid.');
      const bytes = Buffer.from(asset.data, 'base64');
      const hash = digest(bytes);
      if (asset.assetId && sharedBindings.has(asset.assetId) && sharedBindings.get(asset.assetId) !== hash) throw new Error('The same shared asset ID cannot refer to different media bytes.');
      if (asset.assetId) sharedBindings.set(asset.assetId, hash);
      const assetId = asset.assetId || hash;
      const old = project.manifest.assets.find((candidate) => candidate.id === hash && candidate.digest === hash && candidate.mimeType === asset.mimeType);
      const saved = saveAsset(bytes, asset.mimeType, { id: assetId, name: asset.name });
      const existing = project.manifest.assets.findIndex((candidate) => candidate.id === assetId);
      if (existing >= 0) project.manifest.assets[existing] = saved;
      else if (old && assetId !== hash) {
        project.manifest.assets.splice(project.manifest.assets.indexOf(old), 1, saved);
        remappedAssets.set(hash, assetId);
      } else project.manifest.assets.push(saved);
    }
    for (const [name, content] of Object.entries(project.files)) {
      let remapped = content;
      for (const [oldId, assetId] of remappedAssets) remapped = remapped.split(`{{asset:${oldId}}}`).join(`{{asset:${assetId}}}`);
      project.files[name] = remapped;
    }
  }

  function save(artifact = {}) {
    const id = idFactory();
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Canvas ID generator returned an invalid ID.');
    const title = typeof artifact.title === 'string' && artifact.title.trim()
      ? artifact.title.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120)
      : 'Easel Canvas';
    const html = addCanvasMetadata(buildCanvasDocument({ ...artifact, kitBundles: { ...kitBundles, ...artifact.kitBundles } }), id, title);
    const project = projectFromDocument(html, { extractAssets, extractKits });
    applyArtifactAssets(project, artifact.assets);
    for (const name of artifact.kits || []) {
      if (!project.manifest.kits.some((kit) => kit.name === name)) project.manifest.kits.push({ name });
    }
    project.id = id;
    project.title = title;
    return commitProject(id, project);
  }

  function createEmpty(title = 'Untitled Canvas', options = {}) {
    return save({ ...options, title, html: EMPTY_CANVAS_HTML });
  }

  function createProject({ title = 'Untitled project', kits = [] } = {}) {
    return createEmpty(title, { kits });
  }

  function renameProject(id, { title, expectedProjectRevision } = {}) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('Project name must contain 1 to 120 characters without control characters.');
    const project = loadProject(id);
    checkRevisions(project, undefined, { expectedProjectRevision });
    project.title = title.trim();
    return { ...commitProject(id, project), renamed: true };
  }

  function listDocuments(id) {
    const project = loadProject(id);
    return { id, title: project.title, documents: projectDocuments(project), projectRevision: projectRevision(project), updatedAt: project.updatedAt };
  }

  function createDocument(id, args = {}) {
    const project = loadProject(id);
    checkRevisions(project, undefined, args);
    let name = args.path;
    if (name === undefined) {
      let number = projectDocuments(project).length + 1;
      do { name = `canvases/canvas-${number++}/index.html`; } while (Object.hasOwn(project.files, name));
    }
    name = validateFilePath(name);
    if (!/\.html?$/i.test(name)) throw new Error('A canvas document must have an .html or .htm extension.');
    if (Object.hasOwn(project.files, name)) throw new Error('This document path already exists. Choose a new path.');
    const fallback = `Canvas ${projectDocuments(project).length + 1}`;
    const title = args.title === undefined ? documentTitle(args.html || '', fallback) : args.title;
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('Canvas title must contain 1 to 120 characters without control characters.');
    let authored = args.html === undefined ? EMPTY_CANVAS_HTML : args.html;
    if (typeof authored !== 'string') throw new Error('Canvas HTML is required.');
    // Existing project references remain opaque while the artifact validator processes new media.
    for (const asset of project.manifest.assets) authored = authored.split(`{{asset:${asset.id}}}`).join(`{{easel-project-asset:${asset.id}}}`);
    let html = addCanvasMetadata(buildCanvasDocument({ html: authored, kits: args.kits || [], assets: args.assets || [], kitBundles }), id, title.trim());
    for (const asset of project.manifest.assets) html = html.split(`{{easel-project-asset:${asset.id}}}`).join(`{{asset:${asset.id}}}`);
    const base = name.replace(/\.html?$/i, '');
    const scriptPath = path.posix.basename(base).toLowerCase() === 'index' ? `${path.posix.dirname(name)}/app.js`.replace(/^\.\//, '') : `${base}.app.js`;
    const stylePath = path.posix.basename(base).toLowerCase() === 'index' ? `${path.posix.dirname(name)}/styles.css`.replace(/^\.\//, '') : `${base}.styles.css`;
    const document = projectFromDocument(html, { documentPath: name, scriptPath, stylePath, extractAssets, extractKits });
    applyArtifactAssets(document, args.assets);
    for (const [filename, content] of Object.entries(document.files)) {
      if (Object.hasOwn(project.files, filename)) throw new Error(`The new canvas dependency conflicts with an existing file: ${filename}. Choose another document path.`);
      project.files[filename] = content;
    }
    for (const asset of document.manifest.assets) {
      const existing = project.manifest.assets.find((candidate) => candidate.id === asset.id);
      if (existing) {
        if (existing.digest !== asset.digest || existing.mimeType !== asset.mimeType) throw new Error('The new canvas reuses an asset ID with different media.');
      } else project.manifest.assets.push(asset);
    }
    for (const kit of document.manifest.kits) {
      if (!project.manifest.kits.some((candidate) => candidate.name === kit.name)) project.manifest.kits.push(kit);
    }
    for (const kit of args.kits || []) {
      if (!project.manifest.kits.some((candidate) => candidate.name === kit)) project.manifest.kits.push({ name: kit });
    }
    assemble(project, id, title.trim(), { documentPath: name });
    validateJavaScriptFiles({ ...project, manifest: { ...project.manifest, entry: name } }, Object.keys(document.files));
    return { ...commitProject(id, project), documentPath: name, documentTitle: title.trim(), documents: projectDocuments(project), dependencyPaths: Object.keys(document.files).filter((filename) => filename !== name), atomic: true };
  }

  function update(id, snapshotHtml, { documentPath, restoreMetadata = false } = {}) {
    const existing = loadProject(id);
    const document = buildCanvasSnapshotDocument(snapshotHtml);
    const project = projectFromDocument(document, { previous: existing, documentPath, preferPrevious: !restoreMetadata, extractAssets, extractKits });
    project.id = id;
    project.title = restoreMetadata && typeof project.title === 'string' && project.title.trim() ? project.title : existing.title;
    return commitProject(id, project);
  }

  function list() {
    if (!fileSystem.existsSync(canvasesPath)) return [];
    const names = fileSystem.readdirSync(canvasesPath);
    const ids = new Set(names.filter((filename) => /^[a-f0-9]{32}\.(?:html|project\.json)$/.test(filename)).map((filename) => filename.slice(0, 32)));
    return [...ids].map((id) => {
        const projectFile = projectFilename(id);
        if (fileSystem.existsSync(projectFile)) {
          const project = JSON.parse(fileSystem.readFileSync(projectFile, 'utf8'));
          return { id, title: project.title || 'Easel Canvas', documentCount: Object.keys(project.files || {}).filter((name) => /\.html?$/i.test(name)).length, assetCount: project.manifest?.assets?.length || 0, updatedAt: fileSystem.statSync(projectFile).mtimeMs };
        }
        const file = getFilename(id);
        return { id, title: titleFromHtml(fileSystem.readFileSync(file, 'utf8')), documentCount: 1, assetCount: 0, updatedAt: fileSystem.statSync(file).mtimeMs };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  function get(id, { documentPath } = {}) {
    const project = loadProject(id);
    const selected = resolveDocumentPath(project, documentPath);
    const selectedTitle = documentTitle(project.files[selected], selected === project.manifest.entry ? project.title : path.posix.basename(selected));
    const html = assemble(project, id, selectedTitle, { documentPath: selected });
    return {
      id,
      title: project.title,
      documentPath: selected,
      documentTitle: selectedTitle,
      documents: projectDocuments(project),
      html,
      assembledBytes: Buffer.byteLength(html, 'utf8'),
      updatedAt: project.updatedAt,
      projectRevision: projectRevision(project),
    };
  }

  function getDocument(id, documentPath) {
    return get(id, { documentPath });
  }

  function getProject(id) {
    const project = loadProject(id);
    const uniqueAssets = new Map(project.manifest.assets.map((asset) => [asset.digest, asset.bytes]));
    const contributions = { sourceBytes: Object.values(project.files).reduce((total, content) => total + Buffer.byteLength(content), 0), mediaBytes: [...uniqueAssets.values()].reduce((total, bytes) => total + bytes, 0), sourceFiles: Object.keys(project.files).length, mediaAssets: project.manifest.assets.length, uniqueMediaAssets: uniqueAssets.size };
    return { id, title: project.title, version: project.version, manifest: project.manifest, documents: projectDocuments(project), contributions, projectRevision: projectRevision(project), updatedAt: project.updatedAt, files: Object.entries(project.files).map(([file, content]) => ({ path: file, bytes: Buffer.byteLength(content, 'utf8'), lines: content.split('\n').length, revision: digest(content), kind: file === project.manifest.entry ? 'entry' : file === 'state.json' ? 'state' : path.posix.extname(file).slice(1) })), contract: { source: 'Project files are persisted independently from the open runtime. Use reload_canvas to apply edits. Write dependency files before referencing them; remove references before deleting files. apply_canvas_file_patches validates and commits all matches against original files in one revision.', documents: 'Every authored HTML file is a canvas document identified by its stable relative path. Opening a document does not change the default manifest.entry. Documents share project source files, kits, media and state.json.', kits: 'Named dependencies are stored outside editable source.', assets: 'Attach assets before using them. Await EaselCanvas.assets.ready, then EaselCanvas.assets.getUrl(id) returns an offline URL for attached IDs without querying the DOM. Source can also use {{asset:id}} or a local assets/ path in HTML/CSS. Media bytes never appear in source reads.', modules: 'Classic scripts execute in document order at their tag position; async/defer are removed when inlined. Place app.js at the body end, or use type=module for deferred execution. ES modules support relative static and literal dynamic imports through a local blob import map; bare package/HTTP imports and computed dynamic imports are unsupported.', state: 'state.json is opt-in persistent JSON, available initially as window.__easelProjectState; runtime state is not saved automatically.' } };
  }

  function listFiles(id, { directory = '', offset = 0, limit = 100 } = {}) {
    if (directory && (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(directory) || directory.split('/').includes('..'))) throw new Error('Project directory is invalid.');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_FILES) throw new Error('File list offset/limit is invalid.');
    const project = getProject(id);
    const prefix = directory ? `${directory.replace(/\/$/, '')}/` : '';
    const files = project.files.filter((file) => file.path.startsWith(prefix)).sort((left, right) => left.path.localeCompare(right.path));
    return { ...project, files: files.slice(offset, offset + limit), totalFiles: files.length, nextOffset: offset + limit < files.length ? offset + limit : null };
  }

  function readFile(id, args = {}) {
    const name = validateFilePath(args.path);
    const project = loadProject(id);
    if (!Object.hasOwn(project.files, name)) throw new Error('Canvas project file was not found.');
    return { path: name, ...readChunk(project.files[name], args), projectRevision: projectRevision(project), persisted: true, embeddedAssetsExcluded: true };
  }

  function checkRevisions(project, name, args) {
    if (args.expectedProjectRevision !== undefined && args.expectedProjectRevision !== projectRevision(project)) throw new Error('Canvas project changed. Read the project again before editing.');
    if (args.expectedRevision !== undefined && (!Object.hasOwn(project.files, name) || args.expectedRevision !== digest(project.files[name]))) throw new Error('Canvas file changed. Read the file again before editing.');
  }

  function writeFile(id, args = {}) {
    const name = validateFilePath(args.path);
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) throw new Error('Canvas source file must be text no larger than 1 MiB.');
    const project = loadProject(id);
    checkRevisions(project, name, args);
    project.files[name] = extractAssets(args.content, project.manifest.assets);
    const saved = commitProject(id, project);
    return { ...saved, path: name, revision: digest(project.files[name]), bytes: Buffer.byteLength(project.files[name], 'utf8'), effects: { source: 'persisted', runtime: 'unchanged until reload' } };
  }

  function patchFile(id, args = {}) {
    const name = validateFilePath(args.path);
    if (typeof args.find !== 'string' || !args.find || typeof args.replace !== 'string' || Buffer.byteLength(args.find) > 65536 || Buffer.byteLength(args.replace) > 65536) throw new Error('File patch needs nonempty find and replacement text, at most 64 KiB each.');
    const project = loadProject(id);
    checkRevisions(project, name, args);
    if (!Object.hasOwn(project.files, name)) throw new Error('Canvas project file was not found.');
    const original = project.files[name];
    const location = original.indexOf(args.find);
    if (location < 0) throw new Error('Patch text was not found in the file.');
    if (original.indexOf(args.find, location + 1) >= 0) throw new Error('Patch text matches more than once. Include more context.');
    return writeFile(id, { ...args, content: `${original.slice(0, location)}${args.replace}${original.slice(location + args.find.length)}` });
  }

  function patchFiles(id, args = {}) {
    if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 20) throw new Error('Canvas batch patches need 1 to 20 edits.');
    const project = loadProject(id);
    checkRevisions(project, undefined, args);
    const changes = new Map();
    for (const edit of args.edits) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit) || Object.keys(edit).some((key) => !['path', 'find', 'replace', 'expectedRevision'].includes(key))) throw new Error('Canvas batch edit is invalid.');
      const name = validateFilePath(edit.path);
      checkRevisions(project, name, edit);
      if (!Object.hasOwn(project.files, name)) throw new Error(`Canvas project file was not found: ${name}`);
      if (typeof edit.find !== 'string' || !edit.find || typeof edit.replace !== 'string' || Buffer.byteLength(edit.find) > 65_536 || Buffer.byteLength(edit.replace) > 65_536) throw new Error('Each batch edit requires nonempty find and replacement text, at most 64 KiB each.');
      const original = project.files[name];
      const start = original.indexOf(edit.find);
      if (start < 0) throw new Error(`Patch text was not found in ${name}. No batch edits were saved.`);
      if (original.indexOf(edit.find, start + 1) >= 0) throw new Error(`Patch text matches more than once in ${name}. No batch edits were saved.`);
      const end = start + edit.find.length;
      const existing = changes.get(name) || [];
      if (existing.some((change) => start < change.end && end > change.start)) throw new Error(`Batch edits overlap in ${name}. All matches must target the original file text.`);
      existing.push({ start, end, replacement: edit.replace });
      changes.set(name, existing);
    }
    const diff = [];
    for (const [name, edits] of changes) {
      const original = project.files[name];
      let content = original;
      for (const edit of [...edits].sort((left, right) => right.start - left.start)) content = `${content.slice(0, edit.start)}${edit.replacement}${content.slice(edit.end)}`;
      project.files[name] = extractAssets(content, project.manifest.assets);
      diff.push({ path: name, edits: edits.length, previousRevision: digest(original), revision: digest(project.files[name]), bytesBefore: Buffer.byteLength(original), bytesAfter: Buffer.byteLength(project.files[name]), hunks: edits.map((edit) => ({ line: original.slice(0, edit.start).split('\n').length, removedBytes: Buffer.byteLength(original.slice(edit.start, edit.end)), addedBytes: Buffer.byteLength(edit.replacement) })) });
    }
    const syntax = validateJavaScriptFiles(project, [...changes.keys()]);
    return { ...commitProject(id, project), editCount: args.edits.length, filesChanged: diff.length, diff, syntax, atomic: true, effects: { source: 'all edits persisted in one project revision', runtime: 'unchanged until reload' } };
  }

  function validateDeletionProject(project, id) {
    validateProject(project);
    const failures = [];
    for (const document of projectDocuments(project)) {
      try { assemble(project, id, document.title, { documentPath: document.path }); }
      catch (error) { failures.push({ path: document.path, error: error.message }); }
    }
    return failures;
  }

  function fileDeletionPlan(id, args = {}) {
    const name = validateFilePath(args.path);
    const project = loadProject(id, { readOnly: true });
    checkRevisions(project, name, args);
    if (!Object.hasOwn(project.files, name)) throw new Error('Canvas project file was not found.');
    const isDocument = /\.html?$/i.test(name);
    const previousEntry = project.manifest.entry;
    const documents = projectDocuments(project).filter((document) => document.path !== name);
    const nextEntry = name === previousEntry ? documents[0]?.path || null : previousEntry;
    const referencingFiles = Object.entries(project.files).filter(([file, content]) => file !== name && referencesProjectItem(content, file, name)).map(([file]) => file).sort();
    const summary = { id, path: name, title: project.title, bytes: Buffer.byteLength(project.files[name]), revision: digest(project.files[name]), projectRevision: projectRevision(project), isDocument, isEntry: name === previousEntry, previousEntry, nextEntry, remainingDocuments: documents, referencingFiles, ok: false };
    if (isDocument && !documents.length) return { project, summary: { ...summary, reason: 'The last HTML document cannot be deleted. Create another HTML document first.' } };
    if (referencingFiles.length) return { project, summary: { ...summary, reason: `File ${name} is still referenced by: ${referencingFiles.join(', ')}. Remove these source references first.` } };
    delete project.files[name];
    project.manifest.entry = nextEntry;
    const validationErrors = validateDeletionProject(project, id);
    if (validationErrors.length) return { project, summary: { ...summary, validationErrors, reason: `Deletion would leave invalid project documents: ${validationErrors.map((failure) => `${failure.path}: ${failure.error}`).join('; ')}` } };
    return { project, summary: { ...summary, ok: true, remainingDocuments: projectDocuments(project), validation: { ok: true, checkedDocuments: documents.map((document) => document.path) } } };
  }

  function deletionError(summary) {
    const error = new Error(summary.reason);
    error.code = 'CANVAS_DELETE_BLOCKED';
    error.referencingFiles = summary.referencingFiles;
    if (summary.validationErrors) error.validationErrors = summary.validationErrors;
    return error;
  }

  function inspectDeletion(id, args = {}) {
    return fileDeletionPlan(id, args).summary;
  }

  function deleteFile(id, args = {}) {
    const { project, summary } = fileDeletionPlan(id, args);
    if (!summary.ok) throw deletionError(summary);
    return { ...commitProject(id, project), path: summary.path, deletedPath: summary.path, deleted: true, isDocument: summary.isDocument, isEntry: summary.isEntry, previousEntry: summary.previousEntry, nextEntry: summary.nextEntry, documents: projectDocuments(project), effects: { source: 'file removed from the project; a surviving HTML document remains the entry', runtime: 'unchanged until host reload' } };
  }

  function assetDeletionPlan(id, args = {}) {
    if (typeof args.assetId !== 'string' || !ATTACHED_ID_PATTERN.test(args.assetId)) throw new Error('Project asset ID is invalid.');
    const project = loadProject(id, { readOnly: true });
    checkRevisions(project, undefined, args);
    const asset = project.manifest.assets.find((candidate) => candidate.id === args.assetId);
    if (!asset) throw new Error('This media asset is not attached to the selected project.');
    const referencingFiles = Object.entries(project.files).filter(([file, content]) => referencesProjectItem(content, file, asset.path, asset.id)).map(([file]) => file).sort();
    const summary = { id, assetId: asset.id, title: project.title, asset: { ...asset }, projectRevision: projectRevision(project), referencingFiles, ok: false };
    if (referencingFiles.length) return { project, summary: { ...summary, reason: `Media ${asset.path} is still referenced by: ${referencingFiles.join(', ')}. Remove these source references first.` } };
    project.manifest.assets = project.manifest.assets.filter((candidate) => candidate.id !== asset.id);
    const validationErrors = validateDeletionProject(project, id);
    if (validationErrors.length) return { project, summary: { ...summary, validationErrors, reason: `Detaching media would leave invalid project documents: ${validationErrors.map((failure) => `${failure.path}: ${failure.error}`).join('; ')}` } };
    return { project, summary: { ...summary, ok: true } };
  }

  function inspectAssetDeletion(id, args = {}) {
    return assetDeletionPlan(id, args).summary;
  }

  function detachAsset(id, args = {}) {
    const { project, summary } = assetDeletionPlan(id, args);
    if (!summary.ok) throw deletionError(summary);
    return { ...commitProject(id, project), assetId: summary.assetId, detachedAssetId: summary.assetId, detached: true, asset: summary.asset, documents: projectDocuments(project), effects: { source: 'project attachment removed; shared library media and cached blobs are preserved', runtime: 'unchanged until host reload' } };
  }

  function updateManifest(id, args = {}) {
    const project = loadProject(id);
    checkRevisions(project, undefined, args);
    if (args.entry !== undefined) project.manifest.entry = validateFilePath(args.entry);
    if (args.kits !== undefined) {
      if (!Array.isArray(args.kits) || args.kits.length > 32 || args.kits.some((kit) => typeof kit !== 'string')) throw new Error('Project kits must be kit names.');
      project.manifest.kits = [...new Set(args.kits)].map((name) => {
        const existing = project.manifest.kits.find((kit) => kit.name === name);
        if (typeof kitBundles[name] === 'string') return cacheDependency(name, kitBundles[name]);
        if (existing) return existing;
        if (['canvas-2d', 'html-deck'].includes(name)) return { name };
        throw new Error(`The ${name} canvas kit is unavailable.`);
      });
    }
    return { ...commitProject(id, project), manifest: project.manifest, effects: { source: 'persisted', runtime: 'unchanged until reload' } };
  }

  function assetBytes(asset) {
    const bytes = fileSystem.readFileSync(path.join(projectAssetsPath, asset.digest));
    if (!Buffer.isBuffer(bytes) || bytes.length !== asset.bytes || digest(bytes) !== asset.digest) throw new Error('Project media is missing or corrupted.');
    return bytes;
  }

  function listAssets(id, { offset = 0, limit = 200 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Project asset list offset/limit is invalid.');
    const project = loadProject(id);
    return { id, title: project.title, assets: project.manifest.assets.slice(offset, offset + limit).map((asset) => ({ ...asset, name: asset.name || path.posix.basename(asset.path), projectId: id })), totalAssets: project.manifest.assets.length, nextOffset: offset + limit < project.manifest.assets.length ? offset + limit : null, projectRevision: projectRevision(project), updatedAt: project.updatedAt };
  }

  function getAsset(id, assetId, { thumbnail = false } = {}) {
    if (typeof assetId !== 'string' || !ATTACHED_ID_PATTERN.test(assetId)) throw new Error('Project asset ID is invalid.');
    if (typeof thumbnail !== 'boolean') throw new Error('Project asset thumbnail option is invalid.');
    const project = loadProject(id);
    const asset = project.manifest.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error('This media asset is not attached to the selected project.');
    const bytes = assetBytes(asset);
    const metadata = { ...asset, name: asset.name || path.posix.basename(asset.path), projectId: id };
    if (thumbnail) {
      const preview = /^image\//i.test(asset.mimeType) ? thumbnailFactory(bytes, asset.mimeType) : '';
      if (typeof preview !== 'string' || (preview && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(preview))) throw new Error('Project media thumbnail is invalid.');
      return { ...metadata, thumbnail: preview };
    }
    return { ...metadata, data: bytes.toString('base64') };
  }

  async function attachAsset(id, args = {}) {
    if (typeof args.assetId !== 'string' || !ATTACHED_ID_PATTERN.test(args.assetId)) throw new Error('Shared or project asset ID is invalid.');
    if (args.path !== undefined && (typeof args.path !== 'string' || !/^assets\/[A-Za-z0-9_.-]{1,128}$/.test(args.path))) throw new Error('Asset path must be a filename inside assets/.');
    const project = loadProject(id);
    checkRevisions(project, undefined, args);
    const initialRevision = projectRevision(project);
    const previous = project.manifest.assets.find((candidate) => candidate.id === args.assetId);
    let saved;
    if (previous) {
      const bytes = assetBytes(previous);
      saved = { ...previous, ...imageDimensions(bytes, previous.mimeType), path: args.path || previous.path };
      project.manifest.assets[project.manifest.assets.indexOf(previous)] = saved;
    } else {
      if (!ID_PATTERN.test(args.assetId)) throw new Error('This digest media ID is not attached to the selected project.');
      if (!assetStore || typeof assetStore.get !== 'function') throw new Error('Shared media asset storage is unavailable.');
      const asset = await assetStore.get(args.assetId);
      if (!asset || asset.id !== args.assetId || typeof asset.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) throw new Error('Shared media asset is invalid.');
      if (projectRevision(loadProject(id)) !== initialRevision) throw new Error('Project changed while loading media. Retry with the latest revision.');
      saved = saveAsset(Buffer.from(asset.data, 'base64'), asset.mimeType, { ...asset, id: asset.id, assetPath: args.path });
      project.manifest.assets.push(saved);
    }
    return { ...commitProject(id, project), asset: saved, reference: `{{asset:${saved.id}}}`, effects: { source: 'asset attached; reference it from a source file', runtime: 'unchanged until reload' } };
  }

  async function attachAssets(id, args = {}) {
    if (!Array.isArray(args.assetIds) || args.assetIds.length < 1 || args.assetIds.length > 200 || args.assetIds.some((assetId) => typeof assetId !== 'string' || !ATTACHED_ID_PATTERN.test(assetId))) throw new Error('Attach between 1 and 200 valid asset IDs.');
    const project = loadProject(id);
    checkRevisions(project, undefined, args);
    const initialRevision = projectRevision(project);
    const assets = [];
    for (const assetId of new Set(args.assetIds)) {
      const existing = project.manifest.assets.find((candidate) => candidate.id === assetId);
      if (existing) {
        const bytes = fileSystem.readFileSync(path.join(projectAssetsPath, existing.digest));
        if (digest(bytes) !== existing.digest) throw new Error(`Attached asset ${assetId} is corrupted. No attachments were saved.`);
        Object.assign(existing, imageDimensions(bytes, existing.mimeType));
        assets.push(existing);
        continue;
      }
      if (!ID_PATTERN.test(assetId)) throw new Error(`Digest asset ${assetId} is not attached to this project. Use an ID from the shared asset library.`);
      if (!assetStore || typeof assetStore.get !== 'function') throw new Error('Shared media asset storage is unavailable.');
      const asset = await assetStore.get(assetId);
      if (!asset || asset.id !== assetId || typeof asset.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) throw new Error(`Shared asset ${assetId} is invalid. No attachments were saved.`);
      const saved = saveAsset(Buffer.from(asset.data, 'base64'), asset.mimeType, { ...asset, id: assetId });
      project.manifest.assets.push(saved);
      validateProject(project);
      assets.push(saved);
    }
    if (projectRevision(loadProject(id)) !== initialRevision) throw new Error('Canvas project changed while loading assets. No attachments were saved; retry from the latest revision.');
    const changed = projectRevision(project) !== initialRevision;
    const result = changed ? commitProject(id, project) : { id, title: project.title, updatedAt: project.updatedAt, projectRevision: initialRevision };
    return { ...result, atomic: true, changed, attachedCount: assets.length, assets: assets.map((asset) => ({ ...asset, reference: `{{asset:${asset.id}}}` })), effects: { source: changed ? 'all assets attached in one project revision' : 'assets already attached', runtime: 'unchanged until reload' } };
  }

  async function insertImage(id, args = {}) {
    if (typeof args.assetId !== 'string' || !ATTACHED_ID_PATTERN.test(args.assetId)) throw new Error('Shared or project image asset ID is invalid.');
    const alt = args.alt ?? '';
    const maxWidth = args.maxWidth ?? 80;
    if (typeof alt !== 'string' || alt.length > 240) throw new Error('Image alt text is invalid.');
    if (!Number.isInteger(maxWidth) || maxWidth < 10 || maxWidth > 100) throw new Error('Image width must be between 10 and 100 percent.');
    const project = loadProject(id);
    checkRevisions(project, undefined, args);
    const initialRevision = projectRevision(project);
    const entry = resolveDocumentPath(project, args.documentPath);
    const location = await imageInsertionLocation(project.files[entry]);
    const previous = project.manifest.assets.find((candidate) => candidate.id === args.assetId);
    let asset;
    if (previous) asset = { ...previous, data: assetBytes(previous).toString('base64') };
    else {
      if (!ID_PATTERN.test(args.assetId)) throw new Error('This digest media ID is not attached to the selected project.');
      if (!assetStore || typeof assetStore.get !== 'function') throw new Error('Shared media asset storage is unavailable.');
      asset = await assetStore.get(args.assetId);
    }
    if (!asset || asset.id !== args.assetId || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) || typeof asset.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) throw new Error('Canvas image must be a valid saved PNG, JPEG, or WebP asset.');
    if (projectRevision(loadProject(id)) !== initialRevision) throw new Error('Canvas source changed while adding the image. Retry from its latest revision.');
    const saved = saveAsset(Buffer.from(asset.data, 'base64'), asset.mimeType, { id: asset.id, assetPath: previous?.path, name: asset.name });
    const existing = project.manifest.assets.findIndex((candidate) => candidate.id === saved.id);
    if (existing >= 0) project.manifest.assets[existing] = saved;
    else project.manifest.assets.push(saved);
    const image = imageElement({ assetId: saved.id, alt, maxWidth });
    const html = project.files[entry];
    project.files[entry] = `${html.slice(0, location.offset)}${image}${html.slice(location.offset)}`;
    assemble(project, id, documentTitle(project.files[entry], project.title), { documentPath: entry });
    return { ...commitProject(id, project), documentPath: entry, atomic: true, assetId: saved.id, asset: saved, target: location.target, entry, alt, maxWidth, effects: { source: 'image and attachment saved in one project revision', runtime: 'unchanged until reload or host insertion' } };
  }

  async function migrateAssetReferences(id) {
    const project = loadProject(id);
    const initialRevision = projectRevision(project);
    const references = new Set();
    const paths = [];
    for (const [name, content] of Object.entries(project.files)) {
      // Earlier migration versions added another brace pair each time a project was opened.
      const normalized = content.replace(/(\{+)asset:(?:\/\/)?([a-f0-9]{64}|[a-f0-9]{32})(\}+)/gi, (match, opening, assetId, closing) => opening.length >= 2 && opening.length % 2 === 0 && opening.length === closing.length ? `{{asset:${assetId.toLowerCase()}}}` : match);
      for (const match of normalized.matchAll(PROJECT_ASSET_REFERENCE)) references.add(match[1].toLowerCase());
      for (const match of normalized.matchAll(LEGACY_ASSET_REFERENCE)) references.add(match[1].toLowerCase());
      const migrated = normalized.replace(LEGACY_ASSET_REFERENCE, (_match, assetId) => `{{asset:${assetId.toLowerCase()}}}`);
      if (migrated !== content) { project.files[name] = migrated; paths.push(name); }
    }
    for (const assetId of references) {
      if (!project.manifest.assets.some((candidate) => candidate.id === assetId)) {
        if (!ID_PATTERN.test(assetId)) throw new Error('Cannot migrate a digest media reference that is not attached to this project.');
        if (!assetStore || typeof assetStore.get !== 'function') throw new Error('Cannot migrate canvas media: shared asset storage is unavailable.');
        const asset = await assetStore.get(assetId);
        if (!asset || asset.id !== assetId || typeof asset.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) throw new Error('Cannot migrate a missing or invalid canvas media asset.');
        project.manifest.assets.push(saveAsset(Buffer.from(asset.data, 'base64'), asset.mimeType, { id: assetId, name: asset.name }));
        validateProject(project);
      }
    }
    if (projectRevision(project) === initialRevision) return { id, title: project.title, updatedAt: project.updatedAt, changed: false, projectRevision: initialRevision, migratedFiles: [], assetIds: [...references] };
    if (projectRevision(loadProject(id)) !== initialRevision) throw new Error('Canvas source changed during media migration. Retry opening this canvas.');
    return { ...commitProject(id, project), changed: true, migratedFiles: paths, assetIds: [...references] };
  }

  function readProjectState(id) {
    const project = loadProject(id);
    const text = project.files['state.json'];
    return { state: text === undefined ? null : validateStateText(text), exists: text !== undefined, revision: text === undefined ? null : digest(text), projectRevision: projectRevision(project), persisted: true };
  }

  function saveProjectState(id, args = {}) {
    let text;
    try { text = JSON.stringify(args.state, null, 2); } catch { throw new Error('Canvas state must be JSON serializable.'); }
    if (text === undefined) throw new Error('Canvas state is required.');
    validateStateText(text);
    return writeFile(id, { ...args, path: 'state.json', content: `${text}\n` });
  }

  function exportProject(id) {
    const project = loadProject(id);
    const documents = projectDocuments(project);
    const canonical = { ...project };
    delete canonical.updatedAt;
    const canonicalText = JSON.stringify(canonical, null, 2);
    const sourceBytes = Object.values(project.files).reduce((total, content) => total + Buffer.byteLength(content), 0);
    const mediaAliasBytes = project.manifest.assets.reduce((total, asset) => total + asset.bytes, 0);
    const uniqueMedia = new Map(project.manifest.assets.map((asset) => [asset.digest, asset]));
    const uniqueMediaBytes = [...uniqueMedia.values()].reduce((total, asset) => total + asset.bytes, 0);
    const kitBytes = project.manifest.kits.reduce((total, kit) => total + (kit.digest ? fileSystem.statSync(path.join(dependenciesPath, `${kit.digest}.js`)).size : 0), 0);
    const payloadBytes = [...uniqueMedia.values()].reduce((total, asset) => total + Math.ceil(asset.bytes / 3) * 4, 0);
    const minimumRenderedBytes = documents.length * (kitBytes + payloadBytes);
    const contributions = { sourceBytes, canonicalBytes: Buffer.byteLength(canonicalText), uniqueMediaBytes, mediaAliasBytes, kitBytes, documentCount: documents.length, minimumRenderedBytes, renderedBytes: 0, limitBytes: MAX_PROJECT_EXPORT_BYTES, documentLimitBytes: MAX_DOCUMENT_EXPORT_BYTES };
    const failSize = (reason) => {
      throw new Error(`Project ZIP export exceeds its 256 MiB total or 128 MiB document limit. ${reason} Contributions: ${JSON.stringify(contributions)}. Split a large project or remove unused media before exporting. No partial ZIP was written.`);
    };
    if (sourceBytes + contributions.canonicalBytes + mediaAliasBytes + kitBytes + minimumRenderedBytes > MAX_PROJECT_EXPORT_BYTES) failSize('The minimum export size is already over budget.');
    const zip = createProjectZip({ maxUncompressedBytes: MAX_PROJECT_EXPORT_BYTES, timestamp: project.updatedAt });
    const add = (name, value) => {
      const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value, 'utf8');
      if (zip.uncompressedBytes + bytes > MAX_PROJECT_EXPORT_BYTES) failSize(`${name} requires ${bytes} bytes.`);
      zip.add(name, value);
    };
    const exportedKits = project.manifest.kits.map((kit) => ({ ...kit, ...(kit.digest ? { path: `.easel/kits/${kit.name}-${kit.digest.slice(0, 16)}.js` } : {}) }));
    const manifest = { format: 'easel-project-export', version: 1, id, title: project.title, defaultDocument: project.manifest.entry, documents: documents.map(({ path: documentPath, title }) => ({ path: documentPath, title, sourcePath: `.easel/source/${documentPath}` })), sourceDirectory: '.easel/source/', canonicalProject: '.easel/project.json', media: project.manifest.assets, kits: exportedKits, contract: { documents: 'Open any listed HTML document directly in a modern browser. Each is self-contained with its shared project media and offline kits. Network access is not required.', source: 'Authored source is preserved separately in .easel/source/. Edit and rebuild it in Easel; runtime documents are compiled previews.', devices: 'Camera and microphone remain subject to browser device permission. Canvas-to-chat actions require the Easel host.', state: 'All documents start with the saved shared state.json; runtime changes are not persisted to the ZIP.' } };
    add('manifest.json', JSON.stringify(manifest, null, 2));
    add('.easel/project.json', canonicalText);
    add('README.txt', `Easel project: ${project.title}\n\nOpen ${project.manifest.entry} in a modern browser. All listed HTML documents\ncontain their own offline kits and media; no server or network is required.\n\nAuthored files: .easel/source/\nCanonical project: .easel/project.json\nMedia files: assets/ (at their original project aliases)\nKit source: .easel/kits/\nDocument list and capability notes: manifest.json\n\nCamera and microphone require browser permission. Chat input requires Easel.\n`);
    for (const [name, content] of Object.entries(project.files)) add(`.easel/source/${name}`, content);
    const cachedMedia = new Map();
    for (const asset of project.manifest.assets) {
      if (!cachedMedia.has(asset.digest)) cachedMedia.set(asset.digest, assetBytes(asset));
      add(asset.path, cachedMedia.get(asset.digest));
    }
    const cachedKits = new Map();
    for (const kit of exportedKits) {
      if (!kit.digest) continue;
      const source = fileSystem.readFileSync(path.join(dependenciesPath, `${kit.digest}.js`), 'utf8');
      if (digest(source) !== kit.digest) throw new Error(`The ${kit.name} offline kit is missing or corrupted.`);
      cachedKits.set(kit.digest, source);
      add(kit.path, source);
    }
    for (const document of documents) {
      const remaining = MAX_PROJECT_EXPORT_BYTES - zip.uncompressedBytes;
      const budget = Math.min(MAX_DOCUMENT_EXPORT_BYTES, remaining);
      let html;
      try {
        html = assemble(project, id, document.title, { documentPath: document.path, includeSnapshot: false, maxOutputBytes: budget, readKit: (kit) => cachedKits.get(kit.digest), readAsset: (asset) => cachedMedia.get(asset.digest) });
      } catch (error) {
        if (/exceeds|assembly uses.*limit/i.test(error.message)) failSize(`${document.path}: ${error.message}`);
        throw error;
      }
      const bytes = Buffer.byteLength(html, 'utf8');
      contributions.renderedBytes += bytes;
      if (bytes > budget) failSize(`${document.path} requires ${bytes} bytes; ${budget} remain.`);
      add(document.path, html);
    }
    const archive = zip.finish();
    const slug = project.title.normalize('NFKD').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100) || 'easel-project';
    return { ...archive, id, title: project.title, fileName: `${slug}.zip`, bytes: archive.data.length, documents, manifest, contributions };
  }

  return { attachAsset, attachAssets, createDocument, createEmpty, createProject, deleteFile, detachAsset, exportProject, get, getAsset, getDocument, getProject, inspectAssetDeletion, inspectDeletion, insertImage, list, listAssets, listDocuments, listFiles, migrateAssetReferences, patchFile, patchFiles, readAsset: getAsset, readFile, readProjectState, renameProject, save, saveProjectState, update, updateManifest, writeFile };
}

module.exports = { EMPTY_CANVAS_HTML, MAX_DOCUMENT_EXPORT_BYTES, MAX_PROJECT_EXPORT_BYTES, createCanvasStore };
