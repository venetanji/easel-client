import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateVideo, getVideo, MAX_VIDEO_BYTES } from '../src/video.js';

const id = 'video_test-123';
const mp4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

test('submits text-only video with multipart fields and no reference file', async () => {
  const job = await generateVideo({ prompt: ' A cat ', model: 'ltx-2.5', baseUrl: 'https://media.example/v1', apiKey: 'secret', fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://media.example/v1/videos');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer secret');
    const form = init?.body as FormData;
    assert.equal(form.get('prompt'), 'A cat');
    assert.equal(form.get('seconds'), '4');
    assert.equal(form.get('size'), '1280x720');
    assert.equal(form.has('input_reference'), false);
    return Response.json({ id, status: 'queued', progress: 0 });
  } });
  assert.deepEqual(job, { id, status: 'queued', providerStatus: 'queued', progress: 0 });
});

test('uploads a validated image reference using the endpoint field name', async () => {
  await generateVideo({ prompt: 'Animate this', model: 'ltx-2.5', inputReference: { data: png, mimeType: 'image/png' }, fetchImpl: async (_url, init) => {
    const reference = (init?.body as FormData).get('input_reference') as File;
    assert.equal(reference.type, 'image/png');
    assert.deepEqual(Buffer.from(await reference.arrayBuffer()), Buffer.from(png, 'base64'));
    return Response.json({ id, status: 'queued' });
  } });
});

test('a pending job returns its status without downloading or resubmitting', async () => {
  let requests = 0;
  const result = await getVideo({ videoId: id, fetchImpl: async (_url, init) => {
    requests += 1;
    assert.equal(init?.method, 'GET');
    return Response.json({ id, status: 'in_progress', progress: 42 });
  } });
  assert.equal(requests, 1);
  assert.equal(result.job.progress, 42);
  assert.equal(result.media, undefined);
});

test('optional Easel queue diagnostics include position and completion estimate', async () => {
  const urls: string[] = [];
  const result = await getVideo({ videoId: id, includeQueue: true, fetchImpl: async (url) => {
    urls.push(String(url));
    return urls.length === 1 ? Response.json({ id, status: 'queued' }) : Response.json({ id, queue_position: 2, queue_ahead: 2, estimated_wait_seconds: 72, estimated_completion_at: 1790000072 });
  } });
  assert.equal(urls.length, 2);
  assert.ok(urls[1].endsWith('/v1/videos/queue/' + id));
  assert.equal(result.job.queuePosition, 2);
  assert.equal(result.job.estimatedWaitSeconds, 72);
});

test('an endpoint without queue diagnostics still returns its ordinary job status', async () => {
  const result = await getVideo({ videoId: id, includeQueue: true, fetchImpl: async (url) => String(url).includes('/queue/') ? Response.json({}, { status: 404 }) : Response.json({ id, status: 'queued' }) });
  assert.equal(result.job.status, 'queued');
  assert.equal(result.job.estimatedWaitSeconds, undefined);
});

test('submits one and twelve second durations without adjustment', async () => {
  for (const seconds of [1, 12]) await generateVideo({ prompt: 'A cat', model: 'ltx-2.5', seconds, fetchImpl: async (_url, init) => {
    assert.equal((init?.body as FormData).get('seconds'), String(seconds));
    return Response.json({ id, status: 'queued' });
  } });
});

test('completed video downloads validated bytes from the configured endpoint', async () => {
  const urls: string[] = [];
  const result = await getVideo({ videoId: id, baseUrl: 'https://media.example/v1', fetchImpl: async (url, init) => {
    urls.push(String(url));
    assert.equal(init?.redirect, 'error');
    return urls.length === 1 ? Response.json({ id, status: 'completed' }) : new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
  } });
  assert.deepEqual(urls, ['https://media.example/v1/videos/' + id, 'https://media.example/v1/videos/' + id + '/content']);
  assert.deepEqual(result.media, { data: mp4.toString('base64'), mimeType: 'video/mp4' });
});

test('status-only retrieval never downloads a completed result', async () => {
  let requests = 0;
  const result = await getVideo({ videoId: id, download: false, fetchImpl: async () => { requests += 1; return Response.json({ id, status: 'completed' }); } });
  assert.equal(requests, 1);
  assert.equal(result.media, undefined);
});

test('rejects oversized content and mismatched job IDs', async () => {
  await assert.rejects(getVideo({ videoId: id, fetchImpl: async (url) => String(url).endsWith('/content')
    ? new Response(mp4, { headers: { 'Content-Length': String(MAX_VIDEO_BYTES + 1), 'Content-Type': 'video/mp4' } })
    : Response.json({ id, status: 'completed' }) }), /32 MiB/);
  await assert.rejects(getVideo({ videoId: id, fetchImpl: async () => Response.json({ id: 'another-job', status: 'completed' }) }), /mismatched job/);
});

test('duration rejection is actionable and secrets are redacted without retrying', async () => {
  let requests = 0;
  await assert.rejects(generateVideo({ prompt: 'A cat', model: 'ltx-2.5', seconds: 3, apiKey: 'hidden-key', fetchImpl: async () => {
    requests += 1;
    return Response.json({ detail: 'seconds must be 4, 8, or 12 hidden-key' }, { status: 400 });
  } }), (error: Error) => /seconds must be 4, 8, or 12/.test(error.message) && !error.message.includes('hidden-key'));
  assert.equal(requests, 1);
});
