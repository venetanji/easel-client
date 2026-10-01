import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateImages, getImageJob } from '../src/easel.js';

const id = 'image_job_123';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

test('queued image receipts are preserved without expecting synchronous image bytes', async () => {
  const result = await generateImages({ prompt: 'A cat', model: 'qwen', fetchImpl: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('Prefer'), 'respond-async');
    return Response.json({ id, status: 'queued', queue_position: 1, estimated_wait_seconds: 20 }, { status: 202 });
  } });
  assert.equal(Array.isArray(result), false);
  if (!Array.isArray(result)) { assert.equal(result.job.id, id); assert.equal(result.job.estimatedWaitSeconds, 20); }
});

test('the proposed image job contract returns pending status or validated completed output', async () => {
  let complete = false;
  const options = { jobId: id, fetchImpl: async (url: string | URL) => {
    assert.ok(String(url).endsWith('/v1/images/jobs/' + id));
    return Response.json({ id, status: complete ? 'completed' : 'queued', ...(complete ? { data: [{ b64_json: png }] } : {}) });
  } };
  assert.equal((await getImageJob(options)).images, undefined);
  complete = true;
  const result = await getImageJob(options);
  assert.equal(result.images?.[0]?.mimeType, 'image/png');
  assert.equal(result.images?.[0]?.data, png);
});
