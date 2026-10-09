const { parse, tokenizer } = require('acorn');

function hasRegisteredLayer(node, topLevel = false) {
  if (!node || typeof node !== 'object') return false;
  const property = node.type === 'MemberExpression' &&
    (node.computed ? node.property.value : node.property.name);
  if ((node.type === 'LabeledStatement' && !topLevel) ||
      (node.type === 'MemberExpression' && node.computed && node.property.type !== 'Literal') ||
      property === 'p' || /^[pd][1-9]$/.test(property)) {
    throw new Error('Add this example manually to a score with dynamic pattern registrations.');
  }
  // Inspect every branch before changing source; registration in a helper or
  // conditional cannot be inferred from its syntax without executing user code.
  const children = Object.values(node).map(value => Array.isArray(value)
    ? value.map(child => hasRegisteredLayer(child)).some(Boolean) : hasRegisteredLayer(value));
  return (node.type === 'LabeledStatement' && !node.label.name.startsWith('_') && !node.label.name.endsWith('_')) || children.some(Boolean);
}

function appendStrudelLayer(source, layer) {
  const { body } = parse(source, { ecmaVersion: 2022, allowAwaitOutsideFunction: true });
  const last = body.at(-1);
  // Strudel ignores the returned expression once labeled patterns exist. Keep
  // a plain score's final expression as a layer before adding its first label.
  const registered = body.map(node => hasRegisteredLayer(node, true)).some(Boolean);
  if (!registered && last?.type === 'ExpressionStatement') {
    source = source.slice(0, last.start) + '$: ' + source.slice(last.start);
  }
  return source + (source.trim() ? '\n\n' : '') + '$: ' + layer;
}

function escapeCode(source) {
  return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightStrudel(source) {
  const spans = [];
  const scan = tokenizer(source, { ecmaVersion: 2022, allowAwaitOutsideFunction: true,
    onComment(_block, _text, start, end) { spans.push({ start, end, kind: 'comment' }); } });
  try {
    for (let token = scan.getToken(); token.type.label !== 'eof'; token = scan.getToken()) {
      const label = token.type.label;
      let kind;
      if (token.type.keyword) kind = 'keyword';
      else if (['string', 'template', '`', 'regexp'].includes(label)) kind = 'string';
      else if (label === 'num') kind = 'number';
      else if (label === 'name' && /^\s*:/.test(source.slice(token.end))) kind = 'label';
      else if (label === 'name' && /^\s*\(/.test(source.slice(token.end))) kind = 'function';
      if (kind) spans.push({ start: token.start, end: token.end, kind });
    }
  } catch { /* Keep unfinished drafts visible while the user types. */ }
  let cursor = 0, html = '';
  for (const { start, end, kind } of spans.sort((a, b) => a.start - b.start)) {
    html += escapeCode(source.slice(cursor, start)) + `<span class="token-${kind}">${escapeCode(source.slice(start, end))}</span>`;
    cursor = end;
  }
  return html + escapeCode(source.slice(cursor));
}

module.exports = { appendStrudelLayer, highlightStrudel };
