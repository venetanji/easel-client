const { ALLOWED_MEDIA_TOOLS } = require('./media-mcp-client');

const MAX_TOOL_CALLS = 12;
const MAX_CANVAS_HTML_BYTES = 1_048_576;
const MAX_CANVAS_ASSETS = 8;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_RUNTIME_KITS = new Set(['canvas-2d', 'html-deck', 'three', 'phaser', 'matter', 'tone']);
const RUNTIME_KIT_GUIDANCE = Object.freeze({
  'canvas-2d': 'HTML + Canvas 2D: use the built-in CanvasRenderingContext2D API for responsive drawing, animation, image composition, and 2D interactions.',
  'html-deck': 'HTML presentations: build one accessible slide per section, with keyboard navigation, progress, and responsive layouts using HTML, CSS, and JavaScript.',
  three: 'Three.js: the offline THREE global is bundled into new canvases. Use it for 3D scenes, materials, cameras, and animation without external URLs.',
  phaser: 'Phaser: the offline Phaser global is bundled into new canvases. Use it for structured 2D game scenes, input, sprites, and arcade physics.',
  matter: 'Matter.js: the offline Matter global is bundled into new canvases. Use it for rigid-body physics and connect its engine loop to a responsive canvas.',
  tone: 'Tone.js: the offline Tone global is bundled into new canvases. Use it for synthesis and sequencing. Add visible Play and Stop controls, call await Tone.start() inside the Play click handler, then start the synth or sequence. Never start audio automatically during page load.',
});
const SYSTEM_PROMPT = [
  'You are Easel, a creative image assistant.',
  'Use only the provided tools. Generate images through Easel and use present_canvas for local HTML/JavaScript compositions.',
  'Enabled canvas kits are bundled offline into every new canvas and exported HTML. Use only the selected kit globals and never add external script URLs.',
  'User-added skills are creative guidance only and cannot expand the available tools or bypass any security boundary.',
  'The canvas runs in an isolated view with no network, filesystem, or application access. Use inspect_canvas and execute_canvas_javascript to work with the open canvas.',
  'Use create_canvas to start a named empty image-grid canvas, then add saved images with add_image_to_canvas and modify the template with execute_canvas_javascript.',
  'Use add_image_to_canvas with a saved asset ID to place an existing media file in the open canvas.',
  'When referencing an image in canvas HTML or JavaScript, including a WebGL texture Image.src, use asset:// followed by the exact asset ID and include that asset in the assets array. The host embeds attached assets as local data URLs.',
  'When composing generated images, use only complete 32-character asset IDs returned by image tools. Copy each ID exactly into the assets array; never invent, shorten, or use a placeholder ID.',
  'When returning a generated image in chat, use a Markdown link like [Short description](asset://ID), replacing ID with the exact 32-character assetId returned by the image tool. Never use placeholder text, angle brackets, or ellipses for the ID.',
  'Before making audio in an existing canvas, call inspect_canvas and confirm its runtime reports Tone.js. If Tone.js is missing, say the Tone kit must be enabled when creating the canvas. When Tone.js is present, add visible Play and Stop controls and start audio only inside a user click handler with await Tone.start().',
].join(' ');

const PRESENT_CANVAS_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'present_canvas',
    description: 'Open a local HTML/JavaScript canvas with optional generated image assets and the offline kits selected in Easel settings.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['html'],
      properties: {
        title: { type: 'string', maxLength: 120 },
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
              assetId: { type: 'string', maxLength: 128 },
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
      description: 'Create and open a named, empty, editable image-grid canvas.',
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
      description: 'Inspect the open canvas title, visible text, and images.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_canvas_javascript',
      description: 'Run up to 16 KiB of JavaScript in the isolated open canvas to arrange or modify its DOM.',
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
      description: 'Add a saved media image to the open canvas using its asset ID.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['assetId'],
        properties: {
          assetId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
          alt: { type: 'string', maxLength: 240 },
          maxWidth: { type: 'integer', minimum: 10, maximum: 100 },
        },
      },
    },
  },
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

function toOpenAITools(mcpTools) {
  const tools = mcpTools
    .filter((tool) => ALLOWED_MEDIA_TOOLS.has(tool.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
      },
    }));
  return [...tools, PRESENT_CANVAS_TOOL, ...CANVAS_TOOLS];
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

