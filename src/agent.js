const { TIMELINE_TOOLS, TIMELINE_METHODS } = require('./video-timeline-tools');
const { ALLOWED_MEDIA_TOOLS } = require('./media-mcp-client');
const { PROJECT_CANVAS_TOOLS, SOURCE_CANVAS_TOOLS } = require('./canvas-tools');
const { CANVAS_INPUT_TOOLS } = require('./canvas-input-tools');
const { canvasInputSummary, validateCanvasInputRequest } = require('./canvas-input');
const crypto = require('node:crypto');
const { awaitAbortable, isTurnAbort, throwIfAborted } = require('./turn-abort');
const { MEDIA_OUTPUT_TOOLS, MEDIA_REFERENCE_TOOLS, mediaToolSchema, resolveMediaToolArguments } = require('./media-reference-tools');

const MAX_TOOL_CALLS = 12;
const MAX_CANVAS_HTML_BYTES = 1_048_576;
const MAX_CANVAS_ASSETS = 8;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SAVED_MEDIA_TYPES = new Set([...IMAGE_TYPES, 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg']);
const ALLOWED_RUNTIME_KITS = new Set(['canvas-2d', 'html-deck', 'three', 'phaser', 'matter', 'tone', 'p5']);
const PROJECT_CANVAS_METHODS = Object.freeze({
  list_canvas_documents: 'listCanvasDocuments',
  open_canvas_document: 'openCanvasDocument',
  create_canvas_document: 'createCanvasDocument',
  list_canvas_files: 'listCanvasFiles',
  read_canvas_file: 'readCanvasFile',
  write_canvas_file: 'writeCanvasFile',
  patch_canvas_file: 'patchCanvasFile',
  apply_canvas_file_patches: 'applyCanvasFilePatches',
  delete_canvas_file: 'deleteCanvasFile',
  update_canvas_project: 'updateCanvasProject',
  attach_canvas_asset: 'attachCanvasAsset',
  attach_canvas_assets: 'attachCanvasAssets',
  get_canvas_state: 'getCanvasState',
  set_canvas_state: 'setCanvasState',
});
const RUNTIME_KIT_GUIDANCE = Object.freeze({
  'canvas-2d': 'HTML + Canvas 2D: use the built-in CanvasRenderingContext2D API for responsive drawing, animation, image composition, and 2D interactions.',
  'html-deck': 'HTML presentations: build one accessible slide per section, with keyboard navigation, progress, and responsive layouts using HTML, CSS, and JavaScript.',
  three: 'Three.js: the offline THREE global is bundled into new canvases. Use it for 3D scenes, materials, cameras, and animation without external URLs.',
  phaser: 'Phaser: the offline Phaser global is bundled into new canvases. Use it for structured 2D game scenes, input, sprites, and arcade physics.',
  matter: 'Matter.js: the offline Matter global is bundled into new canvases. Use it for rigid-body physics and connect its engine loop to a responsive canvas.',
  tone: 'Tone.js: the offline Tone global is bundled into new canvases with a timer clock (workers are blocked). Use it for synthesis and sequencing. Custom Tone.Context instances must use clockSource:"timeout". Add visible Play and Stop controls, call await Tone.start() inside the Play click handler, then start the synth or sequence. Never start audio automatically during page load.',
  p5: 'p5.js: use the offline p5 global in instance mode (new p5(sketch, root)). Give the mount a definite height before measuring it; in a bounded flex/grid layout use min-height:0 so a generated canvas cannot grow its parent on every resize. Resize from the mount bounds, use the p5 draw loop only, and call instance.remove() in registered disposal. p5.sound is not included; use the enabled Tone.js kit for audio.',
});
const SYSTEM_PROMPT = require('./harness-instructions').BUILTIN_INSTRUCTIONS;

const PRESENT_CANVAS_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'present_canvas',
    description: 'Create and open a complete new HTML document inside the active project. Existing documents are preserved. Inherits enabled project kits; does not enable additional libraries. Use local kit globals, never CDN scripts. No preceding create_canvas call is needed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['html'],
      properties: {
        title: { type: 'string', maxLength: 120 },
        path: { type: 'string', maxLength: 180, description: 'Optional new relative HTML document path, unique within the active project.' },
        html: { type: 'string', maxLength: MAX_CANVAS_HTML_BYTES },
        assets: {
          type: 'array',
          maxItems: MAX_CANVAS_ASSETS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'assetId'],
            properties: {
              name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
              assetId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
            },
          },
        },
      },
    },
  },
});

const CANVAS_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'create_canvas',
      description: 'Add and open a named empty HTML canvas in the active project. Creates a project if none is selected. Existing project kits, files and media are shared; this does not enable another kit. For a complete new sketch use present_canvas directly.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: { title: { type: 'string', minLength: 1, maxLength: 120 } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_canvas',
      description: 'Inspect the actual open canvas: text/images, canvas bounds and counts, registered renderer/scene/camera, animation/audio state, scoped error logs, sandbox capabilities and persistence contract.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_canvas_javascript',
      description: 'Run up to 16 KiB of JavaScript as an async function body in the isolated open canvas. Supports await and return. Use return to report a result and window properties for state shared between calls.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: { code: { type: 'string', minLength: 1, maxLength: 16_384 } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_image_to_canvas',
      description: 'Explicitly place a saved or attached image into the open HTML document using its asset ID. Shared library IDs are 32 hex; attached project digest IDs may be 64 hex. Use only when the user requests image placement.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['assetId'],
        properties: {
          assetId: { type: 'string', pattern: '^(?:[a-f0-9]{32}|[a-f0-9]{64})$' },
          alt: { type: 'string', maxLength: 240 },
          maxWidth: { type: 'integer', minimum: 10, maximum: 100 },
        },
      },
    },
  },
  ...SOURCE_CANVAS_TOOLS,
  ...PROJECT_CANVAS_TOOLS,
  ...CANVAS_INPUT_TOOLS,
]);

function parseArguments(value) {
  let args;
  try {
    args = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('Invalid tool arguments: expected JSON.');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Invalid tool arguments: expected an object.');
  }
  return args;
}

function normalizeCanvasAssetReferences(html, assets) {
  const assetNames = new Map((Array.isArray(assets) ? assets : [])
    .filter((asset) => asset && typeof asset.assetId === 'string' && typeof asset.name === 'string')
    .map((asset) => [asset.assetId.toLowerCase(), asset.name]));
  if (/asset:\/\/(?![a-f0-9]{32}(?![a-f0-9]))/i.test(html)) {
    throw new Error('Canvas asset references must use a complete 32-character asset ID.');
  }
  return html.replace(/asset:\/\/([a-f0-9]{32})/gi, (match, rawAssetId) => {
    const assetId = rawAssetId.toLowerCase();
    const name = assetNames.get(assetId);
    if (!name) throw new Error('Canvas image asset must be attached through the canvas assets list.');
    return `{{asset:${name}}}`;
  });
}

