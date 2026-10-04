const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { abortError, awaitAbortable, combinedSignal, isTurnAbort, throwIfAborted } = require('./turn-abort');

const ALLOWED_MEDIA_TOOLS = Object.freeze(new Set([
  'list_models',
  'discover_video_capabilities',
  'list_video_loras',
  'generate_image',
  'edit_image',
  'create_image_variation',
  'generate_video',
  'get_video',
  'get_image_job',
  'capture_canvas_screenshot',
]));

function createMediaMcpClient({
  command,
  args = [],
  env = {},
  cwd,
  transportFactory = (options) => new StdioClientTransport({ ...options, stderr: 'pipe', maxBufferSize: 64 * 1024 * 1024 }),
  clientFactory = () => new Client({ name: 'easel-client', version: '0.0.1' }),
  signal: turnSignal,
}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('Media MCP command is required.');
  throwIfAborted(turnSignal);
  const transport = transportFactory({ command, args, env, cwd });
  const client = clientFactory();

  let connected = false;
  let closed = false;
  let closing;
  let serverStderr = '';
  const secrets = [env.EASEL_API_KEY].filter((key) => typeof key === 'string' && key);
  if (env.EASEL_MEDIA_MODELS) {
    try {
      for (const model of JSON.parse(env.EASEL_MEDIA_MODELS)) if (typeof model.apiKey === 'string' && model.apiKey) secrets.push(model.apiKey);
    } catch { throw new Error('Media model configuration is invalid.'); }
  }
  transport.stderr?.on?.('data', (chunk) => {
    serverStderr = `${serverStderr}${String(chunk)}`.slice(-8192);
  });

  function errorMessage(error, fallback) {
    const message = error?.message || fallback;
    const details = serverStderr.trim();
    const combined = details ? `${message}\nMedia MCP server stderr: ${details}` : message;
    return secrets.reduce((message, secret) => message.split(secret).join('[redacted]'), String(combined));
  }

  async function connect() {
    try {
      throwIfAborted(turnSignal);
      await awaitAbortable(client.connect(transport, turnSignal ? { signal: turnSignal } : undefined), turnSignal);
      throwIfAborted(turnSignal);
      connected = true;
    } catch (error) {
      await close().catch(() => {});
      if (isTurnAbort(error, turnSignal)) throw abortError(turnSignal);
      throw new Error(errorMessage(error, 'Could not start Media MCP server.'));
    }
  }

  async function listTools({ signal: requestSignal } = {}) {
    const signal = combinedSignal(turnSignal, requestSignal);
    throwIfAborted(signal);
    if (!connected || closed) throw new Error('Media MCP client is not connected.');
    try {
      const result = await awaitAbortable(client.listTools(undefined, signal ? { signal } : undefined), signal);
      throwIfAborted(signal);
      return result.tools.filter((tool) => ALLOWED_MEDIA_TOOLS.has(tool.name));
    } catch (error) {
      if (isTurnAbort(error, signal)) { await close().catch(() => {}); throw abortError(signal); }
      throw new Error(errorMessage(error, 'Media MCP tool listing failed.'));
    }
  }

  async function callTool(name, argsValue, { signal: requestSignal } = {}) {
    const signal = combinedSignal(turnSignal, requestSignal);
    throwIfAborted(signal);
    if (!connected || closed) throw new Error('Media MCP client is not connected.');
    if (!ALLOWED_MEDIA_TOOLS.has(name)) throw new Error(`Media MCP tool is not allowlisted: ${name}`);
    if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue)) {
      throw new Error('Media MCP tool arguments must be an object.');
    }
    try {
      const result = await awaitAbortable(client.callTool({ name, arguments: argsValue }, undefined, signal ? { signal } : undefined), signal);
      throwIfAborted(signal);
      if (result.isError && Array.isArray(result.content)) {
        const errorSecrets = [...new Set(secrets.flatMap((secret) => [secret, secret.trim()]).filter(Boolean))];
        return { ...result, content: result.content.map((item) => item.type === 'text' && typeof item.text === 'string'
          ? { ...item, text: errorSecrets.reduce((message, secret) => message.split(secret).join('[redacted]'), item.text) }
          : item) };
      }
      return result;
    } catch (error) {
      if (isTurnAbort(error, signal)) { await close().catch(() => {}); throw abortError(signal); }
      throw new Error(errorMessage(error, 'Media MCP call failed.'));
    }
  }

  function close() {
    if (closing) return closing;
    closed = true;
    turnSignal?.removeEventListener('abort', stop);
    closing = (async () => {
      try { await client.close(); }
      finally { await transport.close?.(); connected = false; }
    })();
    return closing;
  }

  const stop = () => { close().catch(() => {}); };
  turnSignal?.addEventListener('abort', stop, { once: true });

  return connect().then(() => ({ listTools, callTool, close }));
}

module.exports = { ALLOWED_MEDIA_TOOLS, createMediaMcpClient };
