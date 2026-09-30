const crypto = require('node:crypto');
const path = require('node:path');
const acorn = require('acorn');

const MAX_FILE_BYTES = 1_048_576;
const MAX_PROJECT_BYTES = 4 * MAX_FILE_BYTES;
const MAX_FILES = 100;
const MAX_READ_BYTES = 24_000;
const MAX_STATE_BYTES = 65_536;
const FILE_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.md', '.svg', '.glsl', '.vert', '.frag', '.wgsl']);
const PROJECT_SNAPSHOT_ID = 'easel-project-snapshot';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateFilePath(value) {
  if (typeof value !== 'string' || value.length > 180 || !value || value.includes('\\') || /[\u0000-\u0020\u007f?#:%]/.test(value)) throw new Error('Project paths must be relative POSIX paths without spaces, URL escapes, or control characters.');
  if (value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error('Project path cannot traverse directories.');
  if (value === 'canvas.json' || value.startsWith('.easel/')) throw new Error('The project manifest is managed by Easel.');
  if (!FILE_EXTENSIONS.has(path.posix.extname(value).toLowerCase())) throw new Error('Unsupported project source file extension. Store media through asset references.');
  return value;
}

function validateProject(project) {
  if (!project || project.version !== 1 || !project.files || typeof project.files !== 'object' || Array.isArray(project.files)) throw new Error('Canvas project is invalid.');
  const entries = Object.entries(project.files);
  if (entries.length > MAX_FILES) throw new Error('Canvas projects support at most 100 source files.');
  let bytes = 0;
  for (const [name, content] of entries) {
    validateFilePath(name);
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('A project source file exceeds 1 MiB.');
    if (/data:[^\s"'<>]+;base64,/i.test(content)) throw new Error('Embedded binary data must be extracted before saving source.');
    bytes += Buffer.byteLength(content, 'utf8');
  }
  if (bytes > MAX_PROJECT_BYTES) throw new Error('Canvas project source exceeds 4 MiB.');
  const entry = validateFilePath(project.manifest?.entry || 'index.html');
  if (!/\.html?$/i.test(entry) || !Object.hasOwn(project.files, entry)) throw new Error('The project entry must reference an existing HTML file.');
  if (!Array.isArray(project.manifest?.kits) || project.manifest.kits.length > 32 || !Array.isArray(project.manifest?.assets) || project.manifest.assets.length > 200) throw new Error('Canvas project dependencies are invalid.');
  for (const kit of project.manifest.kits) {
    if (!kit || !/^[a-z][a-z0-9-]{0,63}$/.test(kit.name) || (kit.digest !== undefined && !/^[a-f0-9]{64}$/.test(kit.digest))) throw new Error('Canvas kit dependency is invalid.');
  }
  const assetPaths = new Set();
  const assetIds = new Set();
  const assetSizes = new Map();
  for (const asset of project.manifest.assets) {
    if (!asset || !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(asset.id) || !/^[a-f0-9]{64}$/.test(asset.digest) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(asset.mimeType) || !Number.isInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > 32 * MAX_FILE_BYTES) throw new Error('Canvas asset reference is invalid.');
    if (typeof asset.path !== 'string' || !/^assets\/[A-Za-z0-9_.-]+$/.test(asset.path) || assetPaths.has(asset.path) || Object.hasOwn(project.files, asset.path)) throw new Error('Canvas asset path is invalid or conflicts with another file.');
    if (assetIds.has(asset.id)) throw new Error('Canvas asset IDs must be unique.');
    assetIds.add(asset.id);
    assetPaths.add(asset.path);
    if (assetSizes.has(asset.digest) && assetSizes.get(asset.digest) !== asset.bytes) throw new Error('Canvas asset aliases have inconsistent byte sizes.');
    assetSizes.set(asset.digest, asset.bytes);
    if (asset.width !== undefined && (!Number.isInteger(asset.width) || asset.width < 1 || asset.width > 100_000)) throw new Error('Canvas asset width is invalid.');
    if (asset.height !== undefined && (!Number.isInteger(asset.height) || asset.height < 1 || asset.height > 100_000)) throw new Error('Canvas asset height is invalid.');
  }
  if ([...assetSizes.values()].reduce((total, bytes) => total + bytes, 0) > 32 * MAX_FILE_BYTES) throw new Error('Canvas project media exceeds 32 MiB.');
  if (Object.hasOwn(project.files, 'state.json')) validateStateText(project.files['state.json']);
  return project;
}

function validateStateText(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) throw new Error('Persistent canvas state exceeds 64 KiB.');
  try { return JSON.parse(text); } catch { throw new Error('state.json must contain valid JSON.'); }
}

function resolveDocumentPath(project, value = project.manifest.entry) {
  const name = validateFilePath(value);
  if (!/\.html?$/i.test(name) || !Object.hasOwn(project.files, name)) throw new Error('Select an existing HTML document in this project.');
  return name;
}

function documentTitle(html, fallback = 'Untitled canvas') {
  let templateDepth = 0;
  const tokens = /<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?template\b[^>]*>|<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi;
  for (const match of html.matchAll(tokens)) {
    if (/^<template\b/i.test(match[0])) templateDepth += 1;
    else if (/^<\/template\b/i.test(match[0])) templateDepth = Math.max(0, templateDepth - 1);
    else if (!templateDepth && match[2] !== undefined) {
      const text = match[2].replace(/&(?:amp|lt|gt|quot|apos|#(?:x[0-9a-f]+|[0-9]+));/gi, (entity) => {
        const common = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
        if (common[entity.toLowerCase()]) return common[entity.toLowerCase()];
        const point = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
      }).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
      if (text) return text;
    }
  }
  return fallback;
}

function projectDocuments(project) {
  return Object.entries(project.files).filter(([name]) => /\.html?$/i.test(name)).map(([name, content]) => ({
    path: name,
    title: documentTitle(content, name === project.manifest.entry ? project.title || 'Untitled canvas' : path.posix.basename(name).replace(/\.html?$/i, '')),
    isEntry: name === project.manifest.entry,
    revision: digest(content),
    bytes: Buffer.byteLength(content, 'utf8'),
  })).sort((left, right) => Number(right.isEntry) - Number(left.isEntry) || left.path.localeCompare(right.path));
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function getAttribute(tag, name) {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i').exec(tag)?.slice(1).find((part) => part !== undefined);
}

function authoredAttributes(tag, omit = []) {
  const source = tag.replace(/^<[^\s>]+/, '').replace(/\/?\s*>$/, '');
  const excluded = new Set(omit);
  return [...source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)]
    .filter((match) => !excluded.has(match[1].toLowerCase()) && !match[1].toLowerCase().startsWith('data-easel-project-'))
    .map((match) => ` ${match[0]}`).join('');
}

function styleDisabledBootstrap(index) {
  // Styles are inlined, so reflect the link disabled API on their replacement style element.
  return `<script id="easel-project-style-${index}">(() => {const style=document.currentScript.previousElementSibling;const apply=()=>{if(style.sheet)style.sheet.disabled=style.hasAttribute('disabled');};Object.defineProperty(style,'disabled',{configurable:true,get:()=>style.hasAttribute('disabled'),set:value=>{style.toggleAttribute('disabled',Boolean(value));apply();}});new MutationObserver(apply).observe(style,{attributes:true,attributeFilter:['disabled']});apply();})();</script>`;
}

function injectHead(html, text) {
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (tag) => `${tag}${text}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${text}</head>`);
  return `<!doctype html><html><head>${text}</head><body>${html}</body></html>`;
}

function cleanHostDocument(html) {
  return stripManagedKitScripts(html)
    .replace(/<script\b[^>]*\bid\s*=\s*["'](?:easel-runtime-[^"']+|easel-project-[^"']+)["'][^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?)[^>]*>/gi, '')
    .replace(/<meta\b[^>]*\bname=["']easel-canvas-(?:id|title)["'][^>]*>/gi, '');
}

function managedKitScripts(html) {
  const scripts = [];
  let templateDepth = 0;
  // Consume complete tags, quoted attributes and raw-text elements before recognizing kit markers.
  const tokens = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes)\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*$|<\/?[a-z][a-z0-9:-]*(?:"[^"]*"|'[^']*'|[^'">])*?>/gi;
  for (const match of html.matchAll(tokens)) {
    const token = match[0];
    if (/^<template\b/i.test(token)) { templateDepth += 1; continue; }
    if (/^<\/template\b/i.test(token)) { templateDepth = Math.max(0, templateDepth - 1); continue; }
    if (templateDepth || match[1]?.toLowerCase() !== 'script') continue;
    const opening = /^<script\b(?:"[^"]*"|'[^']*'|[^'">])*?>/i.exec(token)[0];
    const attributes = [...opening.slice(7, -1).matchAll(/([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=]+)))?/g)];
    const marker = attributes.find((attribute) => attribute[1].toLowerCase() === 'data-easel-canvas-kit');
    if (marker) scripts.push({ start: match.index, end: match.index + token.length, name: marker.slice(2).find((value) => value !== undefined), source: token.slice(opening.length, /<\/script\s*>$/i.exec(token)?.index ?? token.length) });
  }
  return scripts;
}

