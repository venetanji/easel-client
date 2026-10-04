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
    assert.equal(form.has('size'), false);
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

test('sends explicit video dimensions without deriving them from the reference image', async () => {
  await generateVideo({ prompt: 'Animate this', model: 'ltx-2.5', size: '512x320', seconds: 2,
    inputReference: { data: png, mimeType: 'image/png' }, fetchImpl: async (_url, init) => {
      const form = init?.body as FormData;
      assert.equal(form.get('size'), '512x320');
      assert.equal(form.get('seconds'), '2');
      assert.equal((form.get('input_reference') as File).type, 'image/png');
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

test('serializes exact advanced controls without changing a uint64 seed', async () => {
  await generateVideo({ prompt: 'Camera study', model: 'ltx-2.5', cameraLora: 'dolly-in', cameraLoraStrength: 0,
    loras: [{ id: 'camera-static', strength: 0.5 }], seed: '18446744073709551614', fetchImpl: async (_url, init) => {
      const form = init?.body as FormData;
      assert.equal(form.get('camera_lora'), 'dolly-in');
      assert.equal(form.get('camera_lora_strength'), '0');
      assert.equal(form.get('seed'), '18446744073709551614');
      assert.deepEqual(JSON.parse(form.get('loras') as string), [{ id: 'camera-static', strength: 0.5 }]);
      return Response.json({ id, status: 'queued' });
    } });
});

test('serializes temporal guide metadata and bounded ordered image files', async () => {
  await generateVideo({ prompt: 'Move between anchors', model: 'ltx-2.5', seconds: 1,
    guidingFrames: [{ frameIndex: 0, image: { data: png, mimeType: 'image/png' } }, { frameIndex: 24, strength: 0, image: { data: png, mimeType: 'image/png' } }],
    fetchImpl: async (_url, init) => {
      const form = init?.body as FormData;
      assert.deepEqual(JSON.parse(form.get('guiding_frames') as string), [{ image_index: 0, frame_index: 0, strength: 1 }, { image_index: 1, frame_index: 24, strength: 0 }]);
      const images = form.getAll('guiding_images') as File[];
      assert.equal(images.length, 2);
      assert.deepEqual(Buffer.from(await images[1].arrayBuffer()), Buffer.from(png, 'base64'));
      assert.equal(form.has('input_reference'), false);
      return Response.json({ id, status: 'queued' });
    } });
});

test('serializes Ingredients and slow-motion requirements using their actual wire names', async () => {
  for (const options of [
    { seconds: 5, loras: [{ id: 'ingredients' }], loraReference: { data: png, mimeType: 'image/png' as const }, loraReferenceStrength: 0 },
    { loras: [{ id: 'slow-motion' }], inputReference: { data: png, mimeType: 'image/png' as const }, motionSpeed: 0.025 },
  ]) await generateVideo({ prompt: 'Reference study', model: 'ltx-2.5', ...options, fetchImpl: async (_url, init) => {
    const form = init?.body as FormData;
    if ('loraReference' in options) {
      assert.equal((form.get('lora_reference') as File).type, 'image/png');
      assert.equal(form.get('lora_reference_strength'), '0');
    } else assert.equal(form.get('motion_speed'), '0.025');
    return Response.json({ id, status: 'queued' });
  } });
});

test('rejects malformed advanced options and incompatible modes before any request', async () => {
  const image = { data: png, mimeType: 'image/png' };
  const guide = { image, frameIndex: 0 };
  const invalid = [
    { seed: 9007199254740992 }, { seed: '-1' }, { seed: '18446744073709551615' }, { seed: '01' },
    { cameraLora: 'orbit' }, { cameraLoraStrength: 1 }, { cameraLora: 'static', cameraLoraStrength: NaN },
    { cameraLora: 'static', loras: [{ id: 'camera-static' }] }, { loras: [{ id: 'camera-static', path: '/tmp/lora' }] },
    { loras: '[{"id":"camera-static"}]' }, { loras: [{ id: 'camera-static', strength: Infinity }] },
    { motionSpeed: 0.2 }, { loras: [{ id: 'slow-motion' }], inputReference: image },
    { loras: [{ id: 'cinemagraph' }] }, { loras: [{ id: 'cinemagraph' }], inputReference: image, cameraLora: 'dolly-in' },
    { loras: [{ id: 'ingredients' }], seconds: 4, loraReference: image }, { loraReference: image },
    { loras: [{ id: 'ingredients' }, { id: 'camera-static' }], seconds: 5, loraReference: image },
    { guidingFrames: [] }, { guidingFrames: [guide, guide] }, { guidingFrames: [{ ...guide, frameIndex: 25 }], seconds: 1 },
    { guidingFrames: [{ ...guide, frameIndex: 1.5 }] }, { guidingFrames: [{ ...guide, strength: NaN }] },
    { guidingFrames: [{ ...guide, url: 'https://example.test/image' }] }, { guidingFrames: [guide], inputReference: image },
    { guidingFrames: [guide], loras: [{ id: 'ingredients' }], seconds: 5, loraReference: image },
    { inputReference: { ...image, path: '/tmp/image' } }, { arbitrary: true },
  ];
  for (const options of invalid) await assert.rejects(generateVideo({ prompt: 'Invalid', model: 'ltx-2.5', ...options,
    fetchImpl: async () => assert.fail('Rejected input must not reach the API') } as any), (error: any) => {
      assert.equal(error.code, 'INVALID_TOOL_ARGUMENTS'); assert.equal(error.requestSent, false); return true;
    });
});

test('combined video image uploads share the 32 MiB budget', async () => {
  const bytes = Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(17 * 1024 * 1024)]);
  const image = { data: bytes.toString('base64'), mimeType: 'image/png' as const };
  await assert.rejects(generateVideo({ prompt: 'Too large', model: 'ltx-2.5', guidingFrames: [{ image, frameIndex: 0 }, { image, frameIndex: 24 }],
    fetchImpl: async () => assert.fail('Oversized input must not reach the API') }), /size limit|32 MiB/);
});

test('versioned curated IDs remain addressable while paths and URL-like identifiers are rejected', async () => {
  let submitted;
  await generateVideo({ prompt: 'Future curated adapter', model: 'ltx-2.5', loras: [{ id: 'ltx-2.3-relight' }], fetchImpl: async (_url, init) => {
    submitted = JSON.parse((init?.body as FormData).get('loras') as string); return Response.json({ id, status: 'queued' });
  } });
  assert.deepEqual(submitted, [{ id: 'ltx-2.3-relight' }]);
  for (const unsafe of ['../lora', 'ltx..adapter', 'https://example.test/lora', '/tmp/lora', '.hidden', 'id-', 'a'.repeat(129)]) {
    await assert.rejects(generateVideo({ prompt: 'Unsafe', model: 'ltx-2.5', loras: [{ id: unsafe }], fetchImpl: async () => assert.fail('Unsafe identifiers must not be submitted') }), (error: any) => error.code === 'INVALID_TOOL_ARGUMENTS');
  }
});
