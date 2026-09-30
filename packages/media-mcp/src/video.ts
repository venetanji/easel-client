import { setTimeout as delay } from 'node:timers/promises';
import { appendImage, decodeImageUpload, type ImageUpload } from './image-upload.js';
import { headers, normalizeEaselBaseUrl, requestBinary, requestJson, requestSignal, safeErrorMessage, type ProviderOptions } from './media-http.js';

export const MAX_VIDEO_BYTES = 32 * 1_048_576;
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export interface GenerateVideoInput {
  prompt: string;
  model: string;
  seconds?: number;
  size?: string;
  inputReference?: ImageUpload;
  signal?: AbortSignal;
}

export interface GetVideoInput {
  videoId: string;
  model?: string;
  waitSeconds?: number;
  download?: boolean;
  signal?: AbortSignal;
}

export interface VideoJob {
  id: string;
  status: string;
  providerStatus: string;
  progress?: number;
  seconds?: number;
  size?: string;
  error?: string;
}

export interface VideoResult { job: VideoJob; media?: { data: string; mimeType: 'video/mp4' | 'video/webm' } }

function videoJob(payload: any, apiKey: string, expectedId?: string): VideoJob {
  const value = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
  const id = value?.id ?? value?.video_id;
  if (typeof id !== 'string' || !VIDEO_ID_PATTERN.test(id) || (expectedId && id !== expectedId)) {
    throw new Error('The video endpoint returned an invalid or mismatched job ID. Do not resubmit a generation automatically.');
  }
  const raw = value.status;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw new Error(`Video job ${id} returned no usable status. Retrieve this job again; do not resubmit it.`);
  const normalized = raw.toLowerCase();
  const aliases: Record<string, string> = { pending: 'queued', created: 'queued', running: 'in_progress', processing: 'in_progress', succeeded: 'completed', ready: 'completed', done: 'completed', error: 'failed', canceled: 'cancelled' };
  const job: VideoJob = { id, status: aliases[normalized] || normalized, providerStatus: raw };
  if (typeof value.progress === 'number' && Number.isFinite(value.progress)) job.progress = Math.max(0, Math.min(100, value.progress));
  const seconds = Number(value.seconds);
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 3_600) job.seconds = seconds;
  if (typeof value.size === 'string' && /^\d{2,5}x\d{2,5}$/.test(value.size)) job.size = value.size;
  if (value.error) job.error = safeErrorMessage(value.error?.message || value.error, apiKey, 500);
  return job;
}

export async function generateVideo(options: GenerateVideoInput & ProviderOptions): Promise<VideoJob> {
  options.signal?.throwIfAborted();
  const prompt = typeof options.prompt === 'string' ? options.prompt.trim() : '';
  const model = typeof options.model === 'string' ? options.model.trim() : '';
  if (!prompt || prompt.length > 5_000) throw new Error('Video prompt must contain 1-5000 characters.');
  if (!model || model.length > 256) throw new Error('Choose a video generation model (at most 256 characters).');
  const seconds = options.seconds ?? 4;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Video duration must be an integer from 1 to 60 seconds; supported durations depend on the model.');
  const size = options.size ?? '1280x720';
  if (!/^\d{2,5}x\d{2,5}$/.test(size)) throw new Error('Video size must use WIDTHxHEIGHT format.');
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('model', model);
  form.append('seconds', String(seconds));
  form.append('size', size);
  if (options.inputReference) appendImage(form, 'input_reference', decodeImageUpload(options.inputReference, 'Video reference image'));
  const apiKey = options.apiKey || '';
  const result = await requestJson(`${normalizeEaselBaseUrl(options.baseUrl)}/v1/videos`, {
    method: 'POST', headers: headers(apiKey), body: form, signal: requestSignal(options.signal, 45_000),
  }, apiKey, options.fetchImpl || globalThis.fetch, { label: 'Video generation', path: '/v1/videos', model });
  return videoJob(result, apiKey);
}

export async function getVideo(options: GetVideoInput & ProviderOptions): Promise<VideoResult> {
  if (!VIDEO_ID_PATTERN.test(options.videoId)) throw new Error('Use the exact video job ID returned by generate_video.');
  const waitSeconds = options.waitSeconds ?? 0;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 15) throw new Error('Wait must be an integer from 0 to 15 seconds.');
  const apiKey = options.apiKey || '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const signal = requestSignal(options.signal, 45_000);
  const path = `/v1/videos/${encodeURIComponent(options.videoId)}`;
  const url = normalizeEaselBaseUrl(options.baseUrl) + path;
  const deadline = Date.now() + waitSeconds * 1_000;
  let job: VideoJob;
  do {
    job = videoJob(await requestJson(url, { method: 'GET', headers: headers(apiKey), signal }, apiKey, fetchImpl,
      { label: 'Video job retrieval', path, model: options.model }), apiKey, options.videoId);
    if (!['queued', 'in_progress'].includes(job.status) || Date.now() >= deadline) break;
    await delay(Math.min(3_000, Math.max(1, deadline - Date.now())), undefined, { signal });
  } while (Date.now() <= deadline);
  if (job.status !== 'completed' || options.download === false) return { job };
  const { bytes, mimeType } = await requestBinary(url + '/content', {
    method: 'GET', headers: headers(apiKey, 'video/mp4, video/webm, application/octet-stream'), signal,
  }, apiKey, fetchImpl, MAX_VIDEO_BYTES, { label: 'Video download', path: path + '/content', model: options.model });
  const detected = bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4'
    : bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'video/webm' : undefined;
  if (!detected || (mimeType && mimeType !== 'application/octet-stream' && mimeType !== detected)) {
    throw new Error(`Video job ${job.id} completed, but content is not a supported MP4/WebM file. Keep this job ID; do not generate a replacement automatically.`);
  }
  return { job, media: { data: bytes.toString('base64'), mimeType: detected } };
}
