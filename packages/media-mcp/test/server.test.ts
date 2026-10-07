import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMediaServer, registerMediaTools } from '../src/server.js';

const fakeEasel = {
  listModels: async () => ['flux2-9b'],
  generateImages: async () => [{ data: 'YWJj', mimeType: 'image/png' as const }],
  captureCanvasScreenshot: async () => ({ data: 'iVBORw0KGgo=', mimeType: 'image/png' as const }),
};

test('registers only allowlisted media tools and returns image content', async () => {
  const registered = new Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<unknown> }>();
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<unknown>) {
      registered.set(name, { config, handler });
    },
  };
  registerMediaTools(server as never, {
    easel: fakeEasel,
    canvas: {
      capture: async () => ({ data: Buffer.from('iVBORw0KGgo=', 'base64'), mimeType: 'image/png' }),
    },
  });
  assert.deepEqual([...registered.keys()].sort(), ['capture_canvas_screenshot', 'generate_image', 'list_models']);
  const models = await registered.get('list_models')!.handler({});
  assert.deepEqual(models, {
    content: [{ type: 'text', text: 'Available Media models: ["flux2-9b"]' }],
    structuredContent: { models: ['flux2-9b'] },
  });
  const image = await registered.get('generate_image')!.handler({ prompt: 'a cat' }) as { content: unknown[] };
  assert.deepEqual(image.content, [
    { type: 'text', text: 'Generated 1 image.' },
    { type: 'image', data: 'YWJj', mimeType: 'image/png' },
  ]);
  const screenshot = await registered.get('capture_canvas_screenshot')!.handler({ html: '<p>offline</p>' }) as { content: unknown[] };
  assert.deepEqual(screenshot.content, [
    { type: 'text', text: 'Canvas screenshot captured.' },
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  ]);
});

test('serves the allowlisted tools through MCP without external services', async (t) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMediaServer({ easel: fakeEasel });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'capture_canvas_screenshot', 'generate_image', 'list_models',
  ]);
  assert.doesNotMatch(listed.tools.find((tool) => tool.name === 'list_models')!.description || '', /not yet implemented/);
  const generated = await client.callTool({ name: 'generate_image', arguments: { prompt: 'a cat' } });
  assert.equal(generated.isError, undefined);
  assert.deepEqual(generated.content.map((item) => item.type), ['text', 'image']);
});

test('queued image guidance names the image retrieval tool', async (t) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMediaServer({ easel: {
    listModels: async () => ['qwen'],
    generateImages: async () => ({ job: { id: 'image_job_123', status: 'queued', providerStatus: 'queued' } }),
  } });
  const client = new Client({ name: 'queued-image-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'a cat' } });
  const content = result.content.find((item) => item.type === 'text');
  assert.equal(content?.type, 'text');
  assert.match(JSON.parse(content!.text as string).guidance, /get_image_job/);
});

test('advanced tools are typed and discovery routes through the selected video endpoint', async (t) => {
  const originalModels = process.env.EASEL_MEDIA_MODELS;
  const originalFetch = globalThis.fetch;
  process.env.EASEL_MEDIA_MODELS = JSON.stringify([
    { id: 'studio:video', model: 'ltx-2.5', name: 'Video', endpointName: 'Studio', baseUrl: 'https://studio.example/v1', apiKey: 'studio-secret', mediaTypes: ['video'] },
    { id: 'other:image', model: 'qwen-image-2.1', name: 'Image', endpointName: 'Other', baseUrl: 'https://other.example', apiKey: 'other-secret', mediaTypes: ['image'] },
  ]);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init }); return Response.json({ object: 'list', data: [] }); }) as typeof fetch;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMediaServer();
  const client = new Client({ name: 'advanced-test', version: '1' });
  t.after(async () => { globalThis.fetch = originalFetch; if (originalModels === undefined) delete process.env.EASEL_MEDIA_MODELS; else process.env.EASEL_MEDIA_MODELS = originalModels; await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  assert.ok(names.includes('discover_video_capabilities')); assert.ok(names.includes('list_video_loras'));
  const schema: any = listed.tools.find(tool => tool.name === 'generate_video')!.inputSchema;
  assert.equal(schema.properties.seed.type, 'string');
  assert.equal(schema.properties.loras.type, 'array');
  assert.equal(schema.properties.guidingFrames.items.additionalProperties, false);
  assert.deepEqual(schema.properties.model.enum, ['studio:video']);
  const result: any = await client.callTool({ name: 'list_video_loras', arguments: { model: 'studio:video' } });
  assert.equal(result.isError, undefined); assert.deepEqual(result.structuredContent, { modelId: 'studio:video', loras: [] });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://studio.example/v1/videos/loras');
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'Bearer studio-secret');
  assert.equal(calls[0].init?.method, 'GET');
  const rejected: any = await client.callTool({ name: 'list_video_loras', arguments: { model: 'other:image' } });
  assert.equal(rejected.isError, true); assert.equal(calls.length, 1);
  const malformed: any = await client.callTool({ name: 'generate_video', arguments: { model: 'studio:video', prompt: 'test', guidingFrames: [{ image: { data: 'abc', mimeType: 'image/png' }, frameIndex: 0, extra: 1 }] } });
  assert.equal(malformed.isError, true); assert.equal(calls.length, 1);
});

