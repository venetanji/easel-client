import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMediaServer } from '../src/server.js';
import { generateVideo } from '../src/video.js';
import { capabilities } from './fixtures/video-contract.js';
const require = createRequire(import.meta.url);
const { createMediaMcpClient } = require('../../../src/media-mcp-client.js');
const { createEaselToolHost } = require('../../../src/easel-tool-host.js');
const { createChatService } = require('../../../src/chat-service.js');
const audio = { data: Buffer.from('RIFF0000WAVE').toString('base64'), mimeType: 'audio/wav' };
const remoteId = 'a'.repeat(32);
const sourceAudioAssetId = 'b'.repeat(32);
const input = { model: 'ltx-2.5', prompt: 'motion', sourceAudio: audio };
const available = { ...capabilities, source_audio: { supported: true, available: true } };
function barrier() { return Promise.withResolvers<void>(); }

for (const entryPoint of ['external', 'desktop']) for (const stage of ['connect', 'preflight', 'post'] as const) {
  test(`${entryPoint} cancellation during ${stage} ${stage === 'post' ? 'retains accepted receipt' : 'prevents POST'}`, { timeout: 5000 }, async (t) => {
    const entered = barrier(); const release = barrier();
    const requests: string[] = []; const receipts: any[] = [];
    let activeClient: Client; let connections = 0;
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      requests.push(init!.method!);
      if (stage !== 'connect' && init!.method === (stage === 'preflight' ? 'GET' : 'POST')) { entered.resolve(); await release.promise; }
      return Response.json(init!.method === 'GET' ? available : { id: remoteId, status: 'queued' });
    };
    const options = {
      canvasController: { getCurrentCanvasId: () => 'c'.repeat(32) },
      assetStore: { get: async () => audio },
      registerMediaJob: async (receipt: any) => { if (!receipts.some(saved => saved.job.id === receipt.job.id)) receipts.push(receipt); return { id: 'local', ...receipt }; },
      createMediaClient: async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = createMediaServer({ easel: { listModels: async () => ['ltx-2.5'], generateImages: async () => [],
          generateVideo: (args) => generateVideo({ ...args, fetchImpl }) } });
        await server.connect(serverTransport);
        t.after(() => server.close());
        activeClient = new Client({ name: 'video-cancel-test', version: '1' });
        const client = await createMediaMcpClient({ command: 'unused', transportFactory: () => clientTransport, clientFactory: () => activeClient });
        if (++connections === 2 && stage === 'connect') { entered.resolve(); await release.promise; }
        return client;
      },
    };
    const host = entryPoint === 'external' ? createEaselToolHost(options) : createChatService({ ...options,
      settingsStore: { loadPublic: () => ({ litellmModel: 'agent' }), loadSecrets: () => ({}) },
      mcpFactory: options.createMediaClient, mcpLaunchOptions: () => ({}),
      llmFactory: () => ({ createCompletion: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [
        { id: 'submit', type: 'function', function: { name: 'generate_video', arguments: JSON.stringify({ model: input.model, prompt: input.prompt, sourceAudioAssetId }) } },
      ] } }] }) }),
    });
    t.after(() => { release.resolve(); return host.shutdown(); });
    if (entryPoint === 'external') await host.listTools();
    const abort = new AbortController();
    const pending = entryPoint === 'desktop' ? host.sendMessage('Animate this audio') : host.callTool('generate_video', { model: input.model, prompt: input.prompt, sourceAudioAssetId }, { signal: abort.signal });
    const canceled = entryPoint === 'desktop' ? pending.then((result: any) => assert.equal(result.cancelled, true)) : assert.rejects(pending, { name: 'AbortError' });
    await entered.promise;
    if (entryPoint === 'desktop') host.stopAgent(); else abort.abort();
    await canceled;
    // A round trip on the same real MCP transport places cancellation before release.
    await activeClient!.ping();
    release.resolve(); await host.shutdown();
    assert.deepEqual(requests, stage === 'connect' ? [] : stage === 'preflight' ? ['GET'] : ['GET', 'POST']);
    assert.equal(receipts.length, stage === 'post' ? 1 : 0);
    if (stage === 'post') assert.equal(receipts[0].job.id, remoteId);
  });
}

test('standalone video cancellation during delayed discovery prevents POST', async () => {
  const entered = barrier(); const release = barrier(); const abort = new AbortController(); const requests: string[] = [];
  const pending = generateVideo({ ...input, signal: abort.signal, fetchImpl: async (_url, init) => {
    requests.push(init!.method!); entered.resolve(); await release.promise;
    return Response.json(init!.method === 'GET' ? available : { id: remoteId, status: 'queued' });
  } });
  const canceled = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise; abort.abort(); release.resolve(); await canceled;
  assert.deepEqual(requests, ['GET']);
});

test('video submission retains receipt when cancellation follows POST dispatch', async () => {
  const entered = barrier(); const release = barrier(); const abort = new AbortController(); const requests: string[] = [];
  const pending = generateVideo({ ...input, signal: abort.signal, fetchImpl: async (_url, init) => {
    requests.push(init!.method!);
    if (init!.method === 'POST') { entered.resolve(); await release.promise; }
    return Response.json(init!.method === 'GET' ? available : { id: remoteId, status: 'queued' });
  } });
  await entered.promise; abort.abort(); release.resolve();
  assert.equal((await pending).id, remoteId);
  assert.deepEqual(requests, ['GET', 'POST']);
});

