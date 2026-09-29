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
    content: [{ type: 'text', text: 'Available models: flux2-9b' }],
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
  const generated = await client.callTool({ name: 'generate_image', arguments: { prompt: 'a cat' } });
  assert.equal(generated.isError, undefined);
  assert.deepEqual(generated.content.map((item) => item.type), ['text', 'image']);
});
