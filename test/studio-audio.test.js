const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaMcpClient } = require('../src/media-mcp-client');
const { runAgentTurn, executeEaselTool } = require('../src/agent');
const { createCanvasMediaStore } = require('../src/canvas-media-store');
const { producedMediaAssets } = require('../src/media-tool-results');
const { createChatService } = require('../src/chat-service');
const { createControlEventStore } = require('../src/control-event-store');
const { createMediaJobStore } = require('../src/media-job-store');
const { createMediaJobMonitor } = require('../src/media-job-monitor');
const { createChatStore } = require('../src/chat-store');

const attemptId = '11111111-1111-4111-8111-111111111111';
const trackId = '22222222-2222-4222-8222-222222222222';
const model = 'studio:suno-music';
const m4a = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A \0\0\0\0M4A isom')]);

test('restoring audio repairs generic names from saved song metadata and preserves custom names', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-audio-names-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = createCanvasMediaStore({ userDataPath: root });
  const genericId = await media.save({ data: m4a.toString('base64'), mimeType: 'audio/mp4', name: 'Generated audio.m4a' });
  const customId = await media.save({ data: m4a.toString('base64'), mimeType: 'audio/mp4', name: 'My favorite take.m4a' });
  const chats = createChatStore({ userDataPath: root });
  const chatId = 'a'.repeat(32);
  chats.save({ id: chatId, title: 'Songs', history: [
    { role: 'tool', tool_call_id: 'inspect', content: JSON.stringify({ audio: { modelId: model, trackId, title: 'Hazy Pixel Dreams', duration: 218 } }) },
    { role: 'tool', tool_call_id: 'download', content: JSON.stringify({ audio: { modelId: model, trackId, track: { song_id: trackId } },
      assets: [{ assetId: genericId, mimeType: 'audio/mp4' }, { assetId: customId, mimeType: 'audio/mp4' }] }) },
  ] });
  const service = createChatService({ chatStore: chats, mediaAssetStore: media,
    settingsStore: { loadPublic: () => ({ litellmModel: 'test' }), loadSecrets: () => ({}) },
  });
  const snapshot = await service.openChat(chatId);
  assert.equal(snapshot.media.find(asset => asset.assetId === genericId).name, 'Hazy Pixel Dreams.m4a');
  assert.equal((await media.getMetadata(genericId)).duration, 218);
  assert.equal((await media.getMetadata(customId)).name, 'My favorite take.m4a');
  assert.equal((await media.get(genericId)).data, m4a.toString('base64'));
  await service.shutdown();
});

test('shared audio status registers only tracks from the original owned attempt', async () => {
  const registered = [];
  let owned = false;
  const controller = {
    getCurrentCanvasId: () => 'c'.repeat(32),
    listAudioGenerations: async () => ({ generations: owned ? [{ attemptId, modelId: model, projectId: 'a'.repeat(32) }] : [] }),
  };
  const options = { canvasController: controller,
    mcp: { callTool: async () => ({ structuredContent: { attempt_id: attemptId, status: 'submitted', songs: [{ id: trackId }] } }) },
    registerMediaJob: async input => { registered.push(input); return { id: 'b'.repeat(32), remoteId: input.job.id, status: 'queued' }; },
  };
  assert.equal((await executeEaselTool('get_audio_generation_status', { model }, options)).awaitingMediaJob, undefined);
  assert.equal(registered.length, 0);
  owned = true;
  const execution = await executeEaselTool('get_audio_generation_status', { model }, options);
  assert.equal(execution.awaitingMediaJob.remoteId, trackId);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].projectId, 'a'.repeat(32));
  assert.equal(JSON.parse(execution.content).audio.monitored, true);
});

