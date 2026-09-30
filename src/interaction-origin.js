const BACKENDS = new Set(['builtin', 'external', 'codex']);
const THREAD_ID = /^[A-Za-z0-9_-]{1,160}$/;
const CHAT_ID = /^[a-f0-9]{32}$/;

function validateInteractionOrigin(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['backend', 'chatId', 'threadId', 'model'].includes(key))) throw new Error('Interaction origin contains unsupported fields.');
  if (!BACKENDS.has(value.backend)) throw new Error('Interaction origin backend is invalid.');
  if (value.chatId !== undefined && (typeof value.chatId !== 'string' || !CHAT_ID.test(value.chatId))) throw new Error('Interaction origin chat ID is invalid.');
  if (value.threadId !== undefined && (typeof value.threadId !== 'string' || !THREAD_ID.test(value.threadId))) throw new Error('Interaction origin thread ID must contain 1 to 160 letters, digits, underscores or dashes.');
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256 || /[\u0000-\u001f\u007f]/.test(value.model))) throw new Error('Interaction origin model is invalid.');
  return { backend: value.backend, ...(value.chatId === undefined ? {} : { chatId: value.chatId }), ...(value.threadId === undefined ? {} : { threadId: value.threadId }), ...(value.model === undefined ? {} : { model: value.model.trim() }) };
}

module.exports = { validateInteractionOrigin };
