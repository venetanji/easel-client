const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOptions, checkReceipt, redact, validateResume } = require('../scripts/test-live-video-workflow.cjs');

test('live workflow defaults to help and never opts into spending implicitly', () => {
  assert.equal(parseOptions([]).mode, 'help');
  assert.throws(() => parseOptions(['--live']), /allow-generation-cost/);
  assert.throws(() => parseOptions(['--allow-generation-cost']), /mode/);
  assert.throws(() => parseOptions(['--live', '--allow-generation-cost', '--offline']), /one mode/);
  assert.throws(() => parseOptions(['--live', '--allow-generation-cost', '--jobs', '4']), /Unknown/);
  assert.deepEqual(parseOptions(['--live', '--allow-generation-cost']), { mode: 'live', timeoutSeconds: 1200 });
});

test('read-only probe and resume do not require or grant generation authorization', () => {
  assert.equal(parseOptions(['--probe']).mode, 'probe');
  assert.equal(parseOptions(['--resume', '/tmp/saved']).mode, 'resume');
  assert.throws(() => parseOptions(['--resume', '/tmp/saved', '--allow-generation-cost']), /only.*live/);
  for (const value of ['0', '29', '3601', 'NaN', '1.5']) assert.throws(() => parseOptions(['--probe', '--timeout-seconds', value]), /timeout/);
});

test('receipts must identify the expected job, recognize terminal states and redact secrets', () => {
  const job = { id: 'video_123', status: 'completed' };
  assert.equal(checkReceipt(job, 'video_123'), job);
  assert.throws(() => checkReceipt(job, 'video_other'), /mismatch/);
  assert.throws(() => checkReceipt({ ...job, status: 'surprise' }), /status/);
  assert.throws(() => checkReceipt({ ...job, id: '../other' }), /ID/);
  assert.equal(redact('Oops key-secret and key-secret', 'key-secret'), 'Oops [redacted] and [redacted]');
});

test('resume requires two existing exact receipts at the same selected origin and never guesses missing IDs', () => {
  const manifest = { schemaVersion: 1, mode: 'live', baseUrl: 'https://easel.example', jobs: [
    { id: 'video_1', status: 'queued' }, { id: 'video_2', status: 'completed' },
  ] };
  assert.equal(validateResume(manifest, 'https://easel.example'), manifest);
  assert.throws(() => validateResume(manifest, 'https://other.example'), /endpoint/);
  assert.throws(() => validateResume({ ...manifest, jobs: [manifest.jobs[0], { submissionStarted: true }] }, manifest.baseUrl), /receipt|ID/);
  assert.throws(() => validateResume({ ...manifest, jobs: [manifest.jobs[0]] }, manifest.baseUrl), /two/);
});

test('successful endpoint metadata and receipts cannot leak the configured credential', async () => {
  const { probe } = require('../scripts/test-live-video-workflow.cjs');
  const key = 'not-a-real-test-credential';
  assert.throws(() => checkReceipt({ id: `video_${key}`, status: 'queued' }, undefined, key), /credential.*response/i);
  const provider = {
    listModels: async () => ['ltx-2.5'], headers: () => ({}),
    requestJson: async () => ({ paths: {} }),
    discoverVideoCapabilities: async () => capabilities(),
    listVideoLoras: async () => [{ id: 'camera-static', requires: [key] }],
  };
  await assert.rejects(() => probe(provider, { baseUrl: 'https://example.test', apiKey: key }), /credential.*response/i);
  provider.listModels = async () => ['ltx-2.5', key];
  await assert.rejects(() => probe(provider, { baseUrl: 'https://example.test', apiKey: key }), /credential.*response/i);
});

test('submission persists a recoverable exact ID before rejecting an unknown status', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { recordSubmissionReceipt } = require('../scripts/test-live-video-workflow.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-receipt-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'receipts.json');
  const manifest = { jobs: [{ submissionStarted: true }] };
  assert.throws(() => recordSubmissionReceipt(manifest, 0, { id: 'video_known_id', status: 'paused' }, filename, ''), /Unknown job status/);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).jobs[0].id, 'video_known_id');
});

