const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ALLOWED_MEDIA_TOOLS = Object.freeze(new Set([
  'list_models',
  'generate_image',
  'capture_canvas_screenshot',
]));

function createMediaMcpClient({
  command,
  args = [],
  env = {},
  transportFactory = (options) => new StdioClientTransport({ ...options, stderr: 'inherit', maxBufferSize: 64 * 1024 * 1024 }),
  clientFactory = () => new Client({ name: 'easel-client', version: '0.0.1' }),
}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('Media MCP command is required.');
  const transport = transportFactory({ command, args, env });
  const client = clientFactory();

  let connected = false;
  let closed = false;
  const secret = typeof env.EASEL_API_KEY === 'string' ? env.EASEL_API_KEY : '';

  async function connect() {
    try {
      await client.connect(transport);
      connected = true;
    } catch (error) {
      throw new Error(secret ? String(error?.message || error).split(secret).join('[redacted]') : (error?.message || 'Could not start Media MCP server.'));
    }
  }

  async function listTools() {
    if (!connected || closed) throw new Error('Media MCP client is not connected.');
    const result = await client.listTools();
    return result.tools.filter((tool) => ALLOWED_MEDIA_TOOLS.has(tool.name));
  }

  async function callTool(name, argsValue) {
    if (!connected || closed) throw new Error('Media MCP client is not connected.');
    if (!ALLOWED_MEDIA_TOOLS.has(name)) throw new Error(`Media MCP tool is not allowlisted: ${name}`);
    if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue)) {
      throw new Error('Media MCP tool arguments must be an object.');
    }
    try {
      return await client.callTool({ name, arguments: argsValue });
    } catch (error) {
      const message = error?.message || 'Media MCP call failed.';
      throw new Error(secret ? message.split(secret).join('[redacted]') : message);
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (connected) await client.close();
  }

  return connect().then(() => ({ listTools, callTool, close }));
}

module.exports = { ALLOWED_MEDIA_TOOLS, createMediaMcpClient };
