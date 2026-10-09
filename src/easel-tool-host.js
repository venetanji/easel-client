const { executeEaselTool, handleMcpResult, toOpenAITools, validateToolArguments, toolCorrection } = require('./agent');
const { EXTERNAL_INSTRUCTIONS } = require('./harness-instructions');
const { MEDIA_OUTPUT_TOOLS } = require('./media-reference-tools');
const { AUDIO_GENERATION_TOOLS, AUDIO_TOOLS } = require('./media-mcp-client');
const { registerAudioTrackJobs, managedAudioTrackResult, enrichAudioDownload } = require('./audio-track-jobs');
const { throwIfAborted } = require('./turn-abort');

const WORKSPACE_TOOLS = [
  { name: 'list_projects', description: 'List named Easel projects and the currently open project. Use opaque IDs returned here to switch the tool destination.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'open_project', description: 'Save the current canvas and open an existing project or HTML document as the tool destination. A failed open preserves the current runtime. Source is unchanged.', inputSchema: { type: 'object', additionalProperties: false, required: ['projectId'], properties: { projectId: { type: 'string', pattern: '^[a-f0-9]{32}$' }, documentPath: { type: 'string', maxLength: 180 } } } },
  { name: 'create_project', description: 'Create a named project and open its first HTML canvas. Installed kit selection applies to every HTML document in that project.', inputSchema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, kits: { type: 'array', maxItems: 8, items: { type: 'string', enum: ['canvas-2d', 'html-deck', 'three', 'phaser', 'matter', 'tone', 'p5', 'strudel'] } } } } },
  { name: 'delete_project', description: 'Ask the user to confirm deletion of this project and whether to keep its media. Shared media is retained. Cancellation leaves files unchanged; never assume approval.', inputSchema: { type: 'object', additionalProperties: false, required: ['projectId'], properties: { projectId: { type: 'string', pattern: '^[a-f0-9]{32}$' } } } },
  { name: 'get_control_events', description: 'Read durable media completions, saved canvas answers, and project change notifications after an event cursor. Events survive app restarts; MCP resource notifications announce new events. Read at turn start or after notification, without polling.', inputSchema: { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
];

function createEaselToolHost({ canvasController, presentCanvas, assetStore, mediaAssetStore = assetStore,
  createMediaClient, getKits = () => [], getOrigin = () => ({}), registerMediaJob, workspace,
  eventStore, control, onEvent, onWaiting, beforeTool } = {}) {
  let descriptors = new Map();
  let descriptorList;
  let discovery;
  let toolsRevision = 0;
  let stopping = false;
  const submissions = new Set();
  const clients = new Set();
  const detachedTools = new Set([...MEDIA_OUTPUT_TOOLS, ...AUDIO_GENERATION_TOOLS, 'generate_video']);
  async function withMedia(action, signal) {
    throwIfAborted(signal);
    const client = await createMediaClient(signal);
    clients.add(client);
    try { return await action(client); }
    finally {
      clients.delete(client);
      try { await client.close(); }
      catch { onEvent?.({ type: 'error', message: 'The media connection could not close cleanly. Accepted media and saved job receipts are kept.' }); }
    }
  }
  async function listTools() {
    if (stopping) throw new Error('Easel is shutting down.');
    if (descriptorList) return descriptorList;
    if (discovery) return discovery;
    const revision = toolsRevision;
    const pending = withMedia((client) => client.listTools()).then((media) => {
      if (revision !== toolsRevision) return listTools();
      const shared = toOpenAITools(media).map(({ function: tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
      descriptorList = [...WORKSPACE_TOOLS, ...shared];
      descriptors = new Map(descriptorList.map((tool) => [tool.name, tool]));
      return descriptorList;
    });
    discovery = pending;
    try { return await pending; }
    finally { if (discovery === pending) discovery = undefined; }
  }
  function invalidateTools() {
    toolsRevision += 1;
    descriptors = new Map();
    descriptorList = undefined;
    discovery = undefined;
  }
  async function execute(name, args, { signal, sessionId } = {}) {
    if (stopping) throw new Error('Easel is shutting down. Accepted media jobs remain saved.');
    if (!descriptors.size) await listTools();
    const descriptor = descriptors.get(name);
    try {
      if (!descriptor) throw new Error(`Unknown or unavailable Easel tool: ${name}`);
      validateToolArguments(args, descriptor.inputSchema);
      throwIfAborted(signal);
      await beforeTool?.();
      throwIfAborted(signal);
      let result;
      const origin = await getOrigin(sessionId);
      const context = { ...origin, signal };
      if (name === 'get_control_events') result = eventStore.read(args);
      else if (name === 'list_projects') result = await workspace.list();
      else if (name === 'open_project') result = await workspace.open(args, context);
      else if (name === 'create_project') result = await workspace.create(args, context);
      else if (name === 'delete_project') result = await workspace.delete(args, context);
      else {
        const kits = await getKits();
        const outputObservations = [];
        const registeredJobs = new Map();
        const submittedProjectId = canvasController.getCurrentCanvasId?.() || '';
        function registerOnce(input) {
          const key = `${input.modelId || input.job?.modelId || ''}:${input.job?.id || ''}`;
          if (!registeredJobs.has(key)) registeredJobs.set(key, Promise.resolve().then(() => registerMediaJob?.({
            ...input, ...origin, projectId: input.projectId ?? submittedProjectId,
            turnOptions: { ...origin.turnOptions, kits },
          })));
          return registeredJobs.get(key);
        }
        const mcp = {
          callTool: async (tool, input, options = {}) => {
            let managedAudioJob;
            if (tool === 'download_audio' && typeof canvasController.listMediaJobs === 'function') {
              const listing = await canvasController.listMediaJobs();
              managedAudioJob = listing.jobs?.find(entry => entry.mediaType === 'audio' && entry.remoteId === input.trackId && entry.modelId === input.model && !['cancelled', 'failed'].includes(entry.status));
              if (managedAudioJob) {
                const reused = await managedAudioTrackResult(managedAudioJob, mediaAssetStore);
                if (reused) return reused;
              }
            }
            if (!detachedTools.has(tool)) return withMedia((client) => client.callTool(tool, input, options), signal);
            // Once submitted, generation must save its receipt even if the controller disconnects.
            const submission = withMedia(async (client) => {
              let response = await client.callTool(tool, input);
              if (tool === 'download_audio') response = await enrichAudioDownload(response, input, client);
              if (AUDIO_GENERATION_TOOLS.has(tool)) response = await registerAudioTrackJobs(response,
                { model: input.model, prompt: input.prompt, projectId: submittedProjectId }, registerMediaJob ? registerOnce : undefined);
              const hasOutput = response.content?.some((item) => ['image', 'audio', 'resource'].includes(item.type)) || response.structuredContent?.assets?.length;
              if (!response.isError && response.structuredContent?.job && !hasOutput && !['failed', 'cancelled'].includes(response.structuredContent.job.status)) {
                const acceptedJob = { remoteId: response.structuredContent.job.id, modelId: response.structuredContent.job.modelId || input.model,
                  mediaType: tool === 'generate_video' || tool === 'get_video' ? 'video' : 'image', projectId: submittedProjectId };
                try { await registerOnce({ job: response.structuredContent.job, modelId: acceptedJob.modelId, mediaType: acceptedJob.mediaType, prompt: input.prompt || '' }); }
                catch (cause) {
                  const message = `Media job ${acceptedJob.remoteId} was accepted, but its local receipt could not be saved. Keep this remote ID; resolve the storage error before retrieving it. Do not resubmit.`;
                  onEvent?.({ type: 'error', message });
                  throw Object.assign(new Error(message, { cause }), { code: 'MEDIA_RECEIPT_SAVE_FAILED', acceptedJob });
                }
              }
              if (!response.isError && (hasOutput || !response.structuredContent?.job)) {
                const saved = JSON.parse(await handleMcpResult(response, mediaAssetStore, (event) => {
                  if (event.type === 'image' && event.data) outputObservations.push({ data: event.data, mimeType: event.mimeType });
                  onEvent?.({ ...event, chatId: origin.chatId, origin: origin.origin });
                }, { generated: !AUDIO_GENERATION_TOOLS.has(tool), projectId: submittedProjectId, kits, attachGeneratedAssets: canvasController.attachGeneratedAssets,
                  ...(AUDIO_TOOLS.has(tool) ? { audioContext: { toolName: tool, modelId: input.model, trackId: input.trackId } } : {}) }));
                if (managedAudioJob && saved.assets?.length) {
                  try { await canvasController.updateMediaJobAssets?.(managedAudioJob.id, saved.assets); }
                  catch { /* A removed receipt must not prevent an explicit download. */ }
                }
                return { content: [], structuredContent: saved };
              }
              return response;
            });
            submissions.add(submission);
            const settled = () => { submissions.delete(submission); onEvent?.({ type: 'control-settled' }); };
            submission.then(settled, settled);
            return submission;
          },
        };
        const execution = await executeEaselTool(name, args, { canvasController, presentCanvas, assetStore, mediaAssetStore,
          mcp, kits, onEvent, signal, context,
          registerMediaJob: registerOnce,
        });
        throwIfAborted(signal);
        result = execution.content;
        if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
        const content = [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }];
        for (const capture of [...outputObservations, ...(execution.captures || [])]) content.push({ type: 'image', data: capture.data, mimeType: capture.mimeType });
        if (execution.awaitingCanvasInput) onWaiting?.({ request: execution.awaitingCanvasInput, ...origin });
        return { content, ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}), ...(result?.ok === false ? { isError: true } : {}) };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}) };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = String(error.message || error);
      const correction = toolCorrection(name, descriptor ? { function: { parameters: descriptor.inputSchema } } : undefined, message, error.code);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message, code: error.code || 'EASEL_TOOL_ERROR', ...(error.requestSent === false && ['INVALID_TOOL_ARGUMENTS', 'INVALID_MEDIA_REFERENCE'].includes(error.code) ? { requestSent: false, stage: error.stage } : {}), ...(error.acceptedJob ? { acceptedJob: error.acceptedJob } : {}), ...correction }) }] };
    }
  }
  return {
    instructions: EXTERNAL_INSTRUCTIONS,
    listTools,
    invalidateTools,
    isBusy: () => submissions.size > 0 || clients.size > 0,
    callTool: (name, args = {}, options = {}) => control ? control.runTool(options.sessionId, () => execute(name, args, options), options.signal) : execute(name, args, options),
    async shutdown() { stopping = true; invalidateTools(); await Promise.allSettled([...submissions]); await Promise.allSettled([...clients].map((client) => client.close())); },
    cancelShutdown() { stopping = false; invalidateTools(); },
  };
}

module.exports = { createEaselToolHost, WORKSPACE_TOOLS };