test('two submission responses with the same ID cannot become a successful live run', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { recordSubmissionReceipt } = require('../scripts/test-live-video-workflow.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-receipt-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'receipts.json');
  const manifest = { jobs: [{ id: 'video_duplicate', status: 'queued' }, { submissionStarted: true }] };
  assert.throws(() => recordSubmissionReceipt(manifest, 1, { id: 'video_duplicate', status: 'completed' }, filename, ''), /Duplicate receipt/);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).jobs[1].id, 'video_duplicate');
});

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { scenarioRequests, validateScenarioPreflight, run } = require('../scripts/test-live-video-workflow.cjs');
const capabilities = () => ({
  object: 'video.capabilities', schema_version: 1, model: 'ltx-2.5', fps: 24,
  seconds: { min: 1, max: 12, default: 4 }, sizes: ['512x320'],
  seed: { min: '0', max: '18446744073709551614', encoding: 'decimal_string' },
  uploads: { mime_types: ['image/png'], max_total_bytes: 33554432 },
  guiding_frames: { supported: true, available: true, validation: 'graph_contract_tested', max_count: 8, frame_index_multiple: 1 },
});
const cameras = () => ['camera-dolly-in', 'camera-static'].map(id => ({ id, supported: true, installed: true, requires: [] }));
const discovery = () => ({ capabilities: capabilities(), adapters: cameras() });

// Removing the scenario gate would let a typo or unapproved mode choose paid work.
test('advanced scenarios require an explicit live selection and independent cost consent', () => {
  for (const scenario of ['baseline', 'camera', 'guided-frames']) {
    assert.equal(parseOptions(['--live', '--allow-generation-cost', '--scenario', scenario]).scenario, scenario);
    assert.throws(() => parseOptions(['--live', '--scenario', scenario]), /allow-generation-cost/);
  }
  for (const mode of ['--offline', '--help', '--probe']) assert.throws(() => parseOptions([mode, '--scenario', 'camera']), /scenario.*live/i);
  assert.throws(() => parseOptions(['--resume', '/tmp/saved', '--scenario', 'camera']), /scenario.*live/i);
  for (const value of [undefined, 'everything', 'Camera']) assert.throws(() => parseOptions(['--live', '--allow-generation-cost', '--scenario', ...value === undefined ? [] : [value]]), /scenario/i);
  assert.throws(() => parseOptions(['--live', '--allow-generation-cost', '--scenario', 'camera', '--scenario', 'guided-frames']), /scenario/i);
});

// Changing seeds to Number or broadening a case would break these bounded requests.
test('scenario requests preserve baseline and bound named controls to two one-second jobs', () => {
  const baseline = scenarioRequests('baseline');
  assert.equal(baseline.length, 2);
  assert.deepEqual(Object.keys(baseline[0]).sort(), ['model', 'prompt', 'seconds', 'size']);
  assert.match(baseline[0].prompt, /red wooden toy boat/);
  assert.match(baseline[1].prompt, /blue paper kite/);
  for (const name of ['baseline', 'camera', 'guided-frames']) {
    for (const request of scenarioRequests(name)) {
      assert.equal(request.model, 'ltx-2.5'); assert.equal(request.seconds, 1); assert.equal(request.size, '512x320');
    }
  }
  const camera = scenarioRequests('camera');
  assert.deepEqual(camera.map(request => request.seed), ['0', '18446744073709551614']);
  assert.equal(camera[0].cameraLora, 'dolly-in'); assert.equal(camera[0].cameraLoraStrength, 0.8);
  assert.deepEqual(camera[1].loras, [{ id: 'camera-static', strength: 0.8 }]);
  const guided = scenarioRequests('guided-frames');
  assert.equal(guided.length, 2);
  assert.deepEqual(guided.map(request => request.seed), ['0', '18446744073709551614']);
  for (const request of guided) {
    assert.equal(request.inputReference, undefined); assert.equal(request.loraReference, undefined);
    assert.deepEqual(request.guidingFrames.map(guide => guide.frameIndex), [0, 24]);
    for (const guide of request.guidingFrames) {
      assert.equal(guide.strength, 0.7); assert.equal(guide.image.mimeType, 'image/png');
      assert.deepEqual(Buffer.from(guide.image.data, 'base64'), fs.readFileSync(path.join(__dirname, 'fixtures/video-export/overlay.png')));
    }
  }
  assert.throws(() => scenarioRequests('all'), /scenario/i);
});

