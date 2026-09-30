const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexAppServer, launchOptions, resolveCodexExecutable, MCP_TOKEN_ENV } = require('../src/codex-app-server');

const cwd = path.resolve('test-easel-codex-workspace');

function mockProcess(respond = (message) => message.method === 'initialize' ? { userAgent: 'mock-codex' } : {}) {
  const child = new EventEmitter();
  const messages = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let exited = false;
  child.exit = (code = 0) => { if (!exited) { exited = true; child.emit('exit', code, null); } };
  child.kill = () => { child.exit(1); return true; };
  child.send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString());
      messages.push(message);
      if (message.method && message.id !== undefined) {
        const result = respond(message);
        if (result !== undefined) queueMicrotask(() => child.send({ id: message.id, ...(result?.rpcError ? { error: result.rpcError } : { result }) }));
      }
      callback();
    },
    final(callback) { queueMicrotask(() => child.exit()); callback(); },
  });
  return { child, messages };
}

function client(mock, options = {}) {
  return createCodexAppServer({ cwd, resolveExecutable: () => path.resolve('codex.exe'), spawnProcess: () => mock.child, ...options });
}

test('uses a native executable behind the Windows npm launcher without a shell', () => {
  const directory = path.resolve('mock-npm-bin');
  const launcher = path.join(directory, 'codex.cmd');
  const binary = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  const files = new Set([launcher, binary]);
  const fileSystem = { existsSync: (name) => files.has(name), realpathSync: (name) => name };
  assert.equal(resolveCodexExecutable({ env: { Path: directory }, platform: 'win32', arch: 'x64', fileSystem }), binary);
  assert.throws(() => resolveCodexExecutable({ env: { PATH: directory }, platform: 'win32', arch: 'arm64', fileSystem }), /Codex CLI was not found/);
});

test('keeps MCP bearer credentials in child environment and enforces loopback read-only configuration', () => {
  const token = 'test-only-local-token';
  const env = { PATH: 'example', EXISTING: 'value', OPENAI_API_KEY: 'test-host-api-key', OPENAI_BASE_URL: 'https://example.invalid', openai_project_id: 'test-project', CODEX_API_KEY: 'test-codex-api-key', CODEX_HOME: 'test-auth-home' };
  const launch = launchOptions({ cwd, executable: 'codex.exe', env, connection: { url: 'http://127.0.0.1:45001/mcp', bearerToken: token } });
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.cwd, cwd);
  assert.equal(launch.options.env[MCP_TOKEN_ENV], token);
  assert.equal(launch.options.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.options.env.OPENAI_BASE_URL, undefined);
  assert.equal(launch.options.env.openai_project_id, undefined);
  assert.equal(launch.options.env.CODEX_API_KEY, undefined);
  assert.equal(launch.options.env.CODEX_HOME, env.CODEX_HOME);
  assert.equal(env.OPENAI_API_KEY, 'test-host-api-key');
  assert.equal(env[MCP_TOKEN_ENV], undefined);
  assert.equal(launch.args.includes(token), false);
  assert.ok(launch.args.includes('model_provider="openai"'));
  assert.ok(launch.args.includes('sandbox_mode="read-only"'));
  assert.ok(launch.args.includes(`mcp_servers={easel={url="http://127.0.0.1:45001/mcp",bearer_token_env_var="${MCP_TOKEN_ENV}",enabled=true}}`));
  assert.ok(launch.args.includes('shell_tool'));
  assert.ok(launch.args.includes('unified_exec'));
  assert.ok(launch.args.includes('code_mode_host'));
  assert.ok(launch.args.includes('hooks'));
  assert.ok(launchOptions({ cwd }).args.includes('mcp_servers={}'));
  assert.equal(launchOptions({ cwd, env: { [MCP_TOKEN_ENV]: 'stale-token' } }).options.env[MCP_TOKEN_ENV], undefined);
  assert.throws(() => launchOptions({ cwd, connection: { url: 'https://example.com/mcp', token } }), /loopback/);
  assert.throws(() => launchOptions({ cwd, connection: { url: 'http://127.0.0.1/mcp', token: '' } }), /bearer token/);
});

test('initializes exactly once before requests and sends initialized acknowledgement', async (t) => {
  const mock = mockProcess((message) => message.method === 'initialize' ? { userAgent: 'mock' } : { method: message.method });
  const server = client(mock);
  t.after(() => server.close());
  const results = await Promise.all([server.readAccount(), server.listModels()]);
  assert.deepEqual(results.map((entry) => entry.method), ['account/read', 'model/list']);
  assert.deepEqual(mock.messages.map((message) => message.method), ['initialize', 'initialized', 'account/read', 'model/list']);
  assert.equal(mock.messages[2].params.refreshToken, false);
  assert.equal(server.getState().connected, true);
});