function stripManagedKitScripts(html) {
  let source = html;
  for (const script of managedKitScripts(html).reverse()) source = `${source.slice(0, script.start)}${source.slice(script.end)}`;
  return source;
}

function sourcePath(reference, fromFile, files, assetPaths = new Set()) {
  if (typeof reference !== 'string' || !reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(reference) || /[?#\\]/.test(reference)) throw new Error(`Only relative local project references are supported: ${reference}`);
  const name = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), reference));
  if (name.startsWith('../') || name === '..' || (!Object.hasOwn(files, name) && !assetPaths.has(name))) throw new Error(`Project reference was not found: ${reference} (from ${fromFile})`);
  return name;
}

function transformModuleImports(source, fromFile, resolve) {
  let tree;
  try { tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch (error) { throw new Error(`Module ${fromFile} has invalid JavaScript: ${error.message}`); }
  const pending = [tree];
  const edits = [];
  // Traverse syntax nodes instead of text so comments, strings and regexes remain untouched.
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
      if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') throw new Error(`Module ${fromFile} uses a computed dynamic import. Use a literal relative module path.`);
      const resolved = resolve(node.source.value);
      if (resolved !== node.source.value) edits.push({ start: node.source.start, end: node.source.end, text: JSON.stringify(resolved) });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object') pending.push(item);
      }
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  let output = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  return output;
}

