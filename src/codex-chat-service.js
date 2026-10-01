const crypto = require('node:crypto');
const path = require('node:path');
const { createCodexAppServer } = require('./codex-app-server');
const { validateChatMessage } = require('./ipc-contract');

const EASEL_INSTRUCTIONS = 'You are the Easel creative canvas assistant. Work through the easel MCP tools for canvas source, rendering, media, and user choices. For image creation or editing, use native Codex image_generation when available unless the user requests a configured media endpoint. Easel automatically imports completed native images into its media library and the originating project. After generation, call list_media_assets to obtain the saved asset IDs for canvas attachments and references; do not regenerate an image because project attachment failed. Native generation uses the signed-in Codex account. The shell workspace is an empty host-managed read-only directory, not the canvas project. Never edit files or run shell commands to change canvas content. Use installed offline kits, local media references, and installed OS fonts. For source work, use list_canvas_files with includeAssets:false and read only relevant files, with maxBytes no greater than 24000. present_canvas returns actual saved paths and revisions because inline scripts/styles can become separate files; use those paths instead of guessing. Combine related replacements in apply_canvas_file_patches against one expectedProjectRevision, then reload once with validation. capture_live_canvas already includes validation; it captures the actual open view and supports at most 8 frames. Use validate_canvas alone when pixels are unnecessary. Captures are saved in Media and previewed automatically in chat. Link saved media as [Short description](asset://EXACT_ASSET_ID), using the returned ID. Native host confirmation governs destructive operations. request_canvas_input ends your turn until the user responds; do not poll for the answer.';

function defaultInput({ text, attachments = [] }) {
  const input = text ? [{ type: 'text', text }] : [];
  for (const attachment of attachments) {
    if (attachment.type === 'audio') throw new Error('Audio attachments are not supported by the embedded Codex backend. Use a supported agent model for this capture.');
    if (attachment.type === 'image') {
      input.push({ type: attachment.type, url: `data:${attachment.mimeType};base64,${attachment.data}` });
    } else if (attachment.type === 'video') {
      input.push({ type: 'text', text: `Sampled still frames from ${attachment.name}; video audio is not included.` });
      for (const frame of attachment.frames) {
        input.push({ type: 'text', text: `Frame at ${frame.timestamp}s` }, { type: 'image', url: `data:image/jpeg;base64,${frame.data}` });
      }
    } else throw new Error('This attachment is not supported by Codex.');
  }
  return input;
}

function stoppedError() {
  return Object.assign(new Error('Codex request stopped.'), { name: 'AbortError' });
}

function compactToolResult(item) {
  const result = item.result || { error: item.error || null };
  function omitBinary(key, value) {
    if (typeof value !== 'string') return value;
    if (key === 'blob' || key === 'thumbnail' || (key === 'url' && value.startsWith('data:'))) return undefined;
    if (key === 'data' && (['image', 'audio'].includes(this.type) || /^(?:image|audio|video)\//.test(this.mimeType || ''))) return undefined;
    return value;
  }
  // Native threads retain visual observations; Easel history keeps reusable references.
  const content = JSON.stringify(result, omitBinary);
  if (Buffer.byteLength(content) <= 24_000) return content;
  const summary = { tool: item.tool, status: item.status, outputOmitted: true };
  const structured = result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent, omitBinary);
  if (structured && Buffer.byteLength(structured) <= 16_000) {
    summary.structuredContent = JSON.parse(structured);
  } else {
    const assets = new Map();
    let inspected = 0;
    const fields = ['assetId', 'mimeType', 'name', 'bytes', 'width', 'height', 'duration', 'projectId', 'projectPath', 'documentPath'];
    function inspect(value, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 8 || ++inspected > 1000 || assets.size >= 40) return;
      if (typeof value.assetId === 'string' && value.assetId.length <= 128) {
        const asset = {};
        for (const field of fields) if (typeof value[field] === 'number' || typeof value[field] === 'string' && value[field].length <= 240) asset[field] = value[field];
        const proposed = [...assets.values()].filter((entry) => entry.assetId !== asset.assetId).concat(asset);
        if (Buffer.byteLength(JSON.stringify(proposed)) <= 16_000) assets.set(asset.assetId, asset);
      }
      const values = Array.isArray(value) ? value : Object.entries(value).filter(([key]) => !['data', 'blob', 'thumbnail'].includes(key)).map(([, nested]) => nested);
      for (const nested of values) inspect(nested, depth + 1);
    }
    inspect(result.structuredContent);
    for (const block of Array.isArray(result.content) ? result.content : []) {
      inspect(block);
      if (block?.type === 'text') { try { inspect(JSON.parse(block.text)); } catch { /* Plain text has no asset references. */ } }
    }
    if (assets.size) summary.structuredContent = { assets: [...assets.values()] };
  }
  return JSON.stringify(summary);
}