function validateToolArguments(value, schema, label = 'arguments', depth = 0) {
  if (!schema || depth > 32) return;
  const invalid = (message) => { const error = new Error(message); error.code = 'INVALID_TOOL_ARGUMENTS'; throw error; };
  if (Array.isArray(schema.type)) {
    for (const type of schema.type) {
      try { validateToolArguments(value, { ...schema, type }, label, depth + 1); return; }
      catch (error) { if (error.code !== 'INVALID_TOOL_ARGUMENTS') throw error; }
    }
    invalid(`${label} must be a valid ${schema.type.join(' or ')}.`);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) invalid(`${label}.${key} is required.`);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false) invalid(`${label}.${key} is unsupported.`);
        continue;
      }
      validateToolArguments(child, schema.properties[key], `${label}.${key}`, depth + 1);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) invalid(`${label} must be an array.`);
    if (schema.minItems !== undefined && value.length < schema.minItems) invalid(`${label} needs at least ${schema.minItems} items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) invalid(`${label} supports at most ${schema.maxItems} items.`);
    for (const item of value) validateToolArguments(item, schema.items, `${label}[]`, depth + 1);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') invalid(`${label} must be a string.`);
    if (schema.minLength !== undefined && value.length < schema.minLength) invalid(`${label} needs at least ${schema.minLength} characters.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) invalid(`${label} supports at most ${schema.maxLength} characters.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid(`${label} must match ${schema.pattern}.`);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) invalid(`${label} must be ${schema.type === 'integer' ? 'an integer' : 'a finite number'}.`);
    if (schema.minimum !== undefined && value < schema.minimum) invalid(`${label} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) invalid(`${label} must be at most ${schema.maximum}.`);
  } else if (schema.type === 'null' && value !== null) invalid(`${label} must be null.`);
  else if (schema.type === 'boolean' && typeof value !== 'boolean') invalid(`${label} must be a boolean.`);
  if (schema.enum && !schema.enum.includes(value)) invalid(`${label} must be one of: ${schema.enum.join(', ')}.`);
}

function argumentExample(schema, key = '', depth = 0) {
  if (depth > 4) return {};
  if (schema?.default !== undefined) return schema.default;
  if (schema?.enum?.length) return schema.enum[0];
  if (key === 'options') return [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
  if (schema?.type === 'object') return Object.fromEntries((schema.required || []).map((name) => [name, argumentExample(schema.properties?.[name], name, depth + 1)]));
  if (schema?.type === 'array') return [argumentExample(schema.items, key, depth + 1)];
  if (schema?.type === 'integer' || schema?.type === 'number') return Math.max(schema.minimum || 0, 1);
  if (schema?.type === 'boolean') return false;
  const examples = { path: 'index.html', directory: '', html: '<!doctype html><html><head></head><body></body></html>', title: 'Canvas', question: 'Which option do you prefer?', name: 'texture', assetId: 'ASSET_ID_FROM_TOOL_RESULT', model: 'MODEL_ID_FROM_list_models', code: 'return window.EaselCanvas?.inspect();', find: 'exact unique text from the source read', replace: 'updated text', prompt: 'Describe what to create.', content: 'File contents' };
  return examples[key] ?? (schema?.type === 'string' ? `<${key}>` : {});
}

function isOfflineReferenceFailure(error) {
  return /Only relative local project references are supported:\s*(?:https?:|\/\/)|(?:external URLs|external script URLs)/i.test(error);
}

function toolCorrection(name, descriptor, error, code) {
  const schema = descriptor?.function?.parameters;
  if (name === 'generate_video' && validationFailure(error, code, name) && /guidingFrames|loraReference|Ingredients/i.test(error)) return {
    correction: 'This advanced reference failed locally before the video API was called. Use list_media_assets to copy real saved image IDs into guidingFrames or loraReferenceAssetId for Ingredients. Keep the requested conditioning; fix missing assets, positions, strengths or incompatible modes instead of silently changing the generation recipe.',
    exampleNote: 'Guides need unique frameIndex values in 0..seconds*24 and strength 0-1. Ingredients requires its LoRA, a reference sheet and at least 5 seconds. Check discover_video_capabilities and list_video_loras before an advanced retry.',
  };
  if (name === 'generate_video' && validationFailure(error, code, name) && /reference|inputReferenceAssetId|projectId/i.test(error)) return {
    correction: 'This reference failed locally before the video API was called. For text-only video, omit inputReferenceAssetId or set it to null; omit projectId too unless resolving a real project image. Never invent IDs or use all-zero placeholders. Corrected arguments may be retried.',
    example: { model: schema?.properties?.model?.enum?.[0] || 'MODEL_ID_FROM_list_models', prompt: 'A cat blinking in warm morning light.', seconds: 4 },
    exampleNote: 'Use an enabled video model ID. Reference images are optional; this example generates from text only.',
  };
  if (isOfflineReferenceFailure(error) && (name === 'present_canvas' || PROJECT_CANVAS_TOOLS.some((tool) => tool.function.name === name))) return {
    correction: 'The canvas runs offline. Remove external script/link/import URLs. Use the bundled library global without a CDN script. If p5, Three.js, Tone.js or another required kit is missing, ask the user to enable it under Project files > Canvas kits, then wait for confirmation before continuing. Images must use attached media references. Relative script/link paths refer only to authored project files.',
    exampleNote: 'Enabled kits are reported in creation receipts and list_canvas_files. Do not claim a kit is enabled or retry the same URL.',
  };
  if (name === 'present_canvas' && /document path already exists|dependency conflicts with an existing file/i.test(error)) return {
    correction: 'present_canvas creates a NEW document. Choose an unused path or omit path to allocate one automatically. To fill an empty document already returned by create_canvas, use write_canvas_file on that documentPath instead; do not create it again. The existing files are preserved.',
    example: { html: '<!doctype html><html><head><title>New sketch</title></head><body></body></html>', title: 'New sketch' },
    alternate: { tool: 'write_canvas_file' },
    exampleNote: 'For an existing document, use its returned documentPath and revision.',
  };
  if (name === 'present_canvas' && /asset|assets|image references?/i.test(error)) return {
    correction: "Use assets:[{name:'texture',assetId:'...'}]. Replace ... with a complete 32-character asset ID returned by an image tool; use that same asset://ID in HTML. Assets must be an array of these objects, without image data or keys named after assets.",
    example: { html: '<!doctype html><html><head></head><body><img src="asset://ASSET_ID_FROM_TOOL_RESULT"></body></html>', assets: [{ name: 'texture', assetId: 'ASSET_ID_FROM_TOOL_RESULT' }] },
    exampleNote: 'Replace ASSET_ID_FROM_TOOL_RESULT with a real ID returned by a tool. For a canvas without images, omit assets.',
  };
  if (name === 'get_canvas_source' || name === 'apply_canvas_patch') return {
    correction: 'index is allowed only with section:scripts or section:styles. Omit index for app, head and body. Prefer list_canvas_files followed by read_canvas_file for a specific project file; use returned revisions and exact source text for patches.',
    example: name === 'get_canvas_source' ? { section: 'body', origin: 'stored', maxBytes: 12000 } : { section: 'body', find: 'exact unique text from the source read', replace: 'updated text', reload: false },
    alternate: { tool: 'list_canvas_files', arguments: {} },
  };
  if (ALLOWED_MEDIA_TOOLS.has(name) && !validationFailure(error, code, name)) return {
    correction: 'Read the endpoint/media error and check credentials, enabled model capabilities and endpoint availability. Do not treat authentication, provider or generation failures as malformed canvas arguments. Avoid repeating an unchanged billed generation.',
    example: schema ? argumentExample(schema) : {},
    exampleNote: 'The example describes argument structure; use an actual model ID from list_models. It does not establish endpoint availability.',
  };
  return {
    correction: `${error.startsWith('Invalid tool arguments:') ? 'Supply one valid JSON object. ' : ''}Use the declared fields and types${schema?.required?.length ? `; required: ${schema.required.join(', ')}` : ''}. Read or inspect the relevant canvas before correcting a failed operation.`,
    example: schema ? argumentExample(schema) : {},
    ...(schema ? { required: schema.required || [], allowedFields: Object.keys(schema.properties || {}) } : { alternate: { tool: 'list_canvas_files', arguments: {} } }),
    exampleNote: 'Examples show argument structure; use real saved asset IDs, model IDs and revisions from tool responses.',
  };
}

function argumentFingerprint(name, value) {
  const normalize = (input, depth = 0) => {
    if (depth > 64) throw new Error('Tool arguments are nested too deeply.');
    if (Array.isArray(input)) return input.map((item) => normalize(item, depth + 1));
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key], depth + 1)]));
    return input;
  };
  let canonical;
  try { canonical = JSON.stringify(normalize(typeof value === 'string' ? JSON.parse(value) : value)); }
  catch { canonical = typeof value === 'string' ? value.trim() : String(value); }
  return `${name}:${crypto.createHash('sha256').update(canonical || '').digest('hex')}`;
}

