const path = require('node:path');
const crypto = require('node:crypto');
const { buildUserContent, handleMcpResult, runAgentTurn } = require('./agent');
const { createLiteLLMClient } = require('./litellm-client');
const { createMediaMcpClient } = require('./media-mcp-client');
const { validateChatMessage } = require('./ipc-contract');
const { canvasInputSummary, formatCanvasInputMessage, inputId } = require('./canvas-input');
const { validateApprovedMediaModel } = require('./canvas-input-store');

function defaultMcpLaunchOptions(settings, secrets, { isPackaged = false, resourcesPath = '' } = {}) {
  const appRoot = path.resolve(__dirname, '..');
  const serverEntry = isPackaged
    ? path.join(resourcesPath, 'app.asar.unpacked/packages/media-mcp/dist/cli.js')
    : path.join(appRoot, 'packages/media-mcp/dist/cli.js');
  const mediaModels = settings.models?.filter((model) => model.enabled && model.roles.includes('media'));
  const mediaConfiguration = mediaModels?.flatMap((model) => {
    const connection = settings.connections.find((entry) => entry.id === model.connectionId);
    if (!connection) return [];
    return [{ id: `${connection.id}:${model.model}`, model: model.model, name: model.name || model.model, endpointName: connection.name, baseUrl: connection.baseUrl, apiKey: secrets.connectionKeys?.[connection.id] || '', ...(model.mediaTypes?.length ? { mediaTypes: model.mediaTypes } : {}) }];
  });
  return {
    command: process.execPath,
    args: [serverEntry],
    cwd: isPackaged ? resourcesPath : appRoot,
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      NODE_PATH: isPackaged
        ? path.join(resourcesPath, 'app.asar/node_modules')
        : path.join(appRoot, 'node_modules'),
      ELECTRON_RUN_AS_NODE: '1',
      EASEL_BASE_URL: settings.easelBaseUrl,
      EASEL_API_KEY: secrets.easelApiKey || '',
      ...(mediaConfiguration ? { EASEL_MEDIA_MODELS: JSON.stringify(mediaConfiguration) } : {}),
    },
  };
}

