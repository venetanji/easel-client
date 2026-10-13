const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaToolSchema, resolveMediaToolArguments } = require('../src/media-reference-tools');
const capabilities = require('./fixtures/h3/capabilities.json');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const ids = ['a', 'b', 'c', 'd', 'e'].map(letter => letter.repeat(32));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const read = async () => ({ data: png, mimeType: 'image/png' });
const input = () => ({ model: 'configured:minimax-h3', prompt: 'continuous motion',
  semanticReferenceAssetIds: [ids[0]], temporalGroups: [{ frameIndex: 0, imageAssetIds: ids }] });
const discover = async () => capabilities;

test('desktop H3 schemas replace all raw images with ordered saved IDs', () => {
  const schema = mediaToolSchema({ name: 'generate_video', inputSchema: { properties: {
    semanticReferences: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object' } },
    temporalGroups: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', required: ['frameIndex', 'images'], properties: {
      frameIndex: { type: 'integer', minimum: 0 }, images: { type: 'array', minItems: 1, maxItems: 39, items: { type: 'object' } },
    } } },
  } } });
  assert.equal(schema.properties.semanticReferences, undefined);
  assert.ok(schema.properties.semanticReferenceAssetIds.items.pattern);
  const group = schema.properties.temporalGroups.items;
  assert.equal(group.properties.images, undefined);
  assert.deepEqual(group.required, ['frameIndex', 'imageAssetIds']);
  assert.ok(group.properties.imageAssetIds.items.pattern);
  assert.equal(group.additionalProperties, false);
});

test('H3 managed frames serialize ordered multipart indices with separate semantic uploads', async () => {
  const calls = [], projectId = 'f'.repeat(32);
  const wire = await resolveMediaToolArguments('generate_video', { ...input(), projectId }, async reference => {
    calls.push(reference); return read();
  }, undefined, async model => { assert.equal(model, input().model); return capabilities; });
  assert.deepEqual(calls.map(ref => ref.assetId), [ids[0], ...ids]);
  assert.ok(calls.every(ref => ref.projectId === projectId));
  assert.equal(wire.frames, capabilities.frames.default);
  assert.equal(wire.projectId, undefined);
  assert.equal(wire.semanticReferenceAssetIds, undefined);
  assert.equal(wire.temporalGroups[0].imageAssetIds, undefined);
  const { generateVideo } = await import(pathToFileURL(path.join(__dirname, '../packages/media-mcp/dist/video.js')));
  let posts = 0;
  const job = await generateVideo({ ...wire, model: 'minimax-h3', fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'POST'); posts++;
    const form = options.body;
    assert.equal(form.get('frames'), '124'); assert.equal(form.has('seconds'), false);
    assert.equal(form.has('input_reference'), false);
    assert.deepEqual(JSON.parse(form.get('semantic_references')), [{ image_index: 0 }]);
    assert.deepEqual(JSON.parse(form.get('temporal_groups')), [{ frame_index: 0, image_indices: [1, 2, 3, 4, 5] }]);
    const images = form.getAll('images'); assert.equal(images.length, 6);
    assert.deepEqual(images.map(image => image.name), [ids[0], ...ids].map(id => `${id}.png`));
    for (const image of images) assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), png);
    return Response.json({ id: 'video_accepted', status: 'queued', model: 'minimax-h3' });
  } });
  assert.equal(posts, 1); assert.equal(job.id, 'video_accepted');
});

test('H3 adapter uses discovered counts and frame grid rather than its own policy', async () => {
  const custom = structuredClone(capabilities);
  custom.frames = { min: 141, max: 158, default: 141, step: 17, offset: 5 };
  custom.temporal_groups.image_counts = [1];
  custom.temporal_groups.max_count = 1;
  custom.semantic_references.max_count = 1;
  const options = { model: 'endpoint:model', prompt: 'motion', temporalGroups: [{ frameIndex: 140, imageAssetIds: [ids[0]] }] };
  const wire = await resolveMediaToolArguments('generate_video', options, read, undefined, async () => custom);
  assert.equal(wire.frames, 141);
  for (const bad of [input(), { ...options, frames: 124 }, { ...options, frames: 142 },
    { ...options, temporalGroups: [...options.temporalGroups, { frameIndex: 0, imageAssetIds: [ids[1]] }] },
    { ...options, semanticReferenceAssetIds: ids.slice(0, 2) }]) {
    await assert.rejects(resolveMediaToolArguments('generate_video', bad, () => assert.fail('invalid references must not read assets'), undefined, async () => custom), error => error.requestSent === false);
  }
});

