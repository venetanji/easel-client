const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ResourceUpdatedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createControlMcpServer, EVENTS_URI, MAX_BODY_BYTES } = require('../src/control-mcp-server');

const TOOL = {
  name: 'project_read', description: 'Read project data.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { section: { $ref: '#/$defs/section' }, filters: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
    $defs: { section: { type: 'string', enum: ['app', 'scripts'] } },
  },
};

async function fixture(t, options = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const userDataPath = fs.mkdtempSync(path.join(tempRoot, 'easel-control-mcp-'));
  const calls = [];
  const authorized = [];
  const released = [];
  const events = [];
  let enabled = true;
  const control = options.control || {
    canConnect: () => enabled,
    authorizeConnection: ({ sessionId, name }) => { authorized.push({ sessionId, name }); return true; },
    releaseConnection: (sessionId) => { released.push(sessionId); },
  };
  const toolHost = options.toolHost || {
    listTools: async () => [TOOL],
    callTool: async (name, args, context) => { calls.push({ name, args, context }); return { content: [{ type: 'text', text: 'project content' }] }; },
  };
  const server = createControlMcpServer({ userDataPath, toolHost, control, onEvent: (event) => events.push(event), ...options });
  t.after(async () => {
    await server.close();
    if (path.dirname(path.resolve(userDataPath)) !== tempRoot) throw new Error('Unexpected fixture directory.');
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });
  const started = await server.start();
  const info = server.getConnectionInfo();
  return { ...started, info, server, calls, authorized, released, events, userDataPath, control, toolHost, disable: () => { enabled = false; } };
}

function rawRequest(url, { headers = {}, method = 'POST', body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function connect(t, state, name = 'test-client') {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(state.url), {
    requestInit: { headers: { Authorization: `Bearer ${state.info.bearerToken}` } },
    reconnectionOptions: { maxRetries: 0 },
  });
  t.after(() => client.close());
  await client.connect(transport);
  await until(() => state.server.getConnectionInfo().connectedClients.some((entry) => entry.sessionId === transport.sessionId && entry.streaming));
  return { client, transport };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'Expected asynchronous cleanup to finish.');
}

test('rejects missing/invalid auth before parsing JSON and never publishes its token', async (t) => {
  const state = await fixture(t);
  const missing = await rawRequest(state.url, { body: 'invalid json' });
  const invalid = await rawRequest(state.url, { headers: { Authorization: `Bearer ${'x'.repeat(43)}` }, body: 'invalid json' });
  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.equal(missing.headers['www-authenticate'], 'Bearer');
  assert.equal(state.authorized.length, 0);
  assert.ok(!JSON.stringify(state.events).includes(state.info.bearerToken));
});

test('rejects remote Host and Origin headers before body parsing', async (t) => {
  const state = await fixture(t);
  const auth = { Authorization: `Bearer ${state.info.bearerToken}` };
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: `http://127.0.0.1:${state.port + 1}` }]) {
    const response = await rawRequest(state.url, { headers: { ...auth, ...headers }, body: 'invalid json' });
    assert.equal(response.status, 403);
  }
  assert.equal(state.authorized.length, 0);
});

test('initializes SDK clients and preserves plain JSON tool schemas including defs', async (t) => {
  const state = await fixture(t);
  const { client, transport } = await connect(t, state);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools, [TOOL]);
  const result = await client.callTool({ name: TOOL.name, arguments: { section: 'app', filters: [1, 'active'] } });
  assert.equal(result.content[0].text, 'project content');
  assert.deepEqual(state.calls[0].args, { section: 'app', filters: [1, 'active'] });
  assert.equal(state.calls[0].context.sessionId, transport.sessionId);
  assert.ok(state.calls[0].context.signal instanceof AbortSignal);
  assert.equal(state.server.getConnectionInfo().connectedClients.length, 1);
  await assert.rejects(client.callTool({ name: 'not_an_easel_tool', arguments: {} }), /Unknown Easel tool/);
});

test('notifies subscribed clients over SSE and exposes event cursor without payload secrets', async (t) => {
  const state = await fixture(t);
  const { client } = await connect(t, state);
  const notifications = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => notifications.push(notification.params));
  await client.subscribeResource({ uri: EVENTS_URI });
  const published = await state.server.publishEvent({ type: 'canvas-edited', privatePayload: state.info.bearerToken });
  await until(() => notifications.length === 1);
  assert.deepEqual(notifications[0], { uri: EVENTS_URI });
  const resource = await client.readResource({ uri: EVENTS_URI });
  assert.deepEqual(JSON.parse(resource.contents[0].text), published);
  assert.ok(!resource.contents[0].text.includes(state.info.bearerToken));
  await client.unsubscribeResource({ uri: EVENTS_URI });
  await state.server.publishEvent({ type: 'canvas-edited' });
  assert.equal(notifications.length, 1);
});