test('builtin downloads reuse pending and completed monitored audio rather than saving duplicate copies', async t => {
  for (const status of ['generating', 'ready', 'missing']) await t.test(status, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-managed-audio-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createMediaJobStore({ userDataPath: root });
    const saved = store.track({ job: { id: trackId, status: 'submitted' }, modelId: model, mediaType: 'audio', baseUrl: 'https://llm.test/v1', projectId: 'a'.repeat(32) });
    store.update(saved.id, { status: status === 'missing' ? 'ready' : status, assets: status !== 'generating' ? [{ assetId: 'b'.repeat(32), mimeType: 'audio/mp4' }] : [], attached: true });
    let calls = 0;
    let downloads = 0;
    const service = createChatService({ mediaJobStore: store,
      settingsStore: { loadPublic: () => ({ litellmModel: 'test', litellmBaseUrl: 'https://llm.test/v1' }), loadSecrets: () => ({}) },
      canvasController: { getCurrentCanvasId: () => 'a'.repeat(32) },
      mediaAssetStore: {
        async save() { assert.equal(status, 'missing'); return 'c'.repeat(32); },
        async get(id) { if (status === 'missing' && id === 'b'.repeat(32)) throw new Error('File deleted'); return {}; },
      },
      mcpLaunchOptions: () => ({ command: 'fake' }),
      mcpFactory: async () => ({ async close() {},
        listTools: async () => [{ name: 'download_audio', inputSchema: { type: 'object', properties: { model: { type: 'string' }, trackId: { type: 'string' } } } }],
        callTool: () => {
          assert.equal(status, 'missing'); downloads++;
          return { content: [{ type: 'resource', resource: { mimeType: 'audio/mp4', blob: m4a.toString('base64') } }], structuredContent: { track: { song_id: trackId, title: 'Pixel Haze' } } };
        },
      }),
      llmFactory: () => ({ async createCompletion({ messages }) {
        if (calls++ === 0) return { choices: [{ message: { role: 'assistant', tool_calls: [
          { id: 'download', type: 'function', function: { name: 'download_audio', arguments: JSON.stringify({ model, trackId }) } },
        ] } }] };
        const result = JSON.parse(messages.filter(message => message.role === 'tool').at(-1).content);
        assert.equal(result.audio.monitored, status === 'generating');
        if (status === 'ready') { assert.equal(result.cached, true); assert.equal(result.assets[0].assetId, 'b'.repeat(32)); }
        if (status === 'missing') assert.equal(result.assets[0].assetId, 'c'.repeat(32));
        return { choices: [{ message: { role: 'assistant', content: 'Tracked or already saved.' } }] };
      } }),
    });
    const result = await service.sendMessage('Download my song');
    assert.equal(result.ok, true); assert.equal(calls, 2);
    if (status === 'missing') { assert.equal(downloads, 1); assert.equal(store.get(saved.id).assets[0].assetId, 'c'.repeat(32)); }
    await service.shutdown();
  });
});

test('stopping builtin audio submission still registers captured tracks under the original chat and project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-monitored-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMediaJobStore({ userDataPath: root });
  let respond;
  let started;
  let projectId = 'a'.repeat(32);
  const submitted = new Promise(resolve => { started = resolve; });
  const service = createChatService({ mediaJobStore: store,
    settingsStore: { loadPublic: () => ({ litellmModel: 'test', litellmBaseUrl: 'https://llm.test/v1' }), loadSecrets: () => ({}) },
    canvasController: { getCurrentCanvasId: () => projectId },
    registerMediaJob: input => store.track({ ...input, baseUrl: 'https://llm.test/v1' }),
    mcpLaunchOptions: () => ({ command: 'fake' }),
    mcpFactory: async () => ({ async close() {},
      listTools: async () => [{ name: 'generate_music', inputSchema: { type: 'object', properties: { model: { type: 'string' }, prompt: { type: 'string' } } } }],
      callTool: () => { started(); return new Promise(resolve => { respond = resolve; }); },
    }),
    llmFactory: () => ({ createCompletion: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [
      { id: 'song', type: 'function', function: { name: 'generate_music', arguments: JSON.stringify({ model, prompt: 'chiptune' }) } },
    ] } }] }) }),
  });
  const turn = service.sendMessage('Generate a song'); await submitted;
  const originalChatId = service.getActiveChatId();
  service.stopAgent(); await turn;
  projectId = 'c'.repeat(32);
  respond({ structuredContent: { attempt_id: attemptId, status: 'submitted', songs: [{ id: trackId }] } });
  await new Promise(resolve => setImmediate(resolve));
  await service.shutdown();
  const job = store.list({ raw: true })[0];
  assert.equal(job.remoteId, trackId);
  assert.equal(job.mediaType, 'audio');
  assert.equal(job.projectId, 'a'.repeat(32));
  assert.equal(job.chatId, originalChatId);
  assert.equal(job.autoResume, false);
});