function rewriteModuleImports(source, fromFile, files, dependencies = new Set()) {
  return transformModuleImports(source, fromFile, (specifier) => {
    const name = sourcePath(specifier, fromFile, files);
    if (!/\.m?js$/i.test(name)) throw new Error(`Only JavaScript module imports are supported: ${specifier}`);
    dependencies.add(name);
    return `easel-project:///${name}`;
  });
}

function restoreModuleImports(source, fromFile, files) {
  return transformModuleImports(source, fromFile, (specifier) => {
    if (!specifier.startsWith('easel-project:///')) return specifier;
    const name = validateFilePath(specifier.slice('easel-project:///'.length));
    if (!Object.hasOwn(files, name) || !/\.m?js$/i.test(name)) throw new Error(`Rendered module source was not found: ${name}`);
    const relative = path.posix.relative(path.posix.dirname(fromFile), name);
    return relative.startsWith('.') ? relative : `./${relative}`;
  });
}

function relocateInlineModule(source, fromFile, toFile) {
  if (path.posix.dirname(fromFile) === path.posix.dirname(toFile)) return source;
  return transformModuleImports(source, fromFile, (specifier) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(specifier) || /[?#\\]/.test(specifier)) throw new Error(`Only relative local project references are supported: ${specifier}`);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    if (resolved.startsWith('../') || resolved === '..') throw new Error('Module import cannot leave the project directory.');
    const relative = path.posix.relative(path.posix.dirname(toFile), resolved);
    return relative.startsWith('.') ? relative : `./${relative}`;
  });
}