// Ignoring missing runtime guide nodes or an uninstalled adapter would permit paid rejection.
test('advanced preflight fails closed on unknown contracts, unavailable guides and camera adapters', () => {
  assert.doesNotThrow(() => validateScenarioPreflight('baseline', {}));
  for (const scenario of ['camera', 'guided-frames']) {
    assert.doesNotThrow(() => validateScenarioPreflight(scenario, discovery()));
    assert.throws(() => validateScenarioPreflight(scenario, {}), /capabilit/i);
    for (const change of [{ schema_version: 2 }, { model: 'other' }, { fps: 30 }, { sizes: ['1280x720'] }, { seed: { encoding: 'number' } }]) {
      assert.throws(() => validateScenarioPreflight(scenario, { ...discovery(), capabilities: { ...capabilities(), ...change } }), /contract|capabilit|seed|size|model|FPS/i);
    }
  }
  for (const change of [{ supported: false }, { available: false }, { frame_index_multiple: 8 }, { max_count: 1 }]) {
    assert.throws(() => validateScenarioPreflight('guided-frames', { ...discovery(), capabilities: { ...capabilities(), guiding_frames: { ...capabilities().guiding_frames, ...change } } }), /guid/i);
  }
  for (const change of [{ installed: false }, { supported: false }, { requires: ['input_reference'] }]) {
    assert.throws(() => validateScenarioPreflight('camera', { ...discovery(), adapters: [{ ...cameras()[0], ...change }, cameras()[1]] }), /camera|adapter/i);
  }
});

test('probe uses exported read-only capability and LoRA discovery with the selected model', async () => {
  const { probe } = require('../scripts/test-live-video-workflow.cjs');
  const calls = [], config = { baseUrl: 'https://example.test', apiKey: 'fake-test-key' };
  const provider = {
    listModels: async () => ['ltx-2.5'], headers: () => ({}),
    requestJson: async (_url, request) => { assert.equal(request.method, 'GET'); return { paths: {} }; },
    discoverVideoCapabilities: async input => { calls.push(['capabilities', input]); return capabilities(); },
    listVideoLoras: async input => { calls.push(['loras', input]); return cameras(); },
  };
  const result = await probe(provider, config);
  assert.deepEqual(calls.map(([name, input]) => [name, input.model, input.baseUrl, input.apiKey]), [
    ['capabilities', 'ltx-2.5', config.baseUrl, config.apiKey], ['loras', 'ltx-2.5', config.baseUrl, config.apiKey],
  ]);
  assert.deepEqual(result.capabilities, capabilities()); assert.deepEqual(result.adapters, cameras());
  provider.discoverVideoCapabilities = async () => { throw new Error('unsupported capability schema'); };
  const older = await probe(provider, config);
  assert.match(older.capabilityNote, /unsupported capability schema/);
  assert.throws(() => validateScenarioPreflight('guided-frames', older), /capabilit/i);
});

