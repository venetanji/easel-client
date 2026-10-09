const { AUDIO_TOOLS } = require('./media-mcp-client');
const ASSET_ID = { type: 'string', pattern: '^(?!0+$)(?:[a-f0-9]{32}|[a-f0-9]{64})$' };
const PROJECT_ID = { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Optional project containing digest asset IDs. Omit for shared library assets or the active project.' };
const IMAGE_OUTPUT_TOOLS = new Set(['generate_image', 'edit_image', 'create_image_variation']);
const MEDIA_OUTPUT_TOOLS = new Set([...IMAGE_OUTPUT_TOOLS, 'get_video', 'get_image_job', 'download_audio']);
const MEDIA_REFERENCE_TOOLS = Object.freeze([
  { type: 'function', function: {
    name: 'list_audio_generations', description: 'Read recent locally saved Suno receipts for this conversation, including stopped submissions and captured track UUIDs. This does not generate, poll or monitor a queue. Use the original model and attempt IDs; inspect/download captured tracks after shared-browser takeover.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  } },
  { type: 'function', function: {
    name: 'list_media_jobs', description: 'List saved media jobs and queue estimates. The host polls pending jobs across app restarts and notifies this conversation when ready. Do not spend the tool budget polling.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  } },
  { type: 'function', function: {
    name: 'forget_media_job', description: 'Ask the user to confirm removing a media job from the persistent monitor. This forgets its saved ID and stops polling; it does not cancel the server job or delete downloaded files. Retrieval requires the remote ID. Never assume confirmation.',
    parameters: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: { type: 'string', pattern: '^[a-f0-9]{32}$' } } },
  } },
  { type: 'function', function: {
    name: 'list_media_assets',
    description: 'List saved images, canvas screenshots, recordings and audio newest first, with timestamps and compact asset references. Use scope:"library" after native Codex generation, including when project attachment fails. Project scope includes only attached assets. Chats are independent of projects. No binary data is returned.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      scope: { type: 'string', enum: ['library', 'project'], default: 'library' },
      projectId: PROJECT_ID,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    } },
  } },
  { type: 'function', function: {
    name: 'inspect_media_asset',
    description: 'Inspect a saved reference. Images are provided to the model as a temporary visual observation. Use get_video_frames for a recorded video. Binary data is excluded from the saved tool result.',
    parameters: { type: 'object', additionalProperties: false, required: ['assetId'], properties: { assetId: ASSET_ID, projectId: PROJECT_ID } },
  } },
  { type: 'function', function: {
    name: 'delete_media_asset',
    description: 'Preview saved media and ask the user to confirm deletion. Project scope removes an unused attachment and preserves library/other project copies. Library scope deletes only the shared library copy. Referenced project assets cannot be removed. Cancel leaves all media unchanged. Never assume approval.',
    parameters: { type: 'object', additionalProperties: false, required: ['assetId'], properties: { assetId: ASSET_ID, projectId: PROJECT_ID, scope: { type: 'string', enum: ['project', 'library'], default: 'project' } } },
  } },
]);

function mediaToolSchema(tool) {
  const schema = tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false };
  if (AUDIO_TOOLS.has(tool.name)) {
    const properties = { ...schema.properties };
    if (properties.model) {
      const { default: defaultModel, ...model } = properties.model;
      properties.model = model;
    }
    // A receipt must retain the endpoint route even if the shared browser changes.
    const required = [...new Set([...(schema.required || []), 'model'])];
    if (tool.name === 'download_audio') delete properties.outputDirectory;
    return { ...schema, properties, required: required.filter((key) => key !== 'outputDirectory'), additionalProperties: false };
  }
  if (!['edit_image', 'create_image_variation', 'generate_video'].includes(tool.name)) return schema;
  const properties = { ...schema.properties, projectId: { ...PROJECT_ID, type: ['string', 'null'] } };
  const required = (schema.required || []).filter((key) => !['images', 'mask', 'image', 'inputReference', 'loraReference'].includes(key));
  delete properties.images;
  delete properties.mask;
  delete properties.image;
  delete properties.inputReference;
  delete properties.loraReference;
  if (tool.name === 'edit_image') {
    properties.imageAssetIds = { type: 'array', minItems: 1, maxItems: 16, items: ASSET_ID, description: 'Saved image IDs to upload as edit references (32 MiB combined). The host resolves their bytes. Use list_media_assets or a capture result.' };
    properties.maskAssetId = { ...ASSET_ID, description: 'Optional saved PNG mask. Transparent pixels identify regions to edit; it must match the first image dimensions.' };
    required.push('imageAssetIds');
  } else if (tool.name === 'create_image_variation') {
    properties.imageAssetId = { ...ASSET_ID, description: 'A saved image to upload for a variation. Model/endpoint support is required; DALL-E 2 requires a square PNG under 4 MiB.' };
    required.push('imageAssetId');
  } else {
    properties.inputReferenceAssetId = { ...ASSET_ID, type: ['string', 'null'], description: 'Optional saved PNG/JPEG/WebP reference. For text-only video OMIT this field or use null. Never use a placeholder or an all-zero ID. If the user requests a reference, copy a real ID from list_media_assets or a capture result.' };
    if (schema.properties?.loraReference) properties.loraReferenceAssetId = { ...ASSET_ID, type: ['string', 'null'], description: 'Saved Ingredients reference sheet; requires the ingredients LoRA and at least 5 seconds. The host uploads bytes. Do not omit required conditioning after a lookup failure.' };
    if (schema.properties?.guidingFrames) {
      const guide = schema.properties.guidingFrames;
      const { image, ...metadata } = guide.items.properties;
      properties.guidingFrames = { ...guide, description: 'One to eight saved image anchors, with unique pixel-frame indices at 24 FPS in 0..seconds*24. Incompatible with first-image/Ingredients modes. No paths, URLs or raw bytes.', items: { ...guide.items, additionalProperties: false,
        required: [...(guide.items.required || []).filter(key => key !== 'image'), 'assetId'], properties: { ...metadata, assetId: { ...ASSET_ID } } } };
    }

  }
  return { ...schema, properties, required, additionalProperties: false };
}

