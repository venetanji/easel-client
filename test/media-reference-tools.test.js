const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaToolSchema, resolveMediaToolArguments } = require('../src/media-reference-tools');

test('video references are optional and nullable, without placeholder IDs', () => {
  const schema = mediaToolSchema({ name: 'generate_video', inputSchema: {
    type: 'object', required: ['model', 'prompt'], properties: { model: { type: 'string' }, prompt: { type: 'string' }, inputReference: { type: 'object' } },
  } });
  assert.deepEqual(schema.required, ['model', 'prompt']);
  assert.equal(schema.properties.inputReference, undefined);
  assert.deepEqual(schema.properties.inputReferenceAssetId.type, ['string', 'null']);
  assert.match(schema.properties.inputReferenceAssetId.description, /OMIT.*null/);
  const pattern = new RegExp(schema.properties.inputReferenceAssetId.pattern);
  assert.equal(pattern.test('0'.repeat(32)), false);
  assert.equal(pattern.test('a'.repeat(32)), true);
});

test('text-only video omits both absent and null reference uploads', async () => {
  for (const optional of [{}, { inputReferenceAssetId: null, projectId: null }]) {
    const args = await resolveMediaToolArguments('generate_video', { model: 'video-model', prompt: 'A cat', ...optional }, () => assert.fail('Text-only generation must not read an asset.'));
    assert.deepEqual(args, { model: 'video-model', prompt: 'A cat' });
  }
});

test('video reference IDs resolve to upload bytes with an optional project', async () => {
  const id = 'a'.repeat(32);
  const args = await resolveMediaToolArguments('generate_video', { model: 'video-model', prompt: 'Move this image', inputReferenceAssetId: id, projectId: null }, async (reference) => {
    assert.deepEqual(reference, { assetId: id, projectId: undefined });
    return { data: 'YWJj', mimeType: 'image/png' };
  });
  assert.deepEqual(args, { model: 'video-model', prompt: 'Move this image', inputReference: { data: 'YWJj', mimeType: 'image/png', name: id + '.png' } });
});

test('missing video references identify the local failure and a correction', async () => {
  await assert.rejects(resolveMediaToolArguments('generate_video', { inputReferenceAssetId: 'b'.repeat(32) }, async () => { throw new Error('Asset was not found.'); }), (error) => {
    assert.equal(error.code, 'INVALID_MEDIA_REFERENCE');
    assert.equal(error.stage, 'reference_resolution');
    assert.equal(error.requestSent, false);
    assert.match(error.message, /API was not called/);
    assert.match(error.message, /omit inputReferenceAssetId/);
    return true;
  });
});
