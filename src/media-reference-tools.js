const ASSET_ID = { type: 'string', pattern: '^(?!0+$)(?:[a-f0-9]{32}|[a-f0-9]{64})$' };
const PROJECT_ID = { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Optional project containing digest asset IDs. Omit for shared library assets or the active project.' };
const IMAGE_OUTPUT_TOOLS = new Set(['generate_image', 'edit_image', 'create_image_variation']);
const MEDIA_OUTPUT_TOOLS = new Set([...IMAGE_OUTPUT_TOOLS, 'get_video']);
const MEDIA_REFERENCE_TOOLS = Object.freeze([
  { type: 'function', function: {
    name: 'list_media_assets',
    description: 'List saved images, canvas screenshots, recordings and audio as compact asset references. Chats are independent of projects. No binary data is returned.',
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
  if (!['edit_image', 'create_image_variation', 'generate_video'].includes(tool.name)) return schema;
  const properties = { ...schema.properties, projectId: { ...PROJECT_ID, type: ['string', 'null'] } };
  const required = (schema.required || []).filter((key) => !['images', 'mask', 'image'].includes(key));
  delete properties.images;
  delete properties.mask;
  delete properties.image;
  delete properties.inputReference;
  if (tool.name === 'edit_image') {
    properties.imageAssetIds = { type: 'array', minItems: 1, maxItems: 16, items: ASSET_ID, description: 'Saved image IDs to upload as edit references (32 MiB combined). The host resolves their bytes. Use list_media_assets or a capture result.' };
    properties.maskAssetId = { ...ASSET_ID, description: 'Optional saved PNG mask. Transparent pixels identify regions to edit; it must match the first image dimensions.' };
    required.push('imageAssetIds');
  } else if (tool.name === 'create_image_variation') {
    properties.imageAssetId = { ...ASSET_ID, description: 'A saved image to upload for a variation. Model/endpoint support is required; DALL-E 2 requires a square PNG under 4 MiB.' };
    required.push('imageAssetId');
  } else {
    properties.inputReferenceAssetId = { ...ASSET_ID, type: ['string', 'null'], description: 'Optional saved PNG/JPEG/WebP reference. For text-only video OMIT this field or use null. Never use a placeholder or an all-zero ID. If the user requests a reference, copy a real ID from list_media_assets or a capture result.' };
  }
  return { ...schema, properties, required, additionalProperties: false };
}

async function resolveMediaToolArguments(name, args, readAsset, signal) {
  if (!['edit_image', 'create_image_variation', 'generate_video'].includes(name)) return args;
  const { projectId, imageAssetIds, imageAssetId, maskAssetId, inputReferenceAssetId, ...wire } = args;
  let totalBytes = 0;
  function invalidReference(message) {
    const error = new Error(`${message} The media API was not called. Use list_media_assets to choose an existing image${name === 'generate_video' ? ', or omit inputReferenceAssetId/use null for text-only video' : ''}.`);
    Object.assign(error, { code: 'INVALID_MEDIA_REFERENCE', stage: 'reference_resolution', requestSent: false });
    throw error;
  }
  async function image(assetId, pngOnly = false) {
    signal?.throwIfAborted();
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
  else if (inputReferenceAssetId) wire.inputReference = await image(inputReferenceAssetId);
  return wire;
}

module.exports = { IMAGE_OUTPUT_TOOLS, MEDIA_OUTPUT_TOOLS, MEDIA_REFERENCE_TOOLS, mediaToolSchema, resolveMediaToolArguments, resolveImageToolArguments: resolveMediaToolArguments };