test('handles split Unicode notifications, out-of-order replies and server-initiated approvals', async (t) => {
  const notifications = [];
  const approvals = [];
  const mock = mockProcess((message) => message.method === 'initialize' ? {} : undefined);
  const server = client(mock, { onNotification: (value) => notifications.push(value), onRequest: async (request) => { approvals.push(request); return { decision: 'decline' }; } });
  t.after(() => server.close());
  await server.initialize();
  const first = server.request('first');
  const second = server.request('second');
  await new Promise(setImmediate);
  const requests = mock.messages.filter((message) => ['first', 'second'].includes(message.method));
  mock.child.send({ id: requests[1].id, result: 'second-result' });
  mock.child.send({ id: requests[0].id, result: 'first-result' });
  assert.deepEqual(await Promise.all([first, second]), ['first-result', 'second-result']);
  const notification = Buffer.from(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'cafe\u00e9' } })}\n`);
  const offset = notification.indexOf(Buffer.from('\u00e9')) + 1;
  mock.child.stdout.write(notification.subarray(0, offset));
  mock.child.stdout.write(notification.subarray(offset));
  mock.child.send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'example' } });
  await new Promise(setImmediate);
  assert.equal(notifications[0].params.delta, 'cafe\u00e9');
  assert.equal(approvals[0].method, 'item/commandExecution/requestApproval');
  assert.deepEqual(mock.messages.find((message) => message.id === 'approval-1'), { id: 'approval-1', result: { decision: 'decline' } });
});

test('rejects RPC errors, timeouts, aborted requests and pending calls on process exit', async (t) => {
  const mock = mockProcess((message) => message.method === 'initialize' ? {} : message.method === 'bad' ? { rpcError: { code: 123, message: 'Mock rejected' } } : undefined);
  const server = client(mock);
  t.after(() => server.close());
  await server.initialize();
  await assert.rejects(server.request('bad'), (error) => error.code === 123 && error.message === 'Mock rejected');
  await assert.rejects(server.request('slow', {}, { timeoutMs: 5 }), /timed out/);
  const controller = new AbortController();
  const cancelled = server.request('cancel', {}, { signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const pending = server.request('exit');
  await new Promise(setImmediate);
  mock.child.exit(3);
  await assert.rejects(pending, /exited \(3\)/);
});

test('fails malformed protocol output without leaking stderr or bearer credentials', async (t) => {
  const mock = mockProcess((message) => message.method === 'initialize' ? {} : undefined);
  const server = client(mock);
  t.after(() => server.close());
  await server.initialize();
  const pending = server.request('wait');
  await new Promise(setImmediate);
  mock.child.stderr.write('secret diagnostic');
  mock.child.stdout.write('not JSON\n');
  await assert.rejects(pending, (error) => /invalid protocol output/.test(error.message) && !error.message.includes('secret diagnostic'));
});

test('supports managed login methods only and preserves public account/thread operations', async (t) => {
  const mock = mockProcess((message) => ({ method: message.method }));
  const server = client(mock);
  t.after(() => server.close());
  await server.startLogin('chatgptDeviceCode');
  await server.cancelLogin('login-1');
  await server.logout();
  await server.startThread({ model: 'example-model' });
  await server.resumeThread({ threadId: 'thread-1' });
  await server.readThread('thread-1');
  await server.listThreads();
  await server.startTurn({ threadId: 'thread-1', input: [{ type: 'text', text: 'example' }] });
  await server.interruptTurn('thread-1', 'turn-1');
  assert.throws(() => server.startLogin('chatgptAuthTokens'), /managed/);
  assert.equal(mock.messages.some((message) => message.method === 'account/login/start' && message.params.type === 'chatgptDeviceCode'), true);
  assert.equal(mock.messages.find((message) => message.method === 'thread/read').params.includeTurns, false);
  assert.equal(mock.messages.find((message) => message.method === 'thread/list').params.cwd, cwd);
});

test('reconnects after an idle close with a new handshake and refreshed local MCP token', async () => {
  const processes = [mockProcess(), mockProcess()];
  const launches = [];
  let count = 0;
  const server = createCodexAppServer({ cwd, resolveExecutable: () => 'codex.exe', getMcpConnection: () => ({ url: 'http://127.0.0.1:4567/mcp', token: `token-${count}` }), spawnProcess: (...args) => { launches.push(args); return processes[count++].child; } });
  await server.initialize();
  await server.close();
  await server.initialize();
  assert.equal(launches.length, 2);
  assert.notEqual(launches[0][2].env[MCP_TOKEN_ENV], launches[1][2].env[MCP_TOKEN_ENV]);
  assert.deepEqual(processes[1].messages.map((message) => message.method), ['initialize', 'initialized']);
  await server.close();
});

test('closing while an MCP connection is pending prevents a late child launch', async () => {
  let connect;
  let spawns = 0;
  const connection = new Promise((resolve) => { connect = resolve; });
  const server = createCodexAppServer({ cwd, resolveExecutable: () => 'codex.exe', getMcpConnection: () => connection, spawnProcess: () => { spawns += 1; return mockProcess().child; } });
  const starting = server.initialize();
  await server.close();
  connect({ url: 'http://127.0.0.1:4567/mcp', token: 'mock-token' });
  await assert.rejects(starting, /initialization was cancelled/);
  assert.equal(spawns, 0);
});

test('Stop can cancel a pending native approval for the matching thread and turn', async (t) => {
  const mock = mockProcess();
  let request;
  const server = client(mock, { onRequest: (input) => { request = input; return new Promise(() => {}); } });
  t.after(() => server.close());
  await server.initialize();
  mock.child.send({ id: 'approval-2', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  await new Promise(setImmediate);
  server.cancelServerRequests({ threadId: 'thread-other' });
  assert.equal(request.signal.aborted, false);
  server.cancelServerRequests({ threadId: 'thread-1', turnId: 'turn-1' });
  await new Promise(setImmediate);
  assert.equal(request.signal.aborted, true);
  assert.match(mock.messages.find((message) => message.id === 'approval-2').error.message, /cancelled/);
});
