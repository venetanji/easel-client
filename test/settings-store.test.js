const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSettingsStore, validateSettings } = require('../src/settings-store');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'easel-settings-'));
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) { return Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a); },
    decryptString(value) { return Buffer.from(value).map((byte) => byte ^ 0x5a).toString('utf8'); },
  };
}

test('settings store encrypts keys and never returns them in public settings', (t) => {
  const userDataPath = createTempDir();
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createSettingsStore({ userDataPath, safeStorage: fakeSafeStorage() });

  store.save({
    easelBaseUrl: 'https://easel.ait4x.org',
    easelApiKey: 'easel-secret',
    litellmBaseUrl: 'http://127.0.0.1:4000/v1',
    litellmModel: 'design-model',
    litellmApiKey: 'llm-secret',
  });

  const persisted = fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf8');
  assert.doesNotMatch(persisted, /easel-secret|llm-secret/);
  assert.deepEqual(store.loadSecrets(), {
    easelApiKey: 'easel-secret',
    litellmApiKey: 'llm-secret',
  });
  assert.equal(Object.hasOwn(store.loadPublic(), 'easelApiKey'), false);
  assert.equal(Object.hasOwn(store.loadPublic(), 'litellmApiKey'), false);
  assert.equal(store.loadPublic().hasEaselApiKey, true);
  assert.equal(store.loadPublic().hasLiteLLMApiKey, true);
});

test('settings store refuses to persist credentials when encryption is unavailable', (t) => {
  const userDataPath = createTempDir();
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createSettingsStore({ userDataPath, safeStorage: fakeSafeStorage(false) });

  assert.throws(() => store.save({ easelApiKey: 'secret' }), /secure storage is unavailable/i);
  assert.throws(() => store.saveConnection({ name: 'Example', baseUrl: 'https://example.test/v1', apiKey: 'secret' }), /secure storage is unavailable/i);
  assert.equal(fs.existsSync(path.join(userDataPath, 'settings.json')), false);
});

test('settings validation rejects non-HTTP URLs and embedded credentials', () => {
  assert.throws(() => validateSettings({ easelBaseUrl: 'file:///tmp' }), /HTTP|HTTPS/i);
  assert.throws(() => validateSettings({ litellmBaseUrl: 'https://user:pass@example.com/v1' }), /credentials/i);
  assert.equal(validateSettings({}).easelBaseUrl, 'https://easel.ait4x.org');
});
