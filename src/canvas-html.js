async function imageInsertionLocation(html) {
  if (typeof html !== 'string' || !html) throw new Error('Canvas entry HTML is required.');
  const { parse } = await import('parse5');
  const document = parse(html, { sourceCodeLocationInfo: true });
  const pending = [document];
  let body;
  let root;
  while (pending.length) {
    const node = pending.pop();
    if (node.tagName === 'html') root = node;
    if (node.tagName === 'body') body = node;
    if (node.attrs?.some((attribute) => attribute.name === 'data-easel-canvas')) {
      const offset = node.sourceCodeLocation?.endTag?.startOffset;
      if (!Number.isInteger(offset)) throw new Error('The authored canvas container needs an explicit closing tag before adding an image.');
      return { target: 'grid', offset };
    }
    // Templates hold inert content outside childNodes; never inspect template.content.
    for (const child of [...(node.childNodes || [])].reverse()) pending.push(child);
  }
  const script = body?.childNodes?.find((node) => node.tagName === 'script' && Number.isInteger(node.sourceCodeLocation?.startOffset));
  const offset = script?.sourceCodeLocation?.startOffset
    ?? body?.sourceCodeLocation?.endTag?.startOffset
    ?? root?.sourceCodeLocation?.endTag?.startOffset
    ?? html.length;
  return { target: 'body', offset };
}

function imageElement({ assetId, alt, maxWidth }) {
  const escapedAlt = alt.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return `<img src="{{asset:${assetId}}}" alt="${escapedAlt}" data-easel-asset-id="${assetId}" style="display:block;max-width:${maxWidth}%;height:auto;object-fit:contain;margin:12px auto;">`;
}

module.exports = { imageElement, imageInsertionLocation };
