import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateVideo } from '../src/video.js';
import { generateImages, getImageJob } from '../src/easel.js';
import { requestBinary } from '../src/media-http.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image = { data: png, mimeType: 'image/png' as const };
test('H3 serializes native frames, exact uint64 seed and every reference mode without LTX fields', async () => {
  for (const mode of ['text', 'image', 'semantic', 'temporal']) {
    await generateVideo({ model: 'minimax-h3', prompt: 'shot', frames: 141, seed: '18446744073709551615',
      ...(mode === 'image' ? { inputReference: image } : mode === 'semantic' ? { semanticReferences: [image] }
        : mode === 'temporal' ? { semanticReferences: [image], temporalGroups: [{ frameIndex: 17, images: [image] }] } : {}),
      fetchImpl: async (_url, init) => {
        const form = init?.body as FormData;
        assert.equal(form.get('frames'), '141'); assert.equal(form.get('seed'), '18446744073709551615');
        assert.equal(form.has('seconds'), false); assert.equal(form.has('camera_lora'), false);
        if (mode === 'semantic' || mode === 'temporal') assert.deepEqual(JSON.parse(String(form.get('semantic_references'))), [{ image_index: 0 }]);
        if (mode === 'temporal') assert.deepEqual(JSON.parse(String(form.get('temporal_groups'))), [{ frame_index: 17, image_indices: [1] }]);
        return Response.json({ id: 'video_h3', status: 'queued', model: 'minimax-h3' });
      },
    });
  }
});
test('H3 rejects incompatible controls, off-grid frames, overlapping groups and invalid MIME before POST', async () => {
  let calls = 0;
  const defaults = { model: 'minimax-h3', prompt: 'shot', fetchImpl: async () => { calls++; return Response.json({}); } };
  for (const controls of [{ seconds: 4 }, { frames: 125 }, { loras: [] }, { inputReference: image, semanticReferences: [image] },
    { temporalGroups: [{ frameIndex: 10, images: Array(5).fill(image) }, { frameIndex: 12, images: [image] }] },
    { temporalGroups: [{ frameIndex: 123, images: Array(5).fill(image) }] },
    { temporalGroups: [{ frameIndex: 0, images: [image, image] }] }]) await assert.rejects(generateVideo({ ...defaults, ...controls }));
  await assert.rejects(generateVideo({ ...defaults, model: 'ltx-2.5', frames: 124 }));
  assert.equal(calls, 0);
});
test('image generation carries controls and URL retrieval stays on the authenticated origin', async () => {
  let downloads = 0;
  const result = await generateImages({ prompt: 'shot', model: 'qwen-image-2.1', steps: 8, seed: '18446744073709551615',
    server: 'image', responseFormat: 'url', apiKey: 'private-key', baseUrl: 'https://easel.test',
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), { prompt: 'shot', n: 1, model: 'qwen-image-2.1', steps: 8,
          seed: '18446744073709551615', server: 'image', response_format: 'url' });
        return Response.json({ data: [{ url: '/v1/images/jobs/image_one/content/0' }] });
      }
      downloads++; assert.equal(String(url), 'https://easel.test/v1/images/jobs/image_one/content/0');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-key'); assert.equal(init?.redirect, 'error');
      return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } });
    } });
  assert.ok(Array.isArray(result)); assert.equal(result[0]!.data, png); assert.equal(downloads, 1);
  let requests = 0;
  await assert.rejects(getImageJob({ jobId: 'image_one', baseUrl: 'https://easel.test', apiKey: 'private-key', fetchImpl: async () => {
    requests++; return Response.json({ id: 'image_one', status: 'completed', data: [{ url: 'https://evil.test/image.png' }] });
  } }), /origin/);
  assert.equal(requests, 1);
});
test('binary downloads reject oversized, truncated and empty output', async () => {
  for (const [body, length] of [['abc', '100'], ['abc', '4'], ['', '0']]) {
    await assert.rejects(requestBinary('https://easel.test/content', {}, '', async () => new Response(body, { headers: { 'content-length': length! } }),
      8, { label: 'Download', path: '/content' }), /limit|truncated|empty/);
  }
});
