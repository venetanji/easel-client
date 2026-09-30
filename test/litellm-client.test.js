const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiteLLMClient, normalizeLiteLLMBaseUrl } = require('../src/litellm-client');

function responseStream(events) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('normalizes LiteLLM base URLs and rejects unsafe endpoints', () => {
  assert.equal(normalizeLiteLLMBaseUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000/v1');
  assert.equal(normalizeLiteLLMBaseUrl('https://llm.example/proxy/v1/'), 'https://llm.example/proxy/v1');
  assert.throws(() => normalizeLiteLLMBaseUrl('file:///tmp'), /HTTP|HTTPS/i);
  assert.throws(() => normalizeLiteLLMBaseUrl('https://user:pass@example.org'), /credentials/i);
  assert.throws(() => normalizeLiteLLMBaseUrl('https://llm.example/v1?token=secret'), /query/i);
});

test('uses streamed Responses API with configured model, tools, history, and key', async () => {
  const requests = [];
  const client = createLiteLLMClient({
    baseUrl: 'https://llm.example/v1/',
    apiKey: 'proxy-secret',
    model: 'design-model',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return responseStream([
        { type: 'response.output_text.delta', delta: 'Ready.' },
        { type: 'response.completed', response: { id: 'resp-test', output: [] } },
      ]);
    },
  });
  const response = await client.createCompletion({
    messages: [
      { role: 'user', content: 'List image models.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_models', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Available models: flux2.' },
    ],
    tools: [{ type: 'function', function: { name: 'list_models', description: 'List image models', parameters: { type: 'object' } } }],
  });
  assert.equal(response.choices[0].message.content, 'Ready.');
  assert.equal(requests[0].url, 'https://llm.example/v1/responses');
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer proxy-secret');
  const payload = JSON.parse(String(requests[0].init.body));
  assert.equal(payload.model, 'design-model');
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'List image models.' }] },
    { type: 'function_call', call_id: 'call_1', name: 'list_models', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'Available models: flux2.' },
  ]);
  assert.deepEqual(payload.tools[0], {
    type: 'function', name: 'list_models', description: 'List image models', parameters: { type: 'object' }, strict: false,
  });
});

test('assembles streamed function calls when the completed response output is empty', async () => {
  const client = createLiteLLMClient({
    baseUrl: 'https://llm.example/v1',
    model: 'design-model',
    fetchImpl: async () => responseStream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'list_models', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'list_models', arguments: '{}' } },
      { type: 'response.completed', response: { id: 'resp-test', output: [] } },
    ]),
  });
  const response = await client.createCompletion({ messages: [{ role: 'user', content: 'List models.' }] });
  assert.deepEqual(response.choices[0].message.tool_calls, [{
    id: 'call_1', type: 'function', function: { name: 'list_models', arguments: '{}' },
  }]);
});

test('omits authorization when LiteLLM has no API key', async () => {
  let headers;
  const client = createLiteLLMClient({
    baseUrl: 'http://127.0.0.1:4000/v1',
    model: 'local-model',
    fetchImpl: async (_url, init) => {
      headers = new Headers(init.headers);
      return responseStream([
        { type: 'response.output_text.delta', delta: 'Ready.' },
        { type: 'response.completed', response: { id: 'resp-test', output: [] } },
      ]);
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