function moduleBootstrap(files, roots) {
  const modules = {};
  const pending = [...roots];
  const seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const dependencies = new Set();
    modules[`easel-project:///${name}`] = `${rewriteModuleImports(files[name], name, files, dependencies)}\n//# sourceURL=easel-source:///${name}\n`;
    pending.push(...dependencies);
  }
  const json = JSON.stringify(modules).replace(/</g, '\\u003c');
  return `<script id="easel-project-modules">(() => {const sources=${json};const imports={};const urls=[];for(const [name,source] of Object.entries(sources)){const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));imports[name]=url;urls.push(url);}const map=document.createElement('script');map.id='easel-project-importmap';map.type='importmap';map.textContent=JSON.stringify({imports});document.currentScript.after(map);window.addEventListener('pagehide',()=>urls.forEach(url=>URL.revokeObjectURL(url)),{once:true});})();</script>`;
}

function validateJavaScriptFiles(project, names) {
  const entry = project.manifest.entry;
  const moduleFiles = new Set();
  const classicFiles = new Set();
  const roots = new Set();
  for (const match of project.files[entry].matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)) {
    const tag = match[0];
    const openingEnd = tag.indexOf('>') + 1;
    const opening = tag.slice(0, openingEnd);
    const type = getAttribute(opening, 'type')?.toLowerCase() || '';
    const source = getAttribute(opening, 'src');
    if (type === 'module') {
      if (source) roots.add(sourcePath(source, entry, project.files));
      else rewriteModuleImports(tag.slice(openingEnd, tag.lastIndexOf('</')), entry, project.files, roots);
    } else if (['', 'text/javascript', 'application/javascript'].includes(type)) {
      if (source) classicFiles.add(sourcePath(source, entry, project.files));
      else if (names.includes(entry)) {
        try { acorn.parse(tag.slice(openingEnd, tag.lastIndexOf('</')), { ecmaVersion: 'latest', sourceType: 'script' }); }
        catch (error) { throw new Error(`Inline script in ${entry} has invalid JavaScript: ${error.message}`); }
      }
    }
  }
  const pending = [...roots];
  while (pending.length) {
    const name = pending.pop();
    if (moduleFiles.has(name)) continue;
    moduleFiles.add(name);
    const dependencies = new Set();
    rewriteModuleImports(project.files[name], name, project.files, dependencies);
    pending.push(...dependencies);
  }
  for (const name of names) {
    if (!/\.m?js$/i.test(name)) continue;
    const sourceType = /\.mjs$/i.test(name) || moduleFiles.has(name) ? 'module' : 'script';
    try { acorn.parse(project.files[name], { ecmaVersion: 'latest', sourceType }); }
    catch (error) {
      if (sourceType === 'script' && !classicFiles.has(name)) {
        try { acorn.parse(project.files[name], { ecmaVersion: 'latest', sourceType: 'module' }); continue; }
        catch { /* Report the original script parse when neither form is valid. */ }
      }
      throw new Error(`Canvas file ${name} has invalid ${sourceType} JavaScript: ${error.message}`);
    }
  }
  return { checkedFiles: names.filter((name) => /\.m?js$/i.test(name)), moduleFiles: [...moduleFiles] };
}

function cssImportRules(source) {
  const rules = [];
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    const character = source[index];
    if (character === '"' || character === "'") {
      const quote = character;
      while (++index < source.length && source[index] !== quote) if (source[index] === '\\') index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') depth = Math.max(0, depth - 1);
    if (!depth && /^@import\b/i.test(source.slice(index, index + 8))) {
      const start = index;
      let quote = '';
      while (++index < source.length) {
        if (source[index] === '\\') { index += 1; continue; }
        if (quote) { if (source[index] === quote) quote = ''; }
        else if (source[index] === '"' || source[index] === "'") quote = source[index];
        else if (source[index] === ';') break;
      }
      rules.push({ start, end: index + 1, text: source.slice(start, index + 1) });
    }
  }
  return rules;
}

