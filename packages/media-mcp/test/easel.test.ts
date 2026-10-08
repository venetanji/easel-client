import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateImages, listModels, normalizeEaselBaseUrl } from '../src/easel.js';
import { images as imageFixtures } from './fixtures/images.js';

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
  const png = imageFixtures[0].data;
  let request: { url: string; init?: RequestInit } | undefined;
  const images = await generateImages({
    baseUrl: 'https://easel.ait4x.org/',
    prompt: ' a paper lantern ',
    model: 'flux2-9b',
    n: 2,
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ b64_json: png }, { b64_json: png }] }), { status: 200 });
    },
  });
  assert.deepEqual(images, [
    { data: png, mimeType: 'image/png' },
    { data: png, mimeType: 'image/png' },
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

for (const fixture of imageFixtures) {
  test(`image generation preserves ${fixture.mimeType} from a same-origin download`, async () => {
    const result = await generateImages({ prompt: 'a dot', baseUrl: 'https://easel.test', responseFormat: 'url',
      fetchImpl: async (url, init) => {
        if (init?.method === 'POST') return Response.json({ data: [{ url: '/generated/image' }] });
        assert.equal(String(url), 'https://easel.test/generated/image');
        return new Response(Buffer.from(fixture.data, 'base64'), { headers: { 'Content-Type': fixture.mimeType } });
      },
    });
    assert.deepEqual(result, [{ data: fixture.data, mimeType: fixture.mimeType }]);
  });

  test(`image generation detects ${fixture.mimeType} from base64 bytes`, async () => {
    const result = await generateImages({ prompt: 'a dot', fetchImpl: async () => Response.json({ data: [{ b64_json: fixture.data }] }) });
    assert.deepEqual(result, [{ data: fixture.data, mimeType: fixture.mimeType }]);
  });
}

test('image generation rejects unsupported bytes and noncanonical base64', async () => {
  for (const b64_json of ['YWJj', '', '!!!!', 'Zh==']) {
    await assert.rejects(generateImages({ prompt: 'a dot', fetchImpl: async () => Response.json({ data: [{ b64_json }] }) }), /image bytes/);
  }
});
