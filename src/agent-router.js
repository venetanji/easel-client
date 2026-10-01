const { canvasInputSummary, formatCanvasInputMessage, inputId } = require('./canvas-input');
const { validateApprovedMediaModel } = require('./canvas-input-store');

function createAgentRouter({ builtin, codex, control, chatStore, inputStore, mediaJobStore,
  mediaAssetStore, canvasController, eventStore, onEvent, onBackendChanged,
  disconnectControllers = async () => {}, shutdownTools = async () => {}, resumeTools = () => {} } = {}) {
  let switching = false;
  let shuttingDown = false;
  let restorePending = true;
  let paused = false;
  let scheduled = false;
  let continuation;
  const backendOf = (entry) => entry.origin?.backend || 'builtin';
  const selected = () => control.getBackend();
  const service = () => selected() === 'codex' ? codex : builtin;
  builtin.setEnabled(selected() === 'builtin');

  function emit(event) { onEvent?.(event); }
  function journal(event) { eventStore?.append(event); }
  function isBusy() { return switching || Boolean(continuation) || builtin.isBusy() || builtin.isSettling?.() || codex.isBusy() || control.isToolBusy(); }
  function assertIdle() {
    if (isBusy()) throw new Error('Stop the current agent run before changing conversations or controllers.');
    if (shuttingDown) throw new Error('The application is closing.');
  }
  function getActiveChatId() { return selected() === 'external' ? control.getExternalChatId() : service().getActiveChatId(); }
  function getToolOrigin() {
    const backend = selected();
    const turn = backend === 'codex' ? codex.getTurnOrigin() : null;
    if (backend === 'codex' && !turn) throw new Error('Start a Codex turn before invoking canvas tools.');
    const chatId = backend === 'external' ? control.getExternalChatId() : getActiveChatId();
    return { chatId, origin: { backend, chatId, ...(turn?.threadId ? { threadId: turn.threadId } : {}),
      ...(backend === 'codex' ? { model: turn.origin?.model || control.getCodexModel() } : {}) },
      turnOptions: turn?.options || { kits: canvasController.getCurrentKits?.() || [] } };
  }
  function matchesCanvas(entry) {
    return entry.canvasId === canvasController.getCurrentCanvasId()
      && (!entry.documentPath || entry.documentPath === canvasController.getCurrentDocumentPath());
  }
  async function applyAnswer(entry) {
    if (entry.kind !== 'choice' || entry.actionApplied) return;
    try {
      await canvasController.completeCanvasInput(entry);
      inputStore.markActionApplied(entry.id);
    } catch (error) {
      inputStore.markActionError(entry.id, error);
      throw new Error(`Your answer is saved. ${error.message}`);
    }
  }
  function validCodexDestination(entry) {
    const model = entry.origin?.model || entry.approvedModel?.model;
    if (entry.kind === 'media' && (entry.approvedModel?.backend !== 'codex' || entry.approvedModel.model !== model)) return false;
    return entry.chatId === codex.getActiveChatId()
      && (!entry.origin?.threadId || entry.origin.threadId === codex.getCurrentThreadId())
      && (!model || model === (codex.getState().model || control.getCodexModel()));
  }
  async function resumeInput(entry) {
    if (savedCompletion(entry, 'canvasInputCompletedId')) { inputStore.complete(entry.id); return; }
    const claimed = inputStore.beginDispatch(entry.id);
    let outcome = {};
    emit({ type: 'canvas-input-resume-start', request: canvasInputSummary(claimed), chatId: claimed.chatId });
    try {
      await applyAnswer(claimed);
      if (paused || shuttingDown) { inputStore.interrupt(claimed.id, 'The response was stopped. Retry explicitly to continue.'); outcome.cancelled = true; return; }
      const saved = inputStore.get(claimed.id);
      const attachments = saved.kind === 'media' ? await Promise.all(saved.attachments.map(async (reference) => {
        const asset = await mediaAssetStore.get(reference.assetId);
        if (asset.mimeType !== reference.mimeType || typeof asset.data !== 'string') throw new Error('Saved canvas media does not match its declared format.');
        return { ...reference, data: asset.data };
      })) : [];
      if (paused || shuttingDown) { inputStore.interrupt(saved.id, 'The response was stopped. Retry explicitly to continue.'); outcome.cancelled = true; return; }
      if (selected() !== 'codex' || !matchesCanvas(saved) || !validCodexDestination(saved)) throw new Error('Open the original canvas, conversation and Codex model before continuing this saved response.');
      emit({ type: 'canvas-input-answer', request: canvasInputSummary(saved), text: saved.kind === 'choice'
        ? saved.options.find((option) => option.value === saved.value)?.label || saved.value : saved.prompt || 'Review the media I shared from the canvas.',
        attachments, chatId: saved.chatId });
      const continueChat = codex.hasThread(saved.chatId) ? (text, options) => codex.continueConversation(saved.chatId, text, options) : (text, options) => codex.sendMessage(text, options);
      const result = await continueChat(formatCanvasInputMessage(saved), {
        ...saved.turnOptions, attachments, attachmentRefs: saved.attachments, canvasInputRequestId: saved.id,
      });
      if (result.cancelled || paused || shuttingDown) inputStore.interrupt(saved.id, 'The response was stopped. Retry explicitly to continue; previous tool effects may already have occurred.');
      else if (result.saveWarning) inputStore.fail(saved.id, result.saveWarning);
      else inputStore.complete(saved.id);
      outcome = { cancelled: result.cancelled || paused || shuttingDown, saveWarning: result.saveWarning };
    } catch (error) {
      if (paused || shuttingDown) inputStore.interrupt(entry.id, 'The response was stopped. Retry explicitly to continue.');
      else inputStore.fail(entry.id, error);
      outcome = { error: error.message, cancelled: paused || shuttingDown };
    } finally {
      emit({ type: 'canvas-input-resume-end', request: canvasInputSummary(inputStore.get(entry.id)), chatId: entry.chatId, ...outcome });
    }
  }
  async function resumeJob(entry) {
    if (savedCompletion(entry, 'mediaJobCompletedId')) { mediaJobStore.update(entry.id, { notification: 'responded' }); return; }
    const resultData = { jobId: entry.remoteId, localJobId: entry.id, name: entry.name, mediaType: entry.mediaType,
      modelId: entry.modelId, projectId: entry.projectId, status: entry.status, assets: entry.assets, ...(entry.error ? { error: entry.error } : {}) };
    mediaJobStore.update(entry.id, { notification: 'dispatching' });
    emit({ type: 'media-job-notification', chatId: entry.chatId, projectId: entry.projectId, jobId: entry.id, assets: entry.assets, job: entry,
      text: entry.status === 'ready' ? `Your ${entry.mediaType} is ready.` : `${entry.mediaType} generation failed.` });
    emit({ type: 'media-job-resume-start', chatId: entry.chatId, jobId: entry.id, mediaType: entry.mediaType, status: entry.status });
    try {
      const response = await codex.continueConversation(entry.chatId,
        `Background ${entry.mediaType} job ${entry.status === 'ready' ? 'is ready' : 'failed'}. This is an automatic host notification, not a new user request.\n${JSON.stringify(resultData)}\nThe host already saved the output and added its preview to chat. Continue the original request if work remains; otherwise acknowledge completion briefly without a View/Watch link. Do not generate a replacement or retrieve the output again. Edit only the listed project.`,
        { ...entry.turnOptions, mediaJobId: entry.id, mediaJobResult: resultData });
      mediaJobStore.update(entry.id, { notification: response.cancelled || paused || shuttingDown || response.saveWarning ? 'interrupted' : 'responded',
        ...(response.saveWarning ? { notificationError: response.saveWarning } : {}) });
      emit({ type: 'media-job-resume-end', chatId: entry.chatId, jobId: entry.id, cancelled: response.cancelled, saveWarning: response.saveWarning });
    } catch (error) {
      mediaJobStore.update(entry.id, { notification: 'interrupted', notificationError: String(error.message).slice(0, 1000) });
      emit({ type: 'media-job-resume-end', chatId: entry.chatId, jobId: entry.id, error: error.message });
    }
  }
  function schedule() {
    if (scheduled || switching || shuttingDown || paused || restorePending || selected() !== 'codex') return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (isBusy() || shuttingDown || paused || restorePending || selected() !== 'codex') return;
      continuation = (async () => {
        for (const entry of inputStore.list({ chatId: codex.getActiveChatId() || undefined, status: ['answered', 'queued'], raw: true, limit: 200 }).reverse()) {
          if (selected() !== 'codex' || paused || shuttingDown || restorePending) break;
          if (backendOf(entry) === 'codex' && validCodexDestination(entry) && matchesCanvas(entry)) await resumeInput(entry);
        }
        for (const entry of mediaJobStore.list({ raw: true })) {
          if (selected() !== 'codex' || paused || shuttingDown || restorePending) break;
          if (backendOf(entry) !== 'codex' || !['ready', 'failed'].includes(entry.status)
            || entry.autoResume === false
            || !['pending', 'delivered'].includes(entry.notification) || !validCodexDestination(entry)
            || (entry.projectId && entry.projectId !== canvasController.getCurrentCanvasId())) continue;
          await resumeJob(entry);
        }
      })().catch((error) => emit({ type: 'error', message: `Response queue: ${error.message}` }))
        .finally(() => { continuation = undefined; onBackendChanged?.(); });
    });
  }
  function savedCompletion(entry, marker) {
    try { return chatStore.get(entry.chatId).history.some((message) => message[marker] === entry.id); }
    catch { return false; }
  }
  async function setBackend(backend, { reason = 'backend-switch' } = {}) {
    assertIdle();
    control.assertIdle();
    if (backend === selected()) return;
    switching = true;
    builtin.setEnabled(false);
    try {
      await disconnectControllers('The Easel controller changed.');
      await codex.disconnectRuntime();
      control.setBackend(backend);
      restorePending = true;
      paused = false;
      if (backend === 'builtin') await builtin.getCurrentChat({ deferResume: true });
    } finally {
      switching = false;
      builtin.setEnabled(selected() === 'builtin');
      await onBackendChanged?.(reason);
    }
  }
  async function sendMessage(text, options) {
    if (selected() === 'external') throw new Error('Use your external agent to chat while External MCP is selected.');
    if (switching || shuttingDown || continuation || builtin.isSettling?.() || control.isToolBusy()) throw new Error('Wait for the current operation before sending.');
    paused = false;
    restorePending = false;
    try { return await service().sendMessage(text, options); }
    finally { schedule(); onBackendChanged?.(); }
  }
  async function getCurrentChat(options = {}) {
    if (options.deferResume) restorePending = true;
    if (selected() === 'external') return { id: control.getExternalChatId(), title: 'External agent', backend: 'external', history: [], images: [], media: [], canvasInputs: inputStore.list({ chatId: control.getExternalChatId(), limit: 50 }) };
    const snapshot = await service().getCurrentChat(options);
    if (selected() === 'codex') snapshot.canvasInputs = inputStore.list({ chatId: snapshot.id || undefined, limit: 50 }).filter((entry) => entry.chatId === snapshot.id);
    return { ...snapshot, backend: selected() };
  }
  function recoverCanvasInputs() {
    builtin.recoverCanvasInputs();
    if (!codex.isBusy() && !continuation) {
      for (const entry of inputStore.list({ status: 'dispatching', raw: true, limit: 200 })) {
        if (backendOf(entry) !== 'builtin') {
          if (savedCompletion(entry, 'canvasInputCompletedId')) inputStore.complete(entry.id);
          else inputStore.interrupt(entry.id);
        }
      }
      for (const entry of mediaJobStore.list({ raw: true })) {
        if (backendOf(entry) !== 'builtin' && entry.notification === 'dispatching') mediaJobStore.update(entry.id, { notification: savedCompletion(entry, 'mediaJobCompletedId') ? 'responded' : 'interrupted' });
      }
    }
    schedule();
  }
  async function submitCanvasInput(input) {
    const entry = inputStore.get(inputId(input.requestId, 'Input request ID'));
    if (backendOf(entry) === 'builtin') return builtin.submitCanvasInput(input);
    if (!matchesCanvas(entry)) throw new Error('Open the original project document before answering this question.');
    const saved = inputStore.submit(input);
    paused = false;
    const event = { type: 'canvas-input-answer', request: canvasInputSummary(saved), chatId: saved.chatId };
    journal(event);
    emit({ type: 'canvas-input', request: canvasInputSummary(saved), status: 'answered' });
    if (backendOf(saved) === 'external') {
      try { await applyAnswer(saved); inputStore.complete(saved.id); }
      catch (error) { inputStore.fail(saved.id, error); emit({ type: 'error', message: error.message }); }
    } else schedule();
    return { ok: true, request: canvasInputSummary(inputStore.get(saved.id)), queued: backendOf(saved) === 'codex',
      ...(selected() !== backendOf(saved) || saved.chatId !== getActiveChatId() ? { waitingFor: 'Open the original conversation and controller to continue.' } : {}) };
  }
  async function submitCanvasMedia(input) {
    if (selected() === 'builtin') return builtin.submitCanvasMedia(input);
    if (input.chatId !== getActiveChatId()) throw new Error('The conversation changed before sharing this capture.');
    if (input.canvasId !== canvasController.getCurrentCanvasId() || input.documentPath && input.documentPath !== canvasController.getCurrentDocumentPath()) throw new Error('Open the original canvas before sharing this capture.');
    if (selected() === 'codex' && input.attachments.some((asset) => asset.type === 'audio')) throw new Error('Embedded Codex supports image captures. Audio remains saved locally; choose an Agent model with audio input to share it.');
    const model = selected() === 'codex' ? codex.getState().model || control.getCodexModel() : '';
    const approvedModel = validateApprovedMediaModel(input.approvedModel);
    if (approvedModel.backend !== selected() || selected() === 'codex' && approvedModel.model !== model) throw new Error('The approved controller or model changed. Share this capture again to confirm its destination.');
    const chatId = selected() === 'codex' ? codex.ensureConversation('Canvas media') : control.getExternalChatId();
    const origin = selected() === 'codex' ? { backend: 'codex', chatId, ...(codex.getCurrentThreadId() ? { threadId: codex.getCurrentThreadId() } : {}), model } : { backend: 'external', chatId };
    const saved = inputStore.createMedia({ ...input, chatId, origin, approvedModel });
    journal({ type: 'canvas-input-answer', request: canvasInputSummary(saved), chatId });
    emit({ type: 'canvas-input', request: canvasInputSummary(saved), status: 'queued' });
    paused = false;
    restorePending = false;
    if (selected() === 'external') inputStore.complete(saved.id);
    else schedule();
    return { ok: true, queued: selected() === 'codex', request: canvasInputSummary(inputStore.get(saved.id)) };
  }
  async function retryCanvasInput(id) {
    const entry = inputStore.get(inputId(id, 'Input request ID'));
    if (backendOf(entry) === 'builtin') {
      if (selected() !== 'builtin') throw new Error('Choose the original Built-in controller to retry this response.');
      return builtin.retryCanvasInput(id);
    }
    assertIdle();
    if (!['failed', 'interrupted'].includes(entry.status) || !matchesCanvas(entry) || entry.chatId !== getActiveChatId() || selected() !== backendOf(entry)) throw new Error('Open the original conversation, controller, and canvas to retry this response.');
    if (savedCompletion(entry, 'canvasInputCompletedId')) return { ok: true, request: canvasInputSummary(inputStore.complete(id)) };
    paused = false;
    restorePending = false;
    if (selected() === 'external') { await applyAnswer(entry); inputStore.complete(id); }
    else {
      if (!validCodexDestination(entry)) throw new Error('Choose the original Codex model to retry this response.');
      continuation = resumeInput(entry).finally(() => { continuation = undefined; schedule(); onBackendChanged?.(); });
    }
    return { ok: true, request: canvasInputSummary(inputStore.get(id)) };
  }
  async function notifyMediaJob(job) {
    journal({ type: 'media-job-ready', job, jobId: job.id, projectId: job.projectId, chatId: job.chatId });
    if (backendOf(job) === 'builtin') return builtin.notifyMediaJob(job);
    emit({ type: 'media-job-ready', job, jobId: job.id, assets: job.assets, projectId: job.projectId, chatId: job.chatId });
    schedule();
  }
  function stopAgent() {
    paused = true;
    const result = selected() === 'external' ? { ok: true, active: control.isToolBusy(), stopping: control.isToolBusy() } : service().stopAgent();
    if (!shuttingDown && getActiveChatId()) {
      try {
        for (const job of mediaJobStore.list({ chatId: getActiveChatId(), raw: true })) {
          if (['pending', 'delivered', 'dispatching'].includes(job.notification)) mediaJobStore.update(job.id, { autoResume: false });
        }
      } catch (error) { emit({ type: 'error', message: `The agent stopped, but its background reply pause could not be saved: ${error.message}` }); }
    }
    if (selected() === 'external') Promise.resolve(disconnectControllers('The user stopped this agent run. Accepted media jobs remain saved.')).catch(() => {});
    return result;
  }
  return {
    isBusy, isSwitching: () => switching,
    isRunning: () => Boolean(continuation) || builtin.isBusy() || builtin.isSettling?.() || codex.isBusy(),
    getToolOrigin, getActiveChatId, setBackend, sendMessage, getCurrentChat, recoverCanvasInputs, notifyMediaJob,
    submitCanvasInput, submitCanvasMedia, retryCanvasInput, stopAgent,
    getCanvasInputs: (query = {}) => inputStore.list({ ...query, chatId: getActiveChatId() }),
    cancelCanvasInput: (input) => builtin.cancelCanvasInput(input),
    listChats: () => chatStore.list().filter((chat) => (chat.backend || 'builtin') !== 'external'),
    async openChat(id) {
      assertIdle();
      const saved = chatStore.get(id);
      await setBackend(saved.backend || 'builtin', { reason: 'chat-opened' });
      restorePending = true;
      return service().openChat(id);
    },
    clearHistory() { assertIdle(); if (selected() === 'external') throw new Error('Create new conversations in your external agent.'); service().clearHistory(); restorePending = false; paused = false; },
    acknowledgeChat(id) {
      if (id !== getActiveChatId()) return { ok: false, stale: true };
      restorePending = false;
      if (selected() !== 'external') service().acknowledgeChat(id);
      schedule();
      return { ok: true };
    },
    async shutdown() {
      shuttingDown = true;
      stopAgent();
      const disabled = control.shutdown();
      await disconnectControllers('Easel is closing.');
      await builtin.shutdown();
      await codex.shutdown();
      await continuation;
      await disconnectControllers('Easel is closing.');
      await shutdownTools();
      await disabled;
    },
    async cancelShutdown(options) {
      await resumeTools();
      shuttingDown = false;
      control.cancelShutdown();
      builtin.cancelShutdown(options);
      codex.cancelShutdown();
      if (options?.schedule !== false) schedule();
    },
  };
}

module.exports = { createAgentRouter };
