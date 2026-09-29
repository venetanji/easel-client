const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiteLLMModelService, normalizeModelCatalog } = require('../src/litellm-models');

test('normalizes LiteLLM model catalogs to unique selectable IDs', () => {
  assert.deepEqual(normalizeModelCatalog({ data: [
    { id: ' provider/model-a ', name: 'Model A' },
    { id: 'model-b' },
    { id: 'model-b' },
    { name: 'missing-id' },
  ] }), [
    { id: 'provider/model-a', name: 'Model A' },
    { id: 'model-b', name: 'model-b' },
  ]);
});

test('lists models from the configured OpenAI-compatible API', async () => {
  let options;
  const service = createLiteLLMModelService({
    settingsStore: {
      loadPublic: () => ({ litellmBaseUrl: 'http://localhost:4000/v1' }),
      loadSecrets: () => ({ litellmApiKey: 'secret-key' }),
    },
    openAIClientFactory: (input) => {
      options = input;
      return { models: { list: async () => ({ data: [{ id: 'model-a' }] }) } };
    },
  });
  assert.deepEqual(await service.listModels(), [{ id: 'model-a', name: 'model-a' }]);
  assert.equal(options.baseURL, 'http://localhost:4000/v1');
  assert.equal(options.apiKey, 'secret-key');
});

test('omits bearer authorization when the endpoint has no API key', async () => {
  let options;
  const service = createLiteLLMModelService({
    settingsStore: {
      loadPublic: () => ({ litellmBaseUrl: 'http://localhost:4000/v1' }),
      loadSecrets: () => ({}),
    },
    fetchImpl: async (_input, init) => {
      options.requestHeaders = new Headers(init.headers);
      return { ok: true };
    },
    openAIClientFactory: (input) => {
      options = input;
      return { models: { list: async () => ({ data: [] }) } };
    },
  });
  await service.listModels();
  await options.fetch('http://localhost:4000/v1/models', {
    headers: new Headers({ authorization: `Bearer ${options.apiKey}` }),
  });
  assert.equal(options.requestHeaders.has('authorization'), false);
});

test('runs explicit chat and image probes with the selected model', async () => {
  const calls = [];
  const service = createLiteLLMModelService({
    settingsStore: {
      loadPublic: () => ({ litellmBaseUrl: 'https://llm.example/v1' }),
      loadSecrets: () => ({ litellmApiKey: 'secret-key' }),
    },
    openAIClientFactory: () => ({
      responses: { create: async (input) => { calls.push(['chat', input]); return { output_text: 'Probe reply.' }; } },
      images: { generate: async (input) => { calls.push(['image', input]); return { data: [{ b64_json: 'not-returned-to-renderer' }] }; } },
    }),
  });
  assert.deepEqual(await service.testChat('model-a'), { ok: true, message: 'Text response received.' });
  assert.deepEqual(await service.testImage('model-b'), { ok: true, message: 'Image generation response received.' });
  assert.deepEqual(calls.map(([type, input]) => [type, input.model]), [['chat', 'model-a'], ['image', 'model-b']]);
});

test('returns clear probe errors without exposing the configured API key', async () => {
  const service = createLiteLLMModelService({
    settingsStore: {
      loadPublic: () => ({ litellmBaseUrl: 'https://llm.example/v1' }),
      loadSecrets: () => ({ litellmApiKey: 'secret-key' }),
    },
    openAIClientFactory: () => ({
      responses: { create: async () => { throw new Error('request failed with secret-key'); } },
      images: { generate: async () => { throw new Error('image failed'); } },
    }),
  });
  await assert.rejects(service.testChat('model-a'), /request failed with \[redacted\]/);
  await assert.rejects(service.testImage('model-a'), /image failed/);
});

test('rejects empty image-generation responses as failed media probes', async () => {
  const service = createLiteLLMModelService({
    settingsStore: {
      loadPublic: () => ({ litellmBaseUrl: 'http://localhost:4000/v1' }),
      loadSecrets: () => ({ litellmApiKey: 'secret-key' }),
    },
    openAIClientFactory: () => ({
      images: { generate: async () => ({ data: [{}] }) },
    }),
  });
  await assert.rejects(service.testImage('model-a'), /no image payload/i);
});

test('rejects invalid selected models before making API requests', async () => {
  const service = createLiteLLMModelService({
    settingsStore: { loadPublic: () => ({ litellmBaseUrl: 'http://localhost:4000/v1' }), loadSecrets: () => ({}) },
    openAIClientFactory: () => { throw new Error('must not construct client'); },
  });
  await assert.rejects(service.testChat(' '), /model is required/i);
});