test('publishes harness instructions and a durable cursor before new session events', async (t) => {
  let cursor = 42;
  const state = await fixture(t, { getEventCursor: () => cursor, toolHost: {
    instructions: 'Use offline kits and saved source. Read durable events after reconnecting.',
    listTools: async () => [TOOL], callTool: async () => ({ content: [] }),
  } });
  const { client } = await connect(t, state);
  assert.equal(client.getInstructions(), state.toolHost.instructions);
  const resource = await client.readResource({ uri: EVENTS_URI });
  assert.equal(JSON.parse(resource.contents[0].text).eventId, 42);
  cursor = 43;
  const published = await state.server.publishEvent({ type: 'canvas' });
  assert.equal(published.eventId, 43);
});

test('releases a session exactly once after DELETE', async (t) => {
  const state = await fixture(t);
  const { transport } = await connect(t, state);
  const sessionId = transport.sessionId;
  await transport.terminateSession();
  await until(() => state.released.length === 1);
  assert.deepEqual(state.released, [sessionId]);
  assert.equal(state.server.getConnectionInfo().connectedClients.length, 0);
});

test('releases controller ownership when an SDK client disconnects its SSE stream', async (t) => {
  const state = await fixture(t);
  const { client, transport } = await connect(t, state);
  const sessionId = transport.sessionId;
  await client.close();
  await until(() => state.released.includes(sessionId));
  assert.equal(state.server.getConnectionInfo().connectedClients.length, 0);
});

test('rejects builtin mode and coordinator ownership conflicts without adding clients', async (t) => {
  let enabled = false;
  const state = await fixture(t, {
    control: {
      canConnect: () => enabled,
      authorizeConnection: () => { throw Object.assign(new Error('Another controller is active.'), { code: 'CONTROL_BUSY' }); },
      releaseConnection: () => {},
    },
  });
  const headers = { Authorization: `Bearer ${state.info.bearerToken}` };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'client', version: '1' } } });
  assert.equal((await rawRequest(state.url, { headers, body })).status, 403);
  enabled = true;
  const busy = await rawRequest(state.url, { headers, body });
  assert.equal(busy.status, 409);
  assert.equal(JSON.parse(busy.body).error.data.code, 'CONTROL_BUSY');
  assert.equal(state.server.getConnectionInfo().connectedClients.length, 0);
});

test('allows multiple sessions only when approved and disconnectAll releases each once', async (t) => {
  const state = await fixture(t);
  await connect(t, state, 'external-one');
  await connect(t, state, 'embedded-two');
  assert.deepEqual(state.server.getConnectionInfo().connectedClients.map((entry) => entry.name), ['external-one', 'embedded-two']);
  await state.server.disconnectAll();
  assert.equal(state.server.getConnectionInfo().connectedClients.length, 0);
  assert.equal(new Set(state.released).size, 2);
  assert.equal(state.released.length, 2);
});

test('mode changes stop subsequent calls before invoking the tool host', async (t) => {
  const state = await fixture(t);
  const { client } = await connect(t, state);
  state.disable();
  await assert.rejects(client.callTool({ name: TOOL.name, arguments: {} }), /disabled|403/);
  assert.equal(state.calls.length, 0);
  await state.server.disconnectAll();
  assert.equal(state.released.length, 1);
});

test('bounds request bodies by Content-Length and streamed bytes', async (t) => {
  const state = await fixture(t, { maxBodyBytes: 1024 });
  const headers = { Authorization: `Bearer ${state.info.bearerToken}` };
  const declared = await rawRequest(state.url, { headers: { ...headers, 'Content-Length': MAX_BODY_BYTES + 1 }, body: '{}' });
  const streamed = await rawRequest(state.url, { headers, body: 'x'.repeat(2048) });
  assert.equal(declared.status, 413);
  assert.equal(streamed.status, 413);
  assert.equal(state.authorized.length, 0);
});

test('aborts in-flight host calls on shutdown and closes without waiting for host work', async (t) => {
  let seenSignal;
  const state = await fixture(t, {
    toolHost: {
      listTools: async () => [TOOL],
      callTool: async (_name, _args, { signal }) => {
        seenSignal = signal;
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'aborted' }] }), { once: true }));
      },
    },
  });
  const { client } = await connect(t, state);
  const pending = client.callTool({ name: TOOL.name, arguments: {} }).catch((error) => error);
  await until(() => Boolean(seenSignal));
  await state.server.close();
  assert.equal(seenSignal.aborted, true);
  await pending;
  assert.equal(state.released.length, 1);
});

