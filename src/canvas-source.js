const crypto = require('node:crypto');

const SECTIONS = new Set(['app', 'head', 'body', 'styles', 'scripts']);
const MAX_SOURCE_BYTES = 24_000;
const MAX_PATCH_BYTES = 65_536;
const PROTECTED_SCRIPT = /\bdata-easel-canvas-kit\b|\bdata-easel-project-module\s*=\s*["']true["']|\bid\s*=\s*["'](?:easel-runtime-[^"']+|easel-project-[^"']+)["']/i;

function revision(html) {
  return crypto.createHash('sha256').update(html).digest('hex');
}

function sourceBlocks(html) {
  const blocks = [];
  // Script/style text is a raw-text HTML element: a closing tag ends it even inside JS strings.
  const pattern = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const openingEnd = match[0].indexOf('>') + 1;
    const closingStart = match[0].lastIndexOf('</');
    const opening = match[0].slice(0, openingEnd);
    blocks.push({
      type: match[1].toLowerCase(), start: match.index, end: match.index + match[0].length,
      contentStart: match.index + openingEnd, contentEnd: match.index + closingStart,
      protected: match[1].toLowerCase() === 'script' && PROTECTED_SCRIPT.test(opening),
    });
  }
  return blocks;
}

function sectionRanges(html, section = 'app', index) {
  if (!SECTIONS.has(section)) throw new Error('Source section must be app, head, body, styles, or scripts.');
  if (index !== undefined && (!Number.isInteger(index) || index < 0 || !['styles', 'scripts'].includes(section))) {
    throw new Error(['app', 'head', 'body'].includes(section) ? `Omit index for section ${section}. Example: {"section":"${section}","origin":"stored"}.` : 'Use a non-negative index only for scripts or styles.');
  }
  const blocks = sourceBlocks(html);
  if (['scripts', 'styles'].includes(section)) {
    const selected = blocks.filter((block) => block.type === (section === 'scripts' ? 'script' : 'style') && !block.protected);
    if (index !== undefined && !selected[index]) throw new Error('Source block was not found.');
    return (index === undefined ? selected : [selected[index]]).map((block) => ({ start: block.contentStart, end: block.contentEnd }));
  }
  let start = 0;
  let end = html.length;
  if (section !== 'app') {
    // Mask raw-text elements before locating structural tags so JS strings cannot select a false body/head.
    let structural = html;
    for (const block of [...blocks].reverse()) structural = `${structural.slice(0, block.start)}${' '.repeat(block.end - block.start)}${structural.slice(block.end)}`;
    const opening = new RegExp(`<${section}\\b[^>]*>`, 'i').exec(structural);
    const closing = new RegExp(`</${section}\\s*>`, 'i').exec(structural);
    if (!opening || !closing || closing.index < opening.index) throw new Error(`Canvas ${section} section was not found.`);
    start = opening.index + opening[0].length;
    end = closing.index;
  }
  const ranges = [];
  let cursor = start;
  for (const block of blocks.filter((block) => block.protected && block.end > start && block.start < end)) {
    if (block.start > cursor) ranges.push({ start: cursor, end: Math.min(end, block.start) });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < end) ranges.push({ start: cursor, end });
  return ranges;
}

function getSource(html, { section = 'app', index, offset = 0, maxBytes = MAX_SOURCE_BYTES, includeAssets = false } = {}) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Source offset must be a non-negative byte offset.');
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_SOURCE_BYTES) throw new Error('Source output must be between 256 and 24000 bytes.');
  const ranges = sectionRanges(html, section, index);
  if (typeof includeAssets !== 'boolean') throw new Error('includeAssets must be a boolean.');
  const raw = ranges.map((range) => html.slice(range.start, range.end)).join('\n/* next source block */\n');
  const text = includeAssets ? raw : raw.replace(/data:(?:image|audio|video|font)\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=]+/gi, 'data:[embedded asset omitted]');
  const bytes = Buffer.from(text, 'utf8');
  if (offset > bytes.length) throw new Error('Source offset exceeds the section size.');
  if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error('Source offset must be on a UTF-8 character boundary. Use nextOffset from the previous response.');
  let end = Math.min(offset + maxBytes, bytes.length);
  while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    section, ...(index === undefined ? {} : { index }), revision: revision(html),
    text: bytes.subarray(offset, end).toString('utf8'), offset, nextOffset: end < bytes.length ? end : null,
    totalBytes: bytes.length, truncated: end < bytes.length, protectedBundlesExcluded: true, embeddedAssetsOmitted: !includeAssets,
    blocks: sourceBlocks(html).filter((block) => !block.protected).reduce((counts, block) => ({ ...counts, [block.type]: counts[block.type] + 1 }), { script: 0, style: 0 }),
  };
}

function patchSource(html, { section = 'app', index, find, replace, expectedRevision } = {}) {
  if (typeof find !== 'string' || !find || typeof replace !== 'string') throw new Error('Patch requires nonempty find text and replacement text.');
  if (Buffer.byteLength(find, 'utf8') > MAX_PATCH_BYTES || Buffer.byteLength(replace, 'utf8') > MAX_PATCH_BYTES) throw new Error('Each patch text is limited to 64 KiB.');
  if (expectedRevision !== undefined && expectedRevision !== revision(html)) throw new Error('Canvas source changed. Read the source again before patching.');
  if (/<script\b[^>]*(?:data-easel-canvas-kit|easel-runtime-|easel-project-)/i.test(replace)) throw new Error('Runtime bundles and bootstraps are protected.');
  const matches = [];
  for (const range of sectionRanges(html, section, index)) {
    let cursor = range.start;
    while (cursor <= range.end - find.length) {
      const location = html.indexOf(find, cursor);
      if (location < 0 || location + find.length > range.end) break;
      matches.push(location);
      if (matches.length > 1) throw new Error('Patch text matches more than once. Include more context or select a source block.');
      cursor = location + 1;
    }
  }
  if (matches.length !== 1) throw new Error('Patch text was not found in the editable source section.');
  const position = matches[0];
  const output = `${html.slice(0, position)}${replace}${html.slice(position + find.length)}`;
  // Reject patches that swallow a protected script via altered HTML raw-text boundaries.
  const protectedBefore = sourceBlocks(html).filter((block) => block.protected).map((block) => html.slice(block.start, block.end));
  const protectedAfter = sourceBlocks(output).filter((block) => block.protected).map((block) => output.slice(block.start, block.end));
  if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)) throw new Error('Patch would alter a protected runtime bundle.');
  return { html: output, revision: revision(output) };
}

module.exports = { getSource, patchSource, revision, sourceBlocks };