async function resolveMediaToolArguments(name, args, readAsset, signal) {
  if (!['edit_image', 'create_image_variation', 'generate_video'].includes(name)) return args;
  const { projectId, imageAssetIds, imageAssetId, maskAssetId, inputReferenceAssetId, loraReferenceAssetId, guidingFrames, ...wire } = args;
  let totalBytes = 0;
  function invalidReference(message) {
    const advancedReference = guidingFrames !== undefined || loraReferenceAssetId != null;
    const error = new Error(`${message} The media API was not called. Use list_media_assets to choose an existing image${advancedReference ? ' for the required guidingFrames or Ingredients reference; keep the requested conditioning' : name === 'generate_video' ? ', or omit inputReferenceAssetId/use null for text-only video' : ''}.`);
    Object.assign(error, { code: 'INVALID_MEDIA_REFERENCE', stage: 'reference_resolution', requestSent: false });
    throw error;
  }
  async function image(assetId, pngOnly = false) {
    signal?.throwIfAborted();
    if (typeof assetId !== 'string' || !new RegExp(ASSET_ID.pattern).test(assetId)) invalidReference('Copy an exact non-placeholder saved image asset ID.');
    let asset;
    try { asset = await readAsset({ assetId, projectId: projectId ?? undefined }); }
    catch (cause) {
      signal?.throwIfAborted();
      invalidReference(`Saved image reference ${assetId} could not be resolved locally: ${cause instanceof Error ? cause.message : String(cause)}.`);
    }
    signal?.throwIfAborted();
    if (!asset || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) || (pngOnly && asset.mimeType !== 'image/png')) invalidReference(pngOnly ? 'This reference must be a saved PNG image.' : 'Media references must be saved PNG, JPEG or WebP images.');
    if (typeof asset.data !== 'string' || !asset.data) invalidReference('Saved image reference is missing.');
    totalBytes += Buffer.byteLength(asset.data, 'base64');
    if (totalBytes > 32 * 1024 * 1024) invalidReference('Saved image references exceed 32 MiB combined.');
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[asset.mimeType];
    return { data: asset.data, mimeType: asset.mimeType, name: `${assetId}.${extension}` };
  }
  if (name === 'edit_image') {
    wire.images = [];
    for (const id of imageAssetIds) wire.images.push(await image(id));
    if (maskAssetId) wire.mask = await image(maskAssetId, true);
  } else if (name === 'create_image_variation') wire.image = await image(imageAssetId);
  else {
    if (Object.hasOwn(wire, 'inputReference') || Object.hasOwn(wire, 'loraReference')) invalidReference('In-app video tools accept saved asset IDs, not image upload objects.');
    if (guidingFrames !== undefined) {
      if (!Array.isArray(guidingFrames) || !guidingFrames.length || guidingFrames.length > 8) invalidReference('guidingFrames requires one to eight image anchors.');
      if (inputReferenceAssetId || loraReferenceAssetId || wire.loras?.some(lora => lora.id === 'ingredients')) invalidReference('guidingFrames cannot be combined with first-image or Ingredients references.');
      const seconds = wire.seconds ?? 4, indices = new Set();
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 12) invalidReference('guidingFrames requires 1-12 seconds.');
      for (const guide of guidingFrames) {
        if (!guide || typeof guide !== 'object' || Array.isArray(guide) || Object.keys(guide).some(key => !['assetId', 'frameIndex', 'strength'].includes(key)) ||
          !Number.isInteger(guide.frameIndex) || guide.frameIndex < 0 || guide.frameIndex > seconds * 24 || indices.has(guide.frameIndex) ||
          (guide.strength !== undefined && (typeof guide.strength !== 'number' || !Number.isFinite(guide.strength) || guide.strength < 0 || guide.strength > 1))) invalidReference('guidingFrames needs strict assetId/frameIndex/strength objects with unique in-range positions and finite strength 0-1.');
        if (typeof guide.assetId !== 'string' || !new RegExp(ASSET_ID.pattern).test(guide.assetId)) invalidReference('guidingFrames needs exact non-placeholder saved image IDs.');
        indices.add(guide.frameIndex);
      }
      wire.guidingFrames = [];
      for (const guide of guidingFrames) wire.guidingFrames.push({ image: await image(guide.assetId), frameIndex: guide.frameIndex, ...(guide.strength !== undefined ? { strength: guide.strength } : {}) });
    }
    if (inputReferenceAssetId) wire.inputReference = await image(inputReferenceAssetId);
    if (loraReferenceAssetId) wire.loraReference = await image(loraReferenceAssetId);
  }
  return wire;
}

module.exports = { IMAGE_OUTPUT_TOOLS, MEDIA_OUTPUT_TOOLS, MEDIA_REFERENCE_TOOLS, mediaToolSchema, resolveMediaToolArguments, resolveImageToolArguments: resolveMediaToolArguments };
