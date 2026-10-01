const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  CallToolRequestSchema, InitializeRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema,
  ErrorCode, McpError,
} = require('@modelcontextprotocol/sdk/types.js');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EVENTS_URI = 'easel://events';
const TOKEN_FILENAME = 'control-mcp-token';
const STATE_FILENAME = 'control-mcp-state.json';

function createControlMcpServer({
  toolHost, control, userDataPath, onEvent, getEventCursor, port = 0, bearerToken,
  maxBodyBytes = MAX_BODY_BYTES, sessionIdleMs = 120_000,
  fileSystem = fs, httpServerFactory = http.createServer,
  transportFactory = (options) => new StreamableHTTPServerTransport(options),
  serverFactory = (info, options) => new Server(info, options),
  randomBytes = crypto.randomBytes, sessionIdFactory = crypto.randomUUID, now = Date.now,
} = {}) {
  if (typeof toolHost?.listTools !== 'function' || typeof toolHost?.callTool !== 'function') throw new Error('An Easel tool host is required.');
  if (typeof control?.canConnect !== 'function' || typeof control?.authorizeConnection !== 'function' || typeof control?.releaseConnection !== 'function') throw new Error('A control coordinator is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Control MCP port is invalid.');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > MAX_BODY_BYTES) throw new Error('Control MCP request limit is invalid.');
  if (!Number.isInteger(sessionIdleMs) || sessionIdleMs < 20) throw new Error('Control MCP session timeout is invalid.');

  const sessions = new Map();
  const pendingReleases = new Set();
  const sockets = new Set();
  let listener;
  let startPromise;
  let closePromise;
  let stopping = false;
  let url = '';
  let boundPort = 0;
  let sequence = 0;
  let lastEvent = { sequence: 0, timestamp: 0, type: '' };

  function assertRegularFile(filename) {
    if (fileSystem.lstatSync(filename).isSymbolicLink()) throw new Error('Control MCP state must not be a symbolic link.');
    if (!fileSystem.statSync(filename).isFile()) throw new Error('Control MCP state must be a regular file.');
  }

  function privateDirectory() {
    fileSystem.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  }

  function loadToken() {
    if (bearerToken !== undefined) {
      if (typeof bearerToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(bearerToken)) throw new Error('Control MCP bearer token is invalid.');
      return bearerToken;
    }
    const generated = randomBytes(32).toString('base64url');
    if (!userDataPath) return generated;
    privateDirectory();
    const filename = path.join(userDataPath, TOKEN_FILENAME);
    try { fileSystem.writeFileSync(filename, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertRegularFile(filename);
    if (fileSystem.statSync(filename).size > 128) throw new Error('Control MCP token file is invalid.');
    const saved = fileSystem.readFileSync(filename, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(saved)) throw new Error('Control MCP token file is invalid.');
    fileSystem.chmodSync?.(filename, 0o600);
    return saved;
  }

  const token = loadToken();
  const tokenBytes = Buffer.from(token);
  const safeError = (error) => String(error?.message || error || 'Control MCP request failed.').split(token).join('[redacted]').slice(0, 1000);
  const safeName = (name) => String(name || 'MCP client').split(token).join('[redacted]').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  const clients = () => [...sessions.values()].filter((entry) => entry.initialized && !entry.closed).map(({ id, name, connectedAt, streams }) => ({ sessionId: id, name, connectedAt, streaming: [...streams].some((response) => response.headersSent && response.statusCode === 200) }));

  function emit(action, details = {}) {
    try { onEvent?.({ type: 'control-connection', action, url, port: boundPort, connectedClients: clients(), ...details }); }
    catch { /* UI event delivery must not break HTTP cleanup. */ }
  }

  function loadSavedPort() {
    if (!userDataPath) return 0;
    const filename = path.join(userDataPath, STATE_FILENAME);
    if (!fileSystem.existsSync(filename)) return 0;
    assertRegularFile(filename);
    if (fileSystem.statSync(filename).size > 1024) throw new Error('Control MCP state file is invalid.');
    const saved = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
    return Number.isInteger(saved.port) && saved.port > 0 && saved.port <= 65535 ? saved.port : 0;
  }

  function savePort(value) {
    if (!userDataPath) return;
    privateDirectory();
    const filename = path.join(userDataPath, STATE_FILENAME);
    if (fileSystem.existsSync(filename)) assertRegularFile(filename);
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    fileSystem.writeFileSync(temporary, JSON.stringify({ port: value }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fileSystem.renameSync(temporary, filename); }
    catch (error) { fileSystem.rmSync(temporary, { force: true }); throw error; }
  }

  function sendError(response, status, message, code = -32000, data) {
    if (response.headersSent || response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close', ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message, ...(data ? { data } : {}) } }));
  }

  function validateBoundary(request, response) {
    const remote = request.socket.remoteAddress;
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remote)) { sendError(response, 403, 'Control MCP accepts loopback connections only.'); return false; }
    const host = request.headers.host;
    const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    const countHeaders = (name) => request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
    if (countHeaders('host') !== 1 || !allowedHosts.includes(host?.toLowerCase())) { sendError(response, 403, 'Invalid control MCP Host header.'); return false; }
    const origin = request.headers.origin;
    if (countHeaders('origin') > 1 || (origin !== undefined && !allowedHosts.some((allowed) => origin === `http://${allowed}`))) { sendError(response, 403, 'Invalid control MCP Origin header.'); return false; }
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(authorization);
    const supplied = match ? Buffer.from(match[1]) : Buffer.alloc(0);
    if (countHeaders('authorization') !== 1 || supplied.length !== tokenBytes.length || !crypto.timingSafeEqual(supplied, tokenBytes)) { sendError(response, 401, 'A valid control MCP bearer token is required.'); return false; }
    if (request.url !== '/mcp') { sendError(response, 404, 'Control MCP endpoint not found.'); return false; }
    if (!['POST', 'GET', 'DELETE'].includes(request.method)) { response.setHeader('Allow', 'POST, GET, DELETE'); sendError(response, 405, 'Method not allowed.'); return false; }
    return true;
  }

  async function readBody(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw Object.assign(new Error('MCP POST requires application/json.'), { status: 415 });
    const declared = Number(request.headers['content-length'] || 0);
    if (!Number.isFinite(declared) || declared > maxBodyBytes) throw Object.assign(new Error('Control MCP request body is too large.'), { status: 413 });
    const bytes = await new Promise((resolve, reject) => {
      const chunks = [];
      let count = 0;
      let finished = false;
      const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAbort); };
      const fail = (error) => { if (finished) return; finished = true; cleanup(); request.pause(); reject(error); };
      const onData = (chunk) => {
        count += chunk.length;
        if (count > maxBodyBytes) { fail(Object.assign(new Error('Control MCP request body is too large.'), { status: 413 })); return; }
        chunks.push(chunk);
      };
      const onEnd = () => { if (finished) return; finished = true; cleanup(); resolve(Buffer.concat(chunks)); };
      const onError = (error) => fail(error);
      const onAbort = () => fail(Object.assign(new Error('Control MCP request was disconnected.'), { status: 400 }));
      request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAbort);
    });
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
  }

  function armExpiry(entry) {
    clearTimeout(entry.expiry);
    if (entry.closed || entry.requests.size) return;
    entry.expiry = setTimeout(() => { void releaseSession(entry, 'idle-timeout'); }, sessionIdleMs);
    entry.expiry.unref?.();
  }

  async function releaseSession(entry, reason) {
    if (entry.closed) return entry.releasePromise;
    entry.closed = true;
    sessions.delete(entry.id);
    clearTimeout(entry.expiry);
    entry.abort.abort(new Error(`Control MCP session ended: ${reason}.`));
    entry.releasePromise = (async () => {
      // Closing an SSE response alone leaves some SDK clients waiting for a request timeout.
      await Promise.allSettled([...entry.calls.keys()].map((id) => entry.transport.send({ jsonrpc: '2.0', id, error: { code: ErrorCode.ConnectionClosed, message: 'Easel control session ended.' } })));
      try { await entry.mcp.close(); } catch {}
      try { await control.releaseConnection(entry.id); } catch (error) { emit('error', { message: safeError(error) }); }
      emit('disconnected', { sessionId: entry.id, name: entry.name, reason });
    })();
    pendingReleases.add(entry.releasePromise);
    void entry.releasePromise.finally(() => pendingReleases.delete(entry.releasePromise));
    return entry.releasePromise;
  }

  async function newSession(body) {
    const initialized = InitializeRequestSchema.safeParse(body);
    if (!initialized.success) throw Object.assign(new Error('A valid MCP initialize request is required.'), { status: 400 });
    if (stopping || !(await control.canConnect())) throw Object.assign(new Error('MCP control is disabled in the current mode.'), { code: 'CONTROL_DISABLED' });
    const id = sessionIdFactory();
    const name = safeName(body.params.clientInfo.name);
    if ((await control.authorizeConnection({ sessionId: id, name })) === false) throw Object.assign(new Error('Another controller is active.'), { code: 'CONTROL_BUSY' });
    if (stopping || !(await control.canConnect())) { await control.releaseConnection(id); throw Object.assign(new Error('MCP control is disabled in the current mode.'), { code: 'CONTROL_DISABLED' }); }
    const entry = { id, name, connectedAt: now(), initialized: false, closed: false, requests: new Set(), streams: new Set(), calls: new Map(), abort: new AbortController(), subscribed: false };
    try {
      entry.transport = transportFactory({
        sessionIdGenerator: () => id,
        onsessioninitialized: () => { entry.initialized = true; emit('connected', { sessionId: id, name }); },
        onsessionclosed: () => releaseSession(entry, 'session-deleted'),
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`],
        allowedOrigins: [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`],
      });
      entry.mcp = serverFactory({ name: 'easel-control', version: require('../package.json').version }, { capabilities: { tools: { listChanged: true }, resources: { subscribe: true } }, instructions: toolHost.instructions || 'Control the open Easel application using its tools. Credentials remain private; destructive changes require native user confirmation. Read easel://events for the current event cursor and use the event tools for durable history.' });
      entry.mcp.onclose = () => { void releaseSession(entry, 'transport-closed'); };
      entry.mcp.onerror = (error) => emit('error', { sessionId: id, message: safeError(error) });
      entry.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await toolHost.listTools() }));
      entry.mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (entry.closed || !(await control.canConnect())) throw new McpError(ErrorCode.InvalidRequest, 'MCP control is disabled in the current mode.');
        const tools = await toolHost.listTools();
        if (!tools.some((tool) => tool.name === request.params.name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown Easel tool.');
        const signals = [entry.abort.signal, extra.signal, entry.calls.get(extra.requestId)?.signal].filter(Boolean);
        const signal = AbortSignal.any(signals);
        signal.throwIfAborted();
        try { const result = await toolHost.callTool(request.params.name, request.params.arguments || {}, { signal, sessionId: id }); signal.throwIfAborted(); return result; }
        catch (error) { throw new McpError(Number.isInteger(error?.code) ? error.code : ErrorCode.InternalError, safeError(error)); }
      });
      entry.mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: EVENTS_URI, name: 'Easel event cursor', description: 'Current event cursor metadata. Durable event entries are available through the Easel event tools.', mimeType: 'application/json' }] }));
      const requireEventsUri = (request) => { if (request.params.uri !== EVENTS_URI) throw new McpError(ErrorCode.InvalidParams, 'Unknown Easel resource.'); };
      entry.mcp.setRequestHandler(ReadResourceRequestSchema, async (request) => { requireEventsUri(request); return { contents: [{ uri: EVENTS_URI, mimeType: 'application/json', text: JSON.stringify({ ...lastEvent, ...(getEventCursor ? { eventId: getEventCursor() } : {}) }) }] }; });
      entry.mcp.setRequestHandler(SubscribeRequestSchema, async (request) => { requireEventsUri(request); entry.subscribed = true; return {}; });
      entry.mcp.setRequestHandler(UnsubscribeRequestSchema, async (request) => { requireEventsUri(request); entry.subscribed = false; return {}; });
      sessions.set(id, entry);
      await entry.mcp.connect(entry.transport);
      return entry;
    } catch (error) {
      if (entry.mcp) await releaseSession(entry, 'initialization-failed');
      else await control.releaseConnection(id);
      throw error;
    }
  }

  function trackRequest(entry, request, response, body) {
    clearTimeout(entry.expiry);
    const abort = new AbortController();
    entry.requests.add(abort);
    if (request.method === 'GET') entry.streams.add(response);
    const messages = Array.isArray(body) ? body : [body];
    const requestIds = messages.filter((message) => message && Object.hasOwn(message, 'id')).map((message) => message.id);
    for (const id of requestIds) entry.calls.set(id, abort);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      entry.requests.delete(abort);
      entry.streams.delete(response);
      for (const id of requestIds) if (entry.calls.get(id) === abort) entry.calls.delete(id);
      const disconnected = !response.writableEnded;
      if (disconnected) abort.abort(new Error('Control MCP HTTP request disconnected.'));
      // The SDK only returns 200 for GET when it has established an SSE stream.
      // Its Node adapter may write headers directly, so getHeader('content-type') is not reliable here.
      if (request.method === 'GET' && response.statusCode === 200) void releaseSession(entry, 'client-disconnected');
      else armExpiry(entry);
    };
    response.once('close', finish);
    response.once('finish', finish);
    return abort;
  }

  async function handleRequest(request, response) {
    if (!validateBoundary(request, response)) return;
    if (stopping) { sendError(response, 503, 'Control MCP is stopping.'); return; }
    let entry;
    try {
      if (!(await control.canConnect())) throw Object.assign(new Error('MCP control is disabled in the current mode.'), { code: 'CONTROL_DISABLED' });
      const sessionId = request.headers['mcp-session-id'];
      if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128)) { sendError(response, 400, 'Invalid MCP session ID.'); return; }
      if (sessionId) {
        entry = sessions.get(sessionId);
        if (!entry || entry.closed) { sendError(response, 404, 'MCP session not found.'); return; }
      }
      const body = request.method === 'POST' ? await readBody(request) : undefined;
      if (!entry) {
        if (request.method !== 'POST') { sendError(response, 400, 'Initialize an MCP session first.'); return; }
        entry = await newSession(body);
      }
      if (request.aborted || response.destroyed) { await releaseSession(entry, 'client-disconnected'); return; }
      trackRequest(entry, request, response, body);
      await entry.transport.handleRequest(request, response, body);
      if (!entry.initialized && !entry.closed) await releaseSession(entry, 'initialization-failed');
    } catch (error) {
      const status = error.code === 'CONTROL_BUSY' ? 409 : error.code === 'CONTROL_DISABLED' ? 403 : error.status || 500;
      sendError(response, status, safeError(error), -32000, typeof error.code === 'string' ? { code: error.code } : undefined);
      if (entry && !entry.initialized) await releaseSession(entry, 'initialization-failed');
    }
  }

  async function start() {
    if (startPromise) return startPromise;
    if (stopping) throw new Error('A closed control MCP server cannot restart.');
    startPromise = (async () => {
      const savedPort = port || loadSavedPort();
      listener = httpServerFactory((request, response) => { void handleRequest(request, response).catch(() => sendError(response, 500, 'Control MCP request failed.')); });
      listener.requestTimeout = 30_000;
      listener.headersTimeout = 10_000;
      listener.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      const listen = (value) => new Promise((resolve, reject) => {
        const cleanup = () => { listener.off('listening', onListening); listener.off('error', onError); listener.off('close', onClosed); };
        const onError = (error) => { cleanup(); reject(error); };
        const onListening = () => { cleanup(); resolve(); };
        const onClosed = () => { cleanup(); reject(new Error('Control MCP stopped during startup.')); };
        listener.once('error', onError); listener.once('listening', onListening); listener.once('close', onClosed); listener.listen(value, '127.0.0.1');
      });
      try { await listen(savedPort); }
      catch (error) { if (error.code !== 'EADDRINUSE' || !savedPort) throw error; await listen(0); }
      if (stopping) { await new Promise((resolve) => listener.close(resolve)); throw new Error('Control MCP stopped during startup.'); }
      listener.on('error', (error) => emit('error', { message: safeError(error) }));
      boundPort = listener.address().port;
      url = `http://127.0.0.1:${boundPort}/mcp`;
      savePort(boundPort);
      emit('listening', { urlChanged: Boolean(savedPort && savedPort !== boundPort) });
      return { url, port: boundPort };
    })();
    try { return await startPromise; }
    catch (error) { await close(); throw error; }
  }

  async function disconnectAll(reason = 'control-mode-changed') {
    const released = [...sessions.values()].map((entry) => releaseSession(entry, reason));
    await Promise.all([...released, ...pendingReleases]);
  }

  async function close() {
    if (closePromise) return closePromise;
    stopping = true;
    closePromise = (async () => {
      await disconnectAll('server-shutdown');
      if (listener) {
        const closed = new Promise((resolve) => listener.close(resolve));
        for (const socket of sockets) socket.destroy();
        await closed;
      }
      url = ''; boundPort = 0;
      emit('stopped');
    })();
    return closePromise;
  }

  async function publishEvent(event = {}) {
    sequence += 1;
    lastEvent = { sequence, timestamp: now(), type: safeName(event.type || 'event'), ...(getEventCursor ? { eventId: getEventCursor() } : {}) };
    await Promise.allSettled([...sessions.values()].filter((entry) => entry.initialized && entry.subscribed && !entry.closed).map((entry) => entry.mcp.notification({ method: 'notifications/resources/updated', params: { uri: EVENTS_URI } })));
    return { ...lastEvent };
  }

  return { start, close, disconnectAll, publishEvent, getConnectionInfo: () => ({ url, port: boundPort, bearerToken: token, connectedClients: clients() }) };
}

module.exports = { createControlMcpServer, EVENTS_URI, MAX_BODY_BYTES };
