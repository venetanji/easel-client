const { ALLOWED_MEDIA_TOOLS } = require('./media-mcp-client');

const MAX_TOOL_CALLS = 3;
const MAX_CANVAS_HTML_BYTES = 1_048_576;
const MAX_CANVAS_ASSETS = 8;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SYSTEM_PROMPT = [
  'You are Easel, a creative image assistant.',
  'Use only the provided tools. Generate images through Easel and use present_canvas for local HTML/JavaScript compositions.',
  'Canvas code runs locally in an isolated window with no network, filesystem, or application access.',
  'When composing generated images, reference only asset IDs returned by image tools.',
].join(' ');

const PRESENT_CANVAS_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'present_canvas',
    description: 'Open a local HTML/JavaScript canvas with optional generated image assets.',
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
  return [...tools, PRESENT_CANVAS_TOOL];
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
  history = [],
  llm,
  mcp,
  assetStore,
  presentCanvas,
  maxToolCalls = MAX_TOOL_CALLS,
  onEvent,
}) {
  if (typeof userMessage !== 'string' || !userMessage.trim()) throw new Error('Message is required.');
  if (!Array.isArray(history)) throw new Error('Conversation history is invalid.');
  const mcpTools = await mcp.listTools();
  const tools = toOpenAITools(mcpTools);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage.trim() },
  ];
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
      return { text, history: messages.slice(1) };
    }

    if (calls + toolCalls.length > maxToolCalls) throw new Error(`Agent reached the ${maxToolCalls}-call tool limit.`);
    for (const call of toolCalls) {
      calls += 1;
      const name = call?.function?.name;
      if (typeof name !== 'string' || (!ALLOWED_MEDIA_TOOLS.has(name) && name !== 'present_canvas')) {
        throw new Error(`Unknown or disallowed tool: ${String(name)}`);
      }
      const args = parseArguments(call.function.arguments);
      onEvent?.({ type: 'tool-start', name });
      let content;
      if (name === 'present_canvas') {
        const html = args.html;
        if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html, 'utf8') > MAX_CANVAS_HTML_BYTES) {
          throw new Error('Canvas HTML is required and must be at most 1 MiB.');
        }
        if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 120)) {
          throw new Error('Canvas title is invalid.');
        }
        const assets = await resolveCanvasAssets(assetStore, args.assets || []);
        await presentCanvas({ html, title: args.title || 'Easel Canvas', assets });
        onEvent?.({ type: 'canvas', title: args.title || 'Easel Canvas' });
        content = JSON.stringify({ ok: true, message: 'Canvas updated.' });
      } else {
        const result = await mcp.callTool(name, args);
        content = await handleMcpResult(result, assetStore, onEvent);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
}

module.exports = { MAX_TOOL_CALLS, PRESENT_CANVAS_TOOL, runAgentTurn, toOpenAITools };
