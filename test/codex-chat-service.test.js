const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCodexChatService, defaultInput } = require('../src/codex-chat-service');
const { createChatStore } = require('../src/chat-store');

const cwd = path.resolve('test-easel-codex-workspace');

function mockServer({ autoComplete = true, completeBeforeResponse = false } = {}) {
  const observers = new Set();
  const exits = new Set();
  const calls = [];
  let turns = 0;
  let threads = 0;
  let last;
  const emit = (method, params) => { for (const observer of observers) observer({ method, params }); };
  const server = {
    calls,
    emit,
    exit(error) { for (const observer of exits) observer(error); },
    subscribe(observer) { observers.add(observer); return () => observers.delete(observer); },
    subscribeExit(observer) { exits.add(observer); return () => exits.delete(observer); },
    setRequestHandler(handler) { this.requestHandler = handler; },
    getState: () => ({ connected: true }),
    async initialize() { calls.push(['initialize']); },
    async startThread(params) { calls.push(['thread/start', params]); return { thread: { id: `thread-${++threads}` } }; },
    async resumeThread(params) { calls.push(['thread/resume', params]); return { thread: { id: params.threadId } }; },
    async startTurn(params) {
      calls.push(['turn/start', params]);
      last = { threadId: params.threadId, id: `turn-${++turns}-${crypto.randomUUID()}` };
      const current = last;
      emit('turn/started', { threadId: current.threadId, turn: { id: current.id, status: 'inProgress' } });
      const complete = () => {
        emit('item/agentMessage/delta', { threadId: current.threadId, turnId: current.id, itemId: `item-${turns}`, delta: 'Hello ' });
        emit('item/agentMessage/delta', { threadId: current.threadId, turnId: current.id, itemId: `item-${turns}`, delta: 'canvas' });
        emit('item/completed', { threadId: current.threadId, turnId: current.id, item: { id: `item-${turns}`, type: 'agentMessage', text: 'Hello canvas', phase: 'final_answer' } });
        emit('turn/completed', { threadId: current.threadId, turn: { id: current.id, items: [], status: 'completed' } });
      };
      if (autoComplete) {
        if (completeBeforeResponse) complete(); else setImmediate(complete);
      }
      return { turn: { id: current.id, items: [], status: 'inProgress' } };
    },
    async interruptTurn(threadId, turnId) { calls.push(['turn/interrupt', { threadId, turnId }]); emit('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [] } }); },
    async close() { calls.push(['close']); },
    async readAccount() { calls.push(['account/read']); return { account: { type: 'chatgpt', email: 'user@example.invalid', planType: 'plus' }, requiresOpenaiAuth: false }; },
    async listModels() { calls.push(['model/list']); return { data: [{ id: 'model-1', model: 'example-model', isDefault: true, inputModalities: ['text', 'image'] }], nextCursor: null }; },
    async startLogin(type) { calls.push(['account/login/start', { type }]); return { type, loginId: 'login-1', authUrl: 'https://example.invalid/login' }; },
    async cancelLogin(loginId) { calls.push(['account/login/cancel', { loginId }]); return { status: 'cancelled' }; },
    async logout() { calls.push(['account/logout']); return {}; },
    get lastTurn() { return last; },
  };
  return server;
}

function memoryStore() {
  const chats = new Map();
  let active = '';
  return {
    save(chat) { chats.set(chat.id, structuredClone(chat)); active = chat.id; return { id: chat.id }; },
    get(id) { if (!chats.has(id)) throw new Error('Missing chat'); return structuredClone(chats.get(id)); },
    getActive() { return active ? this.get(active) : null; },
    activate(id) { active = id; },
    list() { return [...chats.values()].map(({ history, ...metadata }) => metadata); },
  };
}

test('streams messages, persists local/thread mapping, and applies fixed read-only policy', async () => {
  const server = mockServer();
  const store = memoryStore();
  const events = [];
  const origins = [];
  const service = createCodexChatService({ appServer: server, chatStore: store, cwd, onEvent: (event) => events.push(event), getContext: () => ({ model: 'example-model', instructions: 'Project instructions', origin: { projectId: 'p'.repeat(32) } }), onTurnReady: (context) => origins.push(context) });
  const result = await service.sendMessage('Make a canvas');
  assert.equal(result.text, 'Hello canvas');
  assert.match(result.chatId, /^[a-f0-9]{32}$/);
  assert.equal(result.threadId, 'thread-1');
  assert.equal(service.isBusy(), false);
  assert.deepEqual(events.filter((event) => event.type === 'token').map((event) => event.text), ['Hello ', 'canvas']);
  assert.equal(events.filter((event) => event.type === 'assistant').length, 1);
  const saved = store.get(result.chatId);
  assert.equal(saved.backend, 'codex');
  assert.equal(saved.codexThreadId, 'thread-1');
  assert.equal(saved.history[1].content, 'Hello canvas');
  assert.equal(saved.history[1].partial, false);
  const start = server.calls.find(([name]) => name === 'thread/start')[1];
  assert.equal(start.cwd, cwd);
  assert.equal(start.modelProvider, 'openai');
  assert.equal(start.sandbox, 'read-only');
  assert.match(start.developerInstructions, /Project instructions/);
  const turn = server.calls.find(([name]) => name === 'turn/start')[1];
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(origins[0].turnId, '');
  assert.equal(origins[1].turnId, server.lastTurn.id);
});

test('handles completion events before turn/start responds without duplicate final messages', async () => {
  const server = mockServer({ completeBeforeResponse: true });
  const service = createCodexChatService({ appServer: server, cwd });
  assert.equal((await service.sendMessage('Fast')).text, 'Hello canvas');
  assert.equal((await service.getCurrentChat()).history.filter((message) => message.role === 'assistant').length, 1);
});

test('restores the exact Codex thread from persisted chat metadata after reopening', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-codex-chat-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createChatStore({ userDataPath });
  const first = createCodexChatService({ appServer: mockServer(), chatStore: store, cwd });
  const saved = await first.sendMessage('First message');
  await first.shutdown();
  const secondServer = mockServer();
  const second = createCodexChatService({ appServer: secondServer, chatStore: store, cwd });
  assert.equal((await second.getCurrentChat()).id, saved.chatId);
  assert.equal(second.hasThread(saved.chatId), true);
  const response = await second.continueConversation(saved.chatId, 'My canvas answer', { canvasInputRequestId: 'input-1' });
  assert.equal(response.threadId, saved.threadId);
  assert.equal(secondServer.calls.some(([name]) => name === 'thread/start'), false);
  assert.equal(secondServer.calls.find(([name]) => name === 'thread/resume')[1].threadId, saved.threadId);
  assert.equal(secondServer.calls.find(([name]) => name === 'thread/resume')[1].modelProvider, 'openai');
  assert.equal((await second.getCurrentChat()).history.find((message) => message.canvasInputRequestId).content, 'My canvas answer');
  assert.equal((await second.getCurrentChat()).history.some((message) => message.canvasInputCompletedId === 'input-1'), true);
  await second.shutdown();
});

test('Stop interrupts the native turn and keeps partial output/history', async () => {
  const server = mockServer({ autoComplete: false });
  const events = [];
  const service = createCodexChatService({ appServer: server, chatStore: memoryStore(), cwd, onEvent: (event) => events.push(event) });
  const pending = service.sendMessage('Run');
  await new Promise(setImmediate);
  const turn = server.lastTurn;
  server.emit('item/agentMessage/delta', { threadId: turn.threadId, turnId: turn.id, itemId: 'partial-1', delta: 'Partial reply' });
  assert.equal(service.stop().active, true);
  const stopped = await pending;
  assert.equal(stopped.cancelled, true);
  assert.equal(service.isBusy(), false);
  assert.equal(server.calls.filter(([name]) => name === 'turn/interrupt').length, 1);
  assert.equal((await service.getCurrentChat()).history.at(-1).content, 'Partial reply');
  assert.equal(events.at(-1).type, 'agent-stopped');
});

test('waits for the canvas-input tool reply before interrupting for a durable choice', async () => {
  const server = mockServer({ autoComplete: false });
  const service = createCodexChatService({ appServer: server, cwd });
  const pending = service.sendMessage('Ask for a choice');
  await new Promise(setImmediate);
  const turn = server.lastTurn;
  const request = { id: 'input-1', question: 'Choose A or B' };
  assert.equal(service.pauseForCanvasInput(request).waiting, true);
  await new Promise(setImmediate);
  assert.equal(server.calls.some(([name]) => name === 'turn/interrupt'), false);
  server.emit('item/completed', { threadId: turn.threadId, turnId: turn.id, item: { id: 'tool-1', type: 'mcpToolCall', tool: 'request_canvas_input', status: 'completed', result: { content: [{ type: 'text', text: 'Choice saved' }] } } });
  const result = await pending;
  assert.deepEqual(result.awaitingCanvasInput, request);
  assert.equal(result.cancelled, undefined);
  assert.equal(server.calls.filter(([name]) => name === 'turn/interrupt').length, 1);
});

test('rejects concurrent sends, stale continuations and chat changes while busy', async () => {
  const server = mockServer({ autoComplete: false });
  const service = createCodexChatService({ appServer: server, chatStore: memoryStore(), cwd });
  const pending = service.sendMessage('Working');
  await new Promise(setImmediate);
  await assert.rejects(service.sendMessage('Another'), /current reply/);
  assert.throws(() => service.clearHistory(), /current reply/);
  await assert.rejects(service.continueConversation('a'.repeat(32), 'Answer'), /original Codex conversation/);
  service.stopAgent();
  await pending;
});

test('surfaces process exits and failed turns while preserving the actual prompt', async () => {
  const server = mockServer({ autoComplete: false });
  const service = createCodexChatService({ appServer: server, chatStore: memoryStore(), cwd });
  const pending = service.sendMessage('Remember me');
  await new Promise(setImmediate);
  server.exit(new Error('Mock process exited'));
  await assert.rejects(pending, /Mock process exited/);
  assert.equal(service.isBusy(), false);
  assert.equal((await service.getCurrentChat()).history[0].content, 'Remember me');
  const next = service.sendMessage('Try again');
  await new Promise(setImmediate);
  const turn = server.lastTurn;
  server.emit('turn/completed', { threadId: turn.threadId, turn: { id: turn.id, status: 'failed', items: [], error: { message: 'Mock failed turn' } } });
  await assert.rejects(next, /Mock failed turn/);
});

test('supports explicit account/model controls and passes caller identity to native approvals', async () => {
  const server = mockServer();
  let approval;
  const service = createCodexChatService({ appServer: server, cwd, onServerRequest: async (request) => { approval = request; return { decision: 'decline' }; } });
  assert.equal(server.calls.length, 0);
  await service.readAccount();
  await service.listModels();
  assert.equal(service.getState().authenticated, true);
  assert.equal(service.getState().model, 'example-model');
  assert.equal(service.selectModel({ model: 'example-model', effort: 'high' }).effort, 'high');
  await service.startLogin('chatgpt');
  await service.cancelLogin();
  await server.requestHandler({ method: 'item/fileChange/requestApproval', params: {} });
  assert.equal(approval.readOnly, true);
  await service.logout();
  assert.equal(service.getState().authenticated, false);
  assert.equal(server.calls.filter(([name]) => name === 'account/logout').length, 1);
});

test('allows model refresh to confirm the busy selection without resetting reasoning effort', async () => {
  const server = mockServer({ autoComplete: false });
  server.listModels = async () => ({ data: [
    { id: 'model-1', model: 'example-model', isDefault: true },
    { id: 'model-2', model: 'another-model' },
  ] });
  const service = createCodexChatService({ appServer: server, cwd });
  await service.listModels();
  service.selectModel({ model: 'example-model', effort: 'high' });
  const pending = service.sendMessage('Working');
  await new Promise(setImmediate);
  assert.deepEqual(service.selectModel('example-model'), { ok: true, model: 'example-model', effort: 'high' });
  assert.equal(service.selectModel({ model: 'model-1', effort: 'high' }).effort, 'high');
  assert.throws(() => service.selectModel('another-model'), /current reply/);
  assert.throws(() => service.selectModel({ model: 'example-model', effort: 'low' }), /current reply/);
  service.stopAgent();
  await pending;
  await service.shutdown();
  assert.throws(() => service.selectModel('example-model'), /closing/);
});

test('preserves a valid catalog selection and replaces a removed model with the current default', async () => {
  const server = mockServer();
  const service = createCodexChatService({ appServer: server, cwd });
  await service.listModels();
  service.selectModel({ model: 'example-model', effort: 'high' });
  await service.listModels();
  assert.equal(service.getState().model, 'example-model');
  assert.equal(service.getState().effort, 'high');
  server.listModels = async () => ({ data: [
    { id: 'first-model', model: 'another-model' },
    { id: 'default-model', model: 'current-default', isDefault: true },
  ] });
  assert.equal((await service.listModels()).model, 'current-default');
  assert.equal(service.getState().effort, '');
  server.listModels = async () => ({ data: [] });
  assert.equal((await service.listModels()).model, '');
});

test('requires managed ChatGPT auth without implicitly clearing other cached account types', async () => {
  for (const account of [null, { type: 'apiKey' }, { type: 'amazonBedrock' }]) {
    const server = mockServer();
    server.readAccount = async () => ({ account, requiresOpenaiAuth: true });
    const service = createCodexChatService({ appServer: server, cwd });
    await service.readAccount();
    assert.equal(service.getState().authenticated, false);
    await assert.rejects(service.sendMessage('Create a canvas'), /Sign in with ChatGPT/);
    assert.equal(server.calls.some(([name]) => ['thread/start', 'turn/start', 'account/logout'].includes(name)), false);
    assert.deepEqual((await service.getCurrentChat()).history, []);
  }
});

test('persists compact capture references and restores previews without MCP observation bytes', async () => {
  const server = mockServer({ autoComplete: false });
  const store = memoryStore();
  const service = createCodexChatService({ appServer: server, chatStore: store, cwd });
  const pending = service.sendMessage('Inspect this canvas');
  await new Promise(setImmediate);
  const turn = server.lastTurn;
  const metadata = { ok: true, assetId: 'a'.repeat(32), mimeType: 'image/png', width: 640, height: 480, name: 'Canvas capture' };
  const binary = 'YWJj'.repeat(25_000);
  const results = [
    { content: [
      { type: 'text', text: JSON.stringify(metadata) },
      { type: 'image', mimeType: 'image/png', data: binary },
      { type: 'audio', mimeType: 'audio/wav', data: binary },
      { type: 'resource', resource: { uri: `asset://${metadata.assetId}`, mimeType: 'image/png', blob: binary } },
    ], structuredContent: metadata },
    { content: [{ type: 'text', text: 'Source'.repeat(10_000) }], structuredContent: { ...metadata, source: 'Source'.repeat(10_000), assets: [{ assetId: 'b'.repeat(32), mimeType: 'image/jpeg', name: 'Generated image' }] } },
    { content: [{ type: 'text', text: JSON.stringify({ ...metadata, source: 'Source'.repeat(10_000) }) }] },
  ];
  for (let index = 0; index < results.length; index += 1) server.emit('item/completed', {
    threadId: turn.threadId, turnId: turn.id,
    item: { id: `capture-${index}`, type: 'mcpToolCall', tool: 'capture_live_canvas', status: 'completed', result: results[index] },
  });
  service.stopAgent();
  await pending;
  await service.shutdown();
  const restored = createCodexChatService({ appServer: mockServer(), chatStore: store, cwd, hydrateChat: async (snapshot) => {
    const assets = new Set();
    for (const message of snapshot.history.filter((entry) => entry.role === 'tool')) {
      assert.ok(Buffer.byteLength(message.content) <= 24_000);
      assert.equal(message.content.includes(binary), false);
      const result = JSON.parse(message.content);
      if (result.structuredContent.assetId) assets.add(result.structuredContent.assetId);
      for (const asset of result.structuredContent.assets || []) assets.add(asset.assetId);
    }
    snapshot.images = [...assets].map((assetId) => ({ assetId, mimeType: 'image/png', data: 'YWJj' }));
    return snapshot;
  } });
  const snapshot = await restored.getCurrentChat();
  assert.equal(snapshot.history.filter((message) => message.role === 'tool').length, 3);
  assert.deepEqual(snapshot.images.map((image) => image.assetId).sort(), ['a'.repeat(32), 'b'.repeat(32)]);
  const savedCapture = JSON.parse(snapshot.history.find((message) => message.codexItemId === 'capture-0').content);
  assert.equal(savedCapture.structuredContent.width, 640);
  assert.equal(savedCapture.content[1].data, undefined);
  assert.equal(savedCapture.content[2].data, undefined);
  assert.equal(savedCapture.content[3].resource.blob, undefined);
  await restored.shutdown();
});

test('hydrates images and video observations while rejecting unsupported audio before a turn', async () => {
  const input = defaultInput({ text: 'Look', attachments: [
    { type: 'image', mimeType: 'image/png', data: 'YWJj' },
    { type: 'video', name: 'Clip', frames: [{ timestamp: 1.5, data: 'YWJj' }] },
  ] });
  assert.equal(input.filter((entry) => entry.type === 'image').length, 2);
  assert.match(input.find((entry) => entry.text?.includes('Frame')).text, /1.5s/);
  const server = mockServer();
  const service = createCodexChatService({ appServer: server, cwd });
  await assert.rejects(service.sendMessage('Listen', { attachments: [{ type: 'audio', mimeType: 'audio/wav', data: 'YWJj' }] }), /Audio attachments are not supported/);
  assert.equal(server.calls.some(([name]) => name === 'turn/start'), false);
  assert.deepEqual((await service.getCurrentChat()).history, []);
});

test('creates an empty local conversation without model calls and disconnects/restarts an idle runtime', async () => {
  const server = mockServer();
  const service = createCodexChatService({ appServer: server, chatStore: memoryStore(), cwd });
  const id = service.ensureConversation('Captured canvas');
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(server.calls.length, 0);
  await service.disconnectRuntime();
  assert.equal(server.calls.at(-1)[0], 'close');
  assert.equal((await service.sendMessage('Create')).chatId, id);
  await service.shutdown();
  service.cancelShutdown();
  assert.equal((await service.sendMessage('Continue')).chatId, id);
  service.clearHistory();
  assert.equal((await service.getCurrentChat()).id, '');
  assert.equal(service.listChats().length, 1);
});

test('Stop cancels preparation and shutdown without waiting for a stalled context callback', async () => {
  const server = mockServer();
  const service = createCodexChatService({ appServer: server, cwd, getContext: () => new Promise(() => {}) });
  const pending = service.sendMessage('Prepare');
  await new Promise(setImmediate);
  const closing = service.shutdown();
  assert.equal((await pending).cancelled, true);
  await closing;
  assert.equal(server.calls.some(([name]) => name === 'turn/start'), false);
});

test('a callback failure after turn start interrupts the actual native turn', async () => {
  const server = mockServer({ autoComplete: false });
  const service = createCodexChatService({ appServer: server, cwd, onTurnReady: ({ turnId }) => { if (turnId) throw new Error('Mock origin failure'); } });
  await assert.rejects(service.sendMessage('Run'), /Mock origin failure/);
  assert.equal(server.calls.filter(([name]) => name === 'turn/interrupt').length, 1);
  assert.equal(service.isBusy(), false);
});

test('forces runtime closure if a native interrupt never completes', async () => {
  const server = mockServer({ autoComplete: false });
  server.interruptTurn = async (threadId, turnId) => { server.calls.push(['turn/interrupt', { threadId, turnId }]); };
  const service = createCodexChatService({ appServer: server, cwd, stopTimeoutMs: 5 });
  const pending = service.sendMessage('Run');
  await new Promise(setImmediate);
  service.stop();
  assert.equal((await pending).cancelled, true);
  assert.equal(server.calls.some(([name]) => name === 'close'), true);
  assert.equal(service.isBusy(), false);
});

test('turn timeout interrupts the native turn and reports a useful failure', async () => {
  const server = mockServer({ autoComplete: false });
  const service = createCodexChatService({ appServer: server, cwd, turnTimeoutMs: 5 });
  await assert.rejects(service.sendMessage('Run'), /timed out/);
  assert.equal(server.calls.some(([name]) => name === 'turn/interrupt'), true);
  assert.equal(service.isBusy(), false);
});

test('background media continuation stores the output and successful completion marker', async () => {
  const server = mockServer();
  const service = createCodexChatService({ appServer: server, chatStore: memoryStore(), cwd });
  const initial = await service.sendMessage('Generate a video');
  const output = { status: 'ready', assets: [{ assetId: 'a'.repeat(32) }] };
  await service.continueConversation(initial.chatId, 'Video ready', { mediaJobId: 'job-1', mediaJobResult: output });
  const history = (await service.getCurrentChat()).history;
  assert.deepEqual(history.find((message) => message.mediaJobId === 'job-1').mediaJobResult, output);
  assert.equal(history.some((message) => message.mediaJobCompletedId === 'job-1'), true);
});

test('successful managed sign-in refreshes public account status and available models', async () => {
  const server = mockServer();
  const service = createCodexChatService({ appServer: server, cwd });
  server.emit('account/login/completed', { loginId: 'login-1', success: true });
  await new Promise(setImmediate);
  assert.equal(service.getState().authenticated, true);
  assert.equal(service.getState().models.length, 1);
});

test('Stop completes even when a started native turn has not acknowledged turn/start', async () => {
  const server = mockServer({ autoComplete: false });
  server.startTurn = async (params) => {
    server.calls.push(['turn/start', params]);
    server.emit('turn/started', { threadId: params.threadId, turn: { id: 'unacknowledged-turn', status: 'inProgress' } });
    return new Promise(() => {});
  };
  const service = createCodexChatService({ appServer: server, cwd });
  const pending = service.sendMessage('Run');
  await new Promise(setImmediate);
  service.stop();
  assert.equal((await pending).cancelled, true);
  assert.equal(service.isBusy(), false);
});

test('Stop closes a pending native turn when its ID is never returned', async () => {
  const server = mockServer({ autoComplete: false });
  server.startTurn = async () => new Promise(() => {});
  const service = createCodexChatService({ appServer: server, cwd, stopTimeoutMs: 5 });
  const pending = service.sendMessage('Run');
  await new Promise(setImmediate);
  service.stop();
  assert.equal((await pending).cancelled, true);
  assert.equal(server.calls.some(([name]) => name === 'close'), true);
  assert.equal(service.isBusy(), false);
});