function validationFailure(message, code, name) {
  if (['INVALID_TOOL_ARGUMENTS', 'INVALID_MEDIA_REFERENCE'].includes(code) || /^Invalid tool arguments:|^arguments(?:\.| must)/i.test(message)) return true;
  if (ALLOWED_MEDIA_TOOLS.has(name)) return false;
  return /^(?:Omit index for section|Use a non-negative index only|Source (?:section|offset|output) |includeAssets |Patch requires |Each patch text |Canvas (?:HTML|title|name|asset name|asset ID|asset references|JavaScript is required|input|choice|source file|state) |Project paths? |Unsupported project source file extension|File patch needs|Asset path must)/i.test(message);
}

function toOpenAITools(mcpTools) {
  const tools = mcpTools
    .filter((tool) => ALLOWED_MEDIA_TOOLS.has(tool.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.name === 'edit_image' ? 'Edit saved image references through an enabled Media model. Supply imageAssetIds and optional PNG maskAssetId; the host uploads the image bytes. Endpoint/model support is required.' : tool.name === 'create_image_variation' ? 'Create variations of one saved imageAssetId through an enabled Media model. The host uploads the reference; endpoint/model support is required.' : tool.description || '',
        parameters: mediaToolSchema(tool),
      },
    }));
  return [...tools, PRESENT_CANVAS_TOOL, ...CANVAS_TOOLS, ...MEDIA_REFERENCE_TOOLS, ...TIMELINE_TOOLS];
}

function formatSkillInstructions(skills) {
  if (!Array.isArray(skills)) return '';
  let remaining = 48_000;
  const sections = [];
  for (const skill of skills.slice(0, 8)) {
    const name = typeof skill?.name === 'string' ? skill.name.trim().slice(0, 80) : '';
    const instructions = typeof skill?.instructions === 'string' ? skill.instructions.trim() : '';
    if (!name || !instructions || remaining <= 0) continue;
    const content = instructions.slice(0, Math.min(32_000, remaining));
    remaining -= content.length;
    sections.push(`### ${name}\n${content}`);
  }
  return sections.length ? `USER-ADDED CREATIVE SKILLS\n${sections.join('\n\n')}` : '';
}

function formatRuntimeKitInstructions(kits) {
  if (!Array.isArray(kits)) return '';
  const selected = [...new Set(kits.filter((kit) => Object.hasOwn(RUNTIME_KIT_GUIDANCE, kit)))];
  if (!selected.length) return '';
  return `ACTIVE OFFLINE CANVAS KITS\n${selected.map((kit) => `- ${RUNTIME_KIT_GUIDANCE[kit]}`).join('\n')}`;
}

function buildUserContent(requestText, attachments) {
  const content = [{ type: 'text', text: requestText }];
  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      content.push({ type: 'text', text: `Attached image: ${attachment.name}` });
      content.push({ type: 'image', name: attachment.name, mimeType: attachment.mimeType, data: attachment.data });
    } else if (attachment.type === 'audio') {
      content.push({ type: 'text', text: `Attached audio: ${attachment.name}` });
      content.push({ type: 'audio', name: attachment.name, mimeType: attachment.mimeType, data: attachment.data });
    } else if (attachment.type === 'video') {
      content.push({ type: 'text', text: `Attached video: ${attachment.name}. It is represented by sampled still frames; the original audio track is not included.` });
      for (const frame of attachment.frames) {
        content.push({ type: 'text', text: `Video frame at ${frame.timestamp.toFixed(2)} seconds.` });
        content.push({ type: 'image', name: attachment.name, mimeType: 'image/jpeg', data: frame.data });
      }
    } else {
      throw new Error('Media attachment type is unsupported.');
    }
  }
  return content;
}

async function resolveCanvasAssets(assetStore, assets = [], signal) {
  if (!Array.isArray(assets) || assets.length > MAX_CANVAS_ASSETS) {
    throw new Error(`Canvas supports at most ${MAX_CANVAS_ASSETS} image assets.`);
  }
  const names = new Set();
  const output = [];
  for (const asset of assets) {
    throwIfAborted(signal);
    if (!asset || typeof asset.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(asset.name)) {
      throw new Error('Canvas asset name is invalid.');
    }
    if (names.has(asset.name)) throw new Error('Canvas asset names must be unique.');
    names.add(asset.name);
    if (typeof asset.assetId !== 'string' || !asset.assetId.trim() || asset.assetId.length > 128) {
      throw new Error('Canvas asset ID is invalid.');
    }
    const saved = await assetStore.get(asset.assetId);
    throwIfAborted(signal);
    if (!saved || !IMAGE_TYPES.has(saved.mimeType) || typeof saved.data !== 'string') {
      throw new Error('Canvas asset could not be loaded.');
    }
    output.push({ name: asset.name, assetId: asset.assetId, data: saved.data, mimeType: saved.mimeType });
  }
  return output;
}

