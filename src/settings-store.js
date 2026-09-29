const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILENAME = 'settings.json';
const DEFAULT_SETTINGS = Object.freeze({
  easelBaseUrl: 'https://easel.ait4x.org',
  litellmBaseUrl: 'http://127.0.0.1:4000/v1',
  litellmModel: '',
});

function normalizeUrl(value, field, fallback) {
  const input = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${field} must be a valid HTTP(S) URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${field} must use HTTP(S).`);
  }
  if (url.username || url.password) {
    throw new Error(`${field} must not contain embedded credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${field} must not contain a query string or fragment.`);
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
}

function validateSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Settings must be an object.');
  }

  const allowed = new Set([
    'easelBaseUrl', 'easelApiKey', 'clearEaselApiKey',
    'litellmBaseUrl', 'litellmModel', 'litellmApiKey', 'clearLiteLLMApiKey',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported setting: ${key}`);
  }

  const easelApiKey = input.easelApiKey ?? '';
  const litellmApiKey = input.litellmApiKey ?? '';
  const litellmModel = input.litellmModel ?? '';
  if (typeof easelApiKey !== 'string' || easelApiKey.length > 4096) {
    throw new Error('Easel API key must be a string no longer than 4096 characters.');
  }
  if (typeof litellmApiKey !== 'string' || litellmApiKey.length > 4096) {
    throw new Error('LiteLLM API key must be a string no longer than 4096 characters.');
  }
  if (typeof litellmModel !== 'string' || litellmModel.trim().length > 256) {
    throw new Error('LiteLLM model must be a string no longer than 256 characters.');
  }

  return {
    easelBaseUrl: normalizeUrl(input.easelBaseUrl, 'Easel URL', DEFAULT_SETTINGS.easelBaseUrl),
    litellmBaseUrl: normalizeUrl(input.litellmBaseUrl, 'LiteLLM URL', DEFAULT_SETTINGS.litellmBaseUrl),
    litellmModel: litellmModel.trim(),
    easelApiKey: easelApiKey.trim(),
    litellmApiKey: litellmApiKey.trim(),
    clearEaselApiKey: input.clearEaselApiKey === true,
    clearLiteLLMApiKey: input.clearLiteLLMApiKey === true,
  };
}

function createSettingsStore({ userDataPath, safeStorage, fileSystem = fs }) {
  const settingsPath = path.join(userDataPath, SETTINGS_FILENAME);

  function readPersisted() {
    if (!fileSystem.existsSync(settingsPath)) return {};
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(settingsPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw new Error('Saved settings could not be read.');
    }
  }

  function decryptKey(value) {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable; saved API keys cannot be read.');
    }
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      throw new Error('Saved API credentials could not be decrypted.');
    }
  }

  function loadSecrets() {
    const saved = readPersisted();
    return {
      easelApiKey: decryptKey(saved.easelApiKeyEncrypted),
      litellmApiKey: decryptKey(saved.litellmApiKeyEncrypted),
    };
  }

  function loadPublic() {
    const saved = readPersisted();
    return {
      ...DEFAULT_SETTINGS,
      easelBaseUrl: saved.easelBaseUrl || DEFAULT_SETTINGS.easelBaseUrl,
      litellmBaseUrl: saved.litellmBaseUrl || DEFAULT_SETTINGS.litellmBaseUrl,
      litellmModel: saved.litellmModel || '',
      hasEaselApiKey: Boolean(saved.easelApiKeyEncrypted),
      hasLiteLLMApiKey: Boolean(saved.litellmApiKeyEncrypted),
    };
  }

  function save(input) {
    const next = validateSettings(input);
    const saved = readPersisted();
    const hasNewSecrets = Boolean(next.easelApiKey || next.litellmApiKey);
    const hasExistingSecrets = Boolean(saved.easelApiKeyEncrypted || saved.litellmApiKeyEncrypted);
    if ((hasNewSecrets || hasExistingSecrets) && !safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable; API keys were not saved.');
    }

    const nextEaselKey = next.clearEaselApiKey
      ? ''
      : next.easelApiKey || decryptKey(saved.easelApiKeyEncrypted);
    const nextLiteLLMKey = next.clearLiteLLMApiKey
      ? ''
      : next.litellmApiKey || decryptKey(saved.litellmApiKeyEncrypted);
    const persisted = {
      easelBaseUrl: next.easelBaseUrl,
      litellmBaseUrl: next.litellmBaseUrl,
      litellmModel: next.litellmModel,
      easelApiKeyEncrypted: nextEaselKey ? safeStorage.encryptString(nextEaselKey).toString('base64') : '',
      litellmApiKeyEncrypted: nextLiteLLMKey ? safeStorage.encryptString(nextLiteLLMKey).toString('base64') : '',
    };

    fileSystem.mkdirSync(userDataPath, { recursive: true });
    fileSystem.writeFileSync(settingsPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    return loadPublic();
  }

  return { loadPublic, loadSecrets, save };
}

module.exports = { createSettingsStore, DEFAULT_SETTINGS, validateSettings };
