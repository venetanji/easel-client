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

test('advanced video schemas expose only saved references and strict guide metadata', () => {
  const schema = mediaToolSchema({ name: 'generate_video', inputSchema: { type: 'object', required: ['model', 'prompt'], additionalProperties: false, properties: {
    model: { type: 'string' }, prompt: { type: 'string' }, inputReference: { type: 'object' }, loraReference: { type: 'object' },
    guidingFrames: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['image', 'frameIndex'], properties: { image: { type: 'object' }, frameIndex: { type: 'integer', minimum: 0, maximum: 288 }, strength: { type: 'number', minimum: 0, maximum: 1 } } } },
  } } });
  assert.equal(schema.properties.loraReference, undefined);
  assert.equal(schema.properties.loraReferenceAssetId.pattern.includes('0+'), true);
  assert.equal(schema.properties.guidingFrames.items.properties.image, undefined);
  assert.equal(schema.properties.guidingFrames.items.properties.assetId.pattern.includes('0+'), true);
  assert.deepEqual(schema.properties.guidingFrames.items.required, ['frameIndex', 'assetId']);
  assert.equal(schema.properties.guidingFrames.items.additionalProperties, false);
  assert.equal(schema.properties.guidingFrames.maxItems, 8);
});

test('guide and Ingredients references use the shared project resolver without leaking IDs on the wire', async () => {
  const assetId = 'c'.repeat(64), projectId = 'a'.repeat(32), references = [];
  const read = async reference => { references.push(reference); return { data: 'YWJj', mimeType: 'image/png' }; };
  const guided = await resolveMediaToolArguments('generate_video', { model: 'video', prompt: 'Guide', projectId, seed: '18446744073709551614', guidingFrames: [{ assetId, frameIndex: 24, strength: 0 }] }, read);
  assert.deepEqual(references, [{ assetId, projectId }]);
  assert.equal(guided.projectId, undefined); assert.equal(guided.guidingFrames[0].assetId, undefined);
  assert.deepEqual(guided.guidingFrames, [{ image: { data: 'YWJj', mimeType: 'image/png', name: assetId + '.png' }, frameIndex: 24, strength: 0 }]);
  assert.equal(guided.seed, '18446744073709551614');
  const ingredients = await resolveMediaToolArguments('generate_video', { model: 'video', loras: [{ id: 'ingredients' }], loraReferenceAssetId: assetId, loraReferenceStrength: 0 }, read);
  assert.equal(ingredients.loraReferenceAssetId, undefined); assert.equal(ingredients.loraReference.data, 'YWJj');
  assert.equal(ingredients.loraReferenceStrength, 0);
});

test('invalid guide metadata is rejected locally without resolving assets', async () => {
  const assetId = 'c'.repeat(32);
  for (const guidingFrames of [[], [{ assetId, frameIndex: -1 }], [{ assetId, frameIndex: 25 }], [{ assetId, frameIndex: 0, image: {} }], [{ assetId, frameIndex: 0, strength: Infinity }], [{ assetId, frameIndex: 0 }, { assetId, frameIndex: 0 }]]) {
    await assert.rejects(resolveMediaToolArguments('generate_video', { seconds: 1, guidingFrames }, () => assert.fail('Invalid guide must not read assets')), error => error.requestSent === false);
  }
});

test('guide asset failures preserve required conditioning rather than suggesting text-only fallback', async () => {
  await assert.rejects(resolveMediaToolArguments('generate_video', { guidingFrames: [{ assetId: 'd'.repeat(32), frameIndex: 0 }] }, async () => { throw new Error('Not found'); }), error => {
    assert.equal(error.code, 'INVALID_MEDIA_REFERENCE'); assert.equal(error.requestSent, false);
    assert.match(error.message, /guidingFrames/); assert.doesNotMatch(error.message, /omit inputReferenceAssetId/); return true;
  });
});

test('all in-app reference types share the 32 MiB bound and preserve aborts', async () => {
  const data = Buffer.alloc(17 * 1024 * 1024).toString('base64'), assetId = 'e'.repeat(32);
  await assert.rejects(resolveMediaToolArguments('generate_video', { guidingFrames: [{ assetId, frameIndex: 0 }, { assetId, frameIndex: 24 }] }, async () => ({ data, mimeType: 'image/png' })), /32 MiB combined/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveMediaToolArguments('generate_video', { guidingFrames: [{ assetId, frameIndex: 0 }] }, () => assert.fail('Aborted reads must not run'), controller.signal), { name: 'AbortError' });
});