async function handleMcpResult(result, mediaAssetStore, onEvent, { generated = false, projectId = '', kits = [], attachGeneratedAssets } = {}) {
  if (result?.isError) {
    const detail = (result.content || []).filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n').slice(0, 2000);
    const error = new Error(detail || 'Media MCP tool failed.');
    const validation = result.structuredContent;
    if (validation?.code === 'INVALID_TOOL_ARGUMENTS' && validation.stage === 'argument_validation' && validation.requestSent === false) {
      Object.assign(error, { code: validation.code, stage: validation.stage, requestSent: false });
    }
    throw error;
  }
  const text = Array.isArray(result?.structuredContent?.text) ? result.structuredContent.text.filter((value) => typeof value === 'string') : [];
  const assets = Array.isArray(result?.structuredContent?.assets) ? result.structuredContent.assets : [];
  const savedMedia = [];
  const saveErrors = [];
  const job = result?.structuredContent?.job;
  for (const item of result?.content || []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      let metadata;
      try { metadata = JSON.parse(item.text); } catch { /* Preserve ordinary provider notes. */ }
      // Job metadata already has a typed field; provider polling prose is for standalone clients.
      if (!job || metadata?.job?.id !== job.id) text.push(item.text);
    }
    const media = ['image', 'audio'].includes(item.type) ? { data: item.data, mimeType: item.mimeType }
      : item.type === 'resource' ? { data: item.resource?.blob, mimeType: item.resource?.mimeType } : null;
    if (media && typeof media.data === 'string' && SAVED_MEDIA_TYPES.has(media.mimeType)) {
      try {
        const image = IMAGE_TYPES.has(media.mimeType);
        const name = image ? undefined : `Generated ${media.mimeType.startsWith('video/') ? 'video' : 'audio'}.${{ 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' }[media.mimeType]}`;
        const metadata = { ...(name ? { name } : {}), ...(job?.seconds ? { duration: job.seconds } : {}) };
        const assetId = await mediaAssetStore.save({ ...media, ...metadata });
        const asset = { assetId, mimeType: media.mimeType, ...metadata };
        assets.push(asset);
        savedMedia.push({ ...asset, data: media.data });
      } catch (error) {
        saveErrors.push(String(error.message).slice(0, 500));
        onEvent?.({ type: 'error', message: `Media was returned, but could not be saved locally: ${error.message}` });
      }
    }
  }
  let attachment = result?.structuredContent?.projectAttachment;
  if (!attachment && generated && assets.length && typeof attachGeneratedAssets === 'function') {
    try { attachment = { ok: true, ...await attachGeneratedAssets({ projectId, assetIds: assets.map((asset) => asset.assetId), kits }) }; }
    catch (error) { attachment = { ok: false, projectId, error: error.message }; onEvent?.({ type: 'error', message: `Media was generated and saved in the library, but could not be attached to the project: ${error.message}` }); }
  }
  for (const media of savedMedia) {
    onEvent?.({ type: IMAGE_TYPES.has(media.mimeType) ? 'image' : 'media', ...media, generated, projectId: attachment?.projectId || projectId, projectTitle: attachment?.projectTitle, attachedToProject: Boolean(attachment?.ok), ...(attachment?.error ? { attachmentError: attachment.error } : {}) });
  }
  return JSON.stringify({ text, assets, ...(job ? { job } : {}), ...(job?.status === 'failed' || job?.status === 'cancelled' ? { ok: false, error: job.error || `Video job ${job.id} ${job.status}.`, code: 'VIDEO_JOB_FAILED' } : {}), ...(attachment ? { projectAttachment: attachment } : {}), ...(saveErrors.length ? { saveErrors, guidance: 'Some returned media could not be saved locally. Preserve successful asset IDs and video job IDs; resolve the storage error before generating replacements.' } : {}) });
}

async function cachedVideoResult(messages, args, mediaAssetStore) {
  if (args.download === false) return null;
  for (const message of [...messages].reverse()) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    let result;
    try { result = JSON.parse(message.content); } catch { continue; }
    if (result.job?.id !== args.videoId || result.job?.modelId !== args.model || result.job?.status !== 'completed' || !result.assets?.length) continue;
    try {
      for (const asset of result.assets) await mediaAssetStore.get(asset.assetId);
      return JSON.stringify({ job: result.job, assets: result.assets, cached: true, message: 'This completed video is already saved in the library. Use attach_canvas_assets to attach it to another project.' });
    } catch { return null; }
  }
  return null;
}