test('new receipts bind the scenario, requested bounds and job count while legacy baseline receipts remain resumable', () => {
  const manifest = { schemaVersion: 2, mode: 'live', scenario: 'camera', expectedJobs: 2,
    baseUrl: 'https://easel.example', model: 'ltx-2.5', seconds: 1, size: '512x320',
    jobs: [{ id: 'video_1', status: 'queued' }, { id: 'video_2', status: 'completed' }] };
  for (const scenario of ['baseline', 'camera', 'guided-frames']) assert.equal(validateResume({ ...manifest, scenario }, manifest.baseUrl).scenario, scenario);
  for (const change of [{ scenario: 'all' }, { scenario: undefined }, { expectedJobs: 1 }, { expectedJobs: undefined }, { jobs: [manifest.jobs[0]] }, { model: 'other' }, { seconds: 12 }, { size: '1280x720' }]) {
    assert.throws(() => validateResume({ ...manifest, ...change }, manifest.baseUrl), /scenario|receipt|count|bounds|model|two/i);
  }
  assert.throws(() => validateResume({ ...manifest, schemaVersion: 1 }, manifest.baseUrl), /scenario|legacy/i);
});

function fakeRuntime(t, overrides = {}) {
  const calls = [], directories = new Set();
  const old = { url: process.env.EASEL_BASE_URL, key: process.env.EASEL_API_KEY };
  process.env.EASEL_BASE_URL = 'https://example.test'; process.env.EASEL_API_KEY = 'local-fake-key';
  t.after(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of [['EASEL_BASE_URL', old.url], ['EASEL_API_KEY', old.key]]) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const provider = {
    normalizeEaselBaseUrl: value => value, listModels: async () => ['ltx-2.5'], headers: () => ({}),
    requestJson: async () => ({ paths: {} }),
    discoverVideoCapabilities: async () => { calls.push(['capabilities']); return capabilities(); },
    listVideoLoras: async () => { calls.push(['loras']); return cameras(); },
    generateVideo: async input => { calls.push(['generate', input]); return { id: `video_${calls.filter(([name]) => name === 'generate').length}`, status: 'queued' }; },
    getVideo: async input => { calls.push(['get', input]); return { job: { id: input.videoId, status: 'completed' }, media: { mimeType: 'video/mp4', data: Buffer.from('fake-media').toString('base64') } }; },
    ...overrides,
  };
  return { calls, provider, dependencies: { loadProvider: async () => provider,
    electronRun: directory => { directories.add(directory); return {}; },
    localWorkflow: async directory => { directories.add(directory); return { sourceHashesUnchanged: true }; },
  } };
}

test('camera live run submits only the named bounded scenario after discovery and resume only retrieves its exact IDs', async t => {
  const { calls, dependencies } = fakeRuntime(t);
  const evidence = await run(['--live', '--allow-generation-cost', '--scenario', 'camera'], dependencies);
  const submissions = calls.filter(([name]) => name === 'generate');
  assert.equal(submissions.length, 2);
  assert.ok(calls.findIndex(([name]) => name === 'capabilities') < calls.findIndex(([name]) => name === 'generate'));
  assert.ok(calls.findIndex(([name]) => name === 'loras') < calls.findIndex(([name]) => name === 'generate'));
  assert.deepEqual(submissions.map(([, input]) => input.seed), ['0', '18446744073709551614']);
  assert.equal(evidence.scenario, 'camera');
  const manifest = JSON.parse(fs.readFileSync(path.join(evidence.directory, 'receipts.json'), 'utf8'));
  assert.equal(manifest.scenario, 'camera'); assert.equal(manifest.expectedJobs, 2);
  calls.length = 0;
  await run(['--resume', evidence.directory], dependencies);
  assert.deepEqual(calls.map(([name, input]) => [name, input?.videoId]), [['get', 'video_1'], ['get', 'video_2']]);
  manifest.jobs.pop(); fs.writeFileSync(path.join(evidence.directory, 'receipts.json'), JSON.stringify(manifest));
  calls.length = 0;
  await assert.rejects(() => run(['--resume', evidence.directory], dependencies), /two|receipt/i);
  assert.deepEqual(calls, []);
});

test('advanced preflight errors and missing cost consent produce no generation request', async t => {
  const { calls, dependencies } = fakeRuntime(t, { discoverVideoCapabilities: async () => { throw new Error('unknown endpoint schema'); } });
  await assert.rejects(() => run(['--live', '--scenario', 'camera'], dependencies), /allow-generation-cost/);
  assert.deepEqual(calls, []);
  await assert.rejects(() => run(['--live', '--allow-generation-cost', '--scenario', 'camera'], dependencies), /capabilit/i);
  assert.equal(calls.some(([name]) => name === 'generate'), false);
});

