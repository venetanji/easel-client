const IPC_CHANNELS = Object.freeze({
  GET_SETTINGS: 'settings:get',
  SAVE_SETTINGS: 'settings:save',
  SEND_MESSAGE: 'chat:send',
  CLEAR_CHAT: 'chat:clear',
  AGENT_EVENT: 'agent:event',
  LIST_ASSETS: 'assets:list',
  LIST_CANVASES: 'canvases:list',
  CREATE_CANVAS: 'canvases:create',
  OPEN_CANVAS: 'canvases:open',
  SAVE_CANVAS: 'canvases:save',
  EXPORT_CANVAS: 'canvases:export',
  ADD_ASSET_TO_CANVAS: 'canvas:add-asset',
  SET_CANVAS_BOUNDS: 'canvas:set-bounds',
});

const SETTING_KEYS = new Set([
  'easelBaseUrl', 'easelApiKey', 'clearEaselApiKey',
  'litellmBaseUrl', 'litellmModel', 'litellmApiKey', 'clearLiteLLMApiKey',
]);
const KNOWN_CHANNELS = new Set(Object.values(IPC_CHANNELS));
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_SKILLS_PER_MESSAGE = 8;
const MAX_SKILL_NAME_LENGTH = 80;
const MAX_SKILL_INSTRUCTIONS_LENGTH = 12_000;
const MAX_TOTAL_SKILL_INSTRUCTIONS_LENGTH = 24_000;
const MAX_CANVAS_BOUNDS = 10_000;

function assertKnownChannel(channel) {
  if (!KNOWN_CHANNELS.has(channel)) throw new Error('Unsupported IPC channel.');
  return channel;
}

function assertTrustedSender(event, mainWindow) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender.');
  }
}

function validateSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Settings object is required.');
  }
  for (const [key, value] of Object.entries(input)) {
    if (!SETTING_KEYS.has(key)) throw new Error(`Unsupported setting: ${key}`);
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new Error(`Invalid value for setting: ${key}`);
    }
    if (typeof value === 'boolean' && !key.startsWith('clear')) {
      throw new Error(`Invalid value for setting: ${key}`);
    }
  }
  if (typeof input.litellmModel === 'string' && input.litellmModel.length > 256) {
    throw new Error('LiteLLM model is too long.');
  }
  if (typeof input.easelApiKey === 'string' && input.easelApiKey.length > 4096) {
    throw new Error('Easel API key is too long.');
  }
  if (typeof input.litellmApiKey === 'string' && input.litellmApiKey.length > 4096) {
    throw new Error('LiteLLM API key is too long.');
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    typeof value === 'string' ? value.trim() : value,
  ]));
}

function validateChatMessage(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Message is required.');
  const message = value.trim();
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error('Message is too long.');
  return message;
}

function validateChatOptions(value) {
  if (value === undefined) return { mode: 'chat', size: '1024x1024', skills: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Chat options must be an object.');
  for (const key of Object.keys(value)) {
    if (!['mode', 'size', 'skills'].includes(key)) throw new Error(`Unsupported chat option: ${key}`);
  }
  const mode = value.mode ?? 'chat';
  if (!['chat', 'image'].includes(mode)) throw new Error('Chat mode is invalid.');
  const size = value.size ?? '1024x1024';
  if (!['1024x1024', '1536x1024', '1024x1536'].includes(size)) throw new Error('Image shape is invalid.');
  const skills = value.skills ?? [];
  if (!Array.isArray(skills) || skills.length > MAX_SKILLS_PER_MESSAGE) {
    throw new Error(`Choose up to ${MAX_SKILLS_PER_MESSAGE} skills per message.`);
  }
  let totalInstructionsLength = 0;
  const cleanSkills = skills.map((skill) => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) throw new Error('Skill instructions are invalid.');
    if (Object.keys(skill).some((key) => !['name', 'instructions'].includes(key))) throw new Error('Skill instructions contain unsupported fields.');
    const name = typeof skill.name === 'string' ? skill.name.trim() : '';
    const instructions = typeof skill.instructions === 'string' ? skill.instructions.trim() : '';
    if (!name || name.length > MAX_SKILL_NAME_LENGTH) throw new Error('Skill name is invalid.');
    if (!instructions || instructions.length > MAX_SKILL_INSTRUCTIONS_LENGTH) throw new Error('Skill instructions are invalid or too long.');
    totalInstructionsLength += instructions.length;
    if (totalInstructionsLength > MAX_TOTAL_SKILL_INSTRUCTIONS_LENGTH) {
      throw new Error('Combined skill instructions must be 24000 characters or fewer.');
    }
    return { name, instructions };
  });
  return { mode, size, skills: cleanSkills };
}

function validateOpaqueId(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function validateCanvasTitle(value) {
  if (typeof value !== 'string') throw new Error('Canvas name is required.');
  const title = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!title) throw new Error('Canvas name is required.');
  if (title.length > 120) throw new Error('Canvas name must be at most 120 characters.');
  return title;
}

function validateCanvasBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Canvas bounds are required.');
  const bounds = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const coordinate = value[key];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > MAX_CANVAS_BOUNDS) {
      throw new Error(`Canvas ${key} is invalid.`);
    }
    bounds[key] = Math.floor(coordinate);
  }
  return bounds;
}

module.exports = {
  IPC_CHANNELS,
  assertKnownChannel,
  assertTrustedSender,
  validateChatMessage,
  validateChatOptions,
  validateCanvasBounds,
  validateCanvasTitle,
  validateOpaqueId,
  validateSettingsInput,
};
