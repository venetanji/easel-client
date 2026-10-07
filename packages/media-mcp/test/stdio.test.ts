import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('built stdio tools reach the private API and save requester files without exposing blobs or credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'easel-stdio-')); t.after(() => rm(root, { recursive: true, force: true }));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    paths.push(request.method + ' ' + request.url); assert.equal(request.headers.authorization, undefined);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'qwen-image-2.1' }, { id: 'suno-speech' }] })); return; }
    if (request.url === '/v1/audio/generations') {
      let body = ''; for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { model: 'suno-speech', prompt: 'Hello', dry_run: true });
      response.end(JSON.stringify({ status: 'captcha_required', attempt_id: '11111111-1111-4111-8111-111111111111' })); return;
    }
    if (request.url === '/v1/images/jobs/image_existing') {
      response.end(JSON.stringify({ id: 'image_existing', status: 'completed', data: [{ url: origin + '/v1/images/jobs/image_existing/content/0' }] })); return;
    }
    if (request.url?.endsWith('/content/0')) { response.setHeader('content-type', 'image/png'); response.end(Buffer.from(png, 'base64')); return; }
    response.statusCode = 404; response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = 'http://easel.invalid:' + (server.address() as { port: number }).port;
  const client = new Client({ name: 'stdio-parity-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    env: { PATH: process.env.PATH!, EASEL_BASE_URL: origin, EASEL_API_KEY: '', EASEL_PRIVATE_BASE_URL: origin,
      EASEL_PRIVATE_ADDRESS: '127.0.0.1', EASEL_MEDIA_OUTPUT_ROOTS: JSON.stringify([root]), HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {}); t.after(() => client.close()); await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 18);
  for (const name of ['generate_music', 'generate_speech', 'generate_sound', 'get_audio_generation_status', 'get_audio_track', 'download_audio', 'abandon_audio_generation', 'download_image']) {
    assert.ok(tools.tools.some(tool => tool.name === name));
  }
  const models = await client.callTool({ name: 'list_models', arguments: {} }); assert.equal(models.isError, undefined);
  const speech = await client.callTool({ name: 'generate_speech', arguments: { prompt: 'Hello', dryRun: true } }); assert.equal(speech.isError, undefined);
  const output = await client.callTool({ name: 'get_image_job', arguments: { jobId: 'image_existing', outputDirectory: join(root, 'media/outbound') } });
  assert.equal(output.isError, undefined); assert.deepEqual(output.content.map(item => item.type), ['text']);
  const files = output.structuredContent?.files as Array<{ path: string; sha256: string }>;
  assert.equal((await readFile(files[0]!.path)).toString('base64'), png); assert.equal(files[0]!.sha256.length, 64);
  assert.deepEqual(paths, ['GET /v1/models', 'POST /v1/audio/generations', 'GET /v1/images/jobs/image_existing', 'GET /v1/images/jobs/image_existing/content/0']);
});