function createCodexChatService({
  appServer,
  appServerFactory = createCodexAppServer,
  chatStore,
  cwd,
  getMcpConnection,
  getTurnContext,
  getContext,
  getInstructions,
  getModel,
  onEvent,
  onServerRequest,
  onTurnReady,
  importGeneratedImage,
  getImageGenerationContext,
  prepareInput = defaultInput,
  hydrateChat,
  turnTimeoutMs = 15 * 60_000,
  stopTimeoutMs = 5000,
} = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Codex needs a dedicated absolute Easel working directory.');
  const server = appServer || appServerFactory({ cwd, getMcpConnection });
  let chatId = '';
  let title = '';
  let threadId = '';
  let loadedThreadId = '';
  let loadedThreadOptions = '';
  let origin = {};
  let history = [];
  let active;
  let shuttingDown = false;
  let selectedModel = '';
  let selectedEffort = '';
  let models = [];
  let account = null;
  let requiresOpenaiAuth = true;
  let login = null;
  let lastError = '';
  let saveWarning = '';
  let saveTimer;

  function emit(event) {
    try { onEvent?.({ ...event, backend: 'codex', ...(event.chatId === undefined && chatId ? { chatId } : {}) }); }
    catch { /* Rendering cannot prevent saving or finishing a turn. */ }
  }

  function getState() {
    return { backend: 'codex', ...server.getState?.(), busy: Boolean(active), authenticated: account?.type === 'chatgpt', requiresOpenaiAuth, account, login, models: structuredClone(models), model: selectedModel, effort: selectedEffort, chatId, threadId, ...(lastError ? { error: lastError } : {}) };
  }

  function applySaved(saved) {
    chatId = saved.id;
    title = saved.title;
    threadId = saved.codexThreadId || '';
    origin = saved.origin || {};
    history = structuredClone(saved.history);
  }

  try {
    const saved = chatStore?.getActive();
    if (saved?.backend === 'codex') applySaved(saved);
  } catch { lastError = 'Saved Codex chat could not be restored. Open History to choose another conversation.'; }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!chatStore || !chatId) return;
    try {
      chatStore.save({ id: chatId, title, history, backend: 'codex', ...(threadId ? { codexThreadId: threadId } : {}), origin });
      saveWarning = '';
    } catch { saveWarning = 'This chat could not be saved locally. Keep this window open and check available disk space.'; }
  }

  function scheduleSave() {
    if (!saveTimer) saveTimer = setTimeout(save, 200);
  }

  function assertIdle() {
    if (active) throw new Error('Wait for the current reply before changing conversations.');
    if (shuttingDown) throw new Error('The application is closing.');
  }

  function finish(turn, error, result) {
    if (turn.settled || turn.finishing) return;
    turn.finishing = true;
    clearTimeout(turn.timer);
    clearTimeout(turn.stopTimer);
    const settle = () => {
      turn.settled = true;
      save();
      if (error) turn.reject(error); else turn.resolve(result);
    };
    // Keep the conversation owned until every emitted image has been saved.
    if (turn.imageImports.length) Promise.allSettled(turn.imageImports).then(settle);
    else settle();
  }

  async function interrupt(turn) {
    if (!turn || turn.settled || turn.finishing || !turn.threadId || !turn.turnId || turn.interruptSent) return;
    turn.interruptSent = true;
    clearTimeout(turn.stopTimer);
    turn.stopTimer = setTimeout(() => {
      if (turn.settled) return;
      // A missing interrupt acknowledgement must not leave an agent running after Stop.
      Promise.resolve(server.close()).catch(() => {});
      finish(turn, null, { status: 'interrupted' });
    }, stopTimeoutMs);
    try { await server.interruptTurn(turn.threadId, turn.turnId); }
    catch (error) {
      if (!turn.settled) {
        Promise.resolve(server.close()).catch(() => {});
        finish(turn, turn.waiting ? null : error, { status: 'interrupted' });
      }
    }
  }

  function requestPause(turn) {
    if (turn?.waiting && turn.inputToolCompleted) queueMicrotask(() => interrupt(turn));
  }

  function assistantMessage(turn, itemId) {
    let message = history.find((entry) => entry.role === 'assistant' && entry.codexItemId === itemId && entry.codexTurnId === turn.turnId);
    if (!message) {
      message = { role: 'assistant', content: '', codexItemId: itemId, codexTurnId: turn.turnId, partial: true };
      history.push(message);
    }
    return message;
  }

  function importImage(turn, item) {
    if (turn.completedItems.has(item.id)) return;
    turn.completedItems.add(item.id);
    const message = { role: 'tool', name: 'image_generation', content: JSON.stringify({ status: 'saving', source: 'codex' }), codexItemId: item.id, codexTurnId: turn.turnId };
    history.push(message);
    save();
    const importing = Promise.resolve().then(async () => {
      if (typeof importGeneratedImage !== 'function') throw new Error('The Codex image importer is unavailable.');
      const context = turn.imageContexts.get(item.id) || { origin: turn.origin, kits: turn.kits };
      const { output, events = [] } = await importGeneratedImage({ item, ...context });
      if (!output?.assets?.length) throw new Error('Codex generated an image, but it could not be saved in Media. Do not generate a replacement.');
      message.content = JSON.stringify({ ...output, source: 'codex' });
      save();
      for (const event of events) emit(event);
      emit({ type: 'tool-end', name: 'image_generation', itemId: item.id, status: 'completed' });
    }).catch((error) => {
      const detail = String(error.message || error).slice(0, 500);
      message.content = JSON.stringify({ ok: false, status: 'failed', source: 'codex', error: detail });
      save();
      emit({ type: 'tool-end', name: 'image_generation', itemId: item.id, status: 'failed' });
      emit({ type: 'error', message: detail });
    });
    turn.imageImports.push(importing);
  }

  function handleNotification({ method, params = {} }) {
    if (method === 'account/updated') {
      Promise.resolve(server.readAccount()).then((result) => { account = result.account || null; requiresOpenaiAuth = result.requiresOpenaiAuth; emit({ type: 'codex-state', state: getState() }); }).catch((error) => { lastError = error.message; });
      return;
    }
    if (method === 'account/login/completed') {
      login = null;
      if (!params.success) lastError = params.error || 'Codex sign-in did not complete.';
      emit({ type: 'codex-login-completed', success: params.success, ...(params.error ? { error: params.error } : {}) });
      if (params.success) Promise.allSettled([readAccount(), listModels()]).then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) { lastError = failed.reason.message; emit({ type: 'codex-state', state: getState() }); }
      });
      return;
    }
    const turn = active;
    if (!turn || turn.settled || turn.finishing || params.threadId !== turn.threadId) return;
    if (method === 'turn/started') {
      if (turn.phase !== 'starting-turn' || (turn.turnId && turn.turnId !== params.turn?.id)) return;
      turn.turnId = params.turn?.id || '';
      if (turn.stopping) queueMicrotask(() => interrupt(turn));
      return;
    }
    const eventTurnId = params.turnId || params.turn?.id;
    if (!turn.turnId) {
      if (eventTurnId && turn.phase === 'starting-turn') turn.earlyEvents.push({ method, params });
      return;
    }
    if (eventTurnId && eventTurnId !== turn.turnId) return;
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const message = assistantMessage(turn, params.itemId);
      message.content += params.delta;
      emit({ type: 'token', text: params.delta, itemId: params.itemId });
      scheduleSave();
    } else if (method === 'item/started' && ['mcpToolCall', 'imageGeneration'].includes(params.item?.type)) {
      if (params.item.type === 'imageGeneration') {
        const context = getImageGenerationContext?.() || {};
        turn.imageContexts.set(params.item.id, { origin: { ...turn.origin, ...context.origin }, kits: context.kits || turn.kits });
      }
      emit({ type: 'tool-start', name: params.item.type === 'imageGeneration' ? 'image_generation' : params.item.tool, itemId: params.item.id });
    } else if (method === 'item/completed') {
      const item = params.item;
      if (item?.type === 'agentMessage') {
        const message = assistantMessage(turn, item.id);
        message.content = item.text || '';
        message.partial = false;
        message.phase = item.phase || 'final_answer';
        if (!turn.completedItems.has(item.id)) emit({ type: 'assistant', text: message.content, itemId: item.id, phase: message.phase });
        turn.completedItems.add(item.id);
        save();
      } else if (item?.type === 'imageGeneration') {
        importImage(turn, item);
      } else if (item?.type === 'mcpToolCall') {
        if (!history.some((entry) => entry.codexItemId === item.id && entry.role === 'tool')) {
          history.push({ role: 'tool', name: item.tool, content: compactToolResult(item), codexItemId: item.id, codexTurnId: turn.turnId });
        }
        emit({ type: 'tool-end', name: item.tool, itemId: item.id, status: item.status });
        if (/(?:^|__)request_canvas_input$/.test(item.tool)) {
          turn.inputToolCompleted = true;
          requestPause(turn);
        }
        save();
      }
    } else if (method === 'error') {
      if (params.willRetry) emit({ type: 'codex-progress', text: params.error?.message || 'Codex is retrying.' });
      else finish(turn, new Error(params.error?.message || 'Codex turn failed.'));
    } else if (method === 'turn/completed') {
      for (const item of params.turn?.items || []) {
        if (['agentMessage', 'imageGeneration'].includes(item.type) && !turn.completedItems.has(item.id)) handleNotification({ method: 'item/completed', params: { threadId: turn.threadId, turnId: turn.turnId, item } });
      }
      if (params.turn?.status === 'failed') finish(turn, new Error(params.turn.error?.message || 'Codex turn failed.'));
      else finish(turn, null, params.turn);
    }
  }

  function handleExit(error) {
    loadedThreadId = '';
    loadedThreadOptions = '';
    if (!server.getState?.().closing) lastError = error.message;
    const turn = active;
    if (!turn || turn.settled) return;
    if (turn.stopping || turn.waiting) finish(turn, null, { status: 'interrupted' });
    else finish(turn, error);
  }

  let unsubscribe = server.subscribe?.(handleNotification);
  let unsubscribeExit = server.subscribeExit?.(handleExit);
  if (onServerRequest) server.setRequestHandler?.((request) => onServerRequest({ ...request, chatId, threadId, origin, readOnly: true }));

  async function sendMessage(input, options = {}) {
    assertIdle();
    const attachments = options.attachments || [];
    const text = typeof input === 'string' && input.trim() ? validateChatMessage(input) : '';
    if (!text && !attachments.length) throw new Error('Message or attachment is required.');
    let resolve;
    let reject;
    let finishLifecycle;
    let cancelPreparation;
    const done = new Promise((success, failure) => { resolve = success; reject = failure; });
    const finished = new Promise((complete) => { finishLifecycle = complete; });
    const stopped = new Promise((complete) => { cancelPreparation = complete; });
    // Completion may arrive before turn/start's response; attach a rejection observer immediately.
    done.catch(() => {});
    const turn = { resolve, reject, done, finished, cancelPreparation, options, phase: 'preparing', threadId: '', turnId: '', stopping: false, settled: false, completedItems: new Set(), earlyEvents: [], imageImports: [], imageContexts: new Map() };
    const prepare = (operation) => Promise.race([operation, stopped.then(() => { throw stoppedError(); })]);
    active = turn;
    try {
      const context = await prepare((getTurnContext || getContext)?.(options)) || {};
      const model = context.model || selectedModel || await prepare(getModel?.(options)) || '';
      const effort = context.effort || selectedEffort;
      const instructions = [EASEL_INSTRUCTIONS,
        'Native image generation and Easel configured Media models are both available. If the user names a Media model such as Qwen, call Easel list_models and use its exact returned model ID with the Easel generation/edit/variation tool. A rejected call or connection error does not mean that model is unconfigured; report the actual error and do not claim the two image routes are mutually exclusive.',
        context.instructions || await prepare(getInstructions?.(options)) || ''].filter(Boolean).join('\n\n');
      origin = context.origin || { ...(context.projectId ? { projectId: context.projectId } : {}), model };
      turn.origin = origin;
      turn.kits = context.kits || options.kits || [];
      if (turn.stopping) return { ok: true, cancelled: true, text: 'Stopped.', chatId };
      const protocolInput = await prepare(prepareInput({ text, attachments, options, context }));
      if (!Array.isArray(protocolInput) || !protocolInput.length) throw new Error('Codex message input is empty.');
      await prepare(server.initialize());
      await prepare(readAccount());
      if (account?.type !== 'chatgpt') throw new Error('Sign in with ChatGPT to use embedded Codex. API endpoint credentials belong in the Built-in agent settings.');
      lastError = '';
      if (!chatId) {
        chatId = crypto.randomUUID().replaceAll('-', '');
        title = (text || 'Attached media').replace(/\s+/g, ' ').slice(0, 120);
      }
      history.push({ role: 'user', content: text || 'Review the attached media.', ...(options.attachmentRefs ? { canvasMediaRefs: options.attachmentRefs } : {}), ...(options.canvasInputRequestId ? { canvasInputRequestId: options.canvasInputRequestId } : {}), ...(options.mediaJobId ? { mediaJobId: options.mediaJobId } : {}), ...(options.mediaJobResult ? { mediaJobResult: options.mediaJobResult } : {}) });
      save();
      const threadOptions = { cwd, modelProvider: 'openai', sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', developerInstructions: instructions, ...(model ? { model } : {}) };
      const threadOptionsKey = JSON.stringify(threadOptions);
      if (turn.stopping) return { ok: true, cancelled: true, text: 'Stopped.', chatId };
      if (!threadId) {
        const started = await prepare(server.startThread({ ...threadOptions, ephemeral: false }));
        if (!started.thread?.id) throw new Error('Codex did not return a thread ID.');
        threadId = started.thread.id;
        loadedThreadId = threadId;
        loadedThreadOptions = threadOptionsKey;
        save();
      } else if (loadedThreadId !== threadId || loadedThreadOptions !== threadOptionsKey) {
        await prepare(server.resumeThread({ ...threadOptions, threadId, excludeTurns: true }));
        loadedThreadId = threadId;
        loadedThreadOptions = threadOptionsKey;
      }
      turn.threadId = threadId;
      // Thread startup/resume can return before its MCP catalog is ready.
      await prepare(server.waitForEaselTools?.(threadId));
      if (turn.stopping) return { ok: true, cancelled: true, text: 'Stopped.', chatId };
      await prepare(onTurnReady?.({ chatId, threadId, turnId: '', origin, options }));
      if (turn.stopping) return { ok: true, cancelled: true, text: 'Stopped.', chatId };
      turn.phase = 'starting-turn';
      turn.timer = setTimeout(() => {
        if (turn.settled) return;
        lastError = 'Codex turn timed out. Its partial reply is saved.';
        turn.timeoutError = new Error(lastError);
        turn.stopping = true;
        if (turn.turnId) interrupt(turn);
        else { Promise.resolve(server.close()).catch(() => {}); finish(turn, new Error(lastError)); }
      }, turnTimeoutMs);
      const startController = new AbortController();
      turn.startRequestController = startController;
      const startRequest = server.startTurn({ threadId, input: protocolInput, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false }, ...(model ? { model } : {}), ...(effort ? { effort } : {}), clientUserMessageId: crypto.randomUUID() }, { signal: startController.signal });
      const started = await Promise.race([startRequest, done.then((completed) => ({ turn: { ...completed, id: completed.id || turn.turnId } }))]);
      startController.abort();
      const id = started.turn?.id;
      if (!id) throw new Error('Codex did not return a turn ID.');
      if (turn.turnId && turn.turnId !== id) throw new Error('Codex returned a different active turn.');
      turn.turnId = id;
      turn.phase = 'running';
      await onTurnReady?.({ chatId, threadId, turnId: id, origin, options });
      for (const event of turn.earlyEvents) handleNotification(event);
      turn.earlyEvents = [];
      if (turn.stopping) interrupt(turn);
      requestPause(turn);
      if (started.turn.status !== 'inProgress' && !turn.settled) handleNotification({ method: 'turn/completed', params: { threadId, turn: started.turn } });
      const result = await done;
      if (turn.timeoutError) throw turn.timeoutError;
      const replies = history.filter((entry) => entry.role === 'assistant' && entry.codexTurnId === id);
      const finalReplies = replies.filter((entry) => entry.phase === 'final_answer');
      const responseText = (finalReplies.length ? finalReplies : replies).map((entry) => entry.content).join('\n\n');
      if ((!turn.stopping && result.status !== 'interrupted') || turn.waiting) {
        const marker = options.canvasInputRequestId ? { canvasInputCompletedId: options.canvasInputRequestId } : options.mediaJobId ? { mediaJobCompletedId: options.mediaJobId } : null;
        if (marker) {
          if (replies.length) Object.assign(replies.at(-1), marker);
          else history.push({ role: 'assistant', content: responseText, ...marker, codexTurnId: id });
          save();
        }
      }
      if (turn.waiting) return { ok: true, text: responseText, chatId, threadId, awaitingCanvasInput: turn.waiting, ...(saveWarning ? { saveWarning } : {}) };
      if (turn.stopping || result.status === 'interrupted') return { ok: true, cancelled: true, text: 'Stopped.', chatId, ...(saveWarning ? { saveWarning } : {}) };
      return { ok: true, text: responseText, chatId, threadId, ...(saveWarning ? { saveWarning } : {}) };
    } catch (error) {
      const cancelled = turn.stopping && !turn.timeoutError;
      if (!cancelled) lastError = error.message;
      if (!turn.settled && turn.turnId) {
        turn.stopping = true;
        await interrupt(turn);
        await turn.done.catch(() => {});
      } else if (!turn.settled && turn.phase === 'starting-turn') {
        await server.close().catch(() => {});
      }
      if (cancelled) return { ok: true, cancelled: true, text: 'Stopped.', chatId, ...(saveWarning ? { saveWarning } : {}) };
      throw error;
    } finally {
      turn.startRequestController?.abort();
      clearTimeout(turn.timer);
      clearTimeout(turn.stopTimer);
      save();
      if (active === turn) active = undefined;
      if (turn.stopping) emit({ type: 'agent-stopped', ...(saveWarning ? { saveWarning } : {}) });
      finishLifecycle();
    }
  }

  function stopAgent() {
    const turn = active;
    if (!turn) return { ok: true, active: false, stopping: false };
    turn.stopping = true;
    turn.waiting = null;
    server.cancelServerRequests?.({ threadId: turn.threadId, turnId: turn.turnId });
    if (turn.phase === 'preparing') {
      turn.cancelPreparation();
      Promise.resolve(server.close()).catch(() => {});
    }
    if (!turn.turnId && turn.phase === 'starting-turn' && !turn.stopTimer) {
      turn.stopTimer = setTimeout(() => {
        Promise.resolve(server.close()).catch(() => {});
        finish(turn, null, { status: 'interrupted' });
      }, stopTimeoutMs);
    }
    queueMicrotask(() => interrupt(turn));
    return { ok: true, active: true, stopping: true };
  }

  function pauseForCanvasInput(request) {
    if (!active || active.stopping) return { ok: false, inactive: true };
    active.waiting = request;
    requestPause(active);
    return { ok: true, waiting: true };
  }

  function clearHistory() {
    assertIdle();
    save();
    chatStore?.activate('');
    chatId = '';
    title = '';
    threadId = '';
    origin = {};
    history = [];
    lastError = '';
  }

  function ensureConversation(nextTitle = 'New chat') {
    if (!chatId) {
      if (typeof nextTitle !== 'string' || !nextTitle.trim()) throw new Error('A conversation title is required.');
      chatId = crypto.randomUUID().replaceAll('-', '');
      title = nextTitle.trim().slice(0, 120);
      save();
    }
    return chatId;
  }

  async function disconnectRuntime() {
    assertIdle();
    await server.close();
  }

  async function getCurrentChat() {
    const current = { id: chatId, title, backend: 'codex', codexThreadId: threadId, origin, history: structuredClone(history), images: [], media: [], canvasInputs: [], ...(lastError ? { error: lastError } : {}) };
    return hydrateChat ? hydrateChat(current) : current;
  }

  function openChat(id) {
    assertIdle();
    if (!chatStore) throw new Error('Chat history is unavailable.');
    const saved = chatStore.get(id);
    if (saved.backend !== 'codex') throw new Error('This conversation uses the built-in Easel agent.');
    save();
    chatStore.activate(id);
    applySaved(saved);
    lastError = '';
    return getCurrentChat();
  }

  function hasThread(id) {
    if (id === chatId) return Boolean(threadId);
    try { const saved = chatStore?.get(id); return saved?.backend === 'codex' && Boolean(saved.codexThreadId); } catch { return false; }
  }

  async function continueConversation(id, text, options = {}) {
    if (id !== chatId) throw new Error('Open the original Codex conversation before continuing its canvas response.');
    if (!hasThread(id)) throw new Error('The saved Codex conversation has no thread to continue.');
    return sendMessage(text, options);
  }

  async function readAccount() {
    const result = await server.readAccount();
    account = result.account || null;
    requiresOpenaiAuth = result.requiresOpenaiAuth;
    lastError = '';
    emit({ type: 'codex-state', state: getState() });
    return result;
  }

  async function listModels() {
    const found = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await server.listModels({ limit: 100, ...(cursor ? { cursor } : {}) });
      found.push(...result.data || []);
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    models = found;
    if (!found.some((model) => model.model === selectedModel || model.id === selectedModel)) {
      const replacement = found.find((model) => model.isDefault) || found[0];
      selectedModel = replacement?.model || replacement?.id || '';
      selectedEffort = '';
    }
    emit({ type: 'codex-state', state: getState() });
    return { data: structuredClone(found), model: selectedModel };
  }

  function selectModel(input, effort) {
    const model = typeof input === 'string' ? input : input?.model;
    const nextEffort = effort ?? (typeof input === 'object' ? input.effort : undefined);
    if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new Error('Codex model selection is invalid.');
    const entry = models.find((candidate) => candidate.model === model || candidate.id === model);
    if (models.length && !entry) throw new Error('Choose a model from the Codex model list.');
    if (nextEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(nextEffort)) throw new Error('Codex reasoning effort is invalid.');
    if (nextEffort && entry?.supportedReasoningEfforts?.length && !entry.supportedReasoningEfforts.some((option) => option.reasoningEffort === nextEffort)) throw new Error('This Codex model does not support the selected reasoning effort.');
    const chosenModel = entry?.model || model;
    const chosenEffort = nextEffort === undefined && chosenModel === selectedModel ? selectedEffort : nextEffort || '';
    // Account refresh may confirm the current selection while a reply is running.
    if (!shuttingDown && chosenModel === selectedModel && chosenEffort === selectedEffort) return { ok: true, model: selectedModel, effort: selectedEffort };
    assertIdle();
    selectedModel = chosenModel;
    selectedEffort = chosenEffort;
    emit({ type: 'codex-state', state: getState() });
    return { ok: true, model: selectedModel, effort: selectedEffort };
  }

  async function shutdown() {
    shuttingDown = true;
    const turn = active;
    stopAgent();
    if (turn) await turn.finished;
    save();
    await server.close();
    unsubscribe?.();
    unsubscribeExit?.();
    unsubscribe = undefined;
    unsubscribeExit = undefined;
  }

  return {
    sendMessage,
    stop: stopAgent,
    stopAgent,
    pauseForCanvasInput,
    continueConversation,
    hasThread,
    isBusy: () => Boolean(active),
    waitForMediaImports: () => Promise.allSettled(active?.imageImports || []),
    getCurrentChat,
    getActiveChatId: () => chatId,
    getCurrentThreadId: () => threadId,
    getTurnOrigin: () => active ? { backend: 'codex', chatId, threadId: active.threadId, turnId: active.turnId, origin: active.origin || origin, options: active.options } : null,
    listChats: () => chatStore?.list().filter((entry) => entry.backend === 'codex') || [],
    openChat,
    clearHistory,
    newChat: clearHistory,
    ensureConversation,
    disconnectRuntime,
    acknowledgeChat: (id) => ({ ok: id === chatId, ...(id !== chatId ? { stale: true } : {}) }),
    shutdown,
    cancelShutdown: () => {
      shuttingDown = false;
      unsubscribe ||= server.subscribe?.(handleNotification);
      unsubscribeExit ||= server.subscribeExit?.(handleExit);
    },
    getState,
    selectModel,
    readAccount,
    refreshAccount: readAccount,
    listModels,
    startLogin: async (type = 'chatgpt') => { login = await server.startLogin(type); emit({ type: 'codex-state', state: getState() }); return login; },
    cancelLogin: async (loginId = login?.loginId) => { if (!loginId) return { status: 'notFound' }; const result = await server.cancelLogin(loginId); login = null; emit({ type: 'codex-state', state: getState() }); return result; },
    logout: async () => { assertIdle(); const result = await server.logout(); account = null; login = null; requiresOpenaiAuth = true; emit({ type: 'codex-state', state: getState() }); return result; },
  };
}

module.exports = { createCodexChatService, defaultInput, EASEL_INSTRUCTIONS };
