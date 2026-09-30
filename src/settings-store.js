const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeLiteLLMBaseUrl } = require('./litellm-client');

const SETTINGS_FILENAME = 'settings.json';
const LEGACY_CONNECTION_ID = '00000000000000000000000000000001';
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

  function readConnections(saved) {
    const connections = Array.isArray(saved.connections) ? saved.connections.map((entry) => ({ ...entry })) : [];
    if (!Array.isArray(saved.connections) && (saved.litellmBaseUrl || saved.litellmApiKeyEncrypted || saved.litellmModel)) {
      const baseUrl = saved.litellmBaseUrl || DEFAULT_SETTINGS.litellmBaseUrl;
      connections.push({ id: LEGACY_CONNECTION_ID, name: new URL(baseUrl).host, baseUrl, apiKeyEncrypted: saved.litellmApiKeyEncrypted || '' });
    }
    if (!saved.unifiedCredentials && (saved.easelBaseUrl || saved.easelApiKeyEncrypted)) {
      const baseUrl = normalizeLiteLLMBaseUrl(saved.easelBaseUrl || DEFAULT_SETTINGS.easelBaseUrl);
      connections.push({ id: '00000000000000000000000000000002', name: new URL(baseUrl).host, baseUrl, apiKeyEncrypted: saved.easelApiKeyEncrypted || '', defaultRole: 'media' });
    }
    return connections;
  }

  function activeConnection(saved) {
    const connections = readConnections(saved);
    return connections.find((entry) => entry.id === saved.activeConnectionId) || connections.find((entry) => entry.id === LEGACY_CONNECTION_ID) || connections[0];
  }

  function readModels(saved) {
    const models = Array.isArray(saved.models) ? saved.models.map((entry) => ({ ...entry, roles: [...entry.roles] })) : [];
    const active = activeConnection(saved);
    if (!Array.isArray(saved.models) && active && saved.litellmModel) {
      models.push({ connectionId: active.id, model: saved.litellmModel, name: saved.litellmModel, enabled: true, roles: ['agent'] });
    }
    return models;
  }

  function loadSecrets(connectionId) {
    const saved = readPersisted();
    const connections = readConnections(saved);
    const connection = connectionId ? connections.find((entry) => entry.id === connectionId) : activeConnection(saved);
    if (connectionId && !connection) throw new Error('Endpoint was not found.');
    const legacyMedia = connections.find((entry) => entry.id === '00000000000000000000000000000002');
    return {
      easelApiKey: connectionId ? '' : decryptKey(legacyMedia?.apiKeyEncrypted),
      litellmApiKey: decryptKey(connection?.apiKeyEncrypted),
    };
  }

  function getConnectionRevision(id) {
    require('./ipc-contract').validateOpaqueId(id, 'Endpoint ID');
    const connection = readConnections(readPersisted()).find((entry) => entry.id === id);
    return connection ? crypto.createHash('sha256').update(JSON.stringify([connection.id, connection.baseUrl, connection.apiKeyEncrypted || ''])).digest('hex') : '';
  }

  function loadPublic() {
    const saved = readPersisted();
    const connection = activeConnection(saved);
    const connections = readConnections(saved);
    const legacyMedia = connections.find((entry) => entry.id === '00000000000000000000000000000002');
    return {
      ...DEFAULT_SETTINGS,
      easelBaseUrl: legacyMedia?.baseUrl.replace(/\/v1$/, '') || DEFAULT_SETTINGS.easelBaseUrl,
      litellmBaseUrl: connection?.baseUrl || DEFAULT_SETTINGS.litellmBaseUrl,
      litellmModel: saved.litellmModel || '',
      activeConnectionId: connection?.id || '',
      connections: connections.map(({ id, name, baseUrl, apiKeyEncrypted }) => ({ id, name, baseUrl, hasApiKey: Boolean(apiKeyEncrypted) })),
      models: readModels(saved),
      hasEaselApiKey: Boolean(legacyMedia?.apiKeyEncrypted),
      hasLiteLLMApiKey: Boolean(connection?.apiKeyEncrypted),
    };
  }

  function writePersisted(saved) {
    fileSystem.mkdirSync(userDataPath, { recursive: true });
    const temporary = settingsPath + '.' + crypto.randomUUID() + '.tmp';
    fileSystem.writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
    try { fileSystem.renameSync(temporary, settingsPath); }
    catch (error) { fileSystem.rmSync(temporary, { force: true }); throw error; }
  }

  function canonical(saved) {
    return { connections: readConnections(saved), models: readModels(saved), activeConnectionId: activeConnection(saved)?.id || '', litellmModel: saved.litellmModel || '', unifiedCredentials: true };
  }

  function encryptKey(value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable; the API key was not saved.');
    return safeStorage.encryptString(value).toString('base64');
  }

  function save(input = {}) {
    const clean = validateSettings(input);
    const saved = canonical(readPersisted());
    if ((clean.easelApiKey || clean.litellmApiKey || saved.connections.some((entry) => entry.apiKeyEncrypted)) && !safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable; API keys were not saved.');
    const legacyInputs = [
      { id: '00000000000000000000000000000002', fields: ['easelBaseUrl', 'easelApiKey', 'clearEaselApiKey'], baseUrl: clean.easelBaseUrl, apiKey: clean.easelApiKey, clear: clean.clearEaselApiKey, role: 'media' },
      { id: saved.activeConnectionId || LEGACY_CONNECTION_ID, fields: ['litellmBaseUrl', 'litellmApiKey', 'clearLiteLLMApiKey', 'litellmModel'], baseUrl: clean.litellmBaseUrl, apiKey: clean.litellmApiKey, clear: clean.clearLiteLLMApiKey },
    ];
    for (const entry of legacyInputs) {
      if (!entry.fields.some((field) => Object.hasOwn(input, field))) continue;
      const index = saved.connections.findIndex((connection) => connection.id === entry.id);
      const existing = saved.connections[index];
      const baseUrl = entry.fields.some((field) => field.endsWith('BaseUrl') && Object.hasOwn(input, field)) ? entry.baseUrl : existing?.baseUrl || entry.baseUrl;
      const next = { id: entry.id, name: existing?.name || new URL(baseUrl).host, baseUrl, apiKeyEncrypted: entry.clear ? '' : entry.apiKey ? encryptKey(entry.apiKey) : existing?.apiKeyEncrypted || '', ...(entry.role ? { defaultRole: entry.role } : {}) };
      if (index < 0) saved.connections.push(next); else saved.connections[index] = next;
      if (!entry.role) saved.activeConnectionId = entry.id;
    }
    if (Object.hasOwn(input, 'litellmModel')) {
      saved.litellmModel = clean.litellmModel;
      if (clean.litellmModel && !saved.models.some((entry) => entry.connectionId === saved.activeConnectionId && entry.model === clean.litellmModel)) saved.models.push({ connectionId: saved.activeConnectionId, model: clean.litellmModel, name: clean.litellmModel, enabled: true, roles: ['agent'] });
    }
    writePersisted(saved);
    return loadPublic();
  }

  function saveConnection(input) {
    const next = require('./ipc-contract').validateConnectionInput(input);
    const saved = canonical(readPersisted());
    const existing = next.id ? saved.connections.find((entry) => entry.id === next.id) : null;
    if (next.id && !existing) throw new Error('Endpoint was not found.');
    if (!existing && saved.connections.length >= 16) throw new Error('You can save up to 16 endpoints.');
    const baseUrl = normalizeLiteLLMBaseUrl(normalizeUrl(next.baseUrl, 'Endpoint URL'));
    const entry = { ...existing, id: existing?.id || crypto.randomUUID().replaceAll('-', ''), name: next.name || new URL(baseUrl).host, baseUrl, apiKeyEncrypted: next.clearApiKey ? '' : next.apiKey ? encryptKey(next.apiKey) : existing?.apiKeyEncrypted || '' };
    if (existing && (existing.baseUrl !== baseUrl || next.apiKey || next.clearApiKey)) {
      for (const model of saved.models.filter((model) => model.connectionId === existing.id)) {
        delete model.capabilities;
        model.roles = [...(model.discoveryRoles || model.roles)];
      }
    }
    const index = saved.connections.findIndex((connection) => connection.id === entry.id);
    if (index >= 0) saved.connections[index] = entry; else saved.connections.push(entry);
    writePersisted(saved);
    return loadPublic();
  }

  function removeConnection(id) {
    require('./ipc-contract').validateOpaqueId(id, 'Endpoint ID');
    const saved = canonical(readPersisted());
    if (!saved.connections.some((entry) => entry.id === id)) throw new Error('Endpoint was not found.');
    saved.connections = saved.connections.filter((entry) => entry.id !== id);
    saved.models = saved.models.filter((entry) => entry.connectionId !== id);
    if (saved.activeConnectionId === id) { saved.activeConnectionId = ''; saved.litellmModel = ''; }
    writePersisted(saved);
    return loadPublic();
  }

  function recordModels(catalog) {
    const saved = canonical(readPersisted());
    for (const result of catalog) {
      const connection = saved.connections.find((entry) => entry.id === result.connectionId);
      if (!connection || result.error || !Array.isArray(result.models)) continue;
      // A successful discovery is authoritative for this endpoint, including an empty list.
      const available = new Set(result.models.map((model) => model.id));
      saved.models = saved.models.filter((model) => model.connectionId !== connection.id || available.has(model.model));
      for (const model of result.models) {
        const existing = saved.models.find((entry) => entry.connectionId === connection.id && entry.model === model.id);
        const roles = model.suggestedRoles || [model.suggestedRole === 'media' ? 'media' : 'agent'];
        if (existing) {
          existing.name = model.name;
          existing.discoveryRoles = [...roles];
          if (!existing.capabilities) existing.roles = [...roles];
          if (!existing.roles.length) existing.enabled = false;
          continue;
        }
        if (saved.models.length >= 4096) break;
        saved.models.push({ connectionId: connection.id, model: model.id, name: model.name, enabled: connection.defaultRole === 'media' && roles.includes('media'), roles: [...roles], discoveryRoles: [...roles] });
      }
    }
    if (saved.litellmModel && !saved.models.some((entry) => entry.connectionId === saved.activeConnectionId && entry.model === saved.litellmModel && entry.enabled && entry.roles.includes('agent'))) {
      const enabledAgents = saved.models.filter((entry) => entry.enabled && entry.roles.includes('agent'));
      const fallback = enabledAgents.find((entry) => entry.connectionId === saved.activeConnectionId) || enabledAgents[0];
      if (fallback) saved.activeConnectionId = fallback.connectionId;
      saved.litellmModel = fallback?.model || '';
    }
    writePersisted(saved);
    return loadPublic();
  }

  function updateModel(input) {
    const clean = require('./ipc-contract').validateModelConfiguration(input);
    const saved = canonical(readPersisted());
    const entry = saved.models.find((model) => model.connectionId === clean.connectionId && model.model === clean.model);
    if (!entry) throw new Error('Model was not found. Refresh the model list.');
    if (clean.roles.length !== entry.roles.length || clean.roles.some((role) => !entry.roles.includes(role))) throw new Error('Model categories are assigned automatically. Check capabilities to update them.');
    if (clean.enabled && !entry.roles.length) throw new Error('Check this model to confirm a supported capability before enabling it.');
    Object.assign(entry, clean);
    if (saved.activeConnectionId === clean.connectionId && saved.litellmModel === clean.model && (!clean.enabled || !clean.roles.includes('agent'))) saved.litellmModel = '';
    writePersisted(saved);
    return loadPublic();
  }

  function recordCapabilities({ connectionId, model }, capabilities) {
    const saved = canonical(readPersisted());
    const entry = saved.models.find((entry) => entry.connectionId === connectionId && entry.model === model);
    if (!entry) throw new Error('Model was removed while its capabilities were being checked.');
    entry.capabilities = { ...capabilities, checkedAt: Date.now() };
    entry.roles = ['agent', 'media'].filter((role) => capabilities[role].status === 'supported'
      || (capabilities[role].status === 'unknown' && entry.roles.includes(role)));
    if (!entry.roles.length) entry.enabled = false;
    if (saved.activeConnectionId === connectionId && saved.litellmModel === model && !entry.roles.includes('agent')) saved.litellmModel = '';
    writePersisted(saved);
    return loadPublic();
  }

  function selectModel(input) {
    const clean = require('./ipc-contract').validateModelSelection(input);
    const saved = canonical(readPersisted());
    if (!saved.models.some((entry) => entry.connectionId === clean.connectionId && entry.model === clean.model && entry.enabled && entry.roles.includes('agent'))) throw new Error('Enable an Agent model in Settings > Models before selecting it.');
    saved.activeConnectionId = clean.connectionId;
    saved.litellmModel = clean.model;
    writePersisted(saved);
    return loadPublic();
  }

  return { loadPublic, loadSecrets, getConnectionRevision, save, saveConnection, removeConnection, recordModels, recordCapabilities, updateModel, selectModel };
}

module.exports = { createSettingsStore, DEFAULT_SETTINGS, validateSettings };