async function connectServer(t: any, fetchImpl: Parameters<typeof generateVideo>[0]['fetchImpl']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMediaServer({ easel: { listModels: async () => [], generateImages: async () => [],
    generateVideo: args => generateVideo({ ...args, fetchImpl }) } });
  await server.connect(serverTransport);
  const raw = new Client({ name: 'preflight-test', version: '1' });
  const client = await createMediaMcpClient({ command: 'unused', transportFactory: () => clientTransport, clientFactory: () => raw });
  t.after(async () => { await client.close(); await server.close(); });
  return { raw, client };
}

test('early cancellation notification is consumed before handler registration and remains token scoped', async (t) => {
  const requests: string[] = [];
  const { raw } = await connectServer(t, async (_url, init) => {
    requests.push(init!.method!);
    return Response.json(init!.method === 'GET' ? available : { id: remoteId, status: 'queued' });
  });
  const token = '11111111-1111-4111-8111-111111111111';
  await raw.notification({ method: 'notifications/easel/cancel-video-preflight', params: { token } });
  await raw.ping();
  const canceled = await raw.callTool({ name: 'generate_video', arguments: input, _meta: { 'easel/video-preflight-token': token } });
  assert.equal(canceled.isError, true);
  assert.deepEqual(requests, []);
  const accepted = await raw.callTool({ name: 'generate_video', arguments: input });
  assert.equal(accepted.isError, undefined);
  assert.deepEqual(requests, ['GET', 'POST']);
});

test('already stopped preflight never sends a video request', async (t) => {
  const { client } = await connectServer(t, async () => assert.fail('Stopped video must not reach HTTP'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.callTool('generate_video', input, { preflightSignal: abort.signal }), { name: 'AbortError' });
});

test('ambiguous POST transport failure submits once and never retries', async (t) => {
  const requests: string[] = [];
  const { client } = await connectServer(t, async (_url, init) => {
    requests.push(init!.method!);
    if (init!.method === 'POST') throw new Error('connection lost after dispatch');
    return Response.json(available);
  });
  const result = await client.callTool('generate_video', input, { preflightSignal: new AbortController().signal });
  assert.equal(result.isError, true);
  assert.deepEqual(requests, ['GET', 'POST']);
});

test('duplicate active tokens are rejected and removed after receipt delivery', async (t) => {
  const entered = barrier(); const release = barrier(); let posts = 0;
  const { raw } = await connectServer(t, async (_url, init) => {
    if (init!.method === 'GET') { entered.resolve(); await release.promise; return Response.json(available); }
    posts++; return Response.json({ id: remoteId, status: 'queued' });
  });
  t.after(() => release.resolve());
  const request = { name: 'generate_video', arguments: input, _meta: { 'easel/video-preflight-token': '22222222-2222-4222-8222-222222222222' } };
  const pending = raw.callTool(request);
  await entered.promise;
  const duplicate = await raw.callTool(request);
  assert.equal(duplicate.isError, true);
  assert.match(JSON.stringify(duplicate.content), /Duplicate video preflight token/);
  release.resolve(); assert.equal((await pending).isError, undefined);
  assert.equal(posts, 1);
  assert.equal((await raw.callTool(request)).isError, undefined);
  assert.equal(posts, 2);
});

test('bundled stdio server propagates Stop during the real HTTP capability GET', { timeout: 10000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { fileURLToPath } = await import('node:url');
  const entered = barrier(); const release = barrier(); const requests: string[] = [];
  const http = createServer(async (request, response) => {
    requests.push(request.method!);
    if (request.method === 'GET') { entered.resolve(); await release.promise; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.method === 'GET' ? available : { id: remoteId, status: 'queued' }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => { release.resolve(); http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const origin = `http://easel.invalid:${(http.address() as { port: number }).port}`;
  let raw: Client;
  const receipts: any[] = [];
  const host = createEaselToolHost({
    canvasController: { getCurrentCanvasId: () => 'c'.repeat(32) }, assetStore: { get: async () => audio },
    registerMediaJob: async (receipt: any) => { receipts.push(receipt); return receipt; },
    createMediaClient: () => createMediaMcpClient({
      command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
      env: { PATH: process.env.PATH, EASEL_BASE_URL: origin, EASEL_API_KEY: '', EASEL_PRIVATE_BASE_URL: origin,
        EASEL_PRIVATE_ADDRESS: '127.0.0.1', EASEL_MEDIA_MODELS: JSON.stringify([
          { id: 'ltx-2.5', model: 'ltx-2.5', name: 'Video', endpointName: 'Studio', baseUrl: origin, apiKey: '', mediaTypes: ['video'] },
        ]) },
      clientFactory: () => (raw = new Client({ name: 'stdio-cancel-test', version: '1' })),
    }),
  });
  t.after(() => { release.resolve(); return host.shutdown(); });
  await host.listTools();
  const abort = new AbortController();
  const pending = host.callTool('generate_video', { model: input.model, prompt: input.prompt, sourceAudioAssetId }, { signal: abort.signal });
  const canceled = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise; abort.abort(); await canceled;
  await raw!.ping(); release.resolve(); await host.shutdown();
  assert.deepEqual(requests, ['GET']);
  assert.equal(receipts.length, 0);
});
