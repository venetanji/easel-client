const IPC_CHANNELS = Object.freeze({
  GET_SETTINGS: 'settings:get',
  SAVE_SETTINGS: 'settings:save',
  SEND_MESSAGE: 'chat:send',
  AGENT_EVENT: 'agent:event',
});

const SETTING_KEYS = new Set([
  'easelBaseUrl', 'easelApiKey', 'clearEaselApiKey',
  'litellmBaseUrl', 'litellmModel', 'litellmApiKey', 'clearLiteLLMApiKey',
]);
const KNOWN_CHANNELS = new Set(Object.values(IPC_CHANNELS));
const MAX_MESSAGE_LENGTH = 20_000;

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

module.exports = {
  IPC_CHANNELS,
  assertKnownChannel,
  assertTrustedSender,
  validateChatMessage,
  validateSettingsInput,
};
