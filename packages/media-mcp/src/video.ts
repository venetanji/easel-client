import { MEDIA_JOB_ID_PATTERN, parseMediaJob, type MediaJob as VideoJob } from './media-job.js';
import { setTimeout as delay } from 'node:timers/promises';
import { appendImage, decodeImageUpload, type ImageUpload } from './image-upload.js';
import { headers, normalizeEaselBaseUrl, requestBinary, requestJson, requestSignal, type ProviderOptions } from './media-http.js';

export const MAX_VIDEO_BYTES = 32 * 1_048_576;
export const VIDEO_ID_PATTERN = MEDIA_JOB_ID_PATTERN;

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
  includeQueue?: boolean;
  signal?: AbortSignal;
}

export type { MediaJob as VideoJob } from './media-job.js';

export interface VideoResult { job: VideoJob; media?: { data: string; mimeType: 'video/mp4' | 'video/webm' } }

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
  return parseMediaJob(result, apiKey);
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
    job = parseMediaJob(await requestJson(url, { method: 'GET', headers: headers(apiKey), signal }, apiKey, fetchImpl,
      { label: 'Video job retrieval', path, model: options.model }), apiKey, options.videoId);
    if (!['queued', 'in_progress'].includes(job.status) || Date.now() >= deadline) break;
    await delay(Math.min(3_000, Math.max(1, deadline - Date.now())), undefined, { signal });
  } while (Date.now() <= deadline);
  if (options.includeQueue && ['queued', 'in_progress'].includes(job.status)) {
    // Queue diagnostics are optional; their absence must not block job retrieval.
    try {
      const queue = await requestJson(normalizeEaselBaseUrl(options.baseUrl) + '/v1/videos/queue/' + encodeURIComponent(options.videoId),
        { method: 'GET', headers: headers(apiKey), signal }, apiKey, fetchImpl, { label: 'Video queue', path: '/v1/videos/queue', model: options.model });
      if (queue?.id === job.id) {
        for (const [remote, local] of Object.entries({ queue_position: 'queuePosition', queue_ahead: 'queueAhead', estimated_wait_seconds: 'estimatedWaitSeconds', estimated_completion_at: 'estimatedCompletionAt' })) {
          if (typeof queue[remote] === 'number' && Number.isFinite(queue[remote]) && queue[remote] >= 0) (job as any)[local] = queue[remote];
        }
      }
    } catch { signal.throwIfAborted(); }
  }
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