test('stopping the built-in agent keeps a receipt that a later turn can recover', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-stopped-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventStore = createControlEventStore({ userDataPath: root });
  const events = [];
  let respond;
  let started;
  let submissionSignal;
  let completion = 0;
  const submitted = new Promise(resolve => { started = resolve; });
  const service = createChatService({
    settingsStore: { loadPublic: () => ({ litellmModel: 'test', litellmBaseUrl: 'https://llm.test/v1' }), loadSecrets: () => ({}) },
    mcpLaunchOptions: () => ({ command: 'fake' }),
    mcpFactory: async ({ signal }) => ({
      async listTools() { return [{ name: 'generate_music', inputSchema: { type: 'object', properties: { model: { type: 'string' }, prompt: { type: 'string' } } } }]; },
      async callTool() {
        submissionSignal = signal;
        started(); return new Promise(resolve => { respond = resolve; });
      }, async close() {},
    }),
    canvasController: { getCurrentCanvasId: () => 'a'.repeat(32), listAudioGenerations: (_args, context) => eventStore.listAudioGenerations(context) },
    onEvent: event => { events.push(event); if (event.type === 'audio-generation') eventStore.append(event); },
    llmFactory: () => ({ async createCompletion({ messages }) {
      if (completion++ === 0) return { choices: [{ message: { role: 'assistant', tool_calls: [
        { id: 'song', type: 'function', function: { name: 'generate_music', arguments: JSON.stringify({ model, prompt: 'chiptune' }) } },
      ] } }] };
      if (completion === 2) return { choices: [{ message: { role: 'assistant', tool_calls: [
        { id: 'receipt', type: 'function', function: { name: 'list_audio_generations', arguments: '{}' } },
      ] } }] };
      const receipt = JSON.parse(messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(receipt.generations[0].attemptId, attemptId);
      return { choices: [{ message: { role: 'assistant', content: 'Recovered the original Suno attempt.' } }] };
    } }),
  });
  const turn = service.sendMessage('Generate a chiptune song');
  await submitted;
  service.stopAgent();
  assert.equal((await turn).cancelled, true);
  assert.equal(service.isSettling(), true);
  assert.equal(submissionSignal, undefined, 'Submission must outlive the turn abort signal.');
  respond({ content: [], structuredContent: { attempt_id: attemptId, status: 'submitted', songs: [] } });
  await service.shutdown();
  assert.equal(events.find(event => event.type === 'audio-generation').attemptId, attemptId);
  assert.equal(service.isSettling(), false);
  service.cancelShutdown();
  assert.equal((await service.sendMessage('Find my earlier song receipt')).text, 'Recovered the original Suno attempt.');
});