async function executeEaselTool(name, args, {
  canvasController, presentCanvas, assetStore, mediaAssetStore = assetStore,
  mcp, kits = [], onEvent, registerMediaJob, signal, messages = [], context = {},
} = {}) {
  let content;
  let awaitingCanvasInput;
  let awaitingMediaJob;
  const liveCaptures = [];
  throwIfAborted(signal);
  if (Object.hasOwn(TIMELINE_METHODS, name)) {
    const method = TIMELINE_METHODS[name];
    if (typeof canvasController?.[method] !== 'function') throw new Error('Timeline editing is unavailable in this app version.');
    if (context.turnOptions?.timelineSelection && args.projectId !== context.turnOptions.timelineSelection.projectId) throw new Error('The timeline edit must target the project selected for this turn.');
    content = JSON.stringify(await canvasController[method](args, context));
  } else if (name === 'request_canvas_input' || name === 'get_canvas_inputs') {
    try {
      if (!canvasController) throw new Error('Canvas input is unavailable.');
      if (name === 'request_canvas_input') {
        if (typeof canvasController.requestCanvasInput !== 'function') throw new Error('Canvas input is unavailable in this app version.');
        const request = await canvasController.requestCanvasInput(validateCanvasInputRequest(args), context);
        awaitingCanvasInput = request;
        content = JSON.stringify({ ok: true, request: canvasInputSummary(request), waiting: true, message: context.origin?.backend === 'external'
          ? 'End this turn. The click is saved to get_canvas_inputs and get_control_events. MCP resource notifications announce new events; your controller decides when to continue. Automatic conversation wakeup is not guaranteed. Do not poll.'
          : 'The turn ends now. The user click is saved and resumes this same conversation automatically. Do not poll.', effects: { source: 'unchanged; choice overlay is temporary', runtime: 'choice overlay shown', persistence: 'request and submitted answer are stored locally' } });
      } else {
        if (typeof canvasController.getCanvasInputs !== 'function') throw new Error('Canvas input history is unavailable.');
        content = JSON.stringify({ ok: true, ...await canvasController.getCanvasInputs(args, context) });
      }
    } catch (error) {
      content = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Canvas input failed.' });
    }
  } else if (name === 'create_canvas') {
    if (!canvasController || typeof canvasController.createEmpty !== 'function') {
      throw new Error('Canvas creation is unavailable.');
    }
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.trim().length > 120) {
      throw new Error('Canvas name is required and must be at most 120 characters.');
    }
    const selectedKits = [...new Set(Array.isArray(kits) ? kits.filter((kit) => ALLOWED_RUNTIME_KITS.has(kit)) : [])];
    const created = await canvasController.createEmpty(args.title.trim(), selectedKits);
    onEvent?.({ type: 'canvas', title: created.title, canvasId: created.id, projectId: created.id, projectTitle: created.projectTitle || created.title, documentPath: created.documentPath, documentTitle: created.documentTitle });
    const enabledKits = Array.isArray(created.kits) ? created.kits : selectedKits;
    content = JSON.stringify({ ok: true, message: 'HTML canvas created and opened in the project.', projectId: created.id, canvasId: created.id, title: created.title, documentPath: created.documentPath, documentTitle: created.documentTitle, kits: enabledKits,
      kitGuidance: 'Use only these enabled kit globals. If a required kit is missing, ask the user to enable it under Project files > Canvas kits before continuing. Do not add CDN scripts.' });
  } else if (name === 'present_canvas') {
    try {
      const html = args.html;
      if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html, 'utf8') > MAX_CANVAS_HTML_BYTES) {
        throw new Error('Canvas HTML is required and must be at most 1 MiB.');
      }
      if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 120)) {
        throw new Error('Canvas title is invalid.');
      }
      const sourceAssets = args.assets || [];
      const canvasHtml = normalizeCanvasAssetReferences(html, sourceAssets);
      const assets = await resolveCanvasAssets(assetStore, sourceAssets, signal);
      throwIfAborted(signal);
      const selectedKits = [...new Set(Array.isArray(kits) ? kits.filter((kit) => ALLOWED_RUNTIME_KITS.has(kit)) : [])];
      const saved = await presentCanvas({ html: canvasHtml, title: args.title || 'Easel Canvas', ...(args.path ? { path: args.path } : {}), assets, kits: selectedKits });
      onEvent?.({ type: 'canvas', title: saved?.title || args.title || 'Easel Canvas', canvasId: saved?.id || '', projectId: saved?.id || '', projectTitle: saved?.projectTitle || saved?.title, documentPath: saved?.documentPath, documentTitle: saved?.documentTitle });
      content = JSON.stringify({ ok: true, message: 'Project document saved and opened. Inline scripts and styles may be extracted; use the returned file paths and revisions for edits.', projectId: saved?.id || '', canvasId: saved?.id || '', documentPath: saved?.documentPath, documentTitle: saved?.documentTitle, files: saved?.files, projectRevision: saved?.projectRevision, kits: Array.isArray(saved?.kits) ? saved.kits : selectedKits });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Canvas could not be opened.';
      content = JSON.stringify({
        ok: false,
        error: message,
        guidance: toolCorrection(name, PRESENT_CANVAS_TOOL, message).correction,
      });
    }
  } else if (name === 'inspect_canvas') {
    if (!canvasController) throw new Error('Canvas controls are unavailable.');
    content = await canvasController.inspect();
  } else if (name === 'list_media_jobs' || name === 'forget_media_job') {
    const method = name === 'list_media_jobs' ? 'listMediaJobs' : 'forgetMediaJob';
    if (typeof canvasController?.[method] !== 'function') throw new Error('Media job monitor is unavailable.');
    content = JSON.stringify(await canvasController[method](args, { signal }));
  } else if (name === 'list_media_assets') {
    if (typeof canvasController?.listMediaAssets !== 'function') throw new Error('Saved media browsing is unavailable.');
    content = JSON.stringify({ ok: true, ...await canvasController.listMediaAssets(args) });
  } else if (name === 'delete_media_asset') {
    if (typeof canvasController?.deleteMediaAsset !== 'function') throw new Error('Confirmed media deletion is unavailable.');
    content = JSON.stringify(await canvasController.deleteMediaAsset(args, { signal }));
  } else if (name === 'inspect_media_asset') {
    if (typeof canvasController?.readMediaAsset !== 'function') throw new Error('Saved media references are unavailable.');
    const asset = await canvasController.readMediaAsset(args);
    if (!IMAGE_TYPES.has(asset.mimeType)) throw new Error('Use get_video_frames for a captured video. This inspection accepts saved images.');
    liveCaptures.push({ ...asset, assetId: args.assetId, canvasId: args.projectId || '', observation: `Saved image reference asset://${args.assetId}` });
    content = JSON.stringify({ ok: true, assetId: args.assetId, mimeType: asset.mimeType, name: asset.name, bytes: asset.bytes, message: 'Saved image supplied as a temporary visual observation.' });
  } else if (PROJECT_CANVAS_TOOLS.some((tool) => tool.function.name === name)) {
    try {
      const method = PROJECT_CANVAS_METHODS[name];
      if (!canvasController || typeof canvasController[method] !== 'function') throw new Error('Canvas project tools are unavailable in this app version.');
      const result = await canvasController[method](args, { signal });
      content = typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Canvas project tool failed.';
      content = JSON.stringify({ ok: false, error: message, guidance: isOfflineReferenceFailure(message) ? toolCorrection(name, undefined, message).correction : name === 'delete_canvas_file' ? 'Inspect the current files and revisions. Remove reported references before retrying. Deleting the last HTML offers project deletion. Deletion requires user confirmation and accepts no reload options.' : 'List the current project and read the affected file before retrying. A failed reload can leave a source edit saved; reload:false changes persisted files only.' });
    }
  } else if (SOURCE_CANVAS_TOOLS.some((tool) => tool.function.name === name)) {
    try {
      if (!canvasController) throw new Error('Canvas controls are unavailable.');
      const methods = { get_canvas_source: 'getCanvasSource', apply_canvas_patch: 'applyCanvasPatch', adopt_canvas_runtime_dom: 'adoptCanvasDom', reload_canvas: 'reloadCanvas', validate_canvas: 'validateCanvas', capture_live_canvas: 'captureLiveCanvas', record_canvas_video: 'recordCanvasVideo', get_video_frames: 'getVideoFrames' };
      const method = methods[name];
      if (typeof canvasController[method] !== 'function') throw new Error('This canvas feature is unavailable in the current app version.');
      const result = await canvasController[method](args, { signal });
      if (name === 'capture_live_canvas') {
        const { data, ...metadata } = result;
        liveCaptures.push(result);
        onEvent?.({ type: 'image', assetId: result.assetId, mimeType: result.mimeType, data, name: 'Live canvas capture.png', width: result.width, height: result.height, projectId: result.canvasId, chatId: context.chatId, generated: false });
        content = JSON.stringify({ ok: true, ...metadata, message: 'PNG captured from the current live canvas. The image is provided separately for visual inspection.' });
      } else if (name === 'record_canvas_video' || name === 'get_video_frames') {
        const { frames: videoFrames, data, thumbnail, ...metadata } = result;
        for (const frame of videoFrames || []) liveCaptures.push({ ...frame, mimeType: 'image/jpeg', assetId: result.assetId, observation: `Recorded canvas asset://${result.assetId} at ${frame.timestamp.toFixed(2)} seconds. Silent video sampled as still frames.` });
        if (name === 'record_canvas_video') onEvent?.({ type: 'media', assetId: result.assetId, mimeType: result.mimeType, name: result.name || 'Canvas recording', width: result.width, height: result.height, duration: result.duration, thumbnail, projectId: result.canvasId, chatId: context.chatId, captured: true });
        content = JSON.stringify({ ok: true, ...metadata, sampledFrames: (videoFrames || []).map(({ timestamp }) => ({ timestamp })), message: 'Video references are reusable; sampled stills are provided separately for visual inspection.' });
      } else content = typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      content = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Canvas tool failed.', guidance: 'Read or inspect the current canvas before retrying. Check the source/runtime persistence contract; a failed reload can leave a source edit saved.' });
    }
  } else if (name === 'execute_canvas_javascript') {
    if (!canvasController) throw new Error('Canvas controls are unavailable.');
    try {
      if (typeof args.code !== 'string' || !args.code.trim() || Buffer.byteLength(args.code, 'utf8') > 16_384) {
        throw new Error('Canvas JavaScript is required and must be at most 16 KiB.');
      }
      const result = await canvasController.execute(args.code);
      content = JSON.stringify({ ok: true, result, effects: { source: 'unchanged; runtime probes are not persisted by Save. Use file/source tools for durable edits, or explicitly adopt_canvas_runtime_dom for a DOM snapshot.', runtime: 'JavaScript executed; may be changed. Runtime variables, renderers and audio nodes are not serialized.' }, contract: canvasController.getContract?.() || null });
    } catch (error) {
      content = JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'Canvas JavaScript failed.',
        guidance: 'Inspect the canvas before retrying; the script may have partially changed it. Correct the JavaScript and try again. Code runs as an async function body with await and return support.',
      });
    }
  } else if (name === 'add_image_to_canvas') {
    if (!canvasController) throw new Error('Canvas controls are unavailable.');
    content = JSON.stringify({ ok: true, result: await canvasController.addImage(args), effects: { source: 'saved; asset attached and matching image inserted into authored HTML, without adopting other runtime DOM. Reload applies the updated asset map.', runtime: 'matching image inserted into the live DOM; sourcePendingReload remains true until reload' }, contract: canvasController.getContract?.() || null });
  } else {
    const projectId = canvasController?.getCurrentCanvasId?.() || '';
    const wireArgs = await resolveMediaToolArguments(name, args, async (reference) => {
      if (typeof canvasController?.readMediaAsset === 'function') return canvasController.readMediaAsset(reference);
      return assetStore.get(reference.assetId);
    }, signal);
    content = name === 'get_video' ? await cachedVideoResult(messages, args, mediaAssetStore) : null;
    if (!content) {
      const result = await awaitAbortable(mcp.callTool(name, wireArgs, { signal }).then(async (result) => {
        if (!result.isError && result.structuredContent?.job && typeof registerMediaJob === 'function') {
          const job = result.structuredContent.job;
          const hasOutput = result.content?.some((item) => ['image', 'audio', 'resource'].includes(item.type)) || result.structuredContent.assets?.length;
          if (!hasOutput && !['failed', 'cancelled'].includes(job.status)) {
            awaitingMediaJob = await registerMediaJob({ job, modelId: job.modelId || args.model, mediaType: name === 'generate_video' || name === 'get_video' ? 'video' : 'image', projectId, prompt: args.prompt || '' });

          }
        }
        return result;
      }), signal);
      throwIfAborted(signal);
      content = name === 'list_models' && !result.isError && Array.isArray(result.structuredContent?.models)
        ? JSON.stringify({ models: result.structuredContent.models })
        : name === 'discover_video_capabilities' && !result.isError && result.structuredContent?.capabilities
          ? JSON.stringify({ modelId: result.structuredContent.modelId, capabilities: result.structuredContent.capabilities })
          : name === 'list_video_loras' && !result.isError && Array.isArray(result.structuredContent?.loras)
            ? JSON.stringify({ modelId: result.structuredContent.modelId, loras: result.structuredContent.loras })
            : await handleMcpResult(result, mediaAssetStore, onEvent, { generated: MEDIA_OUTPUT_TOOLS.has(name), projectId, kits, attachGeneratedAssets: canvasController?.attachGeneratedAssets });
      if (awaitingMediaJob) {
        const fields = ['id', 'remoteId', 'modelId', 'mediaType', 'projectId', 'status', 'estimatedWaitSeconds', 'estimatedCompletionAt'];
        const monitoredJob = Object.fromEntries(fields.filter((field) => awaitingMediaJob[field] !== undefined).map((field) => [field, awaitingMediaJob[field]]));
        content = JSON.stringify({ ...JSON.parse(content), monitoredJob, guidance: 'The host monitors and saves this job across restarts, then adds its chat preview and notifies you. End the turn; do not poll, retrieve, or resubmit.' });
      }
    }
  }

  return { content, captures: liveCaptures, awaitingCanvasInput, awaitingMediaJob };
}

