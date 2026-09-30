const IPC_CHANNELS = Object.freeze({
  GET_SETTINGS: 'settings:get',
  SAVE_SETTINGS: 'settings:save',
  SAVE_CONNECTION: 'connections:save',
  REMOVE_CONNECTION: 'connections:remove',
  SELECT_MODEL: 'models:select',
  GET_MODEL_CATALOG: 'models:catalog',
  UPDATE_MODEL: 'models:update',
  CHECK_MODEL_CAPABILITIES: 'models:check-capabilities',
  OPEN_EXTERNAL: 'links:open-external',
  LIST_CANVAS_FILES: 'canvas:files:list',
  READ_CANVAS_FILE: 'canvas:files:read',
  DELETE_PROJECT_FILE: 'projects:files:delete',
  DELETE_PROJECT: 'projects:delete',
  DELETE_PROJECT_ASSET: 'projects:assets:delete',
  DELETE_LIBRARY_ASSET: 'assets:delete',
  CREATE_PROJECT: 'projects:create',
  RENAME_PROJECT: 'projects:rename',
  EXPORT_PROJECT: 'projects:export',
  LIST_PROJECT_DOCUMENTS: 'projects:documents:list',
  CREATE_PROJECT_DOCUMENT: 'projects:documents:create',
  OPEN_PROJECT_DOCUMENT: 'projects:documents:open',
  GET_AVAILABLE_KITS: 'kits:available',
  GET_PROJECT_KITS: 'projects:kits:get',
  UPDATE_PROJECT_KITS: 'projects:kits:update',
  GET_PROJECT_ASSETS: 'projects:assets:list',
  GET_PROJECT_ASSET: 'projects:assets:get',
  GET_LIBRARY_ASSET: 'assets:get',
  SAVE_LIBRARY_ASSET: 'assets:save',
  ATTACH_PROJECT_ASSET: 'projects:assets:attach',
  SAVE_PROJECT_ASSET: 'projects:assets:save',
  HIDE_CANVAS_PREVIEW: 'canvas:preview:hide',
  MANAGE_CANVAS_DEVICES: 'canvas:devices:manage',
  CLOSE_CANVAS: 'canvases:close',
  LIST_CANVAS_INPUTS: 'canvas:inputs:list',
  RETRY_CANVAS_INPUT: 'canvas:inputs:retry',
  SEND_MESSAGE: 'chat:send',
  STOP_AGENT: 'chat:stop',
  CLEAR_CHAT: 'chat:clear',
  GET_CHAT: 'chat:get',
  ACKNOWLEDGE_CHAT: 'chat:ready',
  LIST_CHATS: 'chat:list',
  OPEN_CHAT: 'chat:open',
  AGENT_EVENT: 'agent:event',
  LIST_ASSETS: 'assets:list',
  LIST_MEDIA_JOBS: 'media:jobs:list',
  DELETE_MEDIA_JOB: 'media:jobs:delete',
  RETRY_MEDIA_JOB: 'media:jobs:retry',
  LIST_CANVASES: 'canvases:list',
  CREATE_CANVAS: 'canvases:create',
  OPEN_CANVAS: 'canvases:open',
  SAVE_CANVAS: 'canvases:save',
  EXPORT_CANVAS: 'canvases:export',
  ADD_ASSET_TO_CANVAS: 'canvas:add-asset',
  UNDO_CANVAS: 'canvas:undo',
  SET_CANVAS_BOUNDS: 'canvas:set-bounds',
  LIST_LITELLM_MODELS: 'litellm:models:list',
  TEST_LITELLM_CHAT: 'litellm:probe:chat',
  TEST_LITELLM_IMAGE: 'litellm:probe:image',
  LIST_INSTALLED_SKILLS: 'skills:list-installed',
});