function createChatService({
  settingsStore,
  assetStore,
  chatStore,
  inputStore,
  mediaJobStore,
  registerMediaJob,
  mediaAssetStore = assetStore,
  llmFactory = createLiteLLMClient,
  mcpFactory = createMediaMcpClient,
  mcpLaunchOptions = defaultMcpLaunchOptions,
  runtime = {},
  canvasController,
  presentCanvas,
  onEvent,
}) {
  const history = [];
  let busy = false;
  let chatId = '';
  let chatTitle = '';
  let loadError = '';
  let pendingSave = false;
  let drainingInputs = false;
  let drainingMedia = false;
  let inputDrainScheduled = false;
  let activeTurn = null;
  let shuttingDown = false;
  let inputQueuePaused = false;
  let chatRestorePending = false;
  let enabled = true;
  let lastTurnOptions = { mode: 'chat', size: '1024x1024', skills: [], kits: [] };
  const pendingSubmissions = new Set();
  try {
    const saved = chatStore?.getActive();
    if (saved) {
      history.push(...saved.history);
      chatId = saved.id;
      chatTitle = saved.title;
    }
  } catch {
    loadError = 'Saved chat could not be restored. Open History to try another conversation.';
  }

  function saveHistory() {
    if (!chatStore || !history.length) return;
    const saved = chatStore.save({ ...(chatId ? { id: chatId } : {}), title: chatTitle, history });
    chatId = saved.id;
    pendingSave = false;
  }

  function ensureChatId(title = 'New chat', { persist = true } = {}) {
    if (chatId) return chatId;
    const nextId = crypto.randomUUID().replaceAll('-', '');
    const nextTitle = chatTitle || title.slice(0, 120);
    if (persist && chatStore) chatStore.save({ id: nextId, title: nextTitle, history: [...history] });
    chatId = nextId;
    chatTitle = nextTitle;
    return chatId;
  }

  function scheduleCanvasInputs() {
    if (!enabled || (!inputStore && !mediaJobStore) || inputDrainScheduled || shuttingDown || inputQueuePaused || chatRestorePending) return;
    inputDrainScheduled = true;
    queueMicrotask(() => {
      inputDrainScheduled = false;
      drainCanvasInputs().then(drainMediaJobs).catch((error) => onEvent?.({ type: 'error', message: `Response queue: ${error.message}` }));
    });
  }

  function beginTurn(canvasInputRequestId = '') {
    if (activeTurn || shuttingDown) throw new Error(shuttingDown ? 'The application is closing.' : 'A chat turn is already running.');
    const controller = new AbortController();
    let resolve;
    const done = new Promise((finish) => { resolve = finish; });
    activeTurn = { controller, done, resolve, canvasInputRequestId };
    return activeTurn;
  }

  function finishTurn(turn) {
    if (activeTurn === turn) activeTurn = null;
    turn.resolve();
  }

  function stopAgent() {
    const active = Boolean(activeTurn || busy || drainingInputs || drainingMedia);
    inputQueuePaused = true;
    activeTurn?.controller.abort();
    return { ok: true, stopping: Boolean(activeTurn?.controller.signal.aborted), active };
  }

  async function shutdown() {
    shuttingDown = true;
    const turn = activeTurn;
    stopAgent();
    if (turn) await turn.done;
    await Promise.allSettled([...pendingSubmissions]);
    if (pendingSave) saveHistory();
  }

  function cancelShutdown({ schedule = true } = {}) {
    shuttingDown = false;
    if (schedule) scheduleCanvasInputs();
  }

  function scopedCanvasController(turnChatId, turnOptions) {
    if (!canvasController) return canvasController;
    return {
      ...canvasController,
      requestCanvasInput: async (args) => {
        if (!inputStore || typeof canvasController.requestCanvasInput !== 'function') throw new Error('Canvas input is unavailable.');
        return canvasController.requestCanvasInput(args, { chatId: turnChatId, turnOptions });
      },
      getCanvasInputs: ({ canvasId, limit = 20 } = {}) => {
        if (!inputStore) throw new Error('Canvas input history is unavailable.');
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Read 1 to 50 canvas responses at a time.');
        const available = inputStore.list({ chatId: turnChatId, ...(canvasId ? { canvasId } : {}), limit });
        const inputs = [];
        let bytes = 0;
        for (const entry of available) {
          const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
          if (bytes + size > 24_000) break;
          bytes += size;
          inputs.push(entry);
        }
        return { inputs, truncated: inputs.length < available.length, limitBytes: 24_000 };
      },
    };
  }

  function assertMediaDestination(entry, settings = settingsStore.loadPublic()) {
    if (entry?.kind !== 'media') return;
    const message = 'This capture is saved locally, but its approved endpoint or model changed. Share the capture again to confirm its destination.';
    let approved;
    let current;
    try {
      approved = validateApprovedMediaModel(entry.approvedModel);
      current = validateApprovedMediaModel({ connectionId: settings.activeConnectionId, model: settings.litellmModel, baseUrl: settings.litellmBaseUrl });
    } catch { throw new Error(message); }
    if (JSON.stringify(approved) !== JSON.stringify(current)) throw new Error(message);
  }

  async function sendMessage(input, { mode = 'chat', size = '1024x1024', skills = [], kits = [], attachments = [] } = {}, canvasResume = null, resumeTurn = null) {
    if (!enabled) throw new Error('The built-in agent is disabled while another controller is selected.');
    let userMessage = '';
    if (typeof input === 'string' && input.trim()) {
      if (canvasResume) {
        userMessage = input.trim();
        if (userMessage.length > 50_000) throw new Error('The saved canvas response exceeds the 50,000-character message envelope. Its capture or choice remains saved locally.');
      } else userMessage = validateChatMessage(input);
    }
    if (!userMessage && (!Array.isArray(attachments) || attachments.length === 0)) throw new Error('Message or attachment is required.');
    if (busy || ((drainingInputs || drainingMedia) && !canvasResume)) throw new Error('A chat turn is already running.');
    const turn = resumeTurn || beginTurn(canvasResume?.id || '');
    if (!canvasResume) inputQueuePaused = false;
    const signal = turn.controller.signal;
    let saveWarning = '';
    function checkpoint(nextHistory) {
      if (nextHistory) history.splice(0, history.length, ...nextHistory);
      pendingSave = true;
      try { saveHistory(); saveWarning = ''; }
      catch { saveWarning = 'This chat could not be saved locally. Keep this window open and check available disk space.'; }
    }
    function cancelledResult() {
      checkpoint(canvasResume ? history.map((message) => {
        if (message.canvasInputCompletedId !== canvasResume.id) return message;
        const { canvasInputCompletedId, ...partial } = message;
        return partial;
      }) : undefined);
      return { ok: true, cancelled: true, text: 'Stopped.', chatId, ...(saveWarning ? { saveWarning } : {}) };
    }
    busy = true;
    try {
      // Save the actual prompt through checkpoint, which retains it in memory on disk errors.
      ensureChatId(userMessage.replace(/\s+/g, ' ').slice(0, 120) || 'Attached media', { persist: false });
      const turnChatId = chatId;
      const projectKits = await canvasController?.getCurrentKits?.();
      if (Array.isArray(projectKits)) kits = [...projectKits];
      const turnOptions = { mode, size, skills, kits };
      lastTurnOptions = turnOptions;
      if (!canvasResume) {
        deliverMediaNotifications({ consume: true });
        const text = userMessage || 'Review the attached media and respond with what you find.';
        const requestText = mode === 'image' ? `Create one image with size ${size}. Use the generate_image tool with n=1. User brief:\n${text}` : text;
        history.push({ role: 'user', content: attachments.length ? buildUserContent(requestText, attachments) : requestText });
        checkpoint();
      }
      signal.throwIfAborted();
      const settings = settingsStore.loadPublic();
      assertMediaDestination(canvasResume, settings);
      const secrets = settingsStore.loadSecrets(settings.activeConnectionId);
      if (!settings.litellmModel) throw new Error('Choose a model in chat before sending. Add an endpoint in Settings > Credentials if no models are available.');
      if (settings.models && !settings.models.some((model) => model.connectionId === settings.activeConnectionId && model.model === settings.litellmModel && model.enabled && model.roles.includes('agent'))) throw new Error('The selected model is disabled or has no Agent role. Choose an enabled Agent model in chat.');
      secrets.connectionKeys = Object.fromEntries((settings.connections || [])
        .filter((connection) => settings.models?.some((model) => model.connectionId === connection.id && model.enabled && model.roles.includes('media')))
        .map((connection) => [connection.id, settingsStore.loadSecrets(connection.id).litellmApiKey]));
      const llm = llmFactory({
        baseUrl: settings.litellmBaseUrl,
        apiKey: secrets.litellmApiKey,
        model: settings.litellmModel,
        signal,
      });
      const launchOptions = mcpLaunchOptions(settings, secrets, runtime);
      const trackJob = registerMediaJob ? (input) => registerMediaJob({ ...input, chatId: turnChatId, turnOptions,
        approvedAgent: { connectionId: settings.activeConnectionId, model: settings.litellmModel, baseUrl: settings.litellmBaseUrl } }) : undefined;
      const rawMcp = await mcpFactory({ ...launchOptions, signal });
      const mcp = {
        listTools: (...args) => rawMcp.listTools(...args),
        close: () => rawMcp.close(),
        callTool: (name, args, options) => {
          if (trackJob && ['generate_video', 'generate_image', 'edit_image', 'create_image_variation'].includes(name)) {
            const submittedProjectId = canvasController?.getCurrentCanvasId?.() || '';
            // Stop ends the agent turn; shutdown still waits for an accepted receipt to be saved.
            const submission = (async () => {
              const submissionMcp = await mcpFactory(launchOptions);
              try {
                const result = await submissionMcp.callTool(name, args);
                if (!result.isError && result.structuredContent?.job) await trackJob({ job: result.structuredContent.job,
                  modelId: result.structuredContent.job.modelId || args.model, mediaType: name === 'generate_video' ? 'video' : 'image',
                  projectId: submittedProjectId, prompt: args.prompt || '' });
                else if (!result.isError) {
                  const saved = JSON.parse(await handleMcpResult(result, mediaAssetStore, (event) => {
                    if (chatId === turnChatId && !shuttingDown) onEvent?.(event);
                  }, { generated: true, projectId: submittedProjectId, kits, attachGeneratedAssets: canvasController?.attachGeneratedAssets }));
                  return { content: (result.content || []).filter((item) => item.type === 'text'), structuredContent: saved };
                }
                return result;
              } finally { await submissionMcp.close(); }
            })();
            pendingSubmissions.add(submission);
            const settled = () => { pendingSubmissions.delete(submission); onEvent?.({ type: 'control-settled' }); };
            submission.then(settled, settled);
            return submission;
          }
          const remoteId = name === 'get_video' ? args.videoId : name === 'get_image_job' ? args.jobId : '';
          const saved = remoteId && mediaJobStore?.list({ raw: true }).find((entry) => entry.remoteId === remoteId && entry.modelId === args.model);
          if (!saved) return rawMcp.callTool(name, args, options);
          const job = { id: saved.remoteId, modelId: saved.modelId, status: saved.status === 'ready' ? 'completed' : saved.status === 'failed' ? 'failed' : 'in_progress', progress: saved.progress, ...(saved.error ? { error: saved.error } : {}) };
          return Promise.resolve({ content: [{ type: 'text', text: 'This job is managed by the persistent host monitor. Do not resubmit or poll it in the agent turn.' }], structuredContent: { job, ...(saved.status === 'ready' ? { assets: saved.assets } : {}) } });
        },
      };
      let result;
      try {
        signal.throwIfAborted();
        result = await runAgentTurn({
          userMessage,
          mode,
          size,
          skills,
          kits,
          attachments,
          history,
          appendUserMessage: false,
          canvasInputRequestId: canvasResume?.kind === 'job' ? '' : canvasResume?.id || '',
          mediaJobResumeId: canvasResume?.kind === 'job' ? canvasResume.id : '',
          canvasInputMedia: canvasResume?.kind === 'media' ? attachments : [],
          llm,
          mcp,
          assetStore,
          mediaAssetStore,
          canvasController: scopedCanvasController(turnChatId, turnOptions),
          presentCanvas,
          onEvent,
          signal,
          onHistory: checkpoint,
          registerMediaJob: trackJob,
        });
        checkpoint(result.history);
        if (!chatTitle) chatTitle = userMessage.replace(/\s+/g, ' ').slice(0, 120) || 'Attached media';
      } finally {
        await mcp.close();
      }
      if (signal.aborted || result.cancelled) return cancelledResult();
      return { ok: true, text: result.text, chatId, ...(result.awaitingCanvasInput ? { awaitingCanvasInput: result.awaitingCanvasInput } : {}), ...(saveWarning ? { saveWarning } : {}) };
    } catch (error) {
      if (signal.aborted) return cancelledResult();
      throw error;
    } finally {
      busy = false;
      if (!resumeTurn) {
        finishTurn(turn);
        if (signal.aborted) onEvent?.({ type: 'agent-stopped', chatId, ...(saveWarning ? { saveWarning } : {}) });
      }
      scheduleCanvasInputs();
    }
  }

  function matchingCanvas(entry) {
    const documentPath = entry.documentPath || (canvasController?.getCurrentCanvasId?.() === entry.canvasId ? canvasController?.getDefaultDocumentPath?.() : '');
    return (typeof canvasController?.getCurrentCanvasId !== 'function' || canvasController.getCurrentCanvasId() === entry.canvasId)
      && (!documentPath || typeof canvasController?.getCurrentDocumentPath !== 'function' || canvasController.getCurrentDocumentPath() === documentPath);
  }

  async function applyInputAction(entry, signal) {
    if (entry.kind !== 'choice' || entry.actionApplied) return;
    try {
      if (typeof canvasController?.completeCanvasInput !== 'function') throw new Error('Canvas response was saved, but this app cannot apply its completion action.');
      await canvasController.completeCanvasInput(entry);
      inputStore.markActionApplied(entry.id);
    } catch (error) {
      inputStore.markActionError(entry.id, error);
      if (!signal?.aborted) onEvent?.({ type: 'error', message: `Your canvas response is saved. ${error.message}` });
    }
  }

  function interruptInput(entry, saveWarning = '') {
    inputStore.interrupt(entry.id, shuttingDown ? 'The application closed during this response. Retry explicitly to continue; previous tool effects may already have occurred.' : 'You stopped this response. Your input is saved. Retry explicitly to continue; previous tool effects may already have occurred.');
    onEvent?.({ type: 'canvas-input-resume-end', request: canvasInputSummary(inputStore.get(entry.id)), chatId, cancelled: true, ...(saveWarning ? { saveWarning } : {}) });
  }

  async function resumeCanvasInput(entry, turn) {
    turn.controller.signal.throwIfAborted();
    assertMediaDestination(entry);
    const text = formatCanvasInputMessage(entry);
    let attachments = [];
    if (entry.kind === 'media') {
      attachments = await Promise.all(entry.attachments.map(async (reference) => {
        const asset = await mediaAssetStore.get(reference.assetId);
        if (asset.mimeType !== reference.mimeType || typeof asset.data !== 'string') throw new Error('Saved canvas media does not match its declared format.');
        return { type: reference.type, name: reference.name, mimeType: asset.mimeType, data: asset.data };
      }));
    }
    turn.controller.signal.throwIfAborted();
    if (!history.some((message) => message.role === 'user' && message.canvasInputRequestId === entry.id)) {
      history.push({ role: 'user', content: text, canvasInputRequestId: entry.id, ...(entry.kind === 'media' ? { canvasMediaRefs: entry.attachments } : {}) });
      pendingSave = true;
      // The real user input is saved once, before starting an agent response.
      saveHistory();
      const displayText = entry.kind === 'choice' ? entry.options.find((option) => option.value === entry.value)?.label || entry.value : entry.prompt || 'Review the media I shared from the canvas.';
      onEvent?.({ type: 'canvas-input-answer', request: canvasInputSummary(entry), text: displayText, attachments, chatId });
    }
    try {
      const result = await sendMessage(text, { ...(entry.turnOptions || {}), attachments }, entry, turn);
      if (result.cancelled) {
        turn.saveWarning = result.saveWarning || '';
        interruptInput(entry, turn.saveWarning);
        return result;
      }
      if (pendingSave) saveHistory();
      inputStore.complete(entry.id);
      onEvent?.({ type: 'canvas-input-resume-end', request: canvasInputSummary(inputStore.get(entry.id)), chatId });
    } catch (error) {
      if (turn.controller.signal.aborted) {
        interruptInput(entry);
        return { ok: true, cancelled: true };
      }
      if (history.some((message) => message.canvasInputCompletedId === entry.id)) {
        if (pendingSave) saveHistory();
        inputStore.complete(entry.id);
      } else inputStore.fail(entry.id, error);
      onEvent?.({ type: 'canvas-input-resume-end', request: canvasInputSummary(inputStore.get(entry.id)), chatId, error: error.message });
    }
  }

  async function drainCanvasInputs() {
    if (!enabled || !inputStore || busy || drainingInputs || drainingMedia || !chatId || shuttingDown || inputQueuePaused || chatRestorePending) return;
    drainingInputs = true;
    try {
      const queue = inputStore.list({ chatId, status: ['answered', 'queued'], limit: 200, raw: true }).reverse();
      for (const entry of queue) {
        if (!enabled || busy || entry.chatId !== chatId || shuttingDown || inputQueuePaused) break;
        if (!matchingCanvas(entry)) continue;
        const claimed = inputStore.beginDispatch(entry.id);
        const turn = beginTurn(entry.id);
        onEvent?.({ type: 'canvas-input-resume-start', request: canvasInputSummary(claimed), chatId });
        try {
          turn.controller.signal.throwIfAborted();
          assertMediaDestination(claimed);
          await applyInputAction(claimed, turn.controller.signal);
          turn.controller.signal.throwIfAborted();
          await resumeCanvasInput(inputStore.get(claimed.id), turn);
        } catch (error) {
          if (turn.controller.signal.aborted) interruptInput(claimed);
          else {
            inputStore.fail(claimed.id, error);
            onEvent?.({ type: 'canvas-input-resume-end', request: canvasInputSummary(inputStore.get(claimed.id)), chatId, error: `Your canvas response is saved but could not continue: ${error.message}` });
          }
        } finally {
          finishTurn(turn);
          if (turn.controller.signal.aborted) onEvent?.({ type: 'agent-stopped', chatId, canvasInputRequestId: entry.id, ...(turn.saveWarning ? { saveWarning: turn.saveWarning } : {}) });
        }
      }
    } finally {
      drainingInputs = false;
      if (chatId && inputStore.list({ chatId, status: ['answered', 'queued'], limit: 200, raw: true }).some(matchingCanvas)) scheduleCanvasInputs();
    }
  }

  function completedMediaJobs() {
    return mediaJobStore?.list({ chatId, raw: true }).filter((entry) => ['ready', 'failed'].includes(entry.status) && ['pending', 'delivered'].includes(entry.notification)) || [];
  }

  function deliverMediaNotifications({ consume = false } = {}) {
    if (!chatId || !mediaJobStore) return [];
    const entries = completedMediaJobs().reverse();
    for (const entry of entries) {
      const result = { jobId: entry.remoteId, localJobId: entry.id, name: entry.name, mediaType: entry.mediaType, modelId: entry.modelId, projectId: entry.projectId, status: entry.status, assets: entry.assets, ...(entry.error ? { error: entry.error } : {}) };
      if (!history.some((message) => message.mediaJobId === entry.id)) {
        history.push({ role: 'user', content: `Background ${entry.mediaType} job ${entry.status === 'ready' ? 'is ready' : 'failed'}. This is an automatic host notification, not a new user request.\n${JSON.stringify(result)}\nContinue the original request using the saved output when useful. Do not generate a replacement or retrieve this completed output again. The output belongs to the listed project; do not edit a different project.`, mediaJobId: entry.id, mediaJobResult: result });
        pendingSave = true;
        saveHistory();
        onEvent?.({ type: 'media-job-notification', chatId, projectId: entry.projectId, jobId: entry.id, assets: entry.assets, job: entry, text: entry.status === 'ready' ? `Your ${entry.mediaType} is ready.` : `${entry.mediaType[0].toUpperCase() + entry.mediaType.slice(1)} generation failed: ${entry.error}` });
      }
      mediaJobStore.update(entry.id, { notification: consume ? 'responded' : 'delivered' });
    }
    return entries;
  }

  async function drainMediaJobs() {
    if (!enabled || !mediaJobStore || busy || drainingInputs || drainingMedia || !chatId || shuttingDown || inputQueuePaused || chatRestorePending) return;
    drainingMedia = true;
    try {
      const settings = settingsStore.loadPublic();
      for (const entry of completedMediaJobs().reverse()) {
        const sameAgent = entry.approvedAgent && entry.approvedAgent.connectionId === settings.activeConnectionId && entry.approvedAgent.model === settings.litellmModel && entry.approvedAgent.baseUrl === settings.litellmBaseUrl;
        const sameProject = !entry.projectId || !canvasController?.getCurrentCanvasId || canvasController.getCurrentCanvasId() === entry.projectId;
        if (!enabled || !sameAgent || !sameProject || activeTurn || shuttingDown || inputQueuePaused) continue;
        deliverMediaNotifications();
        if (history.some((message) => message.mediaJobCompletedId === entry.id)) { mediaJobStore.update(entry.id, { notification: 'responded' }); continue; }
        const turn = beginTurn();
        mediaJobStore.update(entry.id, { notification: 'dispatching' });
        onEvent?.({ type: 'media-job-resume-start', chatId, jobId: entry.id });
        try {
          const result = await sendMessage('Continue from the completed background media job.', entry.turnOptions || {}, { id: entry.id, kind: 'job' }, turn);
          mediaJobStore.update(entry.id, { notification: result.cancelled ? 'interrupted' : 'responded', ...(result.saveWarning ? { notificationError: result.saveWarning } : {}) });
          onEvent?.({ type: 'media-job-resume-end', chatId, jobId: entry.id, cancelled: result.cancelled, saveWarning: result.saveWarning });
        } catch (error) {
          mediaJobStore.update(entry.id, { notification: 'interrupted', notificationError: String(error.message).slice(0, 1000) });
          onEvent?.({ type: 'media-job-resume-end', chatId, jobId: entry.id, error: error.message });
        } finally { finishTurn(turn); }
      }
    } finally { drainingMedia = false; }
  }

  async function notifyMediaJob(job) {
    const assets = await Promise.all((job.assets || []).map(async (asset) => {
      try {
        const metadata = await mediaAssetStore?.getMetadata?.(asset.assetId);
        return { ...asset, ...Object.fromEntries(['name', 'mimeType', 'thumbnail', 'width', 'height', 'duration'].filter((key) => metadata?.[key] !== undefined).map((key) => [key, metadata[key]])) };
      } catch { return asset; }
    }));
    onEvent?.({ type: 'media-job-ready', job, jobId: job.id, assets, projectId: job.projectId, chatId: job.chatId });
    scheduleCanvasInputs();
  }

  async function submitCanvasInput(input) {
    if (!inputStore) throw new Error('Canvas input is unavailable.');
    const request = inputStore.get(inputId(input?.requestId, 'Input request ID'));
    if (!matchingCanvas(request)) throw new Error('Open the original project document before answering this question.');
    const saved = inputStore.submit(input);
    inputQueuePaused = false;
    onEvent?.({ type: 'canvas-input', request: canvasInputSummary(saved), status: 'answered' });
    scheduleCanvasInputs();
    return { ok: true, request: canvasInputSummary(saved), queued: true, ...(saved.chatId !== chatId ? { waitingFor: 'Open the original conversation to continue.' } : busy ? { waitingFor: 'The current reply will finish first.' } : {}) };
  }

  async function submitCanvasMedia({ canvasId, documentPath, chatId: originalChatId, attachments, prompt, approvedModel }) {
    if (!inputStore) throw new Error('Canvas media input is unavailable.');
    if (typeof originalChatId !== 'string') throw new Error('The original conversation is required when sharing canvas media.');
    if (originalChatId) inputId(originalChatId, 'Chat ID');
    if (originalChatId !== chatId) throw new Error('The conversation changed before this capture could be shared. Share it again in the intended conversation.');
    ensureChatId('Canvas media');
    const approved = validateApprovedMediaModel(approvedModel);
    assertMediaDestination({ kind: 'media', approvedModel: approved });
    const saved = inputStore.createMedia({ canvasId, documentPath, chatId, attachments, prompt, approvedModel: approved, turnOptions: lastTurnOptions });
    inputQueuePaused = false;
    onEvent?.({ type: 'canvas-input', request: canvasInputSummary(saved), status: 'queued' });
    scheduleCanvasInputs();
    return { ok: true, request: canvasInputSummary(saved), queued: true };
  }

  async function cancelCanvasInput({ requestId, canvasId, documentPath }) {
    if (!inputStore) throw new Error('Canvas input is unavailable.');
    const request = inputStore.get(inputId(requestId, 'Input request ID'));
    inputId(canvasId, 'Canvas ID');
    if (request.canvasId !== canvasId || (request.documentPath && request.documentPath !== documentPath) || !matchingCanvas(request)) throw new Error('Open the original canvas to dismiss this question.');
    const cancelled = inputStore.cancel(request.id, 'Dismissed by the user.');
    onEvent?.({ type: 'canvas-input', request: canvasInputSummary(cancelled), status: 'cancelled' });
    let dismissError = '';
    if (typeof canvasController?.dismissCanvasInput === 'function') {
      try { await canvasController.dismissCanvasInput(cancelled); }
      catch (error) { dismissError = error.message; }
    }
    return { ok: true, request: canvasInputSummary(cancelled), ...(dismissError ? { dismissError } : {}) };
  }

  function retryCanvasInput(requestId) {
    if (!inputStore) throw new Error('Canvas input is unavailable.');
    const entry = inputStore.get(inputId(requestId, 'Input request ID'));
    if (entry.chatId !== chatId || !matchingCanvas(entry)) throw new Error('Open the original conversation and canvas before retrying this response.');
    if (!['failed', 'interrupted'].includes(entry.status)) throw new Error('Only a failed or interrupted response can be retried.');
    if (busy || drainingInputs) throw new Error('Wait for the current reply before retrying.');
    if (shuttingDown) throw new Error('The application is closing.');
    if (history.some((message) => message.canvasInputCompletedId === entry.id)) {
      if (pendingSave) saveHistory();
      const completed = inputStore.complete(entry.id);
      onEvent?.({ type: 'canvas-input-resume-end', request: canvasInputSummary(completed), chatId });
      return { ok: true, request: canvasInputSummary(completed) };
    }
    assertMediaDestination(entry);
    const claimed = inputStore.beginDispatch(entry.id);
    const turn = beginTurn(entry.id);
    inputQueuePaused = false;
    drainingInputs = true;
    onEvent?.({ type: 'canvas-input-resume-start', request: canvasInputSummary(claimed), chatId });
    (async () => {
      turn.controller.signal.throwIfAborted();
      await applyInputAction(claimed, turn.controller.signal);
      turn.controller.signal.throwIfAborted();
      await resumeCanvasInput(inputStore.get(claimed.id), turn);
    })().catch((error) => {
      if (turn.controller.signal.aborted) interruptInput(entry);
      else {
        inputStore.fail(entry.id, error);
        onEvent?.({ type: 'canvas-input-resume-end', request: canvasInputSummary(inputStore.get(entry.id)), chatId, error: error.message });
      }
    }).finally(() => {
      drainingInputs = false;
      finishTurn(turn);
      if (turn.controller.signal.aborted) onEvent?.({ type: 'agent-stopped', chatId, canvasInputRequestId: entry.id, ...(turn.saveWarning ? { saveWarning: turn.saveWarning } : {}) });
      scheduleCanvasInputs();
    });
    return { ok: true, request: canvasInputSummary(inputStore.get(entry.id)) };
  }

  function recoverCanvasInputs() {
    if (!inputStore) return [];
    for (const entry of !busy && !drainingInputs ? inputStore.list({ chatId: chatId || undefined, status: 'dispatching', limit: 200, raw: true }) : []) {
      if (entry.chatId !== chatId) continue;
      if (history.some((message) => message.canvasInputCompletedId === entry.id)) inputStore.complete(entry.id);
      else inputStore.interrupt(entry.id);
    }
    scheduleCanvasInputs();
    return inputStore.list({ ...(chatId ? { chatId } : {}), limit: 50 });
  }

  function clearHistory() {
    if (busy || drainingInputs || drainingMedia) throw new Error('Wait for the current reply before starting a new chat.');
    if (pendingSave) saveHistory();
    chatStore?.activate('');
    history.splice(0, history.length);
    chatId = '';
    chatTitle = '';
    loadError = '';
    chatRestorePending = false;
  }

  function openChat(id) {
    if (busy || drainingInputs || drainingMedia) throw new Error('Wait for the current reply before opening another chat.');
    if (!chatStore) throw new Error('Chat history is unavailable.');
    if (pendingSave) saveHistory();
    const saved = chatStore.get(id);
    chatStore.activate(id);
    history.splice(0, history.length, ...saved.history);
    chatId = saved.id;
    chatTitle = saved.title;
    loadError = '';
    chatRestorePending = true;
    recoverCanvasInputs();
    return getCurrentChat({ deferResume: true });
  }

  function acknowledgeChat(id) {
    if (id !== chatId) return { ok: false, stale: true };
    chatRestorePending = false;
    scheduleCanvasInputs();
    return { ok: true };
  }

  async function getCurrentChat({ deferResume = false } = {}) {
    if (deferResume) chatRestorePending = true;
    if (!busy && !drainingMedia && mediaJobStore) {
      for (const entry of mediaJobStore.list({ chatId, raw: true }).filter((job) => job.notification === 'dispatching')) {
        mediaJobStore.update(entry.id, { notification: history.some((message) => message.mediaJobCompletedId === entry.id) ? 'responded' : 'interrupted' });
      }
    }
    if (!busy && !drainingMedia) deliverMediaNotifications();
    scheduleCanvasInputs();
    const currentId = chatId;
    const currentTitle = chatTitle;
    const currentHistory = [...history];
    const images = new Map();
    const media = [];
    const seenMedia = new Set();
    let mediaBytes = 0;
    let mediaTruncated = false;
    for (const message of [...currentHistory].reverse()) {
      if (message.role !== 'user' || !Array.isArray(message.canvasMediaRefs)) continue;
      for (const reference of message.canvasMediaRefs) {
        if (seenMedia.has(reference.assetId)) continue;
        seenMedia.add(reference.assetId);
        if (media.length >= 20) { mediaTruncated = true; continue; }
        try {
          const metadata = /^image\//.test(reference.mimeType) ? null : await mediaAssetStore.getMetadata?.(reference.assetId);
          if (metadata && /^(video|audio)\//.test(metadata.mimeType) && metadata.mimeType === reference.mimeType) {
            media.push({ ...metadata, ...reference, requestId: message.canvasInputRequestId });
            continue;
          }
          const saved = await mediaAssetStore.get(reference.assetId);
          if (saved.mimeType !== reference.mimeType || typeof saved.data !== 'string') continue;
          const bytes = Buffer.byteLength(saved.data, 'base64');
          if (mediaBytes + bytes > 64 * 1024 * 1024) { mediaTruncated = true; continue; }
          mediaBytes += bytes;
          media.push({ requestId: message.canvasInputRequestId, ...reference, data: saved.data });
        } catch {
          // Keep the response and asset metadata readable if a capture is missing.
        }
      }
    }
    for (const message of currentHistory) {
      if ((message.role !== 'tool' && !message.mediaJobResult) || typeof message.content !== 'string') continue;
      try {
        const result = message.mediaJobResult || JSON.parse(message.content);
        const references = [...(Array.isArray(result.assets) ? result.assets : []), ...(result.assetId ? [{ assetId: result.assetId }] : [])];
        for (const asset of references) {
          if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(asset.assetId || '') || images.has(asset.assetId)) continue;
          const metadata = /^image\//.test(asset.mimeType) ? null : await mediaAssetStore.getMetadata?.(asset.assetId);
          if (metadata && /^(video|audio)\//.test(metadata.mimeType)) {
            if (seenMedia.has(asset.assetId)) continue;
            seenMedia.add(asset.assetId);
            if (media.length >= 20) { mediaTruncated = true; continue; }
            media.push({ ...asset, ...metadata, assetId: asset.assetId, projectId: result.projectId, generated: Boolean(result.job || message.mediaJobResult) });
            continue;
          }
          const saved = await mediaAssetStore.get(asset.assetId);
          if (/^image\//.test(saved.mimeType)) {
            images.set(asset.assetId, { ...saved, assetId: saved.id });
          } else if (/^(video|audio)\//.test(saved.mimeType) && !seenMedia.has(asset.assetId)) {
            seenMedia.add(asset.assetId);
            const bytes = typeof saved.data === 'string' ? Buffer.byteLength(saved.data, 'base64') : 0;
            if (!bytes) continue;
            if (media.length >= 20 || mediaBytes + bytes > 64 * 1024 * 1024) { mediaTruncated = true; continue; }
            mediaBytes += bytes;
            media.push({ ...saved, assetId: saved.id, projectId: result.projectId, generated: Boolean(result.job || message.mediaJobResult) });
          }
        }
      } catch {
        // A missing asset must not prevent reopening the conversation.
      }
    }
    return { id: currentId, title: currentTitle, history: currentHistory, images: [...images.values()], media, mediaTruncated, canvasInputs: inputStore && currentId ? inputStore.list({ chatId: currentId, limit: 50 }) : [], ...(loadError ? { error: loadError } : {}) };
  }

  return { setEnabled(value) { enabled = Boolean(value); if (enabled) scheduleCanvasInputs(); }, sendMessage, stopAgent, shutdown, cancelShutdown, notifyMediaJob, submitCanvasInput, submitCanvasMedia, cancelCanvasInput, retryCanvasInput, recoverCanvasInputs, getCanvasInputs: (query) => inputStore?.list(query) || [], clearHistory, openChat, getCurrentChat, acknowledgeChat, getActiveChatId: () => chatId, listChats: () => chatStore?.list() || [], isSettling: () => pendingSubmissions.size > 0, isBusy: () => busy || drainingInputs || drainingMedia };
}

module.exports = { createChatService, defaultMcpLaunchOptions };