test('H3 malformed, conflicting and overlapping references fail before resolving assets', async () => {
  const badInputs = [
    { temporalGroups: [] }, { semanticReferenceAssetIds: [] }, { semanticReferences: [{ data: png }] },
    { temporalGroups: [{ frameIndex: 0, images: [{ data: png, mimeType: 'image/png' }] }] },
    { temporalGroups: [{ frameIndex: 0, imageAssetIds: ['not-an-id'] }] },
    { temporalGroups: [{ frameIndex: 0, imageAssetIds: [ids[0]], strength: 1 }] },
    { ...input(), seconds: 4 }, { ...input(), inputReferenceAssetId: ids[0] },
    { ...input(), guidingFrames: [{ assetId: ids[0], frameIndex: 0 }] },
    { ...input(), temporalGroups: [{ frameIndex: 123, imageAssetIds: ids }] },
    { ...input(), temporalGroups: [{ frameIndex: 0, imageAssetIds: ids }, { frameIndex: 4, imageAssetIds: [ids[1]] }] },
  ];
  for (const bad of badInputs) await assert.rejects(resolveMediaToolArguments('generate_video',
    { model: 'endpoint:minimax-h3', ...bad }, () => assert.fail('no asset reads'), undefined, discover), error => error.requestSent === false);
});

test('H3 missing capabilities and unavailable profiles never drop conditioning', async () => {
  const unavailable = structuredClone(capabilities); unavailable.profiles.temporal_ref20.available = false;
  for (const caps of [undefined, {}, { ...capabilities, model: 'ltx-2.5' }, unavailable]) {
    await assert.rejects(resolveMediaToolArguments('generate_video', input(), () => assert.fail('no asset reads'), undefined, async () => caps), error => {
      assert.equal(error.requestSent, false); assert.match(error.message, /preserve|keep/i);
      assert.doesNotMatch(error.message, /text-only|omit inputReferenceAssetId/); return true;
    });
  }
});

test('H3 MIME, permission and discovered byte limits preserve all requested references', async () => {
  const small = structuredClone(capabilities); small.uploads.max_total_bytes = 1;
  for (const [reader, caps] of [[async () => ({ data: png, mimeType: 'image/webp' }), capabilities],
    [async () => { throw new Error('not permitted'); }, capabilities], [read, small]]) {
    await assert.rejects(resolveMediaToolArguments('generate_video', input(), reader, undefined, async () => caps), error => {
      assert.equal(error.requestSent, false); assert.match(error.message, /preserve|keep/i); return true;
    });
  }
});

test('H3 cancellation during capability discovery or asset reading stops before submission', async () => {
  for (const stage of ['discovery', 'assets']) {
    const controller = new AbortController(); let reads = 0;
    await assert.rejects(resolveMediaToolArguments('generate_video', input(), async () => {
      reads++; controller.abort(); return read();
    }, controller.signal, async () => {
      if (stage === 'discovery') controller.abort(); return capabilities;
    }), { name: 'AbortError' });
    assert.equal(reads, stage === 'discovery' ? 0 : 1);
  }
});

test('shared agent routes H3 discovery to the exact endpoint before resolving saved assets', async () => {
  const { runAgentTurn } = require('../src/agent');
  for (const mismatch of [false, true]) {
    let turns = 0;
    const events = [];
    await runAgentTurn({ userMessage: 'Generate with saved H3 guides',
      llm: { async createCompletion({ messages }) { if (turns && mismatch) { const failure = JSON.parse(messages.at(-1).content); assert.match(failure.correction, /Preserve temporalGroups/); assert.doesNotMatch(failure.correction, /text-only/); } return { choices: [{ message: turns++ === 0
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'h3', type: 'function', function: { name: 'generate_video', arguments: JSON.stringify(input()) } }] }
        : { role: 'assistant', content: 'Done.' } }] }; } },
      mcp: { async listTools() { return [{ name: 'generate_video', inputSchema: { type: 'object', properties: {
        model: { type: 'string' }, prompt: { type: 'string' },
        semanticReferences: { type: 'array', items: { type: 'object' } },
        temporalGroups: { type: 'array', items: { type: 'object', required: ['frameIndex', 'images'], properties: { frameIndex: { type: 'integer' }, images: { type: 'array' } } } },
      } } }]; }, async callTool(name, args) {
        events.push(name); assert.equal(args.model, input().model);
        if (name === 'discover_video_capabilities') return { content: [], structuredContent: { modelId: mismatch ? 'other:model' : input().model, capabilities } };
        assert.equal(name, 'generate_video'); assert.equal(args.temporalGroups[0].images.length, 5);
        assert.equal(args.semanticReferences.length, 1);
        return { content: [], structuredContent: { job: { id: 'h3_accepted', status: 'queued' } } };
      } },
      canvasController: { async readMediaAsset() { events.push('read'); return read(); } },
    });
    assert.deepEqual(events, mismatch ? ['discover_video_capabilities'] : ['discover_video_capabilities', ...Array(6).fill('read'), 'generate_video']);
  }
});

test('H3 saved audio remains independent of semantic and temporal references', async () => {
  const audioId = 'f'.repeat(32);
  const wire = await resolveMediaToolArguments('generate_video', { ...input(), sourceAudioAssetId: audioId },
    async ({ assetId }) => assetId === audioId ? { data: 'YWJj', mimeType: 'audio/wav' } : read(), undefined, discover);
  assert.equal(wire.sourceAudio.data, 'YWJj');
  assert.equal(wire.semanticReferences.length, 1);
  assert.equal(wire.temporalGroups[0].images.length, 5);
  assert.equal(wire.seconds, undefined);
});

