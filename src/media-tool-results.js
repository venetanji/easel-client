function producedMediaAssets(result, toolName) {
  // Browsing the library must not attach every inspected asset to a conversation.
  if (toolName && !/(?:^|__)(?:image_generation|generate_image|edit_image|create_image_variation|generate_video|get_video|get_image_job|capture_live_canvas|record_canvas_video)$/.test(toolName)) return [];
  if (!result || result.isError || result.ok === false) return [];
  const payloads = [result, result.structuredContent];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block.type !== 'text') continue;
    try { payloads.push(JSON.parse(block.text)); } catch { /* Plain text has no saved media metadata. */ }
  }
  const assets = new Map();
  for (const payload of payloads) {
    if (!payload || payload.ok === false) continue;
    for (const asset of [...(Array.isArray(payload.assets) ? payload.assets : []), ...(payload.assetId ? [payload] : [])]) {
      const assetId = asset.assetId || asset.id;
      if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i.test(assetId || '')) continue;
      const name = asset.name || (/(?:^|__)capture_live_canvas$/.test(toolName || '') ? 'Live canvas capture.png' : /(?:^|__)record_canvas_video$/.test(toolName || '') ? 'Canvas recording' : undefined);
      const fields = { assetId: assetId.toLowerCase(), ...(name ? { name } : {}) };
      for (const key of ['mimeType', 'bytes', 'width', 'height', 'duration', 'codec', 'projectId', 'documentPath', 'data', 'thumbnail']) if (asset[key] !== undefined) fields[key] = asset[key];
      if (!fields.projectId && asset.canvasId) fields.projectId = asset.canvasId;
      assets.set(fields.assetId, { ...assets.get(fields.assetId), ...fields });
    }
  }
  return [...assets.values()];
}

if (typeof module !== 'undefined') module.exports = { producedMediaAssets };
