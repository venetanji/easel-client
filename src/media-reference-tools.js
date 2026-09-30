const ASSET_ID = { type: 'string', pattern: '^(?:[a-f0-9]{32}|[a-f0-9]{64})$' };
const PROJECT_ID = { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Optional project containing digest asset IDs. Omit for shared library assets or the active project.' };
const IMAGE_OUTPUT_TOOLS = new Set(['generate_image', 'edit_image', 'create_image_variation']);
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
]);

function mediaToolSchema(tool) {
  const schema = tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false };
  if (!['edit_image', 'create_image_variation'].includes(tool.name)) return schema;
  const properties = { ...schema.properties, projectId: PROJECT_ID };
  const required = (schema.required || []).filter((key) => !['images', 'mask', 'image'].includes(key));
  delete properties.images;
  delete properties.mask;
  delete properties.image;
  if (tool.name === 'edit_image') {
    properties.imageAssetIds = { type: 'array', minItems: 1, maxItems: 16, items: ASSET_ID, description: 'Saved image IDs to upload as edit references (32 MiB combined). The host resolves their bytes. Use list_media_assets or a capture result.' };
    properties.maskAssetId = { ...ASSET_ID, description: 'Optional saved PNG mask. Transparent pixels identify regions to edit; it must match the first image dimensions.' };
    required.push('imageAssetIds');
  } else {
    properties.imageAssetId = { ...ASSET_ID, description: 'A saved image to upload for a variation. Model/endpoint support is required; DALL-E 2 requires a square PNG under 4 MiB.' };
    required.push('imageAssetId');
  }
  return { ...schema, properties, required, additionalProperties: false };
}

async function resolveImageToolArguments(name, args, readAsset, signal) {
  if (!['edit_image', 'create_image_variation'].includes(name)) return args;
  const { projectId, imageAssetIds, imageAssetId, maskAssetId, ...wire } = args;
  let totalBytes = 0;
  async function image(assetId, pngOnly = false) {
    signal?.throwIfAborted();
    const asset = await readAsset({ assetId, projectId });
    signal?.throwIfAborted();
    if (!asset || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) || (pngOnly && asset.mimeType !== 'image/png')) throw new Error(pngOnly ? 'This reference must be a saved PNG image.' : 'Edit references must be saved PNG, JPEG or WebP images.');
    if (typeof asset.data !== 'string' || !asset.data) throw new Error('Saved image reference is missing.');
    totalBytes += Buffer.byteLength(asset.data, 'base64');
    if (totalBytes > 32 * 1024 * 1024) throw new Error('Saved image references exceed 32 MiB combined.');
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[asset.mimeType];
    return { data: asset.data, mimeType: asset.mimeType, name: `${assetId}.${extension}` };
  }
  if (name === 'edit_image') {
    wire.images = [];
    for (const id of imageAssetIds) wire.images.push(await image(id));
    if (maskAssetId) wire.mask = await image(maskAssetId, true);
  } else wire.image = await image(imageAssetId);
  return wire;
}

module.exports = { IMAGE_OUTPUT_TOOLS, MEDIA_REFERENCE_TOOLS, mediaToolSchema, resolveImageToolArguments };