test('legacy receipts cannot silently change saved model or generation bounds', () => {
  const manifest = { schemaVersion: 1, mode: 'live', baseUrl: 'https://easel.example', model: 'ltx-2.5', seconds: 1, size: '512x320',
    jobs: [{ id: 'video_1', status: 'queued' }, { id: 'video_2', status: 'completed' }] };
  for (const change of [{ model: 'other' }, { seconds: 2 }, { size: '1280x720' }]) {
    assert.throws(() => validateResume({ ...manifest, ...change }, manifest.baseUrl), /bounds|model/);
  }
});

test('guided runner requests only the two fixture-guided jobs and saves receipts before its first retrieval', async t => {
  const { calls, dependencies, provider } = fakeRuntime(t);
  let evidenceDirectory;
  dependencies.electronRun = directory => { evidenceDirectory = directory; };
  t.after(() => fs.rmSync(evidenceDirectory, { recursive: true, force: true }));
  const getVideo = provider.getVideo;
  provider.getVideo = async input => {
    const saved = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, 'receipts.json'), 'utf8'));
    assert.equal(saved.scenario, 'guided-frames'); assert.equal(saved.jobs.length, 2);
    assert.deepEqual(saved.jobs.map(job => job.id), ['video_1', 'video_2']);
    return getVideo(input);
  };
  const evidence = await run(['--live', '--allow-generation-cost', '--scenario', 'guided-frames'], dependencies);
  assert.equal(evidence.scenario, 'guided-frames');
  const submissions = calls.filter(([name]) => name === 'generate').map(([, request]) => request);
  assert.equal(submissions.length, 2);
  for (const request of submissions) {
    assert.equal(request.guidingFrames.length, 2); assert.equal(request.cameraLora, undefined);
    assert.equal(request.seconds, 1); assert.equal(request.size, '512x320');
  }
});

test('receipt loss never retries the POST or submits the remaining scenario job', async t => {
  let attempts = 0, directory;
  const { calls, dependencies } = fakeRuntime(t, { generateVideo: async () => { attempts++; throw new Error('network response lost'); } });
  dependencies.electronRun = value => { directory = value; };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(() => run(['--live', '--allow-generation-cost', '--scenario', 'camera'], dependencies), /response lost/);
  assert.equal(attempts, 1); assert.equal(calls.some(([name]) => name === 'get'), false);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'receipts.json'), 'utf8'));
  assert.deepEqual(saved.jobs, [{ submissionStarted: true }]); assert.equal(saved.expectedJobs, 2);
  await assert.rejects(() => run(['--resume', directory], dependencies), /two saved receipts/);
  assert.equal(attempts, 1);
});

test('default help and offline workflow never load a provider or inspect API credentials', async t => {
  const originalEnv = process.env;
  process.env = new Proxy(originalEnv, { get(target, key) {
    if (key === 'EASEL_API_KEY' || key === 'EASEL_BASE_URL') throw new Error('Offline read a credential or endpoint');
    return target[key];
  } });
  t.after(() => { process.env = originalEnv; });
  let directory;
  t.after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  const dependencies = { loadProvider: async () => { throw new Error('Offline loaded the provider'); },
    electronRun: value => { directory = value; }, localWorkflow: async (_directory, sources) => {
      assert.equal(sources.length, 2);
      assert.deepEqual(sources.map(filename => fs.readFileSync(filename)), ['red.mp4', 'blue.mp4'].map(name => fs.readFileSync(path.join(__dirname, 'fixtures/video-export', name))));
      return { sourceHashesUnchanged: true };
    } };
  await run([], dependencies);
  const evidence = await run(['--offline'], dependencies);
  assert.equal(evidence.mode, 'offline-fixtures'); assert.equal(evidence.liveGenerationVerified, false);
  assert.equal(fs.existsSync(path.join(directory, 'receipts.json')), false);
});
