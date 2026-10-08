import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { abandonAudioGeneration, downloadAudio, generateAudio, getAudioGenerationStatus, getAudioTrack } from '../src/audio.js';

const trackId = '11111111-1111-4111-8111-111111111111';
test('music maps every CLI/API control without pinning an omitted native Suno model', async () => {
  let calls = 0;
  const result = await generateAudio('music', { prompt: 'jazz', lyrics: 'hello', title: 'Test', dryRun: true,
    negativePrompt: 'noise', weirdness: 20, styleInfluence: 60, variety: 2, vocalGender: 'female',
    durationSeconds: 120, referenceAudioId: trackId, audioMode: 'extend', audioInfluence: 30 }, {
    baseUrl: 'https://easel.test', fetchImpl: async (url, init) => {
      calls++; assert.equal(url, 'https://easel.test/v1/audio/generations'); assert.equal(init?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init?.body)), { model: 'suno-music', prompt: 'jazz', lyrics: 'hello', title: 'Test',
        dry_run: true, negative_prompt: 'noise', weirdness: 20, style_influence: 60, variety: 2, vocal_gender: 'female',
        duration_seconds: 120, reference_audio_id: trackId, audio_mode: 'extend', audio_influence: 30 });
      return Response.json({ attempt_id: trackId, status: 'captcha_required', songs: [] }, { status: 202 });
    },
  });
  assert.equal(calls, 1); assert.equal(result.status, 'captcha_required');
});
test('speech and sound map their typed controls exactly', async () => {
  const payloads: unknown[] = [];
  const options = { fetchImpl: async (_url: string | URL, init?: RequestInit) => { payloads.push(JSON.parse(String(init?.body))); return Response.json({ status: 'submitted' }); } };
  await generateAudio('speech', { prompt: 'Hello', tone: 'warm', backgroundMusic: true, vocalGender: 'male', variety: 4, dryRun: true }, options);
  await generateAudio('sound', { prompt: 'rain', soundType: 'loop', bpm: 100, dryRun: true }, options);
  assert.deepEqual(payloads, [{ model: 'suno-speech', prompt: 'Hello', tone: 'warm', background_music: true, vocal_gender: 'male', variety: 4, dry_run: true },
    { model: 'suno-sound', prompt: 'rain', sound_type: 'loop', bpm: 100, dry_run: true }]);
});
test('empty inspiration IDs do not conflict with reference audio or a playlist', async () => {
  const payloads: unknown[] = [];
  const options = { fetchImpl: async (_url: string | URL, init?: RequestInit) => { payloads.push(JSON.parse(String(init?.body))); return Response.json({ status: 'submitted' }); } };
  await generateAudio('music', { prompt: 'jazz', referenceAudioId: trackId, inspirationIds: [] }, options);
  await generateAudio('music', { prompt: 'jazz', inspirationPlaylist: 'playlist', inspirationIds: [] }, options);
  assert.deepEqual(payloads, [{ model: 'suno-music', prompt: 'jazz', reference_audio_id: trackId, inspiration_ids: [] },
    { model: 'suno-music', prompt: 'jazz', inspiration_playlist: 'playlist', inspiration_ids: [] }]);
});
test('invalid audio combinations are rejected before a POST', async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; return Response.json({}); } };
  for (const input of [{}, { prompt: 'music', audioInfluence: 10 }, { lyrics: 'hello', makeInstrumental: true },
    { prompt: 'music', referenceAudioId: trackId, inspirationIds: [trackId] },
    { prompt: 'music', inspirationPlaylist: 'playlist', inspirationIds: [trackId] },
    { prompt: 'music', inspirationIds: [trackId, trackId] }]) await assert.rejects(generateAudio('music', input, options));
  await assert.rejects(generateAudio('speech', { prompt: 'hello', variety: 5 }, options));
  await assert.rejects(generateAudio('sound', { prompt: 'sound', bpm: 301 }, options));
  assert.equal(calls, 0);
});
test('audio lifecycle uses captured IDs, never re-submits and preserves M4A encoding', async () => {
  const paths: string[] = [];
  const options = { baseUrl: 'https://easel.test', fetchImpl: async (url: string | URL, init?: RequestInit) => {
    paths.push(String(init?.method || 'GET') + ' ' + new URL(url).pathname);
    if (String(url).includes('/content')) return new Response(Buffer.from('served-m4a'), { headers: { 'content-type': 'audio/mp4', 'content-length': '10' } });
    return Response.json({ id: trackId, status: 'complete' });
  } };
  await getAudioGenerationStatus(options); await getAudioTrack(trackId, options); await abandonAudioGeneration(trackId, options);
  const downloaded = await downloadAudio(trackId, options);
  assert.equal(downloaded.media.extension, 'm4a'); assert.equal(downloaded.media.mimeType, 'audio/mp4');
  assert.deepEqual(paths, ['GET /v1/audio/generations/status', 'GET /v1/audio/tracks/' + trackId,
    'POST /v1/audio/generations/abandon', 'POST /v1/audio/tracks/' + trackId + '/download', 'GET /v1/audio/tracks/' + trackId + '/content']);
});
test('audio metadata errors redact credentials, and malformed IDs never reach the endpoint', async () => {
  const options = { apiKey: 'private-token', fetchImpl: async () => Response.json({ error: { message: 'private-token failed' } }, { status: 503 }) };
  await assert.rejects(getAudioGenerationStatus(options), error => !String(error).includes('private-token'));
  await assert.rejects(downloadAudio('../other-track', { fetchImpl: async () => { throw new Error('must not call'); } }), /Invalid/);
});

for (const [name, apiKey, echo] of [
  ['raw', 'private-token', 'private-token'],
  ['padded raw', '  private-token  ', '  private-token  '],
  ['normalized', '  private-token  ', 'private-token'],
  ['JSON-escaped raw', '  private-"token\\value  ', '  private-"token\\value  '],
  ['JSON-escaped normalized', '  private-"token\\value  ', 'private-"token\\value'],
]) {
  test(`audio metadata rejects an echoed ${name} credential`, async () => {
    await assert.rejects(getAudioGenerationStatus({ apiKey, fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${apiKey!.trim()}`);
      return Response.json({ status: 'ready', nested: { note: `Bearer ${echo}` } });
    } }), (error: Error) => error.message === 'Credential found in audio metadata.');
  });
}

test('audio metadata permits normal success without a nonempty credential', async () => {
  const payload = { status: 'ready', note: 'track is available' };
  for (const apiKey of [undefined, '', '   ', '  private-token  ']) {
    assert.deepEqual(await getAudioGenerationStatus({ apiKey, fetchImpl: async () => Response.json(payload) }), payload);
  }
});