function preflightFailure(pattern) {
  return error => {
    assert.equal(error.code, 'INVALID_MEDIA_REFERENCE');
    assert.equal(error.requestSent, false);
    assert.match(error.message, pattern);
    return true;
  };
}

test('H3 enforces discovered preset ceilings including aliases and the default before asset reads', async () => {
  for (const [size, maximum] of [['1024x1024', 141], ['1280x720', 175], ['720x1280', 175]]) {
    const options = { ...input(), size, frames: maximum };
    const accepted = await resolveMediaToolArguments('generate_video', options, read, undefined, discover);
    assert.equal(accepted.frames, maximum);
    await assert.rejects(resolveMediaToolArguments('generate_video', { ...options, frames: maximum + 17 },
      () => assert.fail('no asset reads'), undefined, discover), preflightFailure(/size.*frame|frame.*size/i));
  }
  const caps = structuredClone(capabilities);
  caps.default_size = '1024x1024';
  caps.frames.default = 158;
  await assert.rejects(resolveMediaToolArguments('generate_video', input(), () => assert.fail('no asset reads'),
    undefined, async () => caps), preflightFailure(/size.*frame|frame.*size/i));
  // An alias need not also have its own preset entry.
  caps.size_presets = caps.size_presets.filter(preset => !Object.hasOwn(caps.size_constraints.aliases, preset.size));
  await assert.rejects(resolveMediaToolArguments('generate_video', { ...input(), size: '1280x720', frames: 192 },
    () => assert.fail('no asset reads'), undefined, async () => caps), preflightFailure(/size.*frame|frame.*size/i));
});

test('H3 custom sizes obey discovered dimensions and pixel-frame budgets', async () => {
  const caps = structuredClone(capabilities);
  caps.size_constraints.max_pixel_frames = 800 * 800 * 141;
  const options = { ...input(), size: '800x800', frames: 141 };
  const accepted = await resolveMediaToolArguments('generate_video', options, read, undefined, async () => caps);
  assert.equal(accepted.size, '800x800');
  for (const bad of [{ frames: 158 }, { size: '801x800' }, { size: '224x800' }, { size: '2080x800' }, { size: '2048x2048' }]) {
    await assert.rejects(resolveMediaToolArguments('generate_video', { ...options, ...bad },
      () => assert.fail('no asset reads'), undefined, async () => caps), preflightFailure(/size|pixel/i));
  }
  caps.size_constraints.custom_sizes = false;
  await assert.rejects(resolveMediaToolArguments('generate_video', options, () => assert.fail('no asset reads'),
    undefined, async () => caps), preflightFailure(/size/i));
});

const pixelFixtures = [{ mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAC0lEQVR4nGNgwAIAABUAAapll8QAAAAASUVORK5CYII=' },
{ mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==' }];

test('H3 checks actual PNG/JPEG pixels against discovered per-image limits', async () => {
  for (const asset of pixelFixtures) {
    const caps = structuredClone(capabilities);
    caps.uploads.max_image_pixels = 6;
    const options = { ...input(), temporalGroups: undefined };
    const reader = async () => ({ ...asset, width: 1, height: 1 }); // Stale metadata cannot bypass byte dimensions.
    const wire = await resolveMediaToolArguments('generate_video', options, reader, undefined, async () => caps);
    assert.equal(wire.semanticReferences[0].data, asset.data);
    caps.uploads.max_image_pixels = 5;
    await assert.rejects(resolveMediaToolArguments('generate_video', options, reader, undefined, async () => caps),
      preflightFailure(/image.*pixel/i));
  }
});

test('H3 aggregate pixels count every semantic and temporal upload, including duplicate IDs', async () => {
  for (const asset of pixelFixtures) {
    const caps = structuredClone(capabilities);
    caps.uploads.max_total_pixels = 36; // One semantic plus five temporal copies, six pixels each.
    const wire = await resolveMediaToolArguments('generate_video', input(), async () => asset, undefined, async () => caps);
    assert.equal(wire.temporalGroups[0].images.length, 5);
    caps.uploads.max_total_pixels = 35;
    await assert.rejects(resolveMediaToolArguments('generate_video', input(), async () => asset, undefined, async () => caps),
      preflightFailure(/combined.*pixel|total.*pixel/i));
  }
});

test('H3 unknown image geometry fails closed without trusting saved dimensions', async () => {
  for (const mimeType of ['image/png', 'image/jpeg']) {
    await assert.rejects(resolveMediaToolArguments('generate_video', input(), async () => ({
      mimeType, data: 'YWJj', width: 1, height: 1,
    }), undefined, discover), preflightFailure(/dimension/i));
  }
});

test('H3 missing or invalid discovered pixel budgets fail before asset reads', async () => {
  for (const field of ['max_image_pixels', 'max_total_pixels']) for (const value of [undefined, 0, -1, 1.5]) {
    const caps = structuredClone(capabilities); caps.uploads[field] = value;
    await assert.rejects(resolveMediaToolArguments('generate_video', input(), () => assert.fail('no asset reads'),
      undefined, async () => caps), preflightFailure(/contract/i));
  }
});