function assembleProject(project, { readKit, readAsset, documentPath, includeSnapshot = true, maxOutputBytes = Infinity } = {}) {
  validateProject(project);
  const { files, manifest } = project;
  const entry = resolveDocumentPath(project, documentPath);
  const assetPaths = new Set(manifest.assets.map((asset) => asset.path));
  const assetUrls = new Map();
  const assetPayloads = new Map();
  function assetUrl(asset) {
    if (!assetUrls.has(asset.id)) {
      if (!assetPayloads.has(asset.digest)) {
        const bytes = readAsset(asset);
        if (!Buffer.isBuffer(bytes) || digest(bytes) !== asset.digest || bytes.length !== asset.bytes) throw new Error('Canvas asset is missing or corrupted.');
        assetPayloads.set(asset.digest, bytes.toString('base64'));
      }
      assetUrls.set(asset.id, `data:${asset.mimeType};base64,${assetPayloads.get(asset.digest)}`);
    }
    return assetUrls.get(asset.id);
  }
  function resolveAssets(content, fromFile) {
    let output = content;
    const checkSize = (bytes) => { if (bytes > maxOutputBytes) throw new Error(`Assembled document ${entry} exceeds its ${maxOutputBytes}-byte export budget.`); };
    checkSize(Buffer.byteLength(output));
    for (const asset of manifest.assets) {
      const token = `{{asset:${asset.id}}}`;
      if (!output.includes(token)) continue;
      const pieces = output.split(token);
      const url = assetUrl(asset);
      checkSize(Buffer.byteLength(output) + (pieces.length - 1) * (Buffer.byteLength(url) - token.length));
      output = pieces.join(url);
    }
    let outputBytes = Buffer.byteLength(output);
    output = output.replace(/\b(src|href|poster)\s*=\s*(["'])([^"']+)\2/gi, (match, attr, quote, reference) => {
      if (/^(?:data:|blob:|#)/i.test(reference)) return match;
      const name = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), reference));
      const asset = manifest.assets.find((candidate) => candidate.path === name);
      const replacement = asset ? `${attr}=${quote}${assetUrl(asset)}${quote}` : match;
      outputBytes += Buffer.byteLength(replacement) - Buffer.byteLength(match);
      checkSize(outputBytes);
      return replacement;
    });
    output = output.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi, (match, _quote, reference) => {
      if (/^(?:data:|blob:|#)/i.test(reference)) return match;
      const name = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), reference));
      const asset = manifest.assets.find((candidate) => candidate.path === name);
      const replacement = asset ? `url("${assetUrl(asset)}")` : match;
      outputBytes += Buffer.byteLength(replacement) - Buffer.byteLength(match);
      checkSize(outputBytes);
      return replacement;
    });
    if (/\{\{asset:[^}]+\}\}/.test(output)) throw new Error('Canvas references an unattached asset.');
    return output;
  }
  function cssText(name, ancestry = []) {
    if (ancestry.includes(name)) throw new Error('Circular CSS imports are unsupported.');
    let text = files[name];
    for (const rule of cssImportRules(text).reverse()) {
      const match = /^@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?\s*([^;]*);$/i.exec(rule.text);
      if (!match) throw new Error('CSS imports must use quoted relative paths.');
      const [, , reference, media] = match;
      const imported = sourcePath(reference, name, files);
      if (!/\.css$/i.test(imported)) throw new Error('CSS imports must reference CSS files.');
      if (/\b(?:layer|supports)\s*\(/i.test(media)) throw new Error('CSS @import layer/supports qualifiers are unsupported. Use an explicit CSS block.');
      const nested = cssText(imported, [...ancestry, name]);
      const replacement = media.trim() ? `@media ${media.trim()} {\n${nested}\n}` : nested;
      text = `${text.slice(0, rule.start)}${replacement}${text.slice(rule.end)}`;
    }
    return resolveAssets(text, name);
  }
  let html = cleanHostDocument(files[entry]);
  let hasModules = false;
  const moduleRoots = new Set();
  let styleIndex = 0;
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const relation = getAttribute(tag, 'rel')?.toLowerCase();
    if (!relation?.split(/\s+/).includes('stylesheet')) return tag;
    const reference = getAttribute(tag, 'href');
    const name = sourcePath(reference, entry, files, assetPaths);
    if (!/\.css$/i.test(name)) throw new Error('Stylesheets must reference CSS files.');
    const source = cssText(name);
    const rendered = source.replace(/<\/style/gi, '<\\/style');
    return `<style${authoredAttributes(tag, ['href', 'rel'])} data-easel-project-file="${escapeAttribute(name)}" data-easel-project-link-rel="${escapeAttribute(relation)}" data-easel-project-rendered="${digest(rendered)}">${rendered}</style>${styleDisabledBootstrap(styleIndex++)}`;
  });
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => {
    const opening = tag.slice(0, tag.indexOf('>') + 1);
    const reference = getAttribute(opening, 'src');
    if (!reference) {
      if (getAttribute(opening, 'type')?.toLowerCase() === 'module') {
        hasModules = true;
        const content = tag.slice(opening.length, tag.lastIndexOf('</'));
        const rendered = rewriteModuleImports(resolveAssets(content, entry), entry, files, moduleRoots).replace(/<\/script/gi, '<\\/script');
        return `${opening.slice(0, -1)} data-easel-project-inline-module="${digest(content)}" data-easel-project-rendered="${digest(rendered)}">${rendered}</script>`;
      }
      return tag;
    }
    const name = sourcePath(reference, entry, files);
    if (!/\.m?js$/i.test(name)) throw new Error('Scripts must reference JavaScript files.');
    const attributes = opening.replace(/\s+src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '').replace(/\s+(?:async|defer)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '').slice(0, -1);
    if (getAttribute(opening, 'type')?.toLowerCase() === 'module') {
      hasModules = true;
      moduleRoots.add(name);
      return `${attributes} data-easel-project-file="${escapeAttribute(name)}" data-easel-project-module="true">import ${JSON.stringify(`easel-project:///${name}`)};</script>`;
    }
    const source = resolveAssets(files[name], name);
    const rendered = source.replace(/<\/script/gi, '<\\/script');
    return `${attributes} data-easel-project-file="${escapeAttribute(name)}" data-easel-project-rendered="${digest(rendered)}">${rendered}</script>`;
  });
  html = resolveAssets(html, entry);
  let kits = '';
  for (const kit of manifest.kits) {
    if (!kit.digest) continue;
    const source = readKit(kit);
    if (typeof source !== 'string' || digest(source) !== kit.digest) throw new Error(`The ${kit.name} canvas dependency is missing or corrupted.`);
    kits += `<script data-easel-canvas-kit="${escapeAttribute(kit.name)}">${source.replace(/<\/script/gi, '<\\/script')}</script>`;
  }
  const snapshotProject = { ...project };
  delete snapshotProject.updatedAt;
  const snapshot = includeSnapshot ? `<script id="${PROJECT_SNAPSHOT_ID}" type="application/json" data-easel-project-document="${escapeAttribute(entry)}">${JSON.stringify(snapshotProject).replace(/</g, '\\u003c')}</script>` : '';
  const assets = Object.fromEntries(manifest.assets.map((asset) => [asset.id, asset]));
  const payloads = {};
  for (const asset of manifest.assets) {
    assetUrl(asset);
    payloads[asset.digest] = assetPayloads.get(asset.digest);
  }
  const assetSource = JSON.stringify(assets).replace(/</g, '\\u003c');
  const payloadSource = JSON.stringify(payloads);
  const assetBootstrap = `<script id="easel-project-assets">(() => {const payloads=${payloadSource};window.__easelProjectAssets=Object.freeze(Object.fromEntries(Object.entries(${assetSource}).map(([id,asset])=>[id,Object.freeze({...asset,url:'data:'+asset.mimeType+';base64,'+payloads[asset.digest]})])));window.__easelProjectAssetsReady=Promise.resolve(window.__easelProjectAssets);})();</script>`;
  const state = Object.hasOwn(files, 'state.json') ? `<script id="easel-project-state">window.__easelProjectState=${JSON.stringify(validateStateText(files['state.json'])).replace(/</g, '\\u003c')};</script>` : '';
  const assembled = injectHead(html, `${assetBootstrap}${kits}${snapshot}${state}${hasModules ? moduleBootstrap(Object.fromEntries(Object.entries(files).filter(([name]) => /\.m?js$/i.test(name)).map(([name, source]) => [name, resolveAssets(source, name)])), moduleRoots) : ''}`);
  if (Buffer.byteLength(assembled, 'utf8') > maxOutputBytes) throw new Error(`Assembled document ${entry} exceeds its ${maxOutputBytes}-byte export budget.`);
  return assembled;
}

