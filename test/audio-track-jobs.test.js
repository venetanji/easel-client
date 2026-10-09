const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAudioTrackJobs, retrieveAudioTrackJob, enrichAudioDownload } = require('../src/audio-track-jobs');
const attemptId = '11111111-1111-4111-8111-111111111111';
const trackId = '22222222-2222-4222-8222-222222222222';
const model = 'studio:suno-music';

test('audio downloads look up the song title when download metadata omits it', async () => {
  const downloaded = { content: [{ type: 'resource', resource: { mimeType: 'audio/mp4', blob: 'YWJj' } }], structuredContent: { track: { song_id: trackId, format: 'm4a' } } };
  const result = await enrichAudioDownload(downloaded, { model, trackId }, { async callTool(name, args) {
    assert.equal(name, 'get_audio_track'); assert.deepEqual(args, { model, trackId });
    return { structuredContent: { id: trackId, title: 'Hazy Pixel Dreams', duration: 218 } };
  } });
  assert.equal(result.structuredContent.audio.track.title, 'Hazy Pixel Dreams');
  assert.equal(result.structuredContent.audio.track.duration, 218);
  assert.equal(result.content[0].resource.mimeType, 'audio/mp4');
});

test('audio title lookup preserves a supplied title and uses a track-specific name if unavailable', async () => {
  const content = [{ type: 'audio', mimeType: 'audio/mpeg', data: 'YWJj' }];
  const titled = await enrichAudioDownload({ content, structuredContent: { track: { id: trackId, title: 'Pixel Haze' } } }, { model, trackId },
    { callTool: () => assert.fail('Known song titles do not need another lookup.') });
  assert.equal(titled.structuredContent.audio.track.title, 'Pixel Haze');
  const unavailable = await enrichAudioDownload({ content }, { model, trackId }, { callTool: () => { throw new Error('Offline'); } });
  assert.equal(unavailable.structuredContent.audio.track.title, 'Untitled song 22222222');
});

test('monitoring registers captured track UUIDs and never the shared browser attempt', async () => {
  const registered = [];
  const result = await registerAudioTrackJobs({ structuredContent: { attempt_id: attemptId, status: 'submitted', songs: [{ id: trackId }, { id: trackId }] } },
    { model, prompt: 'chiptune', projectId: 'a'.repeat(32) }, async input => { registered.push(input); return { id: 'b'.repeat(32), remoteId: input.job.id }; });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].job.id, trackId);
  assert.equal(registered[0].mediaType, 'audio');
  assert.equal(result.structuredContent.monitoredAudioJobs[0].remoteId, trackId);
  const captcha = await registerAudioTrackJobs({ structuredContent: { attempt_id: attemptId, status: 'captcha_required', songs: [] } }, { model }, () => assert.fail('CAPTCHA has no durable tracks.'));
  assert.equal(captcha.structuredContent.monitoredAudioJobs, undefined);
});

test('captured track polling downloads only when ready, retaining actual encoding and track metadata', async () => {
  const calls = [];
  let status = 'streaming';
  const client = { async callTool(name, args) {
    calls.push(name); assert.equal(args.trackId, trackId); assert.equal(args.model, model);
    if (name === 'get_audio_track') return { structuredContent: { id: trackId, status, title: 'Pixel Haze', duration: 120 } };
    assert.equal(name, 'download_audio');
    return { content: [{ type: 'resource', resource: { mimeType: 'audio/mp4', blob: 'YWJj' } }], structuredContent: { track: { song_id: trackId, format: 'm4a' } } };
  } };
  const entry = { remoteId: trackId, modelId: model };
  assert.equal((await retrieveAudioTrackJob(client, entry)).structuredContent.job.status, 'in_progress');
  assert.deepEqual(calls, ['get_audio_track']);
  status = 'complete';
  const result = await retrieveAudioTrackJob(client, entry);
  assert.equal(result.structuredContent.job.status, 'completed');
  assert.equal(result.structuredContent.audio.track.title, 'Pixel Haze');
  assert.equal(result.structuredContent.audio.track.duration, 120);
  assert.equal(result.content[0].resource.mimeType, 'audio/mp4');
  assert.deepEqual(calls, ['get_audio_track', 'get_audio_track', 'download_audio']);
});

test('track identity mismatch cannot download and receipt-save failure preserves original metadata', async () => {
  await assert.rejects(retrieveAudioTrackJob({ async callTool(name) {
    assert.equal(name, 'get_audio_track'); return { structuredContent: { id: attemptId, status: 'complete' } };
  } }, { remoteId: trackId, modelId: model }), /does not match/);
  const result = await registerAudioTrackJobs({ structuredContent: { attempt_id: attemptId, songs: [{ id: trackId }] } }, { model }, () => { throw new Error('Disk full'); });
  assert.equal(result.structuredContent.attempt_id, attemptId);
  assert.match(result.structuredContent.monitoringErrors[0], /Disk full/);
});

test('cancellation while inspecting a track blocks its subsequent download', async () => {
  let active = true;
  let respond;
  const response = new Promise(resolve => { respond = resolve; });
  const pending = retrieveAudioTrackJob({ callTool(name) {
    assert.equal(name, 'get_audio_track'); return response;
  } }, { remoteId: trackId, modelId: model }, { checkActive() { if (!active) throw new Error('Canceled'); } });
  active = false;
  respond({ structuredContent: { id: trackId, status: 'complete' } });
  await assert.rejects(pending, /Canceled/);
});
