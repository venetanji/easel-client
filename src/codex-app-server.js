const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const MCP_TOKEN_ENV = 'EASEL_CODEX_MCP_TOKEN';
// A 32 MiB image occupies more space when encoded in a protocol message.
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const DISABLED_CODEX_FEATURES = ['shell_tool', 'unified_exec', 'code_mode', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'in_app_local_automation', 'multi_agent', 'hooks', 'workspace_dependencies', 'view_image', 'skill_search', 'skill_mcp_dependency_install'];

function abortError() {
  const error = new Error('Codex request stopped.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function resolveCodexExecutable({ executable, env = process.env, platform = process.platform, arch = process.arch, fileSystem = fs } = {}) {
  const locations = [];
  const nativeName = platform === 'win32' ? 'codex.exe' : 'codex';
  if (executable) locations.push(path.resolve(executable));
  const searchPath = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] || '';
  for (const directory of searchPath.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const resolved = directory.replace(/^"|"$/g, '');
    locations.push(path.join(resolved, nativeName));
    for (const suffix of ['.cmd', '.ps1', '.js']) locations.push(path.join(resolved, `codex${suffix}`));
  }
  const target = {
    'win32:x64': ['win32-x64', 'x86_64-pc-windows-msvc'],
    'win32:arm64': ['win32-arm64', 'aarch64-pc-windows-msvc'],
    'darwin:x64': ['darwin-x64', 'x86_64-apple-darwin'],
    'darwin:arm64': ['darwin-arm64', 'aarch64-apple-darwin'],
    'linux:x64': ['linux-x64', 'x86_64-unknown-linux-musl'],
    'linux:arm64': ['linux-arm64', 'aarch64-unknown-linux-musl'],
  }[`${platform}:${arch}`];
  for (const location of [...new Set(locations)]) {
    if (!fileSystem.existsSync(location)) continue;
    let resolved;
    try { resolved = fileSystem.realpathSync(location); } catch { continue; }
    if (platform === 'win32' ? /\.exe$/i.test(resolved) : !/\.(?:cmd|ps1|js)$/i.test(resolved)) return resolved;
    if (!target) continue;
    const directory = path.dirname(resolved);
    const roots = [
      path.join(directory, 'node_modules', '@openai', 'codex'),
      path.join(directory, '..', 'node_modules', '@openai', 'codex'),
      path.join(directory, '..', 'lib', 'node_modules', '@openai', 'codex'),
      path.join(directory, '..'),
    ];
    for (const root of roots) {
      for (const vendor of [path.join(root, 'node_modules', '@openai', `codex-${target[0]}`, 'vendor'), path.join(root, 'vendor')]) {
        const binary = path.join(vendor, target[1], 'bin', nativeName);
        if (fileSystem.existsSync(binary)) return fileSystem.realpathSync(binary);
      }
    }
  }
  throw new Error('Codex CLI was not found. Install Codex and make its native executable available on PATH.');
}

function launchOptions({ cwd, connection, executable, env = process.env }) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Codex needs a dedicated absolute Easel working directory.');
  const args = ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="on-request"', '-c', 'web_search="disabled"'];
  // Native tools and MCP calls need the tool host even with code mode disabled.
  args.push('--enable', 'code_mode_host', '--enable', 'image_generation');
  for (const feature of DISABLED_CODEX_FEATURES) args.push('--disable', feature);
  const childEnv = { ...env };
  // Embedded Codex uses managed ChatGPT auth, independent of the host's API setup.
  const apiVariables = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', MCP_TOKEN_ENV]);
  for (const name of Object.keys(childEnv)) if (apiVariables.has(name.toUpperCase())) delete childEnv[name];
  let mcpConfiguration = '{}';
  if (connection) {
    let url;
    try { url = new URL(connection.url); } catch { throw new Error('The Easel MCP connection URL is invalid.'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.hash || url.search) throw new Error('Codex requires an authenticated loopback Easel MCP connection.');
    const token = connection.bearerToken ?? connection.token;
    if (typeof token !== 'string' || !token || /[\r\n\u0000]/.test(token)) throw new Error('The Easel MCP bearer token is required.');
    childEnv[MCP_TOKEN_ENV] = token;
    mcpConfiguration = `{easel={url=${JSON.stringify(url.href)},bearer_token_env_var="${MCP_TOKEN_ENV}",enabled=true}}`;
  }
  // Replace the entire server table so this child does not inherit unrelated MCP endpoints.
  args.push('-c', `mcp_servers=${mcpConfiguration}`);
  // Selecting Codex authorizes Easel tools; destructive tools confirm in Easel.
  if (connection) args.push('-c', 'mcp_servers.easel.default_tools_approval_mode="approve"');
  return { command: executable, args, options: { cwd, env: childEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] } };
}