test('Studio routes Suno through real stdio, preserves receipts and delivers M4A once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-studio-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(request.method + ' ' + request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/audio/generations') {
      let body = ''; for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { model: 'suno-music', prompt: 'chiptune shoegaze' });
      response.statusCode = 202;
      response.end(JSON.stringify({ attempt_id: attemptId, status: 'submitted', songs: [] }));
    } else if (request.url === '/v1/audio/generations/status') {
      response.end(JSON.stringify({ attempt_id: attemptId, status: 'complete', songs: [{ id: trackId }] }));
    } else if (request.url === `/v1/audio/tracks/${trackId}`) {
      response.end(JSON.stringify({ id: trackId, title: 'Pixel Haze', status: 'complete', duration: 120 }));
    } else if (request.url === `/v1/audio/tracks/${trackId}/download`) {
      response.end(JSON.stringify({ song_id: trackId, status: 'complete', format: 'm4a' }));
    } else if (request.url === `/v1/audio/tracks/${trackId}/content?download=true`) {
      response.setHeader('content-type', 'audio/mp4'); response.end(m4a);
    } else { response.statusCode = 404; response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://easel.invalid:${server.address().port}`;
  const mcp = await createMediaMcpClient({ command: process.execPath, args: [path.resolve('packages/media-mcp/dist/cli.js')],
    env: { PATH: process.env.PATH, EASEL_BASE_URL: origin, EASEL_API_KEY: '', EASEL_PRIVATE_BASE_URL: origin,
      EASEL_PRIVATE_ADDRESS: '127.0.0.1', EASEL_MEDIA_MODELS: JSON.stringify([
        { id: model, model: 'suno-music', name: 'Suno', endpointName: 'Studio', baseUrl: origin, apiKey: '', mediaTypes: ['audio'] },
      ]) } });
  t.after(() => mcp.close());
  const store = createCanvasMediaStore({ userDataPath: root });
  const attached = [];
  const events = [];
  const steps = [
    ['generate_music', { model, prompt: 'chiptune shoegaze' }],
    ['get_audio_generation_status', { model }],
    ['download_audio', { model, trackId }],
    ['download_audio', { model, trackId }],
  ];
  let step = 0;
  const result = await runAgentTurn({ userMessage: 'Give me some chiptune shoegaze on Suno', mcp,
    mediaAssetStore: store,
    canvasController: { getCurrentCanvasId: () => 'a'.repeat(32), async attachGeneratedAssets(input) {
      attached.push(input); return { projectId: input.projectId };
    } },
    registerMediaJob() { assert.fail('A shared Suno attempt must not become an image/video queue job.'); },
    onEvent: event => events.push(event),
    llm: { async createCompletion({ tools }) {
      assert.ok(tools.some(tool => tool.function.name === 'generate_music'));
      const download = tools.find(tool => tool.function.name === 'download_audio');
      assert.equal(download.function.parameters.properties.outputDirectory, undefined);
      if (step === steps.length) return { choices: [{ message: { role: 'assistant', content: 'Your song is ready.' } }] };
      const [name, args] = steps[step++];
      return { choices: [{ message: { role: 'assistant', tool_calls: [
        { id: `call_${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ] } }] };
    } },
  });
  const outputs = result.history.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(outputs[0].audio.attempt_id, attemptId);
  assert.equal(outputs[0].audio.monitored, false);
  assert.match(outputs[0].guidance, /Without monitored track IDs/);
  assert.equal(outputs[1].audio.songs[0].id, trackId);
  assert.equal(outputs[2].audio.trackId, trackId);
  assert.equal(outputs[3].cached, true);
  assert.equal(attached.length, 1);
  const assets = await store.list(); assert.equal(assets.length, 1);
  assert.equal(assets[0].mimeType, 'audio/mp4');
  assert.equal(assets[0].name, 'Pixel Haze.m4a');
  assert.equal((await store.get(assets[0].id)).data, m4a.toString('base64'));
  assert.equal(events.filter(event => event.type === 'media' && event.attachedToProject).length, 1);
  assert.equal(producedMediaAssets(outputs[2], 'download_audio')[0].assetId, assets[0].id);
  assert.equal(JSON.stringify(result.history).includes(m4a.toString('base64')), false);
  assert.deepEqual(requests, ['POST /v1/audio/generations', 'GET /v1/audio/generations/status',
    `POST /v1/audio/tracks/${trackId}/download`, `GET /v1/audio/tracks/${trackId}/content?download=true`, `GET /v1/audio/tracks/${trackId}`]);

  const monitoredRoot = path.join(root, 'monitored');
  const jobStore = createMediaJobStore({ userDataPath: monitoredRoot });
  const monitoredMedia = createCanvasMediaStore({ userDataPath: monitoredRoot });
  const completions = [];
  const monitor = createMediaJobMonitor({ store: jobStore, mediaAssetStore: monitoredMedia,
    settingsStore: { loadPublic: () => ({ connections: [{ id: 'studio', baseUrl: origin }] }), loadSecrets: () => ({}) },
    mcpFactory: async () => ({ callTool: (...args) => mcp.callTool(...args), async close() {} }),
    onReady: job => completions.push(job),
    attachAssets: async (projectId, ids) => { assert.equal(projectId, 'a'.repeat(32)); assert.equal(ids.length, 1); },
  });
  const tracked = monitor.track({ job: { id: trackId, status: 'submitted' }, modelId: model, mediaType: 'audio', baseUrl: origin, projectId: 'a'.repeat(32) });
  monitor.start(); await monitor.stop();
  assert.equal(jobStore.get(tracked.id).status, 'ready');
  assert.equal(completions.length, 1);
  const monitoredAssets = await monitoredMedia.list();
  assert.equal(monitoredAssets[0].name, 'Pixel Haze.m4a');
  assert.equal(monitoredAssets[0].duration, 120);
  assert.deepEqual(requests.slice(5), [`GET /v1/audio/tracks/${trackId}`, `POST /v1/audio/tracks/${trackId}/download`, `GET /v1/audio/tracks/${trackId}/content?download=true`]);
});