const SETTING_KEYS = new Set([
  'easelBaseUrl', 'easelApiKey', 'clearEaselApiKey',
  'litellmBaseUrl', 'litellmModel', 'litellmApiKey', 'clearLiteLLMApiKey',
]);
const KNOWN_CHANNELS = new Set(Object.values(IPC_CHANNELS));
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_SKILLS_PER_MESSAGE = 8;
const MAX_SKILL_NAME_LENGTH = 80;
const MAX_SKILL_INSTRUCTIONS_LENGTH = 32_000;
const MAX_TOTAL_SKILL_INSTRUCTIONS_LENGTH = 48_000;
const MAX_CANVAS_BOUNDS = 10_000;
const ALLOWED_RUNTIME_KITS = new Set(['canvas-2d', 'html-deck', 'three', 'phaser', 'matter', 'tone', 'p5']);
const MAX_CHAT_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_FRAMES = 6;
const IMAGE_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUDIO_ATTACHMENT_TYPES = new Set(['audio/mpeg', 'audio/wav']);
const VIDEO_ATTACHMENT_TYPES = new Set(['video/mp4', 'video/webm']);

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

function validateLiteLLMModelInput(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('LiteLLM model is required.');
  const model = value.trim();
  if (model.length > 256) throw new Error('LiteLLM model is too long.');
  return model;
}

function validateChatOptions(value) {
  if (value === undefined) return { mode: 'chat', size: '1024x1024', skills: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Chat options must be an object.');
  for (const key of Object.keys(value)) {
    if (!['mode', 'size', 'skills', 'kits', 'attachments'].includes(key)) throw new Error(`Unsupported chat option: ${key}`);
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
      throw new Error(`Combined skill instructions must be ${MAX_TOTAL_SKILL_INSTRUCTIONS_LENGTH} characters or fewer.`);
    }
    return { name, instructions };
  });
  const cleanKits = validateCanvasKits(value.kits);
  const attachments = value.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(`Attach up to ${MAX_CHAT_ATTACHMENTS} files per message.`);
  }
  let totalAttachmentBytes = 0;
  const cleanAttachments = attachments.map((attachment) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) throw new Error('Media attachment is invalid.');
    const type = attachment.type;
    const mimeType = attachment.mimeType;
    const name = typeof attachment.name === 'string'
      ? attachment.name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160)
      : '';
    if (!name) throw new Error('Media attachment name is invalid.');

    function readBase64(data, label, maxBytes = MAX_ATTACHMENT_BYTES) {
      if (typeof data !== 'string' || !data || data.length > Math.ceil(maxBytes / 3) * 4) {
        throw new Error(`${label} exceeds the media size limit.`);
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new Error(`${label} must be base64 encoded.`);
      }
      const bytes = Buffer.from(data, 'base64').length;
      if (!bytes || bytes > maxBytes) throw new Error(`${label} exceeds the media size limit.`);
      totalAttachmentBytes += bytes;
      return data;
    }

    if (type === 'image' || type === 'audio') {
      const supported = type === 'image' ? IMAGE_ATTACHMENT_TYPES : AUDIO_ATTACHMENT_TYPES;
      if (!supported.has(mimeType)) throw new Error(`Unsupported ${type} media format.`);
      if (Object.keys(attachment).some((key) => !['type', 'name', 'mimeType', 'data'].includes(key))) {
        throw new Error('Media attachment contains unsupported fields.');
      }
      return { type, name, mimeType, data: readBase64(attachment.data, 'Media attachment') };
    }

    if (type === 'video') {
      if (!VIDEO_ATTACHMENT_TYPES.has(mimeType)) throw new Error('Unsupported video format.');
      if (Object.keys(attachment).some((key) => !['type', 'name', 'mimeType', 'frames'].includes(key))) {
        throw new Error('Video attachment contains unsupported fields.');
      }
      if (!Array.isArray(attachment.frames) || attachment.frames.length === 0 || attachment.frames.length > MAX_VIDEO_FRAMES) {
        throw new Error(`Video must include up to ${MAX_VIDEO_FRAMES} sampled frames.`);
      }
      const frames = attachment.frames.map((frame) => {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)
          || Object.keys(frame).some((key) => !['timestamp', 'data'].includes(key))) {
          throw new Error('Video frame is invalid.');
        }
        if (typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > 3_600) {
          throw new Error('Video frame timestamp is invalid.');
        }
        return { timestamp: frame.timestamp, data: readBase64(frame.data, 'Video frame', 2 * 1024 * 1024) };
      });
      return { type, name, mimeType, frames };
    }

    throw new Error('Media attachment type is unsupported.');
  });
  if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Attachments exceed 64 MiB in total.');
  return {
    mode,
    size,
    skills: cleanSkills,
    ...(Object.hasOwn(value, 'kits') ? { kits: cleanKits } : {}),
    ...(Object.hasOwn(value, 'attachments') ? { attachments: cleanAttachments } : {}),
  };
}

function validateConnectionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Endpoint details are required.');
  for (const key of Object.keys(input)) {
    if (!['id', 'name', 'baseUrl', 'apiKey', 'clearApiKey'].includes(key)) throw new Error(`Unsupported endpoint field: ${key}`);
  }
  if (input.id !== undefined) validateOpaqueId(input.id, 'Endpoint ID');
  for (const [key, limit] of [['name', 80], ['baseUrl', 2048], ['apiKey', 4096]]) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > limit)) throw new Error(`Endpoint ${key} is invalid or too long.`);
  }
  if (!input.baseUrl?.trim()) throw new Error('Endpoint URL is required.');
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new Error('Clear API key must be a boolean.');
  return { ...(input.id ? { id: input.id } : {}), name: (input.name || '').trim(), baseUrl: input.baseUrl.trim(), apiKey: (input.apiKey || '').trim(), clearApiKey: input.clearApiKey === true };
}

function validateModelSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['connectionId', 'model'].includes(key))) throw new Error('Model selection is invalid.');
  return { connectionId: validateOpaqueId(input.connectionId, 'Endpoint ID'), model: validateLiteLLMModelInput(input.model) };
}

function validateModelConfiguration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['connectionId', 'model', 'enabled', 'roles'].includes(key))) throw new Error('Model configuration is invalid.');
  const selection = validateModelSelection({ connectionId: input.connectionId, model: input.model });
  if (typeof input.enabled !== 'boolean') throw new Error('Model enabled state must be a boolean.');
  if (!Array.isArray(input.roles) || input.roles.length > 2 || input.roles.some((role) => !['agent', 'media'].includes(role))) throw new Error('Choose Agent, Media, or both roles.');
  return { ...selection, enabled: input.enabled, roles: [...new Set(input.roles)] };
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

function validateProjectAssetId(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(value)) throw new Error('Project asset ID is invalid.');
  return value;
}

function validateDocumentPath(value) {
  const documentPath = require('./canvas-project').validateFilePath(value);
  if (!/\.html?$/i.test(documentPath)) throw new Error('Project documents must be authored HTML files.');
  return documentPath;
}

function validateProjectInput(input = {}, { document = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['title', 'kits', ...(document ? ['path'] : [])].includes(key))) throw new Error('Project details are invalid.');
  return { title: validateCanvasTitle(input.title || (document ? 'Untitled document' : 'Untitled project')), ...(input.kits === undefined ? {} : { kits: validateCanvasKits(input.kits) }), ...(document && input.path !== undefined ? { path: validateDocumentPath(input.path) } : {}) };
}

function validateCanvasKits(value = []) {
  if (!Array.isArray(value) || value.length > ALLOWED_RUNTIME_KITS.size) throw new Error('Canvas kit preferences are invalid.');
  return [...new Set(value.map((kit) => {
    if (typeof kit !== 'string' || !ALLOWED_RUNTIME_KITS.has(kit)) throw new Error('Canvas kit preference is invalid.');
    return kit;
  }))];
}

function validateProjectKits(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['kits', 'expectedProjectRevision'].includes(key)) || !Object.hasOwn(input, 'kits')) throw new Error('Project kit settings are invalid.');
  if (typeof input.expectedProjectRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedProjectRevision)) throw new Error('Read the project kit settings before changing them.');
  return { kits: validateCanvasKits(input.kits), expectedProjectRevision: input.expectedProjectRevision };
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
  validateLiteLLMModelInput,
  validateChatOptions,
  validateCanvasBounds,
  validateCanvasTitle,
  validateCanvasKits,
  validateOpaqueId,
  validateProjectAssetId,
  validateDocumentPath,
  validateProjectInput,
  validateProjectKits,
  validateSettingsInput,
  validateConnectionInput,
  validateModelSelection,
  validateModelConfiguration,
};
