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
    requestJson: async url => url.endsWith('/openapi.json') ? { paths: {} } : { data: [{ id: 'camera-static', requires: [key] }] },
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
