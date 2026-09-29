const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaMcpClient, ALLOWED_MEDIA_TOOLS } = require('../src/media-mcp-client');

test('connects over stdio, filters tool listings, and closes the MCP client', async () => {
  const calls = [];
  const transport = { kind: 'stdio' };
  const fakeClient = {
    async connect(value) { calls.push(['connect', value]); },
    async listTools() {
      return { tools: [
        { name: 'generate_image', inputSchema: { type: 'object' } },
        { name: 'list_models', inputSchema: { type: 'object' } },
        { name: 'read_local_file', inputSchema: { type: 'object' } },
      ] };
    },
    async callTool(value) { calls.push(['callTool', value]); return { content: [{ type: 'text', text: 'ok' }] }; },
    async close() { calls.push(['close']); },
  };
  const mcp = await createMediaMcpClient({
    command: 'node',
    args: ['server.js'],
    env: { EASEL_BASE_URL: 'https://easel.ait4x.org' },
    transportFactory: () => transport,
    clientFactory: () => fakeClient,
  });

  assert.deepEqual(calls[0], ['connect', transport]);
  assert.deepEqual((await mcp.listTools()).map((tool) => tool.name), ['generate_image', 'list_models']);
  await mcp.callTool('generate_image', { prompt: 'a lamp' });
  await assert.rejects(mcp.callTool('read_local_file', {}), /not allowlisted/i);
  await mcp.close();
  assert.deepEqual(calls.at(-1), ['close']);
  assert.deepEqual([...ALLOWED_MEDIA_TOOLS].sort(), ['capture_canvas_screenshot', 'generate_image', 'list_models']);
});

test('does not expose a failing child transport as a connected client', async () => {
  await assert.rejects(createMediaMcpClient({
    command: 'node',
    transportFactory: () => ({}),
    clientFactory: () => ({ async connect() { throw new Error('spawn failed'); } }),
  }), /spawn failed/);
});
