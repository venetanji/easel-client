import { MEDIA_JOB_ID_PATTERN, parseMediaJob, type MediaJob as VideoJob } from './media-job.js';
import { setTimeout as delay } from 'node:timers/promises';
import { appendImage, decodeImageUpload, MAX_INPUT_BYTES, type ImageUpload } from './image-upload.js';
import { validateVideoInput, invalidVideoArguments, type CAMERA_LORAS } from './video-input.js';
import { headers, normalizeEaselBaseUrl, requestBinary, requestJson, requestSignal, type ProviderOptions } from './media-http.js';

export const MAX_VIDEO_BYTES = 32 * 1_048_576;
export const VIDEO_ID_PATTERN = MEDIA_JOB_ID_PATTERN;

export interface GenerateVideoInput {
  prompt: string;
  model: string;
  seconds?: number;
  size?: string;
  inputReference?: ImageUpload;
  frames?: number;
  semanticReferences?: ImageUpload[];
  temporalGroups?: Array<{ frameIndex: number; images: ImageUpload[] }>;
  cameraLora?: typeof CAMERA_LORAS[number];
  cameraLoraStrength?: number;
  loras?: Array<{ id: string; strength?: number }>;
  seed?: string;
  motionSpeed?: number;
  loraReference?: ImageUpload;
  loraReferenceStrength?: number;
  guidingFrames?: Array<{ image: ImageUpload; frameIndex: number; strength?: number }>;
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
  const { baseUrl, apiKey: _apiKey, fetchImpl, signal, ...rawInput } = options;
  const input = validateVideoInput(rawInput);
  const { prompt, model, size } = input;
  if (model.length > 256) invalidVideoArguments('Choose a video generation model (at most 256 characters).');
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('model', model);
  const h3 = model === 'minimax-h3';
  form.append(h3 ? 'frames' : 'seconds', String(h3 ? input.frames ?? 124 : input.seconds ?? 4));
  if (size !== undefined) form.append('size', size);
  for (const [key, field] of Object.entries({ cameraLora: 'camera_lora', cameraLoraStrength: 'camera_lora_strength', seed: 'seed', motionSpeed: 'motion_speed', loraReferenceStrength: 'lora_reference_strength' }) as Array<[keyof GenerateVideoInput, string]>) {
    if (input[key as keyof typeof input] !== undefined) form.append(field, String(input[key as keyof typeof input]));
  }
  if (input.loras !== undefined) form.append('loras', JSON.stringify(input.loras));
  let totalBytes = 0;
  const upload = (field: string, image: ImageUpload, label: string) => {
    try {
      const decoded = decodeImageUpload(image, label, MAX_INPUT_BYTES - totalBytes);
      if (h3 && !['image/png', 'image/jpeg'].includes(decoded.mimeType)) invalidVideoArguments('H3 accepts only PNG/JPEG still images.');
      totalBytes += decoded.bytes.length;
      appendImage(form, field, decoded);
    } catch (error) { invalidVideoArguments(error instanceof Error ? error.message : 'Invalid video image upload.'); }
  };
  if (input.inputReference) upload('input_reference', input.inputReference, 'Video reference image');
  if (input.loraReference) upload('lora_reference', input.loraReference, 'Ingredients reference image');
  if (input.guidingFrames) {
    form.append('guiding_frames', JSON.stringify(input.guidingFrames.map((guide, index) => ({ image_index: index, frame_index: guide.frameIndex, strength: guide.strength ?? 1 }))));
    for (const [index, guide] of input.guidingFrames.entries()) upload('guiding_images', guide.image, `Guiding image ${index + 1}`);
  }
  let imageIndex = 0;
  if (input.semanticReferences) {
    form.append('semantic_references', JSON.stringify(input.semanticReferences.map(image => {
      upload('images', image, 'H3 semantic reference');
      return { image_index: imageIndex++ };
    })));
  }
  if (input.temporalGroups) {
    form.append('temporal_groups', JSON.stringify(input.temporalGroups.map(group => ({
      frame_index: group.frameIndex,
      image_indices: group.images.map(image => { upload('images', image, 'H3 temporal image'); return imageIndex++; }),
    }))));
  }
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

export { discoverVideoCapabilities, listVideoLoras, type VideoDiscoveryInput, type VideoCapabilities, type VideoLora } from './video-discovery.js';
