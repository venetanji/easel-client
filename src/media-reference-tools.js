const { imageDimensions } = require('./image-dimensions');
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
    description: 'Inspect a saved image as a temporary visual observation. For video use extract_video_frame or get_video_frames (recorder samples). Binary data is excluded from saved tool results.',
    parameters: { type: 'object', additionalProperties: false, required: ['assetId'], properties: { assetId: ASSET_ID, projectId: PROJECT_ID } },
  } },
  { type: 'function', function: {
    name: 'extract_video_frame',
    description: 'Decode one still from a managed MP4/WebM (generated, imported or recorded). Defaults to the final native video frame; timestampSeconds selects the frame at or before that source time. Saves a reusable JPEG in Media and provides one temporary image observation. Use returned assetId for inputReferenceAssetId, guidingFrames or H3 temporalGroups. For a sequence, extract successive source times and check returned timestamps before ordering IDs. Silent, offline; no generation or canvas reload. Unsupported codecs fail explicitly.',
    parameters: { type: 'object', additionalProperties: false, required: ['assetId'], properties: {
      assetId: ASSET_ID, projectId: PROJECT_ID,
      position: { type: 'string', enum: ['last'], description: 'Default: last. Omit when using timestampSeconds.' },
      timestampSeconds: { type: 'number', minimum: 0, maximum: 3600, description: 'Source-video seconds before the video track ends; exclusive with position.' },
      maxWidth: { type: 'integer', minimum: 320, maximum: 1920, default: 1600, description: 'Bounds both image dimensions, preserves aspect ratio and never enlarges.' },
    } },
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
  const required = (schema.required || []).filter((key) => !['images', 'mask', 'image', 'inputReference', 'loraReference', 'sourceAudio', 'semanticReferences'].includes(key));
  delete properties.images;
  delete properties.mask;
  delete properties.image;
  delete properties.inputReference;
  delete properties.loraReference;
  delete properties.sourceAudio;
  delete properties.semanticReferences;
  if (tool.name === 'edit_image') {
    properties.imageAssetIds = { type: 'array', minItems: 1, maxItems: 16, items: ASSET_ID, description: 'Saved image IDs to upload as edit references (32 MiB combined). The host resolves their bytes. Use list_media_assets or a capture result.' };
    properties.maskAssetId = { ...ASSET_ID, description: 'Optional saved PNG mask. Transparent pixels identify regions to edit; it must match the first image dimensions.' };
    required.push('imageAssetIds');
  } else if (tool.name === 'create_image_variation') {
    properties.imageAssetId = { ...ASSET_ID, description: 'A saved image to upload for a variation. Model/endpoint support is required; DALL-E 2 requires a square PNG under 4 MiB.' };
    required.push('imageAssetId');
  } else {
    if (schema.properties?.semanticReferences) properties.semanticReferenceAssetIds = { ...schema.properties.semanticReferences, items: { ...ASSET_ID }, description: 'H3 saved PNG/JPEG identity/content references in Picture order. The host checks current capabilities and uploads separate copies if an ID also appears in a temporal group.' };
    if (schema.properties?.temporalGroups) {
      const groups = schema.properties.temporalGroups;
      const { images, ...metadata } = groups.items.properties;
      properties.temporalGroups = { ...groups, description: 'H3 contiguous saved PNG/JPEG frame sequences. Each group starts at frameIndex on the output timeline; imageAssetIds are in source-time order. Read current capabilities for allowed group lengths, bounds and availability. No raw bytes, paths or URLs.',
        items: { ...groups.items, additionalProperties: false, required: [...(groups.items.required || []).filter(key => key !== 'images'), 'imageAssetIds'],
          properties: { ...metadata, imageAssetIds: { ...images, items: { ...ASSET_ID } } } } };
    }
    if (schema.properties?.sourceAudio) properties.sourceAudioAssetId = { ...ASSET_ID, type: ['string', 'null'], description: 'Saved WAV/MP3/M4A audio to condition video and supply its trimmed soundtrack. Requires live selected-model source_audio availability. Omit or use null without audio; never drop requested audio after a lookup failure.' };
    properties.inputReferenceAssetId = { ...ASSET_ID, type: ['string', 'null'], description: 'Optional saved PNG/JPEG/WebP first-image reference, uploaded unchanged. Read saved width/height and inspect_media_asset as needed; consult the selected model guide and capabilities input_reference fit/target/configurable metadata. Explain aspect mismatches and known effects or unknown geometry/fit before submission; preserve requested output dimensions and source framing. Fit metadata is descriptive, not a generation argument. For text-only video OMIT this field or use null. Never use a placeholder or all-zero ID; copy a real ID from list_media_assets or a capture result.' };
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

async function resolveMediaToolArguments(name, args, readAsset, signal, discoverCapabilities) {
  if (!['edit_image', 'create_image_variation', 'generate_video'].includes(name)) return args;
  const { projectId, imageAssetIds, imageAssetId, maskAssetId, inputReferenceAssetId, loraReferenceAssetId, sourceAudioAssetId, guidingFrames, semanticReferenceAssetIds, temporalGroups, ...wire } = args;
  let totalBytes = 0;
  let totalPixels = 0;
  let pixelLimits;
  let maxImageBytes = 32 * 1024 * 1024;
  let imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
  const h3References = semanticReferenceAssetIds !== undefined || temporalGroups !== undefined;
  function invalidReference(message) {
    const advancedReference = guidingFrames !== undefined || loraReferenceAssetId != null;
    const recovery = name === 'generate_video' && sourceAudioAssetId != null
      ? 'Use list_media_assets to resolve sourceAudioAssetId and every requested image reference, including inputReferenceAssetId, guidingFrames, temporalGroups, semanticReferenceAssetIds or loraReferenceAssetId. Preserve all requested conditioning and model timing; correct real asset IDs or report the limitation.'
      : h3References ? 'Use list_media_assets to resolve temporalGroups and semanticReferenceAssetIds; preserve all requested conditioning and timing or report the limitation.'
        : `Use list_media_assets to choose an existing image${advancedReference ? ' for the required guidingFrames or Ingredients reference; keep the requested conditioning' : name === 'generate_video' ? ', or omit inputReferenceAssetId/use null for text-only video' : ''}.`;
    const error = new Error(`${message} No generation request was sent. ${recovery}`);
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
    if (!asset || !imageMimeTypes.includes(asset.mimeType) || (pngOnly && asset.mimeType !== 'image/png')) invalidReference(pngOnly ? 'This reference must be a saved PNG image.' : `Media references must be saved images with MIME types: ${imageMimeTypes.join(', ')}.`);
    if (typeof asset.data !== 'string' || !asset.data) invalidReference('Saved image reference is missing.');
    totalBytes += Buffer.byteLength(asset.data, 'base64');
    if (totalBytes > maxImageBytes) invalidReference(maxImageBytes === 32 * 1024 * 1024 ? 'Saved image references exceed 32 MiB combined.' : 'Saved image references exceed the discovered combined byte limit.');
    if (pixelLimits) {
      // Inspect the uploaded bytes; saved metadata may be absent or stale.
      const { width, height } = imageDimensions(Buffer.from(asset.data, 'base64'), asset.mimeType);
      const pixels = width * height;
      if (!Number.isSafeInteger(pixels) || pixels <= 0) invalidReference('Saved image reference dimensions could not be determined.');
      if (pixels > pixelLimits.max_image_pixels) invalidReference('Saved image reference exceeds the discovered per-image pixel limit.');
      // Each occurrence is a separate multipart upload, including reused IDs.
      totalPixels += pixels;
      if (totalPixels > pixelLimits.max_total_pixels) invalidReference('Saved image references exceed the discovered combined pixel limit.');
    }
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[asset.mimeType];
    return { data: asset.data, mimeType: asset.mimeType, name: `${assetId}.${extension}` };
  }
  if (name === 'edit_image') {
    wire.images = [];
    for (const id of imageAssetIds) wire.images.push(await image(id));
    if (maskAssetId) wire.mask = await image(maskAssetId, true);
  } else if (name === 'create_image_variation') wire.image = await image(imageAssetId);
  else {
    if (['inputReference', 'loraReference', 'sourceAudio', 'semanticReferences'].some(key => Object.hasOwn(wire, key))) invalidReference('In-app video tools accept saved asset IDs, not image upload objects.');
    if (h3References) {
      const validIds = values => Array.isArray(values) && values.length > 0 && values.every(id => typeof id === 'string' && new RegExp(ASSET_ID.pattern).test(id));
      if (semanticReferenceAssetIds !== undefined && !validIds(semanticReferenceAssetIds)) invalidReference('semanticReferenceAssetIds needs a nonempty array of real saved image IDs.');
      if (temporalGroups !== undefined && (!Array.isArray(temporalGroups) || !temporalGroups.length || temporalGroups.some(group => !group || typeof group !== 'object' || Array.isArray(group)
        || Object.keys(group).some(key => !['frameIndex', 'imageAssetIds'].includes(key)) || !Number.isSafeInteger(group.frameIndex) || group.frameIndex < 0 || !validIds(group.imageAssetIds)))) invalidReference('temporalGroups needs strict frameIndex/imageAssetIds objects with ordered saved image IDs.');
      if (inputReferenceAssetId != null || loraReferenceAssetId != null || guidingFrames !== undefined || ['seconds', 'cameraLora', 'cameraLoraStrength', 'loras', 'motionSpeed', 'loraReferenceStrength'].some(key => wire[key] !== undefined)) invalidReference('H3 reference groups cannot combine with first-image or LTX controls.');
      signal?.throwIfAborted();
      if (typeof discoverCapabilities !== 'function') invalidReference('Current H3 capability discovery is unavailable.');
      let caps;
      try { caps = await discoverCapabilities(wire.model); }
      catch { signal?.throwIfAborted(); invalidReference('Could not discover the selected model capabilities.'); }
      signal?.throwIfAborted();
      const frame = caps?.frames, groups = caps?.temporal_groups, refs = caps?.semantic_references, uploads = caps?.uploads;
      const positive = value => Number.isSafeInteger(value) && value > 0;
      if (caps?.model !== 'minimax-h3' || caps.schema_version !== 1 || !frame || ![frame.min, frame.max, frame.default, frame.step].every(positive)
        || !Number.isSafeInteger(frame.offset) || frame.offset < 0 || !positive(groups?.max_count) || !Array.isArray(groups?.image_counts) || !groups.image_counts.length || !groups.image_counts.every(positive)
        || !positive(refs?.max_count) || !positive(uploads?.max_count) || !positive(uploads?.max_total_bytes) || !positive(uploads?.max_image_pixels) || !positive(uploads?.max_total_pixels) || !Array.isArray(uploads?.mime_types) || !uploads.mime_types.length
        || uploads.mime_types.some(type => !['image/png', 'image/jpeg'].includes(type))) invalidReference('The selected model does not advertise a usable H3 reference contract.');
      const profile = caps.profiles?.[temporalGroups ? 'temporal_ref20' : 'ref20'];
      if (profile?.supported !== true || profile.available !== true) invalidReference('The selected H3 reference profile is unavailable.');
      const frames = wire.frames ?? frame.default;
      if (!Number.isSafeInteger(frames) || frames < frame.min || frames > frame.max || (frames - frame.offset) % frame.step !== 0) invalidReference('frames must match the discovered H3 frame bounds and grid.');
      const constraints = caps.size_constraints;
      if (!Array.isArray(caps.size_presets) || !constraints) invalidReference('The selected model does not advertise a usable H3 size contract.');
      const requestedSize = wire.size || caps.default_size;
      if (typeof requestedSize !== 'string') invalidReference('H3 size requires a discovered default or explicit dimensions.');
      const normalizedSize = requestedSize.trim().toLowerCase();
      const size = Object.hasOwn(constraints.aliases || {}, normalizedSize) ? constraints.aliases[normalizedSize] : normalizedSize;
      const preset = caps.size_presets.find(entry => entry.size === size);
      if (preset) {
        if (!positive(preset.max_frames)) invalidReference('The selected model does not advertise a usable H3 size frame limit.');
        if (frames > preset.max_frames) invalidReference('frames exceed the discovered H3 size-specific frame limit.');
      } else {
        if (constraints.custom_sizes !== true || typeof size !== 'string' || !/^[0-9]{3,4}x[0-9]{3,4}$/.test(size)) invalidReference('H3 size must match a discovered preset or supported custom dimensions.');
        if (![constraints.min_dimension, constraints.max_dimension, constraints.dimension_multiple, constraints.max_pixels, constraints.max_pixel_frames].every(positive)) invalidReference('The selected model does not advertise a usable H3 custom-size contract.');
        const dimensions = size.split('x').map(Number);
        if (dimensions.some(value => value < constraints.min_dimension || value > constraints.max_dimension || value % constraints.dimension_multiple !== 0)) invalidReference('H3 size dimensions must match the discovered bounds and multiple.');
        const pixels = dimensions[0] * dimensions[1];
        if (pixels > constraints.max_pixels || frames > Math.floor(constraints.max_pixel_frames / pixels)) invalidReference('H3 size and frames exceed the discovered pixel or pixel-frame budget.');
      }
      if ((semanticReferenceAssetIds?.length || 0) > refs.max_count || (temporalGroups?.length || 0) > groups.max_count) invalidReference('H3 references exceed the discovered group limits.');
      const ordered = [...(temporalGroups || [])].sort((a, b) => a.frameIndex - b.frameIndex);
      for (const [index, group] of ordered.entries()) {
        if (!groups.image_counts.includes(group.imageAssetIds.length) || group.frameIndex + group.imageAssetIds.length > frames) invalidReference('Temporal group lengths and positions must fit discovered H3 limits.');
        const previous = ordered[index - 1];
        if (previous && previous.frameIndex + previous.imageAssetIds.length > group.frameIndex) invalidReference('H3 temporal groups must not overlap.');
      }
      if ((semanticReferenceAssetIds?.length || 0) + ordered.reduce((n, group) => n + group.imageAssetIds.length, 0) > uploads.max_count) invalidReference('H3 references exceed the discovered image count limit.');
      wire.frames = frames;
      maxImageBytes = Math.min(maxImageBytes, uploads.max_total_bytes);
      imageMimeTypes = uploads.mime_types;
      pixelLimits = uploads;
      if (semanticReferenceAssetIds) {
        wire.semanticReferences = [];
        for (const id of semanticReferenceAssetIds) wire.semanticReferences.push(await image(id));
      }
      if (temporalGroups) {
        wire.temporalGroups = [];
        for (const group of temporalGroups) {
          const images = [];
          for (const id of group.imageAssetIds) images.push(await image(id));
          wire.temporalGroups.push({ frameIndex: group.frameIndex, images });
        }
      }
    }
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
    if (sourceAudioAssetId != null) {
      signal?.throwIfAborted();
      if (typeof sourceAudioAssetId !== 'string' || !new RegExp(ASSET_ID.pattern).test(sourceAudioAssetId)) invalidReference('Copy an exact saved audio asset ID; preserve requested source audio.');
      let asset;
      try { asset = await readAsset({assetId:sourceAudioAssetId,projectId:projectId ?? undefined}); }
      catch { signal?.throwIfAborted(); invalidReference('Saved source audio is unavailable; preserve requested audio and select an available saved audio asset.'); }
      signal?.throwIfAborted();
      const extension = {'audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'m4a','audio/x-m4a':'m4a'}[asset?.mimeType];
      if (!extension || typeof asset.data !== 'string' || !asset.data || asset.data.length > Math.ceil(32*1024*1024/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data) || Buffer.from(asset.data,'base64').toString('base64') !== asset.data || Buffer.byteLength(asset.data,'base64') > 32*1024*1024) invalidReference('Source audio must be saved WAV/MP3/M4A with valid bytes, at most 32 MiB independently of images.');
      wire.sourceAudio = {data:asset.data,mimeType:asset.mimeType,name:`${sourceAudioAssetId}.${extension}`};
    }
    if (inputReferenceAssetId) wire.inputReference = await image(inputReferenceAssetId);
    if (loraReferenceAssetId) wire.loraReference = await image(loraReferenceAssetId);
  }
  return wire;
}

module.exports = { IMAGE_OUTPUT_TOOLS, MEDIA_OUTPUT_TOOLS, MEDIA_REFERENCE_TOOLS, mediaToolSchema, resolveMediaToolArguments, resolveImageToolArguments: resolveMediaToolArguments };