test('no video tools are advertised for image-only or disabled model configurations', async () => {
  const previous = process.env.EASEL_MEDIA_MODELS;
  try {
    for (const models of [[], [{ id: 'image', model: 'qwen', name: 'Image', endpointName: 'Local', baseUrl: 'https://example.test', apiKey: '', mediaTypes: ['image'] }]]) {
      process.env.EASEL_MEDIA_MODELS = JSON.stringify(models);
      const registered: string[] = [];
      registerMediaTools({ registerTool(name: string) { registered.push(name); } } as never);
      for (const name of ['generate_video', 'get_video', 'discover_video_capabilities', 'list_video_loras']) assert.equal(registered.includes(name), false);
    }
  } finally { if (previous === undefined) delete process.env.EASEL_MEDIA_MODELS; else process.env.EASEL_MEDIA_MODELS = previous; }
});

test('production MCP schema and asset bridge preserve advanced jobs through built-in and external harnesses', async (t) => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { runAgentTurn } = require('../../../src/agent');
  const { createEaselToolHost } = require('../../../src/easel-tool-host');
  const requests: any[] = [], receipts: any[] = [];
  const assetId = 'a'.repeat(32), projectId = 'b'.repeat(32);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMediaServer({ easel: { ...fakeEasel, generateVideo: async input => { requests.push(input); return { id: 'video_' + requests.length, status: 'queued', providerStatus: 'queued' }; } } });
  const client = new Client({ name: 'harness-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const mcp = { listTools: async () => (await client.listTools()).tools, callTool: async (name: string, args: any) => client.callTool({ name, arguments: args }), close: async () => {} };
  const canvasController = { getCurrentCanvasId: () => projectId, readMediaAsset: async (ref: any) => { assert.equal(ref.assetId, assetId); return { data: png, mimeType: 'image/png' }; } };
  const args = { model: 'ltx-2.5', prompt: 'Follow the anchor', seconds: 1, seed: '18446744073709551614', cameraLora: 'static', guidingFrames: [{ assetId, frameIndex: 24, strength: 0.6 }] };
  const registerMediaJob = async (input: any) => { receipts.push(input); return { id: 'c'.repeat(32), remoteId: input.job.id, modelId: input.modelId }; };
  let completions = 0;
  const builtin = await runAgentTurn({ userMessage: 'Make guided video', mcp, canvasController, registerMediaJob,
    llm: { createCompletion: async () => ({ choices: [{ message: completions++ === 0 ? { role: 'assistant', content: null, tool_calls: [{ id: 'guide', type: 'function', function: { name: 'generate_video', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Generating.' } }] }) } });
  assert.equal(builtin.awaitingMediaJob.remoteId, 'video_1');
  assert.doesNotMatch(JSON.stringify(builtin.history), new RegExp(png));
  const host = createEaselToolHost({ canvasController, createMediaClient: async () => mcp, registerMediaJob });
  const external = await host.callTool('generate_video', args);
  assert.equal(external.isError, undefined); assert.equal(external.structuredContent.monitoredJob.remoteId, 'video_2');
  assert.equal(receipts.length, 2); assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.seed, args.seed); assert.equal(request.cameraLora, 'static');
    assert.deepEqual(request.guidingFrames, [{ frameIndex: 24, strength: 0.6, image: { data: png, mimeType: 'image/png', name: assetId + '.png' } }]);
  }
  const invalid = await host.callTool('generate_video', { ...args, guidingFrames: [{ assetId, frameIndex: 24, image: { data: png, mimeType: 'image/png' } }] });
  assert.equal(invalid.isError, true); assert.equal(requests.length, 2);
  await host.shutdown();
});

test('both harnesses preserve typed discovery and distinguish local rejection from remote failure', async (t) => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { executeEaselTool } = require('../../../src/agent');
  const { createEaselToolHost } = require('../../../src/easel-tool-host');
  const { generateVideo } = await import('../src/video.js');
  const { capabilities } = await import('./fixtures/video-contract.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let posts = 0;
  const server = createMediaServer({ easel: { ...fakeEasel,
    discoverVideoCapabilities: async () => capabilities as any, listVideoLoras: async () => [],
    generateVideo: input => generateVideo({ ...input, fetchImpl: async () => { posts++; throw new Error('Remote timeout'); } }),
  } });
  const client = new Client({ name: 'typed-harness-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const mcp = { listTools: async () => (await client.listTools()).tools, callTool: async (name: string, args: any) => client.callTool({ name, arguments: args }), close: async () => {} };
  const host = createEaselToolHost({ canvasController: {}, createMediaClient: async () => mcp });
  for (const name of ['discover_video_capabilities', 'list_video_loras']) {
    const expected = name === 'discover_video_capabilities' ? { modelId: 'ltx-2.5', capabilities } : { modelId: 'ltx-2.5', loras: [] };
    const internal = await executeEaselTool(name, { model: 'ltx-2.5' }, { mcp });
    assert.deepEqual(JSON.parse(internal.content), expected);
    const external = await host.callTool(name, { model: 'ltx-2.5' });
    assert.deepEqual(external.structuredContent, expected);
  }
  const invalidArgs = { model: 'ltx-2.5', prompt: 'Invalid recipe', motionSpeed: 0.5 };
  const direct: any = await client.callTool({ name: 'generate_video', arguments: invalidArgs });
  assert.equal(direct.isError, true); assert.equal(direct.structuredContent.requestSent, false);
  await assert.rejects(executeEaselTool('generate_video', invalidArgs, { mcp }), (error: any) => error.code === 'INVALID_TOOL_ARGUMENTS' && error.requestSent === false);
  const invalid = await host.callTool('generate_video', invalidArgs);
  const rejection = JSON.parse(invalid.content[0].text);
  assert.equal(rejection.code, 'INVALID_TOOL_ARGUMENTS'); assert.equal(rejection.requestSent, false); assert.equal(posts, 0);
  await assert.rejects(executeEaselTool('generate_video', { model: 'ltx-2.5', prompt: 'Valid request' }, { mcp }), (error: any) => {
    assert.notEqual(error.requestSent, false); assert.notEqual(error.code, 'INVALID_TOOL_ARGUMENTS'); return true;
  });
  assert.equal(posts, 1);
  await host.shutdown();
});