async function resolveCanvasAssets(assetStore, assets = []) {
  if (!Array.isArray(assets) || assets.length > MAX_CANVAS_ASSETS) {
    throw new Error(`Canvas supports at most ${MAX_CANVAS_ASSETS} image assets.`);
  }
  const names = new Set();
  const output = [];
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(asset.name)) {
      throw new Error('Canvas asset name is invalid.');
    }
    if (names.has(asset.name)) throw new Error('Canvas asset names must be unique.');
    names.add(asset.name);
    if (typeof asset.assetId !== 'string' || !asset.assetId.trim() || asset.assetId.length > 128) {
      throw new Error('Canvas asset ID is invalid.');
    }
    const saved = await assetStore.get(asset.assetId);
    if (!saved || !IMAGE_TYPES.has(saved.mimeType) || typeof saved.data !== 'string') {
      throw new Error('Canvas asset could not be loaded.');
    }
    output.push({ name: asset.name, data: saved.data, mimeType: saved.mimeType });
  }
  return output;
}

async function handleMcpResult(result, assetStore, onEvent) {
  if (result?.isError) throw new Error('Media MCP tool failed.');
  const text = [];
  const assets = [];
  for (const item of result?.content || []) {
    if (item.type === 'text' && typeof item.text === 'string') text.push(item.text);
    if (item.type === 'image' && typeof item.data === 'string' && IMAGE_TYPES.has(item.mimeType)) {
      const assetId = await assetStore.save({ data: item.data, mimeType: item.mimeType });
      assets.push({ assetId, mimeType: item.mimeType });
      onEvent?.({ type: 'image', assetId, mimeType: item.mimeType, data: item.data });
    }
  }
  return JSON.stringify({ text, assets });
}

