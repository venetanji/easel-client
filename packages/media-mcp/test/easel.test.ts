import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateImages, listModels, normalizeEaselBaseUrl } from '../src/easel.js';

test('normalizes Easel URL and defaults to the hosted service', () => {
  assert.equal(normalizeEaselBaseUrl(' https://easel.ait4x.org/v1/ '), 'https://easel.ait4x.org');
  assert.equal(normalizeEaselBaseUrl(''), 'https://easel.ait4x.org');
  assert.throws(() => normalizeEaselBaseUrl('file:///tmp'), /HTTP|HTTPS/i);
  assert.throws(() => normalizeEaselBaseUrl('https://user:pass@example.org'), /credentials/i);
});

test('lists Easel models with an optional bearer token', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const models = await listModels({
    baseUrl: 'https://easel.ait4x.org',
    apiKey: 'local-key',
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ id: 'flux2-9b' }, { id: 'qwen-image-2.1' }] }), { status: 200 });
    },
  });
  assert.deepEqual(models, ['flux2-9b', 'qwen-image-2.1']);
  assert.equal(request?.url, 'https://easel.ait4x.org/v1/models');
  assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer local-key');
});

test('rejects malformed model lists and sanitizes API errors', async () => {
  await assert.rejects(listModels({
    baseUrl: 'https://easel.ait4x.org',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ name: 'missing-id' }] }), { status: 200 }),
  }), /invalid model/i);
  await assert.rejects(listModels({
    baseUrl: 'https://easel.ait4x.org',
    apiKey: 'private-key',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'failed private-key' } }), { status: 401 }),
  }), (error: Error) => error.message.includes('[redacted]') && !error.message.includes('private-key'));
});

test('generates validated base64 images and rejects empty prompts', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const images = await generateImages({
    baseUrl: 'https://easel.ait4x.org/',
    prompt: ' a paper lantern ',
    model: 'flux2-9b',
    n: 2,
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }, { b64_json: 'ZGVm' }] }), { status: 200 });
    },
  });
  assert.deepEqual(images, [
    { data: 'YWJj', mimeType: 'image/png' },
    { data: 'ZGVm', mimeType: 'image/png' },
  ]);
  assert.equal(request?.url, 'https://easel.ait4x.org/v1/images/generations');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    prompt: 'a paper lantern',
    model: 'flux2-9b',
    n: 2,
    response_format: 'b64_json',
  });
  await assert.rejects(generateImages({ baseUrl: 'https://easel.ait4x.org', prompt: ' ' }), /prompt is required/i);
  await assert.rejects(generateImages({ baseUrl: 'https://easel.ait4x.org', prompt: 'x', n: 5 }), /between 1 and 4/i);
});
