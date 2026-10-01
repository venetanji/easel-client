const { parse } = require('parse5');

function googleFontsUrl(reference, preconnect = false) {
  if (typeof reference !== 'string' || !/^(?:https?:|\/\/)/i.test(reference.trim())) return false;
  let url;
  try { url = new URL(reference.trim(), 'https://fonts.googleapis.com'); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return false;
  if (preconnect) return ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname) && url.pathname === '/' && !url.search && !url.hash;
  return url.hostname === 'fonts.googleapis.com' && ['/css', '/css2'].includes(url.pathname);
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
    if (!depth && /^@import(?![-\w\u0080-\uffff])/i.test(source.slice(index, index + 8))) {
      const start = index;
      let quote = '';
      let parentheses = 0;
      while (++index < source.length) {
        if (source[index] === '\\') { index += 1; continue; }
        if (quote) { if (source[index] === quote) quote = ''; }
        else if (source.startsWith('/*', index)) {
          const end = source.indexOf('*/', index + 2);
          index = end < 0 ? source.length : end + 1;
        }
        else if (source[index] === '"' || source[index] === "'") quote = source[index];
        else if (source[index] === '(') parentheses += 1;
        else if (source[index] === ')') parentheses = Math.max(0, parentheses - 1);
        else if (source[index] === ';' && !parentheses) break;
      }
      const end = Math.min(index + 1, source.length);
      rules.push({ start, end, text: source.slice(start, end) });
    }
  }
  return rules;
}

function importUrl(rule) {
  const source = rule.slice(7);
  let index = 0;
  function skipSpace() {
    while (index < source.length) {
      if (/\s/.test(source[index])) index += 1;
      else if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        if (end < 0) return false;
        index = end + 2;
      } else break;
    }
    return true;
  }
  if (!skipSpace()) return null;
  const wrapped = /^url\(/i.test(source.slice(index));
  if (wrapped) { index += 4; if (!skipSpace()) return null; }
  const quote = ['"', "'"].includes(source[index]) ? source[index++] : '';
  if (!quote && !wrapped) return null;
  const start = index;
  while (index < source.length && (quote ? source[index] !== quote : !/[\s)]/.test(source[index]))) {
    // Escaped URLs are left to the offline policy rather than interpreted as font declarations.
    if (source[index] === '\\') return null;
    index += 1;
  }
  const reference = source.slice(start, index);
  if (quote && source[index++] !== quote) return null;
  if (wrapped && (!skipSpace() || source[index] !== ')')) return null;
  return reference;
}

function sanitizeGoogleFontsCss(source) {
  if (!/fonts\.googleapis\.com/i.test(source)) return source;
  let output = source;
  for (const rule of cssImportRules(source).reverse()) {
    if (googleFontsUrl(importUrl(rule.text))) output = `${output.slice(0, rule.start)}${output.slice(rule.end)}`;
  }
  return output;
}

function sanitizeGoogleFontsHtml(html) {
  if (!/fonts\.(?:googleapis|gstatic)\.com/i.test(html)) return html;
  const document = parse(html, { sourceCodeLocationInfo: true });
  const pending = [document];
  const edits = [];
  while (pending.length) {
    const node = pending.pop();
    const location = node.sourceCodeLocation;
    if (node.tagName === 'link' && node.namespaceURI === 'http://www.w3.org/1999/xhtml' && location) {
      const attributes = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
      const relations = (attributes.rel || '').toLowerCase().split(/\s+/);
      if ((relations.includes('stylesheet') && googleFontsUrl(attributes.href)) || (relations.includes('preconnect') && googleFontsUrl(attributes.href, true))) {
        edits.push({ start: location.startOffset, end: location.endOffset, text: '' });
      }
    } else if (node.tagName === 'style' && location?.startTag) {
      const start = location.startTag.endOffset;
      const end = location.endTag?.startOffset ?? location.endOffset;
      const source = html.slice(start, end);
      const text = sanitizeGoogleFontsCss(source);
      if (text !== source) edits.push({ start, end, text });
    }
    // Inert templates and raw-text nodes are not documents to sanitize.
    for (const child of node.childNodes || []) pending.push(child);
  }
  let output = html;
  for (const edit of edits.sort((left, right) => right.start - left.start)) output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  return output;
}

module.exports = { cssImportRules, sanitizeGoogleFontsCss, sanitizeGoogleFontsHtml };