test('propagates individual SDK request cancellation to the host without releasing its session', async (t) => {
  let seenSignal;
  const state = await fixture(t, {
    toolHost: {
      listTools: async () => [TOOL],
      callTool: async (_name, _args, { signal }) => {
        seenSignal = signal;
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }] }), { once: true }));
      },
    },
  });
  const { client } = await connect(t, state);
  const cancellation = new AbortController();
  const pending = client.callTool({ name: TOOL.name, arguments: {} }, undefined, { signal: cancellation.signal }).catch((error) => error);
  await until(() => Boolean(seenSignal));
  cancellation.abort(new Error('User cancelled the call.'));
  await pending;
  await until(() => seenSignal.aborted);
  assert.equal(state.released.length, 0);
  assert.equal(state.server.getConnectionInfo().connectedClients.length, 1);
});

test('aborts a disconnected HTTP call while keeping the active client SSE session', async (t) => {
  let seenSignal;
  const state = await fixture(t, {
    toolHost: {
      listTools: async () => [TOOL],
      callTool: async (_name, _args, { signal }) => {
        seenSignal = signal;
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'disconnected' }] }), { once: true }));
      },
    },
  });
  const { transport } = await connect(t, state);
  const request = http.request(state.url, { method: 'POST', headers: {
    Authorization: `Bearer ${state.info.bearerToken}`, 'Mcp-Session-Id': transport.sessionId,
    'Mcp-Protocol-Version': '2025-11-25', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
  } });
  request.on('error', () => {});
  request.on('response', (response) => response.resume());
  request.end(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: TOOL.name, arguments: {} } }));
  await until(() => Boolean(seenSignal));
  request.destroy();
  await until(() => seenSignal.aborted);
  assert.equal(state.released.length, 0);
  assert.equal(state.server.getConnectionInfo().connectedClients.length, 1);
});

test('expires initialized sessions that never establish an SSE connection', async (t) => {
  const state = await fixture(t, { sessionIdleMs: 40 });
  const response = await rawRequest(state.url, {
    headers: { Authorization: `Bearer ${state.info.bearerToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'post-only', version: '1' } } }),
  });
  assert.equal(response.status, 200);
  await until(() => state.released.length === 1);
  assert.equal(state.server.getConnectionInfo().connectedClients.length, 0);
});

test('closing during startup does not leave a listening socket', async () => {
  const server = createControlMcpServer({ toolHost: { listTools: () => [], callTool: () => ({ content: [] }) }, control: { canConnect: () => true, authorizeConnection: () => true, releaseConnection: () => {} } });
  const started = server.start().catch((error) => error);
  await server.close();
  const result = await started;
  assert.ok(result instanceof Error);
  assert.equal(server.getConnectionInfo().url, '');
});

test('persists bearer token and listening port across server instances', async (t) => {
  const state = await fixture(t);
  await state.server.close();
  const next = createControlMcpServer({ userDataPath: state.userDataPath, toolHost: state.toolHost, control: state.control });
  t.after(() => next.close());
  const started = await next.start();
  assert.equal(started.port, state.port);
  assert.equal(next.getConnectionInfo().bearerToken, state.info.bearerToken);
});

test('chooses a new port only when the remembered port is occupied and reports the URL change', async (t) => {
  const state = await fixture(t);
  await state.server.close();
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(state.port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const events = [];
  const next = createControlMcpServer({ userDataPath: state.userDataPath, toolHost: state.toolHost, control: state.control, onEvent: (event) => events.push(event) });
  t.after(() => next.close());
  const started = await next.start();
  assert.notEqual(started.port, state.port);
  assert.equal(events.find((event) => event.action === 'listening').urlChanged, true);
});

test('connection information is available safely before startup', async () => {
  const server = createControlMcpServer({ toolHost: { listTools: () => [], callTool: () => ({ content: [] }) }, control: { canConnect: () => true, authorizeConnection: () => true, releaseConnection: () => {} } });
  const info = server.getConnectionInfo();
  assert.equal(info.url, '');
  assert.equal(info.port, 0);
  assert.deepEqual(info.connectedClients, []);
  assert.match(info.bearerToken, /^[A-Za-z0-9_-]{43}$/);
  await server.close();
});
