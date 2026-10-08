import { z } from 'zod/v4';
import { headers, normalizeEaselBaseUrl, requestBinary, requestJson, requestSignal, type ProviderOptions } from './media-http.js';

const percent = z.number().int().min(0).max(100).nullable().optional();
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const common = { model: z.string().trim().min(1).max(320).optional(), dryRun: z.boolean().optional() };
const voice = { vocalGender: z.enum(['', 'male', 'female']).optional(), variety: z.number().int().min(0).max(4).nullable().optional() };

export const MusicInputSchema = z.object({
  ...common, ...voice, prompt: z.string().max(1000).optional(), lyrics: z.string().max(5000).optional(),
  title: z.string().max(1000).optional(), makeInstrumental: z.boolean().optional(), negativePrompt: z.string().max(1000).optional(),
  sunoModel: z.string().max(1000).optional(), weirdness: percent, styleInfluence: percent,
  durationSeconds: z.number().int().min(10).max(360).nullable().optional(), referenceAudioId: uuid.nullable().optional(),
  audioMode: z.enum(['cover', 'extend']).optional(), audioInfluence: percent,
  inspirationIds: z.array(uuid).max(4).nullable().optional(), inspirationPlaylist: z.string().max(4096).optional(),
}).strict();
export const SpeechInputSchema = z.object({
  ...common, ...voice, prompt: z.string().trim().min(1).max(5000), tone: z.string().max(1000).optional(), backgroundMusic: z.boolean().optional(),
}).strict();
export const SoundInputSchema = z.object({
  ...common, prompt: z.string().trim().min(1).max(500), soundType: z.enum(['one_shot', 'loop']).optional(), bpm: z.number().int().min(1).max(300).nullable().optional(),
}).strict();
export const AudioTrackInputSchema = z.object({ trackId: uuid, model: common.model }).strict();
export const AbandonAudioInputSchema = z.object({ attemptId: uuid, model: common.model }).strict();

export type MusicInput = z.infer<typeof MusicInputSchema>;
export type SpeechInput = z.infer<typeof SpeechInputSchema>;
export type SoundInput = z.infer<typeof SoundInputSchema>;
export type AudioKind = 'music' | 'speech' | 'sound';
export type AudioPayload = Record<string, unknown>;
export const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac', 'audio/aac': 'aac',
};
export interface AudioMedia { data: string; mimeType: string; extension: string }

const fields: Record<string, string> = {
  dryRun: 'dry_run', makeInstrumental: 'make_instrumental', negativePrompt: 'negative_prompt', sunoModel: 'suno_model',
  styleInfluence: 'style_influence', vocalGender: 'vocal_gender', durationSeconds: 'duration_seconds',
  referenceAudioId: 'reference_audio_id', audioMode: 'audio_mode', audioInfluence: 'audio_influence',
  inspirationIds: 'inspiration_ids', inspirationPlaylist: 'inspiration_playlist', backgroundMusic: 'background_music', soundType: 'sound_type',
};

async function audioRequest(options: ProviderOptions, path: string, method = 'GET', body?: unknown): Promise<AudioPayload> {
  const apiKey = options.apiKey || '';
  const payload = await requestJson(normalizeEaselBaseUrl(options.baseUrl) + '/v1/audio' + path,
    { method, headers: { ...headers(apiKey), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal(options.signal, 240_000) },
    apiKey, options.fetchImpl || globalThis.fetch, { label: 'Audio ' + path, path: '/v1/audio' + path });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The endpoint returned invalid audio metadata.');
  const encoded = JSON.stringify(payload);
  if (apiKey && (encoded.includes(apiKey) || encoded.includes(JSON.stringify(apiKey).slice(1, -1)))) throw new Error('Credential found in audio metadata.');
  return payload;
}

export async function generateAudio(kind: AudioKind, input: MusicInput | SpeechInput | SoundInput, options: ProviderOptions): Promise<AudioPayload> {
  const parsed = kind === 'music' ? MusicInputSchema.parse(input) : kind === 'speech' ? SpeechInputSchema.parse(input) : SoundInputSchema.parse(input);
  if (kind === 'music') {
    const music = parsed as MusicInput;
    if (!music.prompt?.trim() && !music.lyrics?.trim()) throw new Error('Provide a music prompt or lyrics.');
    if (music.makeInstrumental && music.lyrics?.trim()) throw new Error('Instrumental generation requires empty lyrics.');
    if (music.referenceAudioId && (music.inspirationIds?.length || music.inspirationPlaylist)) throw new Error('Choose reference audio or inspiration, not both.');
    if (music.audioInfluence !== undefined && music.audioInfluence !== null && !music.referenceAudioId) throw new Error('audioInfluence requires referenceAudioId.');
    if (music.inspirationIds?.length && music.inspirationPlaylist) throw new Error('Choose inspiration IDs or a playlist, not both.');
    if (music.inspirationIds && new Set(music.inspirationIds.map(id => id.toLowerCase())).size !== music.inspirationIds.length) throw new Error('inspirationIds must be unique.');
  }
  if (parsed.model && parsed.model !== `suno-${kind}`) throw new Error(`Choose the suno-${kind} routing model for this tool.`);
  const payload = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => key !== 'model' && value !== undefined).map(([key, value]) => [fields[key] || key, value]));
  return audioRequest(options, '/generations', 'POST', { ...payload, model: `suno-${kind}` });
}

export function getAudioGenerationStatus(options: ProviderOptions): Promise<AudioPayload> {
  return audioRequest(options, '/generations/status');
}
export function getAudioTrack(trackId: string, options: ProviderOptions): Promise<AudioPayload> {
  return audioRequest(options, '/tracks/' + uuid.parse(trackId));
}
export function abandonAudioGeneration(attemptId: string, options: ProviderOptions): Promise<AudioPayload> {
  return audioRequest(options, '/generations/abandon', 'POST', { attempt_id: uuid.parse(attemptId) });
}
export async function downloadAudio(trackId: string, options: ProviderOptions): Promise<{ track: AudioPayload; media: AudioMedia }> {
  const identifier = uuid.parse(trackId);
  const track = await audioRequest(options, '/tracks/' + identifier + '/download', 'POST');
  const apiKey = options.apiKey || '';
  const path = '/v1/audio/tracks/' + identifier + '/content?download=true';
  const media = await requestBinary(normalizeEaselBaseUrl(options.baseUrl) + path,
    { headers: headers(apiKey, 'audio/*'), signal: requestSignal(options.signal, 240_000) }, apiKey,
    options.fetchImpl || globalThis.fetch, 32 * 1_048_576, { label: 'Audio download', path });
  const extension = AUDIO_EXTENSIONS[media.mimeType];
  if (!extension) throw new Error('The endpoint returned an unsupported audio encoding.');
  return { track, media: { data: media.bytes.toString('base64'), mimeType: media.mimeType, extension } };
}
