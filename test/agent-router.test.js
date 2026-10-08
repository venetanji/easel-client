const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentRouter } = require('../src/agent-router');
const { createAgentControl } = require('../src/agent-control');
const { createChatService } = require('../src/chat-service');
const { createCodexChatService } = require('../src/codex-chat-service');
const { createChatStore } = require('../src/chat-store');
const { createCanvasInputStore } = require('../src/canvas-input-store');
const { createMediaJobStore } = require('../src/media-job-store');

const BUILTIN_CHAT = 'b'.repeat(32);
const CODEX_CHAT = 'c'.repeat(32);
const CANVAS = 'd'.repeat(32);
const OTHER_CANVAS = 'e'.repeat(32);
const ASSET = 'a'.repeat(32);
const CONNECTION = 'f'.repeat(32);
const MODEL = 'example-model';
const DOCUMENT = 'index.html';

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 3; index += 1) await new Promise(setImmediate);
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 2000;
  do {
    await new Promise(setImmediate);
    if (predicate()) return;
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}`);
}

function mockServer({ autoComplete = true, startThreadWait } = {}) {
  const observers = new Set();
  const calls = [];
  const turns = new Map();
  let threadNumber = 0;
  let turnNumber = 0;
  const emit = (method, params) => {
    for (const observer of observers) observer({ method, params });
  };
  function complete(turn, status = 'completed') {
    if (!turns.delete(turn.id)) return;
    if (status === 'completed') {
      emit('item/completed', { threadId: turn.threadId, turnId: turn.id,
        item: { id: `message-${turn.id}`, type: 'agentMessage', text: 'Canvas ready.', phase: 'final_answer' } });
    }
    emit('turn/completed', { threadId: turn.threadId, turn: { id: turn.id, status, items: [] } });
  }
  return {
    calls,
    subscribe(observer) { observers.add(observer); return () => observers.delete(observer); },
    subscribeExit() { return () => {}; },
    setRequestHandler(handler) { this.requestHandler = handler; },
    getState: () => ({ connected: true }),
    async initialize() { calls.push(['initialize']); },
    async readAccount() {
      calls.push(['account/read']);
      return { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' }, requiresOpenaiAuth: false };
    },
    async startThread(params) {
      calls.push(['thread/start', params]);
      if (startThreadWait) await startThreadWait;
      return { thread: { id: `thread-${++threadNumber}` } };
    },
    async resumeThread(params) { calls.push(['thread/resume', params]); return { thread: { id: params.threadId } }; },
    async startTurn(params) {
      calls.push(['turn/start', params]);
      const turn = { threadId: params.threadId, id: `turn-${++turnNumber}` };
      turns.set(turn.id, turn);
      emit('turn/started', { threadId: turn.threadId, turn: { id: turn.id, status: 'inProgress' } });
      if (autoComplete) setImmediate(() => complete(turn));
      return { turn: { id: turn.id, status: 'inProgress', items: [] } };
    },
    async interruptTurn(threadId, turnId) {
      calls.push(['turn/interrupt', { threadId, turnId }]);
      const turn = turns.get(turnId);
      if (turn) complete(turn, 'interrupted');
    },
    cancelServerRequests(scope) { calls.push(['cancel/requests', scope]); },
    completeAll() { for (const turn of [...turns.values()]) complete(turn); },
    async close() { calls.push(['close']); },
  };
}

function fixture(t, { backend = 'builtin', freshCodex = false, userDataPath, seed = true,
  serverOptions, getAsset, completeCanvasInput } = {}) {
  const directory = userDataPath || fs.mkdtempSync(path.join(os.tmpdir(), 'easel-agent-router-'));
  const chatStore = createChatStore({ userDataPath: directory });
  if (seed) {
    chatStore.save({ id: BUILTIN_CHAT, backend: 'builtin', title: 'Built-in conversation',
      history: [{ role: 'user', content: 'Build an instrument' }, { role: 'assistant', content: 'Instrument ready.' }] });
    if (!freshCodex) chatStore.save({ id: CODEX_CHAT, backend: 'codex', codexThreadId: 'saved-thread',
      title: 'Codex conversation', history: [{ role: 'user', content: 'Build a scene' }, { role: 'assistant', content: 'Scene ready.' }] });
  }
  const inputStore = createCanvasInputStore({ userDataPath: directory });
  const mediaJobStore = createMediaJobStore({ userDataPath: directory });
  let router;
  const control = createAgentControl({ userDataPath: directory, isAgentBusy: () => Boolean(router?.isRunning()) });
  if (!control.getCodexModel()) control.selectCodexModel(MODEL);
  if (control.getBackend() !== backend) control.setBackend(backend);
  const calls = { llm: [], actions: [], disconnected: [], journal: [], events: [] };
  let canvasId = CANVAS;
  let documentPath = DOCUMENT;
  let instanceId;
  const canvasController = {
    getCurrentCanvasId: () => canvasId,
    getCurrentDocumentPath: () => documentPath,
    getCanvasInputScope: () => ({ canvasId, documentPath, instanceId }),
    getCurrentKits: () => ['tone'],
    async completeCanvasInput(entry) {
      calls.actions.push(entry.id);
      return completeCanvasInput?.(entry);
    },
  };
  const mediaAssetStore = {
    get: getAsset || (async () => ({ id: ASSET, mimeType: 'image/png', data: 'aW1hZ2U=' })),
  };
  const settingsStore = {
    loadPublic: () => ({ activeConnectionId: CONNECTION, litellmBaseUrl: 'http://localhost:4000/v1',
      litellmModel: 'builtin-model', easelBaseUrl: 'https://example.invalid' }),
    loadSecrets: () => ({ litellmApiKey: 'fixture-key', easelApiKey: 'fixture-key' }),
  };
  const builtin = createChatService({ settingsStore, chatStore: chatStore.forBackend('builtin'), inputStore,
    mediaJobStore, mediaAssetStore, canvasController, assetStore: {},
    llmFactory: () => ({ async createCompletion(request) {
      calls.llm.push(request);
      return { choices: [{ message: { role: 'assistant', content: 'Built-in ready.' } }] };
    } }),
    mcpFactory: async () => ({ async listTools() { return []; }, async close() {} }),
    mcpLaunchOptions: () => ({ command: 'fixture' }),
    onEvent: (event) => calls.events.push(event),
  });
  const server = mockServer(serverOptions);
  const codex = createCodexChatService({ appServer: server, chatStore: chatStore.forBackend('codex'),
    cwd: directory, getContext: () => ({ model: control.getCodexModel(), instructions: 'Fixture canvas tools.' }),
    onEvent: (event) => calls.events.push(event), stopTimeoutMs: 100, turnTimeoutMs: 2000 });
  codex.selectModel(control.getCodexModel());
  router = createAgentRouter({ builtin, codex, control, chatStore, inputStore, mediaJobStore,
    mediaAssetStore, canvasController, eventStore: { append: (event) => calls.journal.push(event) },
    onEvent: (event) => calls.events.push(event),
    disconnectControllers: async (reason) => calls.disconnected.push(reason),
  });
  t.after(async () => {
    await router.shutdown();
    if (!userDataPath) fs.rmSync(directory, { recursive: true, force: true });
  });
  const codexTurns = () => server.calls.filter(([name]) => name === 'turn/start');
  function choice(origin, overrides = {}) {
    return inputStore.create({ canvasId: CANVAS, documentPath: DOCUMENT,
      chatId: origin?.chatId || BUILTIN_CHAT, origin, question: 'Choose a palette',
      options: [{ value: 'warm', label: 'Warm' }, { value: 'cool', label: 'Cool' }],
      afterSubmit: 'resetState', turnOptions: { kits: ['tone'] }, ...overrides });
  }
  function answer(entry) {
    return router.submitCanvasInput({ requestId: entry.id, canvasId: entry.canvasId,
      documentPath: entry.documentPath, ...(instanceId ? { instanceId } : {}), value: 'warm' });
  }
  function capture(overrides = {}) {
    return router.submitCanvasMedia({ canvasId: CANVAS, documentPath: DOCUMENT, chatId: router.getActiveChatId(),
      prompt: 'Review the captured scene.',
      attachments: [{ assetId: ASSET, type: 'image', name: 'Canvas capture', mimeType: 'image/png' }],
      approvedModel: control.getBackend() === 'external' ? { backend: 'external' } : { backend: 'codex', model: MODEL },
      turnOptions: { kits: ['tone'] }, ...overrides });
  }
  function job(origin, overrides = {}) {
    const tracked = mediaJobStore.track({ job: { id: `remote-${mediaJobStore.list().length}`, status: 'queued' },
      modelId: 'image-model', baseUrl: 'https://example.invalid', mediaType: 'image',
      projectId: CANVAS, chatId: origin?.chatId || BUILTIN_CHAT, origin,
      approvedAgent: { connectionId: CONNECTION, model: 'builtin-model', baseUrl: 'http://localhost:4000/v1' },
      turnOptions: { kits: ['tone'] }, ...overrides });
    return mediaJobStore.update(tracked.id, { status: 'ready', assets: [{ assetId: ASSET, mimeType: 'image/png' }] });
  }
  return { directory, router, control, builtin, codex, server, calls, chatStore, inputStore,
    mediaJobStore, codexTurns, choice, answer, capture, job,
    setInstance(id) { instanceId = id; },
    setCanvas(id, document = DOCUMENT) { canvasId = id; documentPath = document; } };
}

function codexOrigin(overrides = {}) {
  return { backend: 'codex', chatId: CODEX_CHAT, threadId: 'saved-thread', model: MODEL, ...overrides };
}

test('switches controllers with the actual coordinator and excludes switching from active runs', async (t) => {
  const f = fixture(t);
  await f.router.setBackend('codex');
  assert.equal(f.control.getBackend(), 'codex');
  assert.equal(f.router.isBusy(), false);
  await assert.rejects(f.builtin.sendMessage('Do not run'), /disabled/);
  await f.router.setBackend('external');
  assert.match(f.router.getActiveChatId(), /^[a-f0-9]{32}$/);
  await assert.rejects(f.router.sendMessage('Do not run'), /external agent/i);
  await f.router.setBackend('builtin');
  assert.equal(f.router.getActiveChatId(), BUILTIN_CHAT);
  assert.equal(f.calls.disconnected.length, 3);
});

test('coordinator rejects a controller switch while an MCP tool owns the queue', async (t) => {
  const f = fixture(t, { backend: 'external' });
  const gate = deferred();
  f.control.authorizeConnection({ sessionId: 'fixture-session', name: 'Fixture MCP' });
  const running = f.control.runTool('fixture-session', () => gate.promise);
  try {
    await assert.rejects(f.router.setBackend('codex'), /current agent run|current operation/i);
    assert.equal(f.control.getBackend(), 'external');
  } finally {
    gate.resolve();
    await running;
  }
  await f.router.setBackend('codex');
  assert.equal(f.control.getBackend(), 'codex');
});

test('disabled Built-in preserves answered choices and ready jobs until its conversation is acknowledged', async (t) => {
  const f = fixture(t, { backend: 'codex' });
  const entry = f.choice();
  const job = f.job();
  await f.answer(entry);
  await f.router.notifyMediaJob(job);
  f.router.recoverCanvasInputs();
  await flush();
  assert.equal(f.calls.llm.length, 0);
  assert.equal(f.calls.actions.length, 0);
  assert.equal(f.inputStore.get(entry.id).status, 'answered');
  await f.router.setBackend('builtin');
  await flush();
  assert.equal(f.calls.llm.length, 0);
  f.router.acknowledgeChat(BUILTIN_CHAT);
  await waitFor(() => f.inputStore.get(entry.id).status === 'completed'
    && f.mediaJobStore.get(job.id).notification === 'responded', 'Built-in choice and media continuation');
  assert.equal(f.calls.llm.length, 2);
  assert.deepEqual(f.calls.actions, [entry.id]);
  assert.equal(f.codexTurns().length, 0);
});

test('external choices apply their saved action and journal the answer without a model call', async (t) => {
  const f = fixture(t, { backend: 'external' });
  const chatId = f.router.getActiveChatId();
  const entry = f.choice({ backend: 'external', chatId });
  const result = await f.answer(entry);
  await flush();
  assert.equal(result.queued, false);
  assert.equal(f.inputStore.get(entry.id).status, 'completed');
  assert.equal(f.inputStore.get(entry.id).actionApplied, true);
  assert.deepEqual(f.calls.actions, [entry.id]);
  assert.equal(f.calls.journal[0].request.value, 'warm');
  assert.equal(f.calls.journal[0].chatId, chatId);
  assert.equal(f.calls.llm.length, 0);
  assert.equal(f.codexTurns().length, 0);
});

test('Codex choices stay queued in another controller and continue the exact saved thread once opened', async (t) => {
  const f = fixture(t, { backend: 'external' });
  const entry = f.choice(codexOrigin());
  const result = await f.answer(entry);
  assert.equal(result.queued, true);
  assert.match(result.waitingFor, /original conversation/);
  await flush();
  assert.equal(f.calls.actions.length, 0);
  assert.equal(f.codexTurns().length, 0);
  await f.router.openChat(CODEX_CHAT);
  await flush();
  assert.equal(f.codexTurns().length, 0);
  assert.deepEqual(f.router.acknowledgeChat(BUILTIN_CHAT), { ok: false, stale: true });
  f.router.acknowledgeChat(CODEX_CHAT);
  await waitFor(() => f.inputStore.get(entry.id).status === 'completed', 'Codex choice continuation');
  assert.equal(f.codexTurns().length, 1);
  assert.equal(f.codexTurns()[0][1].threadId, 'saved-thread');
  assert.match(f.codexTurns()[0][1].input[0].text, /Canvas response: Warm/);
  assert.deepEqual(f.calls.actions, [entry.id]);
  assert.equal(f.calls.llm.length, 0);
});

test('Codex choices wait for their original model and canvas document', async (t) => {
  const f = fixture(t, { backend: 'codex' });
  const entry = f.choice(codexOrigin({ model: 'original-model' }));
  await f.answer(entry);
  f.router.acknowledgeChat(CODEX_CHAT);
  await flush();
  assert.equal(f.inputStore.get(entry.id).status, 'answered');
  f.control.selectCodexModel('original-model');
  f.codex.selectModel('original-model');
  f.setCanvas(CANVAS, 'other.html');
  f.router.recoverCanvasInputs();
  await flush();
  assert.equal(f.codexTurns().length, 0);
  f.setCanvas(CANVAS);
  f.router.recoverCanvasInputs();
  await waitFor(() => f.inputStore.get(entry.id).status === 'completed', 'matching Codex model and document');
  assert.equal(f.codexTurns()[0][1].model, 'original-model');
});

test('first Codex capture creates and persists a native thread through the response queue', async (t) => {
  const f = fixture(t, { backend: 'codex', freshCodex: true });
  assert.equal(f.router.getActiveChatId(), '');
  const result = await f.capture();
  assert.match(result.request.chatId, /^[a-f0-9]{32}$/);
  assert.equal(result.queued, true);
  await waitFor(() => f.inputStore.get(result.request.id).status === 'completed', 'first capture thread creation');
  const saved = f.chatStore.get(result.request.chatId);
  assert.equal(saved.backend, 'codex');
  assert.equal(saved.codexThreadId, 'thread-1');
  assert.equal(f.server.calls.filter(([name]) => name === 'thread/start').length, 1);
  assert.equal(f.codexTurns().length, 1);
  assert.equal(f.codexTurns()[0][1].input[1].type, 'image');
  assert.equal(f.codexTurns()[0][1].input[1].url, 'data:image/png;base64,aW1hZ2U=');
  assert.ok(saved.history.some((message) => message.canvasInputCompletedId === result.request.id));
  assert.deepEqual(f.inputStore.get(result.request.id).origin, { backend: 'codex', chatId: saved.id, model: MODEL });
});

test('first Codex capture rejects stale canvas documents before creating a conversation', async (t) => {
  const f = fixture(t, { backend: 'codex', freshCodex: true });
  await assert.rejects(f.capture({ canvasId: OTHER_CANVAS }), /canvas|project|document/i);
  await assert.rejects(f.capture({ documentPath: 'other.html' }), /canvas|project|document/i);
  await flush();
  assert.equal(f.router.getActiveChatId(), '');
  assert.equal(f.inputStore.list().length, 0);
  assert.equal(f.codexTurns().length, 0);
});

test('a capture queues while the first native thread is being prepared', async (t) => {
  const gate = deferred();
  const f = fixture(t, { backend: 'codex', freshCodex: true, serverOptions: { startThreadWait: gate.promise } });
  const running = f.router.sendMessage('Create the initial scene');
  await waitFor(() => f.server.calls.some(([name]) => name === 'thread/start'), 'first thread preparation');
  let result;
  try {
    result = await f.capture();
    assert.equal(result.queued, true);
    await flush();
    assert.equal(f.inputStore.get(result.request.id).status, 'queued');
    assert.equal(f.codexTurns().length, 0);
  } finally {
    gate.resolve();
    await running;
  }
  await waitFor(() => f.inputStore.get(result.request.id).status === 'completed', 'capture after first thread preparation');
  assert.equal(f.server.calls.filter(([name]) => name === 'thread/start').length, 1);
  assert.equal(f.codexTurns().length, 2);
});

test('capture confirmation must match both the active controller and its model', async (t) => {
  const f = fixture(t, { backend: 'codex', freshCodex: true });
  const approvals = [
    { backend: 'codex', model: 'previous-model' },
    { backend: 'external' },
    { connectionId: CONNECTION, model: 'builtin-model', baseUrl: 'http://localhost:4000/v1' },
  ];
  for (const approvedModel of approvals) {
    await assert.rejects(f.capture({ approvedModel }), /approved|destination|controller|model/i);
  }
  await flush();
  assert.equal(f.inputStore.list().length, 0);
  assert.equal(f.router.getActiveChatId(), '');
  assert.equal(f.codexTurns().length, 0);
});

test('external captures reject a previous Codex confirmation and publish a valid saved capture', async (t) => {
  const f = fixture(t, { backend: 'external' });
  await assert.rejects(f.capture({ approvedModel: { backend: 'codex', model: MODEL } }), /approved|destination|controller|model/i);
  const result = await f.capture();
  assert.equal(result.queued, false);
  assert.equal(f.inputStore.get(result.request.id).status, 'completed');
  assert.equal(f.calls.journal.length, 1);
  assert.deepEqual(f.calls.journal[0].request.origin, { backend: 'external', chatId: f.router.getActiveChatId() });
  assert.equal(f.codexTurns().length, 0);
  assert.equal(f.calls.llm.length, 0);
});

test('Codex audio captures are rejected before a thread or saved input is created', async (t) => {
  const f = fixture(t, { backend: 'codex', freshCodex: true });
  await assert.rejects(f.capture({ attachments: [{ assetId: ASSET, type: 'audio', name: 'Recording', mimeType: 'audio/wav' }] }), /audio/i);
  assert.equal(f.router.getActiveChatId(), '');
  assert.equal(f.inputStore.list().length, 0);
  assert.equal(f.codexTurns().length, 0);
});

test('Stop during attachment hydration cannot start a later Codex turn', async (t) => {
  const asset = deferred();
  let hydrating = false;
  const f = fixture(t, { backend: 'codex', getAsset: async () => { hydrating = true; return asset.promise; } });
  const result = await f.capture();
  await waitFor(() => hydrating, 'capture hydration');
  f.router.stopAgent();
  asset.resolve({ mimeType: 'image/png', data: 'aW1hZ2U=' });
  await waitFor(() => !f.router.isRunning(), 'stopped capture continuation');
  assert.equal(f.codexTurns().length, 0);
  assert.equal(f.inputStore.get(result.request.id).status, 'interrupted');
  assert.ok(f.calls.events.some((event) => event.type === 'canvas-input-resume-end'
    && event.request.id === result.request.id && event.request.status === 'interrupted'));
});

test('changing the open document during capture hydration prevents an agent continuation', async (t) => {
  const asset = deferred();
  let hydrating = false;
  const f = fixture(t, { backend: 'codex', getAsset: async () => { hydrating = true; return asset.promise; } });
  const result = await f.capture();
  await waitFor(() => hydrating, 'capture hydration');
  f.setCanvas(CANVAS, 'other.html');
  asset.resolve({ mimeType: 'image/png', data: 'aW1hZ2U=' });
  await waitFor(() => !f.router.isRunning(), 'document change during capture hydration');
  assert.equal(f.codexTurns().length, 0);
  assert.notEqual(f.inputStore.get(result.request.id).status, 'completed');
});

test('Stop interrupts the active Codex response and keeps subsequent queued choices unanswered by an agent', async (t) => {
  const f = fixture(t, { backend: 'codex', serverOptions: { autoComplete: false } });
  const first = f.choice(codexOrigin());
  await f.answer(first);
  f.router.acknowledgeChat(CODEX_CHAT);
  await waitFor(() => f.codexTurns().length === 1, 'first Codex choice turn');
  const second = f.choice(codexOrigin());
  await f.answer(second);
  f.router.stopAgent();
  await waitFor(() => !f.router.isRunning(), 'interrupted native turn');
  assert.equal(f.inputStore.get(first.id).status, 'interrupted');
  assert.equal(f.inputStore.get(second.id).status, 'answered');
  assert.equal(f.codexTurns().length, 1);
  assert.equal(f.calls.disconnected.length, 0);
  assert.equal(f.server.calls.filter(([name]) => name === 'turn/interrupt').length, 1);
  assert.equal(f.server.calls.filter(([name]) => name === 'cancel/requests').length, 1);
  f.router.recoverCanvasInputs();
  await flush();
  assert.equal(f.codexTurns().length, 1);
});

test('Stop during a canvas completion action ends the activity without invoking Codex', async (t) => {
  const action = deferred();
  const f = fixture(t, { backend: 'codex', completeCanvasInput: () => action.promise });
  const entry = f.choice(codexOrigin());
  await f.answer(entry);
  f.router.acknowledgeChat(CODEX_CHAT);
  await waitFor(() => f.calls.actions.length === 1, 'saved completion action');
  f.router.stopAgent();
  action.resolve();
  await waitFor(() => !f.router.isRunning(), 'stopped completion action');
  assert.equal(f.codexTurns().length, 0);
  assert.equal(f.inputStore.get(entry.id).status, 'interrupted');
  assert.ok(f.calls.events.some((event) => event.type === 'canvas-input-resume-end' && event.request.id === entry.id));
});

test('rebooted media jobs retain their origin and resume only the saved Codex conversation and model', async (t) => {
  const first = fixture(t, { backend: 'codex' });
  const builtinJob = first.job();
  const externalJob = first.job({ backend: 'external', chatId: first.control.getExternalChatId() });
  const codexJob = first.job(codexOrigin());
  const otherThreadJob = first.job(codexOrigin({ threadId: 'different-thread' }));
  const otherModelJob = first.job(codexOrigin({ model: 'different-model' }));
  const otherCanvasJob = first.job(codexOrigin(), { projectId: OTHER_CANVAS });
  await first.router.shutdown();
  const second = fixture(t, { backend: 'external', userDataPath: first.directory, seed: false });
  for (const id of [builtinJob.id, externalJob.id, codexJob.id, otherThreadJob.id, otherModelJob.id, otherCanvasJob.id]) {
    await second.router.notifyMediaJob(second.mediaJobStore.get(id));
  }
  await flush();
  assert.equal(second.calls.llm.length, 0);
  assert.equal(second.codexTurns().length, 0);
  assert.deepEqual(second.mediaJobStore.get(codexJob.id).origin, codexOrigin());
  await second.router.openChat(CODEX_CHAT);
  await flush();
  assert.equal(second.codexTurns().length, 0);
  second.router.acknowledgeChat(CODEX_CHAT);
  await waitFor(() => second.mediaJobStore.get(codexJob.id).notification === 'responded', 'persisted Codex job continuation');
  assert.equal(second.codexTurns().length, 1);
  assert.equal(second.codexTurns()[0][1].threadId, 'saved-thread');
  assert.match(second.codexTurns()[0][1].input[0].text, new RegExp(codexJob.id));
  for (const id of [builtinJob.id, externalJob.id, otherThreadJob.id, otherModelJob.id, otherCanvasJob.id]) {
    assert.notEqual(second.mediaJobStore.get(id).notification, 'responded');
  }
  assert.equal(second.calls.llm.length, 0);
});

test('History restores each saved backend and native thread while keeping external sessions out of History', async (t) => {
  const f = fixture(t, { backend: 'external' });
  const externalId = f.control.getExternalChatId();
  f.chatStore.save({ id: externalId, backend: 'external', title: 'External controller', history: [] });
  const chats = f.router.listChats();
  assert.deepEqual(new Set(chats.map((chat) => chat.id)), new Set([BUILTIN_CHAT, CODEX_CHAT]));
  const codex = await f.router.openChat(CODEX_CHAT);
  assert.equal(f.control.getBackend(), 'codex');
  assert.equal(codex.codexThreadId, 'saved-thread');
  assert.equal(codex.history[0].content, 'Build a scene');
  const builtin = await f.router.openChat(BUILTIN_CHAT);
  assert.equal(f.control.getBackend(), 'builtin');
  assert.equal(builtin.history[0].content, 'Build an instrument');
  await f.router.openChat(CODEX_CHAT);
  assert.equal(f.codex.getCurrentThreadId(), 'saved-thread');
  assert.equal(f.calls.llm.length, 0);
  assert.equal(f.codexTurns().length, 0);
});

test('recovery reconciles persisted Codex completion markers without replaying finished inputs or jobs', async (t) => {
  const first = fixture(t, { backend: 'codex' });
  const input = first.choice(codexOrigin());
  first.inputStore.submit({ requestId: input.id, canvasId: CANVAS, documentPath: DOCUMENT, value: 'warm' });
  first.inputStore.beginDispatch(input.id);
  const job = first.job(codexOrigin());
  first.mediaJobStore.update(job.id, { notification: 'dispatching' });
  await first.router.shutdown();
  const saved = first.chatStore.get(CODEX_CHAT);
  first.chatStore.save({ ...saved, history: [...saved.history,
    { role: 'assistant', content: 'Choice applied.', canvasInputCompletedId: input.id },
    { role: 'assistant', content: 'Image attached.', mediaJobCompletedId: job.id }] });
  const second = fixture(t, { backend: 'codex', userDataPath: first.directory, seed: false });
  second.router.recoverCanvasInputs();
  second.router.acknowledgeChat(CODEX_CHAT);
  await flush();
  assert.equal(second.inputStore.get(input.id).status, 'completed');
  assert.equal(second.mediaJobStore.get(job.id).notification, 'responded');
  assert.equal(second.calls.actions.length, 0);
  assert.equal(second.codexTurns().length, 0);
});

test('retry reconciles a saved Codex completion marker rather than repeating its tool effects', async (t) => {
  const f = fixture(t, { backend: 'codex' });
  const entry = f.choice(codexOrigin());
  f.inputStore.submit({ requestId: entry.id, canvasId: CANVAS, documentPath: DOCUMENT, value: 'warm' });
  f.inputStore.interrupt(entry.id);
  const saved = f.chatStore.get(CODEX_CHAT);
  f.chatStore.save({ ...saved, history: [...saved.history,
    { role: 'assistant', content: 'Already completed.', canvasInputCompletedId: entry.id }] });
  const result = await f.router.retryCanvasInput(entry.id);
  await flush();
  assert.equal(result.request.status, 'completed');
  assert.equal(f.inputStore.get(entry.id).status, 'completed');
  assert.equal(f.calls.actions.length, 0);
  assert.equal(f.codexTurns().length, 0);
});

test('recovery interrupts incomplete saved continuations and never retries them automatically', async (t) => {
  const f = fixture(t, { backend: 'codex' });
  const entry = f.choice(codexOrigin());
  f.inputStore.submit({ requestId: entry.id, canvasId: CANVAS, documentPath: DOCUMENT, value: 'warm' });
  f.inputStore.beginDispatch(entry.id);
  const job = f.job(codexOrigin());
  f.mediaJobStore.update(job.id, { notification: 'dispatching' });
  f.router.recoverCanvasInputs();
  f.router.acknowledgeChat(CODEX_CHAT);
  await flush();
  assert.equal(f.inputStore.get(entry.id).status, 'interrupted');
  assert.equal(f.mediaJobStore.get(job.id).notification, 'interrupted');
  assert.equal(f.codexTurns().length, 0);
  await f.router.retryCanvasInput(entry.id);
  await waitFor(() => f.inputStore.get(entry.id).status === 'completed', 'explicit retry of incomplete Codex choice');
  assert.equal(f.codexTurns().length, 1);
});

test('queued completion markers also prevent replaying saved finished inputs and media jobs', async (t) => {
  const f = fixture(t, { backend: 'codex' });
  const entry = f.choice(codexOrigin());
  f.inputStore.submit({ requestId: entry.id, canvasId: CANVAS, documentPath: DOCUMENT, value: 'warm' });
  const job = f.job(codexOrigin());
  const saved = f.chatStore.get(CODEX_CHAT);
  f.chatStore.save({ ...saved, history: [...saved.history,
    { role: 'assistant', content: 'Choice already completed.', canvasInputCompletedId: entry.id },
    { role: 'assistant', content: 'Media already attached.', mediaJobCompletedId: job.id }] });
  f.router.acknowledgeChat(CODEX_CHAT);
  await waitFor(() => f.inputStore.get(entry.id).status === 'completed'
    && f.mediaJobStore.get(job.id).notification === 'responded', 'queued completion marker reconciliation');
  assert.equal(f.calls.actions.length, 0);
  assert.equal(f.codexTurns().length, 0);
});

test('saved captures with conflicting model confirmation cannot resume after reopening', async (t) => {
  const f = fixture(t, { backend: 'codex' });
  const saved = f.inputStore.createMedia({ canvasId: CANVAS, documentPath: DOCUMENT, chatId: CODEX_CHAT,
    origin: codexOrigin(), approvedModel: { backend: 'codex', model: 'previous-model' },
    attachments: [{ assetId: ASSET, type: 'image', name: 'Previously saved capture', mimeType: 'image/png' }] });
  f.router.acknowledgeChat(CODEX_CHAT);
  await flush();
  assert.equal(f.codexTurns().length, 0);
  assert.notEqual(f.inputStore.get(saved.id).status, 'completed');
});

test('external Stop disconnects its controller while retaining accepted media job records', async (t) => {
  const f = fixture(t, { backend: 'external' });
  const origin = { backend: 'external', chatId: f.router.getActiveChatId() };
  const job = f.job(origin);
  await f.router.notifyMediaJob(job);
  const result = f.router.stopAgent();
  await flush();
  assert.equal(result.ok, true);
  assert.equal(f.calls.disconnected.length, 1);
  assert.match(f.calls.disconnected[0], /stopped/);
  assert.deepEqual(f.mediaJobStore.get(job.id).origin, origin);
  assert.equal(f.mediaJobStore.get(job.id).status, 'ready');
  assert.notEqual(f.mediaJobStore.get(job.id).notification, 'responded');
  assert.equal(f.codexTurns().length, 0);
  assert.equal(f.calls.llm.length, 0);
});

for (const backend of ['builtin', 'codex', 'external']) test(`${backend}_rejects_a_rebound_instance_answer_before_resume`, async (t) => {
  const f = fixture(t, { backend }), instanceId = '1'.repeat(32);
  f.setInstance(instanceId);
  const origin = backend === 'codex' ? codexOrigin() : backend === 'external' ? { backend, chatId: f.router.getActiveChatId() } : undefined;
  const entry = f.choice(origin, { instanceId, afterSubmit: 'restorePreviousView' });
  f.setInstance('2'.repeat(32));
  await assert.rejects(f.answer(entry), /original|instance|canvas/i);
  await flush();
  assert.equal(f.inputStore.get(entry.id).status, 'pending');
  assert.equal(f.calls.actions.length + f.calls.llm.length + f.codexTurns().length, 0);
});

for (const backend of ['builtin', 'codex']) test(`${backend}_instance_answer_resumes_once_with_document_and_instance_context`, async (t) => {
  const f = fixture(t, { backend }), instanceId = '1'.repeat(32);
  f.setInstance(instanceId);
  const entry = f.choice(backend === 'codex' ? codexOrigin() : undefined, { instanceId, afterSubmit: 'restorePreviousView' });
  f.router.acknowledgeChat(f.router.getActiveChatId());
  await f.answer(entry);
  await waitFor(() => f.inputStore.get(entry.id).status === 'completed', 'one instance-scoped continuation');
  await assert.rejects(f.answer(entry), /already answered|no longer active/);
  f.router.recoverCanvasInputs(); await flush();
  const requests = backend === 'builtin' ? f.calls.llm : f.codexTurns();
  assert.equal(requests.length, 1);
  const text = backend === 'builtin' ? JSON.stringify(requests[0].messages) : JSON.stringify(requests[0][1].input);
  assert.match(text, new RegExp(instanceId));
  assert.match(text, /index.html/);
  assert.deepEqual(f.calls.actions, [entry.id]);
});

for (const backend of ['builtin', 'codex']) test(`${backend}_rechecks_instance_after_deferred_completion`, async (t) => {
  const gate = deferred(), f = fixture(t, { backend, completeCanvasInput: () => gate.promise }), instanceId = '1'.repeat(32);
  f.setInstance(instanceId);
  const entry = f.choice(backend === 'codex' ? codexOrigin() : undefined, { instanceId, afterSubmit: 'restorePreviousView' });
  f.router.acknowledgeChat(f.router.getActiveChatId()); await f.answer(entry);
  await waitFor(() => f.calls.actions.length === 1, 'completion admission');
  f.setInstance('2'.repeat(32)); gate.resolve();
  await waitFor(() => f.inputStore.get(entry.id).status === 'failed', 'rejected stale continuation');
  assert.equal(f.calls.llm.length + f.codexTurns().length, 0);
});