function projectSnapshot(html) {
  const match = new RegExp(`<script\\b[^>]*\\bid=["']${PROJECT_SNAPSHOT_ID}["'][^>]*>([\\s\\S]*?)<\\/script\\s*>`, 'i').exec(html);
  if (!match) return null;
  if (Buffer.byteLength(match[1], 'utf8') > MAX_PROJECT_BYTES * 6 + 300_000) throw new Error('Canvas project snapshot exceeds its source limit.');
  try { return validateProject(JSON.parse(match[1])); } catch (error) { throw new Error(`Canvas project snapshot is invalid: ${error.message}`); }
}

function projectFromDocument(html, { previous, extractAssets, extractKits, documentPath, scriptPath, stylePath, preferPrevious = false } = {}) {
  const embedded = projectSnapshot(html);
  const project = (preferPrevious && previous) || embedded || previous || { version: 1, manifest: { entry: documentPath || 'index.html', kits: [], assets: [] }, files: {} };
  const output = structuredClone(project);
  const embeddedPath = new RegExp(`<script\\b[^>]*\\bid=["']${PROJECT_SNAPSHOT_ID}["'][^>]*>`, 'i').exec(html)?.[0];
  const entry = validateFilePath(documentPath || (embeddedPath && getAttribute(embeddedPath, 'data-easel-project-document')) || output.manifest.entry);
  if ((embedded || previous) && !Object.hasOwn(output.files, entry)) throw new Error('The selected snapshot document is missing from its project.');
  const originalInlineModules = new Map();
  if (embedded || previous) {
    for (const match of output.files[entry].matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)) {
      const tag = match[0];
      const openingEnd = tag.indexOf('>') + 1;
      const opening = tag.slice(0, openingEnd);
      if (!getAttribute(opening, 'src') && getAttribute(opening, 'type')?.toLowerCase() === 'module') {
        const content = tag.slice(openingEnd, tag.lastIndexOf('</'));
        originalInlineModules.set(digest(content), content);
      }
    }
  }
  const foundKits = preferPrevious && previous ? [] : extractKits(html);
  if (foundKits.length) output.manifest.kits = embedded
    ? output.manifest.kits.map((kit) => foundKits.find((candidate) => candidate.name === kit.name) || kit)
    : foundKits;
  let source = cleanHostDocument(html);
  const scriptNames = [];
  const styleNames = [];
  let scriptIndex = 0;
  let styleIndex = 0;
  const usedPaths = new Set();
  source = source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (tag, type) => {
    const openingEnd = tag.indexOf('>') + 1;
    const opening = tag.slice(0, openingEnd);
    const content = tag.slice(openingEnd, tag.lastIndexOf('</'));
    const marker = getAttribute(opening, 'data-easel-project-file');
    const external = getAttribute(opening, 'src');
    if (external && !marker) return tag;
    if (!marker && (embedded || previous)) {
      const clean = opening.replace(/\s+data-easel-project-(?:inline-module|rendered)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
      if (type.toLowerCase() === 'script' && getAttribute(opening, 'type')?.toLowerCase() === 'module') {
        const original = originalInlineModules.get(getAttribute(opening, 'data-easel-project-inline-module'));
        // Preserve authored imports exactly; explicit DOM adoption may change module text.
        const restored = original !== undefined && getAttribute(opening, 'data-easel-project-rendered') === digest(content)
          ? original : restoreModuleImports(content, entry, output.files);
        return `${clean}${restored}</script>`;
      }
      return `${clean}${content}</${type}>`;
    }
    const scriptType = getAttribute(opening, 'type')?.toLowerCase();
    if (type.toLowerCase() === 'script' && !marker && scriptType && !['module', 'text/javascript', 'application/javascript'].includes(scriptType)) return tag;
    const isScript = type.toLowerCase() === 'script';
    const sequence = isScript ? scriptIndex++ : styleIndex++;
    const base = isScript ? scriptPath || 'app.js' : stylePath || 'styles.css';
    const part = isScript ? (scriptPath ? `${base.replace(/\.[^.]+$/, '')}.parts` : 'scripts') : (stylePath ? `${base.replace(/\.[^.]+$/, '')}.parts` : 'styles');
    const name = marker || (sequence ? `${part}/part-${sequence + 1}.${isScript ? 'js' : 'css'}` : base);
    validateFilePath(name);
    if (usedPaths.has(name)) throw new Error('A source file is included more than once in the canvas snapshot.');
    usedPaths.add(name);
    const sourceUnchanged = marker && (getAttribute(opening, 'data-easel-project-module') === 'true' || getAttribute(opening, 'data-easel-project-rendered') === digest(content));
    if (!sourceUnchanged) output.files[name] = extractAssets(isScript && !marker && scriptType === 'module' ? relocateInlineModule(content, entry, name) : content, output.manifest.assets);
    else if (!Object.hasOwn(output.files, name)) throw new Error('Project file source snapshot was not found.');
    (isScript ? scriptNames : styleNames).push(name);
    if (isScript) {
      const clean = opening.replace(/\s+data-easel-project-(?:file|module|rendered)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '').slice(0, -1);
      return `${clean} src="${escapeAttribute(path.posix.relative(path.posix.dirname(entry), name))}"></script>`;
    }
    const relation = getAttribute(opening, 'data-easel-project-link-rel') || 'stylesheet';
    return `<link${authoredAttributes(opening, ['href', 'rel'])} rel="${escapeAttribute(relation)}" href="${escapeAttribute(path.posix.relative(path.posix.dirname(entry), name))}">`;
  });
  output.files[entry] = extractAssets(source, output.manifest.assets);
  if (!embedded && !previous) {
    if (!scriptNames.length) {
      const name = scriptPath || 'app.js';
      output.files[name] = '';
      const reference = escapeAttribute(path.posix.relative(path.posix.dirname(entry), name));
      output.files[entry] = output.files[entry].replace(/<\/body\s*>/i, `<script src="${reference}"></script></body>`);
    }
    if (!styleNames.length) {
      const name = stylePath || 'styles.css';
      output.files[name] = '';
      output.files[entry] = injectHead(output.files[entry], `<link rel="stylesheet" href="${escapeAttribute(path.posix.relative(path.posix.dirname(entry), name))}">`);
    }
  }
  return validateProject(output);
}

function readChunk(content, { offset = 0, maxBytes = MAX_READ_BYTES } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_READ_BYTES) throw new Error('File read needs a non-negative UTF-8 offset and maxBytes between 256 and 24000.');
  const bytes = Buffer.from(content, 'utf8');
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) throw new Error('File offset must be a valid UTF-8 boundary; use nextOffset from the previous read.');
  let end = Math.min(offset + maxBytes, bytes.length);
  while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(offset, end).toString('utf8'), offset, nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length, truncated: end < bytes.length, revision: digest(content) };
}

module.exports = { MAX_FILE_BYTES, MAX_PROJECT_BYTES, MAX_FILES, MAX_STATE_BYTES, assembleProject, cleanHostDocument, digest, documentTitle, managedKitScripts, projectDocuments, projectFromDocument, projectSnapshot, readChunk, resolveDocumentPath, stripManagedKitScripts, validateFilePath, validateJavaScriptFiles, validateProject, validateStateText };
