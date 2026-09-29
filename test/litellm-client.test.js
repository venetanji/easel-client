const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiteLLMClient, normalizeLiteLLMBaseUrl } = require('../src/litellm-client');

function completionResponse(message = { role: 'assistant', content: 'Ready.' }) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'design-model',
    choices: [{ index: 0, finish_reason: 'stop', message }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('normalizes LiteLLM base URLs and rejects unsafe endpoints', () => {
  assert.equal(normalizeLiteLLMBaseUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000/v1');
  assert.equal(normalizeLiteLLMBaseUrl('https://llm.example/proxy/v1/'), 'https://llm.example/proxy/v1');
  assert.throws(() => normalizeLiteLLMBaseUrl('file:///tmp'), /HTTP|HTTPS/i);
  assert.throws(() => normalizeLiteLLMBaseUrl('https://user:pass@example.org'), /credentials/i);
  assert.throws(() => normalizeLiteLLMBaseUrl('https://llm.example/v1?token=secret'), /query/i);
});

test('uses the official OpenAI SDK with configured LiteLLM model, tools, and key', async () => {
  const requests = [];
  const client = createLiteLLMClient({
    baseUrl: 'https://llm.example/v1/',
    apiKey: 'proxy-secret',
    model: 'design-model',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return completionResponse({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_models', arguments: '{}' } }],
      });
    },
  });
  const response = await client.createCompletion({
    messages: [{ role: 'user', content: 'make an image' }],
    tools: [{ type: 'function', function: { name: 'list_models', parameters: { type: 'object' } } }],
  });
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'list_models');
  assert.equal(requests[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer proxy-secret');
  const payload = JSON.parse(String(requests[0].init.body));
  assert.equal(payload.model, 'design-model');
  assert.equal(payload.tools[0].function.name, 'list_models');
});

test('omits authorization when LiteLLM has no API key', async () => {
  let headers;
  const client = createLiteLLMClient({
    baseUrl: 'http://127.0.0.1:4000/v1',
    model: 'local-model',
    fetchImpl: async (_url, init) => {
      headers = new Headers(init.headers);
      return completionResponse();
    },
  });
  await client.createCompletion({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(headers.has('authorization'), false);
});

test('redacts configured credentials from LiteLLM errors', async () => {
  const client = createLiteLLMClient({
    baseUrl: 'https://llm.example/v1',
    apiKey: 'hidden-token',
    model: 'model-a',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'invalid hidden-token' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    client.createCompletion({ messages: [{ role: 'user', content: 'hello' }] }),
    (error) => error.message.includes('[redacted]') && !error.message.includes('hidden-token'),
  );
});