function createCodexAppServer({
  cwd,
  getMcpConnection,
  executable,
  env = process.env,
  spawnProcess = spawn,
  resolveExecutable = resolveCodexExecutable,
  onNotification,
  onRequest,
  onExit,
  requestTimeoutMs = 60_000,
  serverRequestTimeoutMs = 120_000,
  clientInfo = { name: 'easel_studio', title: 'Easel Studio', version: require('../package.json').version },
} = {}) {
  let child;
  let starting;
  let initialized = false;
  let closing = false;
  let closePromise;
  let nextId = 0;
  let generation = 0;
  let requestHandler = onRequest;
  const pending = new Map();
  const serverRequests = new Map();
  const notifications = new Set();
  const exits = new Set();

  function broadcast(callback, listeners, value) {
    for (const listener of [callback, ...listeners]) {
      try { listener?.(value); } catch { /* A client observer cannot break protocol routing. */ }
    }
  }

  function write(message) {
    if (!child?.stdin?.writable || closing) throw new Error('Codex app-server is not connected.');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function fail(error, processChild = child) {
    if (processChild !== child) return;
    initialized = false;
    for (const request of [...pending.values()]) request.finish(error);
    for (const request of serverRequests.values()) request.abort();
    serverRequests.clear();
    broadcast(onExit, exits, error);
  }

  function rpc(method, params = {}, { signal, timeoutMs = requestTimeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      let timer;
      function abort() { finish(abortError()); }
      function finish(error, result) {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      }
      pending.set(id, { finish });
      if (timeoutMs > 0) timer = setTimeout(() => finish(new Error(`Codex ${method} timed out.`)), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      try { write({ id, method, params }); } catch (error) { finish(error); }
    });
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Codex sent an invalid protocol message.');
    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        broadcast(onNotification, notifications, { method: message.method, params: message.params || {} });
        return;
      }
      const processChild = child;
      const controller = new AbortController();
      controller.requestParams = message.params || {};
      const key = JSON.stringify(message.id);
      if (serverRequests.has(key)) throw new Error('Codex duplicated a pending server request.');
      serverRequests.set(key, controller);
      const timer = setTimeout(() => controller.abort(), serverRequestTimeoutMs);
      Promise.resolve().then(async () => {
        if (!requestHandler) throw Object.assign(new Error('This Codex server request is not supported by Easel.'), { code: -32601 });
        const cancelled = new Promise((_, reject) => {
          if (controller.signal.aborted) reject(abortError());
          else controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        return Promise.race([requestHandler({ id: message.id, method: message.method, params: message.params || {}, signal: controller.signal }), cancelled]);
      }).then((result) => {
        if (processChild === child && !closing) write({ id: message.id, result: result ?? {} });
      }).catch((error) => {
        if (processChild === child && !closing) {
          try { write({ id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32000, message: error.name === 'AbortError' ? 'The request was cancelled.' : 'Easel could not approve this Codex request.' } }); } catch { /* The transport may have closed during approval. */ }
        }
      }).finally(() => { clearTimeout(timer); serverRequests.delete(key); });
      return;
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      if (message.error) {
        const error = new Error(typeof message.error.message === 'string' ? message.error.message : 'Codex request failed.');
        error.code = message.error.code;
        request.finish(error);
      } else request.finish(null, message.result);
      return;
    }
    throw new Error('Codex sent an invalid protocol message.');
  }

  async function initialize() {
    if (closing) throw new Error('Codex app-server is closing.');
    if (initialized) return { ready: true };
    if (starting) return starting;
    const launchGeneration = ++generation;
    let ownedProcess;
    const initialization = (async () => {
      const connection = await getMcpConnection?.();
      if (closing || generation !== launchGeneration) throw new Error('Codex app-server initialization was cancelled.');
      const command = resolveExecutable({ executable, env });
      const launch = launchOptions({ cwd, connection, executable: command, env });
      const processChild = spawnProcess(launch.command, launch.args, launch.options);
      ownedProcess = processChild;
      child = processChild;
      let buffered = '';
      const decoder = new StringDecoder('utf8');
      processChild.stdout.on('data', (chunk) => {
        if (processChild !== child) return;
        try {
          buffered += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          let newline;
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline).replace(/\r$/, '');
            buffered = buffered.slice(newline + 1);
            if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('Codex protocol message exceeds the transport limit.');
            if (line.trim()) handleMessage(JSON.parse(line));
          }
          if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) throw new Error('Codex protocol message exceeds the transport limit.');
        } catch {
          fail(new Error('Codex app-server sent invalid protocol output.'), processChild);
          processChild.kill();
        }
      });
      processChild.stderr.resume();
      processChild.stdin.on('error', () => fail(new Error('Codex app-server input closed.'), processChild));
      processChild.once('error', () => fail(new Error('Codex app-server could not start.'), processChild));
      processChild.once('exit', (code, signal) => {
        fail(new Error(closing ? 'Codex app-server closed.' : `Codex app-server exited${signal ? ` (${signal})` : ` (${code ?? 'unknown'})`}.`), processChild);
        if (processChild === child) child = undefined;
      });
      const result = await rpc('initialize', { clientInfo, capabilities: { experimentalApi: true } });
      if (closing || generation !== launchGeneration) throw new Error('Codex app-server initialization was cancelled.');
      write({ method: 'initialized', params: {} });
      initialized = true;
      return result;
    })();
    starting = initialization;
    try { return await initialization; }
    catch (error) {
      if (ownedProcess && child === ownedProcess) ownedProcess.kill();
      throw error;
    } finally { if (starting === initialization) starting = undefined; }
  }

  async function request(method, params = {}, options = {}) {
    if (options.signal?.aborted) throw abortError();
    await initialize();
    return rpc(method, params, options);
  }

  async function waitForEaselTools(threadId, { signal, timeoutMs = 15_000 } = {}) {
    await initialize();
    if (!await getMcpConnection?.()) return;
    const expectedGeneration = generation;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted || generation !== expectedGeneration || closing) throw abortError();
      const inventory = await rpc('mcpServerStatus/list', { threadId, serverName: 'easel', detail: 'toolsAndAuthOnly', limit: 1 }, { signal, timeoutMs: Math.max(1, deadline - Date.now()) });
      const server = inventory.data?.find((entry) => entry.name === 'easel');
      if (server?.toolsError || ['failed', 'authenticationRequired', 'cancelled', 'disabled'].includes(server?.runtimeStatus)) {
        throw new Error(`Codex could not connect to Easel tools: ${server.toolsError || server.runtimeStatus}. Configured Media models remain saved in Easel.`);
      }
      const names = Object.entries(server?.tools || {}).map(([key, tool]) => tool.name || key);
      if ((!server?.runtimeStatus || server.runtimeStatus === 'connected') && ['list_models', 'list_canvas_files'].every((name) => names.some((entry) => entry === name || entry.endsWith(`__${name}`)))) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Codex did not finish connecting to Easel tools. Retry the message; configured Media models are still available in Easel.');
  }

  async function close({ timeoutMs = 2000 } = {}) {
    if (closePromise) return closePromise;
    closing = true;
    generation += 1;
    starting = undefined;
    initialized = false;
    for (const request of [...pending.values()]) request.finish(new Error('Codex app-server closed.'));
    for (const controller of serverRequests.values()) controller.abort();
    const processChild = child;
    closePromise = processChild ? new Promise((resolve) => {
      const timer = setTimeout(() => { processChild.kill(); resolve(); }, timeoutMs);
      processChild.once('exit', () => { clearTimeout(timer); resolve(); });
      try { processChild.stdin.end(); } catch { processChild.kill(); }
    }) : Promise.resolve();
    try { await closePromise; }
    finally { child = undefined; closing = false; closePromise = undefined; }
  }

  return {
    initialize,
    request,
    notify: (method, params = {}) => write({ method, params }),
    subscribe: (listener) => { notifications.add(listener); return () => notifications.delete(listener); },
    subscribeExit: (listener) => { exits.add(listener); return () => exits.delete(listener); },
    setRequestHandler: (handler) => { requestHandler = handler; },
    cancelServerRequests: ({ threadId, turnId } = {}) => {
      for (const controller of serverRequests.values()) {
        const params = controller.requestParams;
        if (threadId && params.threadId === threadId && (!turnId || !params.turnId || params.turnId === turnId)) controller.abort();
      }
    },
    getState: () => ({ connected: initialized, starting: Boolean(starting), closing }),
    readAccount: () => request('account/read', { refreshToken: false }),
    startLogin: (type = 'chatgpt') => {
      if (!['chatgpt', 'chatgptDeviceCode'].includes(type)) throw new Error('Use a managed Codex ChatGPT sign-in flow.');
      return request('account/login/start', { type });
    },
    cancelLogin: (loginId) => request('account/login/cancel', { loginId }),
    logout: () => request('account/logout', {}),
    listModels: (params = {}) => request('model/list', params),
    startThread: (params = {}) => request('thread/start', params),
    waitForEaselTools,
    resumeThread: (params) => request('thread/resume', params),
    readThread: (threadId, options = {}) => request('thread/read', { threadId, includeTurns: false, ...options }),
    listThreads: (params = {}) => request('thread/list', { cwd, ...params }),
    startTurn: (params, options) => request('turn/start', params, options),
    interruptTurn: (threadId, turnId) => request('turn/interrupt', { threadId, turnId }),
    close,
  };
}

module.exports = { createCodexAppServer, launchOptions, resolveCodexExecutable, MCP_TOKEN_ENV, DISABLED_CODEX_FEATURES };