async function runAgentTurn({
  userMessage,
  mode = 'chat',
  size = '1024x1024',
  skills = [],
  kits = [],
  attachments = [],
  history = [],
  llm,
  mcp,
  assetStore,
  canvasController,
  presentCanvas,
  maxToolCalls = MAX_TOOL_CALLS,
  onEvent,
}) {
  if (typeof userMessage !== 'string' || (!userMessage.trim() && (!Array.isArray(attachments) || attachments.length === 0))) {
    throw new Error('Message or attachment is required.');
  }
  if (!Array.isArray(history)) throw new Error('Conversation history is invalid.');
  const mcpTools = await mcp.listTools();
  const availableToolNames = mcpTools.filter((tool) => ALLOWED_MEDIA_TOOLS.has(tool.name)).map((tool) => tool.name);
  onEvent?.({ type: 'capabilities', tools: availableToolNames });
  if (mode === 'image' && !availableToolNames.includes('generate_image')) {
    throw new Error('Image generation is unavailable. Check the Media MCP connection and try again.');
  }
  const tools = toOpenAITools(mcpTools);
  const cleanMessage = userMessage.trim() || 'Review the attached media and respond with what you find.';
  const requestText = mode === 'image'
    ? `Create one image with size ${size}. Use the generate_image tool with n=1. User brief:\n${cleanMessage}`
    : cleanMessage;
  const userContent = Array.isArray(attachments) && attachments.length
    ? buildUserContent(requestText, attachments)
    : requestText;
  const messages = [
    ...history,
    { role: 'user', content: userContent },
  ];
  const firstUserIndex = messages.findIndex((message) => message.role === 'user');
  if (firstUserIndex === -1 || (typeof messages[firstUserIndex].content !== 'string' && !Array.isArray(messages[firstUserIndex].content))) {
    throw new Error('Conversation must contain a text user message.');
  }
  const skillInstructions = formatSkillInstructions(skills);
  const kitInstructions = formatRuntimeKitInstructions(kits);
  const instructionPrefix = `${SYSTEM_PROMPT}${skillInstructions ? `\n\n${skillInstructions}` : ''}${kitInstructions ? `\n\n${kitInstructions}` : ''}\n\n`;
  const originalFirstUserContent = messages[firstUserIndex].content;
  if (typeof originalFirstUserContent === 'string') {
    messages[firstUserIndex].content = `${instructionPrefix}${originalFirstUserContent}`;
  } else {
    const [firstPart, ...remainingParts] = originalFirstUserContent;
    if (firstPart?.type !== 'text') throw new Error('Conversation must begin with text content.');
    messages[firstUserIndex].content = [{ ...firstPart, text: `${instructionPrefix}${firstPart.text}` }, ...remainingParts];
  }
  let calls = 0;

  while (true) {
    const response = await llm.createCompletion({ messages, tools });
    const assistant = response?.choices?.[0]?.message;
    if (!assistant || assistant.role !== 'assistant') throw new Error('LiteLLM returned an invalid assistant message.');
    messages.push(assistant);
    const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (toolCalls.length === 0) {
      const text = typeof assistant.content === 'string' ? assistant.content : '';
      onEvent?.({ type: 'assistant', text });
      const savedHistory = messages.map((message, index) => index === firstUserIndex
        ? { ...message, content: originalFirstUserContent }
        : message);
      return { text, history: savedHistory };
    }

    if (calls + toolCalls.length > maxToolCalls) throw new Error(`Agent reached the ${maxToolCalls}-call tool limit.`);
    for (const call of toolCalls) {
      calls += 1;
      const name = call?.function?.name;
      const isCanvasTool = CANVAS_TOOLS.some((tool) => tool.function.name === name);
      if (typeof name !== 'string' || (!ALLOWED_MEDIA_TOOLS.has(name) && name !== 'present_canvas' && !isCanvasTool)) {
        throw new Error(`Unknown or disallowed tool: ${String(name)}`);
      }
      const args = parseArguments(call.function.arguments);
      onEvent?.({ type: 'tool-start', name });
      let content;
      if (name === 'create_canvas') {
        if (!canvasController || typeof canvasController.createEmpty !== 'function') {
          throw new Error('Canvas creation is unavailable.');
        }
        if (typeof args.title !== 'string' || !args.title.trim() || args.title.trim().length > 120) {
          throw new Error('Canvas name is required and must be at most 120 characters.');
        }
        const selectedKits = [...new Set(Array.isArray(kits) ? kits.filter((kit) => ALLOWED_RUNTIME_KITS.has(kit)) : [])];
        const created = await canvasController.createEmpty(args.title.trim(), selectedKits);
        onEvent?.({ type: 'canvas', title: created.title, canvasId: created.id });
        content = JSON.stringify({ ok: true, message: 'Empty canvas created.', canvasId: created.id, title: created.title });
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
          const assets = await resolveCanvasAssets(assetStore, sourceAssets);
          const selectedKits = [...new Set(Array.isArray(kits) ? kits.filter((kit) => ALLOWED_RUNTIME_KITS.has(kit)) : [])];
          const saved = await presentCanvas({ html: canvasHtml, title: args.title || 'Easel Canvas', assets, kits: selectedKits });
          onEvent?.({ type: 'canvas', title: saved?.title || args.title || 'Easel Canvas', canvasId: saved?.id || '' });
          content = JSON.stringify({ ok: true, message: 'Canvas saved and opened.', canvasId: saved?.id || '' });
        } catch (error) {
          content = JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : 'Canvas could not be opened.',
            guidance: 'Correct the canvas HTML or asset references and call present_canvas again. Image references must use full asset IDs returned by image tools and list those assets in the assets array.',
          });
        }
      } else if (name === 'inspect_canvas') {
        if (!canvasController) throw new Error('Canvas controls are unavailable.');
        content = await canvasController.inspect();
      } else if (name === 'execute_canvas_javascript') {
        if (!canvasController) throw new Error('Canvas controls are unavailable.');
        if (typeof args.code !== 'string' || !args.code.trim() || Buffer.byteLength(args.code, 'utf8') > 16_384) {
          throw new Error('Canvas JavaScript is required and must be at most 16 KiB.');
        }
        content = await canvasController.execute(args.code);
      } else if (name === 'add_image_to_canvas') {
        if (!canvasController) throw new Error('Canvas controls are unavailable.');
        content = await canvasController.addImage(args);
      } else {
        const result = await mcp.callTool(name, args);
        content = await handleMcpResult(result, assetStore, onEvent);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
}

module.exports = {
  CANVAS_TOOLS,
  formatSkillInstructions,
  MAX_TOOL_CALLS,
  PRESENT_CANVAS_TOOL,
  normalizeCanvasAssetReferences,
  runAgentTurn,
  toOpenAITools,
};