async function runAgentTurn({
  userMessage,
  mode = 'chat',
  size = '1024x1024',
  skills = [],
  kits = [],
  attachments = [],
  history = [],
  appendUserMessage = true,
  canvasInputRequestId = '',
  mediaJobResumeId = '',
  canvasInputMedia = [],
  llm,
  mcp,
  assetStore,
  mediaAssetStore = assetStore,
  canvasController,
  presentCanvas,
  maxToolCalls = MAX_TOOL_CALLS,
  onEvent,
  onHistory,
  registerMediaJob,
  signal,
}) {
  if (typeof userMessage !== 'string' || (!userMessage.trim() && (!Array.isArray(attachments) || attachments.length === 0))) {
    throw new Error('Message or attachment is required.');
  }
  if (!Array.isArray(history)) throw new Error('Conversation history is invalid.');
  let tools = [];
  const cleanMessage = userMessage.trim() || 'Review the attached media and respond with what you find.';
  const requestText = mode === 'image'
    ? `Create one image with size ${size}. Use the generate_image tool with n=1. User brief:\n${cleanMessage}`
    : cleanMessage;
  const userContent = Array.isArray(attachments) && attachments.length
    ? buildUserContent(requestText, attachments)
    : requestText;
  const messages = [
    ...history.map((message) => ({ ...message })),
    ...(appendUserMessage ? [{ role: 'user', content: userContent, ...(canvasInputRequestId ? { canvasInputRequestId } : {}) }] : []),
  ];
  const persistedCanvasMediaContent = new Map();
  if (!appendUserMessage && canvasInputRequestId && canvasInputMedia.length) {
    for (const message of messages) {
      if (message.role !== 'user' || message.canvasInputRequestId !== canvasInputRequestId || typeof message.content !== 'string') continue;
      persistedCanvasMediaContent.set(message, message.content);
      message.content = buildUserContent(message.content, canvasInputMedia);
    }
  }
  const firstUserIndex = messages.findIndex((message) => message.role === 'user');
  if (firstUserIndex === -1 || (typeof messages[firstUserIndex].content !== 'string' && !Array.isArray(messages[firstUserIndex].content))) {
    throw new Error('Conversation must contain a text user message.');
  }
  const skillInstructions = formatSkillInstructions(skills);
  const kitInstructions = formatRuntimeKitInstructions(kits);
  const identity = canvasController?.getContract?.();
  const projectInstructions = identity ? `\n\nACTIVE PROJECT VIEW\n${JSON.stringify({ projectId: identity.projectId || identity.canvasId, documentPath: identity.documentPath || '', sourcePendingReload: identity.sourcePendingReload })}` : '';
  const instructions = `${SYSTEM_PROMPT}${skillInstructions ? `\n\n${skillInstructions}` : ''}${kitInstructions ? `\n\n${kitInstructions}` : ''}${projectInstructions}`;
  let calls = 0;
  let finalizing = false;
  let failureFinalization = '';
  let awaitingCanvasInput;
  let awaitingMediaJob;
  const argumentFailures = new Map();
  const repeatedErrors = new Map();
  const descriptors = new Map();
  const transientVisualMessages = new Set();
  const startedToolIds = new Set();
  let partialAssistantText = '';
  const limitNotice = "I reached this turn's tool limit. Send another message to continue working on the canvas.";
  const finalNotice = () => awaitingMediaJob ? 'Your media job is saved. Generation continues in the background, and this conversation will be notified when it is ready.' : failureFinalization ? 'I stopped after repeated tool errors. The canvas may have partial changes; the error details describe the correction needed before continuing.' : limitNotice;

  function recordToolResult(name, fingerprint, content, executed = true) {
    let result;
    try { result = typeof content === 'string' ? JSON.parse(content) : content; } catch { return content; }
    if (result?.ok !== false || (name === 'validate_canvas' && result.source && result.scope)) {
      for (const key of repeatedErrors.keys()) if (key.startsWith(`${name}:`)) repeatedErrors.delete(key);
      for (const key of argumentFailures.keys()) if (key.startsWith(`${name}:`)) argumentFailures.delete(key);
      return typeof content === 'string' ? content : JSON.stringify(content ?? null);
    }
    const error = String(result.error || 'Tool failed.').slice(0, 1500);
    const validation = validationFailure(error, result.code, name);
    const identicalCount = (argumentFailures.get(fingerprint)?.count || 0) + 1;
    const errorSignature = `${name}:${error.toLowerCase().replace(/\s+example:[\s\S]*$/, '').replace(/\bsection (?:app|head|body)\b/g, 'section <document>').replace(/\s+/g, ' ').replace(/\b\d+\b/g, '#').replace(/[a-f0-9]{32,64}/g, '<id>')}`;
    const errorCount = (repeatedErrors.get(errorSignature) || 0) + 1;
    repeatedErrors.set(errorSignature, errorCount);
    argumentFailures.set(fingerprint, { count: identicalCount, error, code: result.code });
    const changeStrategy = identicalCount >= 2 || errorCount >= 2;
    const strategy = ALLOWED_MEDIA_TOOLS.has(name) ? validation ? 'Change strategy now. Correct the local arguments using the correction/example or list_media_assets. The generation API has not been called for this rejected request.' : 'Change strategy now. Check the endpoint error, credentials and model capabilities. Do not repeat a failed generation unchanged.' : 'Change strategy now. Use the correction/example or list_canvas_files then read_canvas_file. Do not repeat failed arguments or change unrelated fields.';
    const guidance = [result.guidance, !executed ? 'This identical failed request was blocked and was not executed.' : '', changeStrategy ? strategy : 'Read the correction and example before retrying.'].filter(Boolean).join(' ');
    if (identicalCount >= 3 || (validation && errorCount >= 3)) {
      failureFinalization = `${name} repeatedly failed: ${error}`;
      finalizing = true;
    }
    return JSON.stringify({ ...result, tool: name, error, code: result.code || (validation ? 'INVALID_TOOL_ARGUMENTS' : 'TOOL_EXECUTION_FAILED'), errorType: validation ? 'validation' : 'execution', ...(validation && ALLOWED_MEDIA_TOOLS.has(name) ? { stage: result.stage || 'argument_validation', requestSent: false } : {}), ...toolCorrection(name, descriptors.get(name), error, result.code), guidance, retry: { identicalFailures: identicalCount, sameErrorFailures: errorCount, executed, changeStrategy, turnEnding: Boolean(failureFinalization) } });
  }

  function savedHistory(cancelled = false) {
    const output = [];
    const pending = new Map();
    const fillPending = () => {
      for (const [id, call] of pending) output.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: false, tool: call.function?.name, executed: startedToolIds.has(id), interrupted: true, ...(cancelled ? { cancelled: true } : { checkpoint: true }), error: startedToolIds.has(id) ? 'This tool had not completed when the turn was stopped or checkpointed. Inspect the project before retrying; its effects are not confirmed.' : cancelled ? 'This tool call was not executed.' : 'This tool was pending at the saved checkpoint. Its eventual outcome is not recorded; inspect the project before retrying.' }) });
      pending.clear();
    };
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (transientVisualMessages.has(message)) continue;
      if (message.role !== 'tool') fillPending();
      const copy = { ...message };
      if (persistedCanvasMediaContent.has(message)) copy.content = persistedCanvasMediaContent.get(message);
      if (copy.tool_calls) copy.tool_calls = copy.tool_calls.map((call) => ({ ...call, function: { ...call.function } }));
      output.push(copy);
      if (message.role === 'assistant') for (const call of message.tool_calls || []) pending.set(call.id, call);
      else if (message.role === 'tool') pending.delete(message.tool_call_id);
    }
    fillPending();
    return output;
  }

  async function checkpoint(cancelled = false) {
    if (onHistory) await onHistory(savedHistory(cancelled));
  }

  async function finishStopped(error) {
    if (typeof error?.partialText === 'string' && error.partialText) messages.push({ role: 'assistant', content: error.partialText, agentCancelled: true });
    if (messages.at(-1)?.role !== 'assistant' || messages.at(-1).content !== 'Stopped.' || !messages.at(-1).agentCancelled) messages.push({ role: 'assistant', content: 'Stopped.', agentCancelled: true });
    for (const message of messages) if (message.canvasInputCompletedId === canvasInputRequestId && canvasInputRequestId) delete message.canvasInputCompletedId;
    try { await checkpoint(true); }
    catch (saveError) { onEvent?.({ type: 'error', message: `The stopped turn could not be saved: ${saveError.message}` }); }
    return { text: 'Stopped.', history: savedHistory(true), cancelled: true, ...(awaitingCanvasInput ? { awaitingCanvasInput: canvasInputSummary(awaitingCanvasInput) } : {}) };
  }

  async function finish(text) {
    throwIfAborted(signal);
    await checkpoint();
    throwIfAborted(signal);
    if (canvasInputRequestId && messages.at(-1)?.role === 'assistant') messages.at(-1).canvasInputCompletedId = canvasInputRequestId;
    if (mediaJobResumeId && messages.at(-1)?.role === 'assistant') messages.at(-1).mediaJobCompletedId = mediaJobResumeId;
    onEvent?.({ type: 'assistant', text });
    return { text, history: savedHistory(), ...(awaitingCanvasInput ? { awaitingCanvasInput: canvasInputSummary(awaitingCanvasInput) } : {}), ...(awaitingMediaJob ? { awaitingMediaJob } : {}) };
  }

  try {
  await checkpoint();
  throwIfAborted(signal);
  const mcpTools = await awaitAbortable(mcp.listTools({ signal }), signal);
  throwIfAborted(signal);
  const availableToolNames = mcpTools.filter((tool) => ALLOWED_MEDIA_TOOLS.has(tool.name)).map((tool) => tool.name);
  tools = toOpenAITools(mcpTools);
  for (const tool of tools) descriptors.set(tool.function.name, tool);
  onEvent?.({ type: 'capabilities', tools: availableToolNames });
  throwIfAborted(signal);
  if (mode === 'image' && !availableToolNames.includes('generate_image')) throw new Error('Image generation is unavailable. Check the Media MCP connection and try again.');
  while (true) {
    throwIfAborted(signal);
    let response;
    try {
      partialAssistantText = '';
      response = await awaitAbortable(llm.createCompletion({
        instructions,
        messages: finalizing ? [...messages, {
          role: 'user',
          content: awaitingMediaJob ? 'The media job is saved in the background monitor. End this turn with a brief status. Polling and downloading continue across restarts; this conversation will be notified when ready. Do not poll or submit this job again.' : failureFinalization ? `${failureFinalization}. Stop using tools. Explain the specific error and correction, any completed or partial changes, and how to continue with a corrected request. Do not claim failed operations succeeded.` : `The ${maxToolCalls}-call tool budget for this turn is exhausted. Stop using tools. Explain what you completed, any unresolved problems, and how the user can continue in another message. Do not claim unfinished work is complete.`,
        }] : messages,
        tools: finalizing ? [] : tools,
        signal,
        onText: (text) => { partialAssistantText = text; },
      }), signal);
      throwIfAborted(signal);
    } catch (error) {
      if (isTurnAbort(error, signal)) throw error;
      if (!finalizing) throw error;
      messages.push({ role: 'assistant', content: finalNotice() });
      return await finish(finalNotice());
    }
    const assistant = response?.choices?.[0]?.message;
    if (!assistant || assistant.role !== 'assistant') throw new Error('LiteLLM returned an invalid assistant message.');
    partialAssistantText = '';
    if (finalizing && assistant.tool_calls?.length) {
      messages.push({ role: 'assistant', content: finalNotice() });
      return await finish(finalNotice());
    }
    messages.push(assistant);
    const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (toolCalls.length === 0) {
      const text = typeof assistant.content === 'string' && assistant.content ? assistant.content : finalizing ? finalNotice() : '';
      assistant.content = text;
      return await finish(text);
    }

    await checkpoint();
    throwIfAborted(signal);

    const liveCaptures = [];
    for (const call of toolCalls) {
      throwIfAborted(signal);
      if (awaitingCanvasInput) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'This turn is waiting for canvas input. This additional tool call was not executed.' }) });
        continue;
      }
      const name = typeof call?.function?.name === 'string' ? call.function.name : String(call?.function?.name);
      if (calls >= maxToolCalls || finalizing) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, tool: name, error: failureFinalization || 'This turn reached its tool limit.', executed: false, guidance: 'This tool call was not executed. Explain the completed work and correction required.' }) });
        continue;
      }
      calls += 1;
      const fingerprint = argumentFingerprint(name, call?.function?.arguments);
      const previousFailure = argumentFailures.get(fingerprint);
      if (previousFailure?.count >= 2) {
        const content = recordToolResult(name, fingerprint, { ok: false, error: previousFailure.error, code: previousFailure.code }, false);
        messages.push({ role: 'tool', tool_call_id: call.id, content });
        continue;
      }
      let content;
      try {
      const descriptor = descriptors.get(name);
      if (!descriptor) { const error = new Error(`Unknown or unavailable tool: ${name}.`); error.code = 'INVALID_TOOL_ARGUMENTS'; throw error; }
      const args = parseArguments(call.function.arguments);
      validateToolArguments(args, descriptor.function.parameters);
      onEvent?.({ type: 'tool-start', name });
      throwIfAborted(signal);
      startedToolIds.add(call.id);
      const execution = await executeEaselTool(name, args, {
        canvasController, presentCanvas, assetStore, mediaAssetStore, mcp, kits,
        onEvent, registerMediaJob, signal, messages,
      });
      content = execution.content;
      awaitingCanvasInput ||= execution.awaitingCanvasInput;
      awaitingMediaJob ||= execution.awaitingMediaJob;
      finalizing ||= Boolean(execution.awaitingMediaJob);
      liveCaptures.push(...execution.captures);
      } catch (error) {
        content = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), ...(error?.code ? { code: error.code } : {}), ...(error?.stage ? { stage: error.stage, requestSent: error.requestSent } : {}) });
      }
      if (!signal?.aborted) content = recordToolResult(name, fingerprint, content);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
      await checkpoint();
      throwIfAborted(signal);
    }
    throwIfAborted(signal);
    if (awaitingCanvasInput) {
      const text = `Waiting for your choice in the canvas: ${awaitingCanvasInput.question}`;
      messages.push({ role: 'assistant', content: text });
      onEvent?.({ type: 'canvas-input', request: canvasInputSummary(awaitingCanvasInput), status: 'pending' });
      return await finish(text);
    }
    if (liveCaptures.length) {
      // Keep the latest visual observation in model context, while tool metadata stays in history.
      for (let index = messages.length - 1; index >= 0; index -= 1) if (transientVisualMessages.has(messages[index])) messages.splice(index, 1);
    }
    for (const capture of liveCaptures.slice(-6)) {
      const observation = { role: 'user', content: [
        { type: 'text', text: capture.observation || `Tool observation: live canvas ${capture.canvasId}, runtime generation ${capture.runtimeGeneration}. Inspect this actual open-view screenshot, saved as asset://${capture.assetId}.` },
        { type: 'image', mimeType: capture.mimeType, data: capture.data },
      ] };
      transientVisualMessages.add(observation);
      messages.push(observation);
    }
    finalizing ||= calls >= maxToolCalls;
  }
  } catch (error) {
    if (isTurnAbort(error, signal)) return finishStopped({ partialText: error?.partialText || partialAssistantText });
    await checkpoint();
    throw error;
  }
}

module.exports = {
  buildUserContent,
  executeEaselTool,
  validateToolArguments,
  toolCorrection,
  SYSTEM_PROMPT,
  CANVAS_TOOLS,
  formatSkillInstructions,
  formatRuntimeKitInstructions,
  handleMcpResult,
  MAX_TOOL_CALLS,
  PRESENT_CANVAS_TOOL,
  PROJECT_CANVAS_METHODS,
  normalizeCanvasAssetReferences,
  runAgentTurn,
  toOpenAITools,
};
