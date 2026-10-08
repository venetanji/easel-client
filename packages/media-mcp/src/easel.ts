import {
  MAX_IMAGE_BYTES, MAX_IMAGE_INPUTS, MAX_INPUT_BYTES, LEGACY_IMAGE_BYTES,
  appendImage, decodeBase64, decodeImageUpload, imageMimeType, requireLegacyImage,
  type ImageMimeType, type ImageUpload,
} from './image-upload.js';

import { headers, normalizeEaselBaseUrl, requestBinary, requestJson, requestSignal, type MediaOperation, type ProviderOptions } from './media-http.js';
import { parseMediaJob, MEDIA_JOB_ID_PATTERN, type MediaJob } from './media-job.js';
export { DEFAULT_EASEL_BASE_URL, normalizeEaselBaseUrl } from './media-http.js';

export interface EaselImage {
  data: string;
  mimeType: ImageMimeType;
}

const MAX_IMAGES = 4;
export type ImageResult = EaselImage[] | { job: MediaJob };

function queuedImageResult(payload: any, apiKey: string): { job: MediaJob } | null {
  const value = payload?.job || payload;
  if (typeof value?.id !== 'string' || typeof value?.status !== 'string') return null;
  return { job: parseMediaJob(value, apiKey) };
}

export interface GenerateImageInput {
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  steps?: number;
  seed?: string | number;
  server?: 'image' | 'video';
  responseFormat?: 'b64_json' | 'url';
  signal?: AbortSignal;
}

export interface EditImageInput extends GenerateImageInput {
  images: ImageUpload[];
  mask?: ImageUpload;
}

export interface ImageVariationInput extends Omit<GenerateImageInput, 'prompt'> {
  image: ImageUpload;
  model?: string;
  size?: string;
  n?: number;
  signal?: AbortSignal;
}

function imageControls(options: Partial<GenerateImageInput>): Record<string, unknown> {
  if (options.steps !== undefined && (!Number.isSafeInteger(options.steps) || options.steps < 1)) throw new Error('steps must be a positive integer.');
  if (options.seed !== undefined && (!/^(0|[1-9][0-9]{0,19})$/.test(String(options.seed))
    || (typeof options.seed === 'number' && !Number.isSafeInteger(options.seed)) || BigInt(options.seed) > 18446744073709551615n)) throw new Error('seed must be an exact unsigned 64-bit integer; use a decimal string for large seeds.');
  if (options.server !== undefined && !['image', 'video'].includes(options.server)) throw new Error('server must be image or video.');
  if (options.responseFormat !== undefined && !['b64_json', 'url'].includes(options.responseFormat)) throw new Error('responseFormat must be b64_json or url.');
  return Object.fromEntries(Object.entries({ steps: options.steps, seed: options.seed, server: options.server }).filter(([, value]) => value !== undefined));
}

async function resolveImageUrls(result: any, options: ProviderOptions): Promise<any> {
  if (!Array.isArray(result?.data)) return result;
  if (!result.data.length || result.data.length > MAX_IMAGES) throw new Error('The endpoint returned an invalid image count.');
  const data = [];
  let total = 0;
  for (const item of result.data) {
    if (!item?.b64_json && typeof item?.url === 'string') {
      const base = new URL(normalizeEaselBaseUrl(options.baseUrl));
      const url = new URL(item.url, base);
      if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error('Image downloads must stay on the configured origin.');
      const apiKey = options.apiKey || '';
      const media = await requestBinary(url.href, { headers: headers(apiKey, 'image/*'), signal: requestSignal(options.signal, 45_000) }, apiKey,
        options.fetchImpl || globalThis.fetch, Math.min(MAX_IMAGE_BYTES, MAX_INPUT_BYTES - total), { label: 'Image download', path: url.pathname });
      const mimeType = imageMimeType(media.bytes);
      if (!mimeType || (media.mimeType && media.mimeType !== mimeType)) throw new Error('The returned image bytes do not match their MIME type.');
      total += media.bytes.length;
      data.push({ ...item, b64_json: media.bytes.toString('base64') });
    } else {
      total += typeof item?.b64_json === 'string' ? Buffer.byteLength(item.b64_json, 'base64') : 0;
      data.push(item);
    }
    if (total > MAX_INPUT_BYTES) throw new Error('The returned images exceed the combined 32 MiB size limit.');
  }
  return { ...result, data };
}

export async function listModels(options: ProviderOptions = {}): Promise<string[]> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const apiKey = options.apiKey || '';
  const payload = await requestJson(
    `${normalizeEaselBaseUrl(options.baseUrl)}/v1/models`,
    { method: 'GET', headers: headers(apiKey), signal: requestSignal(options.signal, 30_000) },
    apiKey,
    fetchImpl,
  );
  if (!Array.isArray(payload?.data)) throw new Error('Easel returned an invalid model list.');
  const models = payload.data.map((item: any) => item?.id);
  if (models.some((id: unknown) => typeof id !== 'string' || !id.trim())) {
    throw new Error('Easel returned an invalid model identifier.');
  }
  return models;
}

export async function generateImages(options: GenerateImageInput & ProviderOptions): Promise<ImageResult> {
  options.signal?.throwIfAborted();
  const prompt = typeof options.prompt === 'string' ? options.prompt.trim() : '';
  if (!prompt) throw new Error('Prompt is required.');
  if (prompt.length > 5_000) throw new Error('Prompt must be at most 5000 characters.');
  if (options.model && options.model.length > 256) throw new Error('Model name is too long.');
  if (options.size && !/^\d{2,5}x\d{2,5}$/.test(options.size)) throw new Error('Size must use WIDTHxHEIGHT format.');
  const n = options.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) throw new Error(`Image count must be between 1 and ${MAX_IMAGES}.`);

  const payload: Record<string, unknown> = {
    prompt,
    n,
    ...imageControls(options),
  };
  if (!isGptImage(options.model)) payload.response_format = options.responseFormat || 'b64_json';
  if (options.model?.trim()) payload.model = options.model.trim();
  if (options.size) payload.size = options.size;

  const apiKey = options.apiKey || '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let result = await requestJson(
    `${normalizeEaselBaseUrl(options.baseUrl)}/v1/images/generations`,
    {
      method: 'POST',
      headers: { ...headers(apiKey), 'Content-Type': 'application/json', Prefer: 'respond-async' },
      body: JSON.stringify(payload),
      signal: requestSignal(options.signal, 180_000),
    },
    apiKey,
    fetchImpl,
  );
  const queued = queuedImageResult(result, apiKey);
  if (queued && !Array.isArray(result?.data)) return queued;
  result = await resolveImageUrls(result, options);
  if (!Array.isArray(result?.data) || result.data.length === 0) throw new Error('Easel returned no images.');
  if (result.data.length > MAX_IMAGES) throw new Error('Easel returned too many images.');

  return result.data.map((item: any) => {
    if (typeof item?.b64_json !== 'string' || item.b64_json.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.b64_json)) {
      throw new Error('Easel returned an invalid image payload.');
    }
    if (Buffer.byteLength(item.b64_json, 'base64') > MAX_IMAGE_BYTES) throw new Error('Easel image exceeds the size limit.');
    return { data: item.b64_json, mimeType: 'image/png' as const };
  });
}

function isGptImage(model?: string): boolean {
  return /^gpt-image-/i.test(model?.trim() || '') || /^chatgpt-image-latest$/i.test(model?.trim() || '');
}

function isDallE2(model?: string): boolean {
  return model?.trim().toLowerCase() === 'dall-e-2';
}

function validateImageOptions(options: { model?: string; size?: string; n?: number }, allowAuto: boolean): number {
  if (options.model !== undefined && (typeof options.model !== 'string' || options.model.length > 256)) {
    throw new Error('Model name must be a string of at most 256 characters.');
  }
  if (options.size !== undefined && !(allowAuto && options.size === 'auto') && !/^\d{2,5}x\d{2,5}$/.test(options.size)) {
    throw new Error(allowAuto ? 'Size must use WIDTHxHEIGHT format or auto.' : 'Size must use WIDTHxHEIGHT format.');
  }
  if (isDallE2(options.model) && options.size && !['256x256', '512x512', '1024x1024'].includes(options.size)) {
    throw new Error('dall-e-2 size must be 256x256, 512x512, or 1024x1024.');
  }
  const n = options.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) throw new Error(`Image count must be between 1 and ${MAX_IMAGES}.`);
  return n;
}

function parseEditedImages(result: any): EaselImage[] {
  if (!Array.isArray(result?.data) || !result.data.length) throw new Error('The media endpoint returned no images.');
  if (result.data.length > MAX_IMAGES) throw new Error('The media endpoint returned too many images.');
  let totalBytes = 0;
  return result.data.map((item: any) => {
    if (!item?.b64_json && typeof item?.url === 'string') {
      throw new Error('The media endpoint returned image URLs instead of base64 bytes; this tool requires b64_json output.');
    }
    const bytes = decodeBase64(item?.b64_json, MAX_IMAGE_BYTES, 'Returned image');
    totalBytes += bytes.length;
    if (totalBytes > MAX_INPUT_BYTES) throw new Error('The returned images exceed the combined 32 MiB size limit.');
    const mimeType = imageMimeType(bytes);
    if (!mimeType) throw new Error('The media endpoint returned unsupported image bytes; PNG, JPEG, or WebP is required.');
    return { data: item.b64_json, mimeType };
  });
}

async function requestImageUpload(
  options: ProviderOptions & Partial<GenerateImageInput>,
  form: FormData,
  operation: MediaOperation,
): Promise<ImageResult> {
  if (options.model?.trim()) form.append('model', options.model.trim());
  if (options.size) form.append('size', options.size);
  // GPT image models always return base64 and reject the legacy response_format field.
  if (!isGptImage(options.model)) form.append('response_format', options.responseFormat || 'b64_json');
  for (const [field, value] of Object.entries(imageControls(options))) form.append(field, String(value));
  const apiKey = options.apiKey || '';
  const result = await requestJson(
    `${normalizeEaselBaseUrl(options.baseUrl)}${operation.path}`,
    { method: 'POST', headers: { ...headers(apiKey), Prefer: 'respond-async' }, body: form, signal: requestSignal(options.signal, 180_000) },
    apiKey,
    options.fetchImpl || globalThis.fetch,
    operation,
  );
  options.signal?.throwIfAborted();
  return (!Array.isArray(result?.data) && queuedImageResult(result, apiKey)) || parseEditedImages(await resolveImageUrls(result, options));
}

export async function editImages(options: EditImageInput & ProviderOptions): Promise<ImageResult> {
  options.signal?.throwIfAborted();
  const prompt = typeof options.prompt === 'string' ? options.prompt.trim() : '';
  if (!prompt) throw new Error('Prompt is required.');
  if (prompt.length > 5_000) throw new Error('Prompt must be at most 5000 characters.');
  const n = validateImageOptions(options, true);
  if (!Array.isArray(options.images) || !options.images.length || options.images.length > MAX_IMAGE_INPUTS) {
    throw new Error(`Image editing requires between 1 and ${MAX_IMAGE_INPUTS} reference images.`);
  }
  let totalBytes = 0;
  const images = options.images.map((image, index) => {
    const decoded = decodeImageUpload(image, `Reference image ${index + 1}`, isDallE2(options.model) ? LEGACY_IMAGE_BYTES : MAX_INPUT_BYTES - totalBytes);
    totalBytes += decoded.bytes.length;
    return decoded;
  });
  if (isDallE2(options.model)) {
    if (images.length !== 1) throw new Error('dall-e-2 image editing accepts exactly one reference image.');
    if (prompt.length > 1_000) throw new Error('dall-e-2 edit prompts must be at most 1000 characters.');
    requireLegacyImage(images[0]!, 'Reference image');
  }
  const mask = options.mask ? decodeImageUpload(options.mask, 'Mask', Math.min(LEGACY_IMAGE_BYTES, MAX_INPUT_BYTES - totalBytes)) : undefined;
  if (mask) {
    if (mask.mimeType !== 'image/png' || mask.bytes.length >= LEGACY_IMAGE_BYTES) {
      throw new Error('Mask must be a PNG smaller than 4 MiB.');
    }
    if (mask.width !== images[0]!.width || mask.height !== images[0]!.height) {
      throw new Error('Mask dimensions must match the first reference image.');
    }
    totalBytes += mask.bytes.length;
  }
  if (totalBytes > MAX_INPUT_BYTES) throw new Error('Reference images and mask must total at most 32 MiB.');
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('n', String(n));
  const field = images.length === 1 ? 'image' : 'image[]';
  for (const image of images) appendImage(form, field, image);
  if (mask) appendImage(form, 'mask', mask);
  return requestImageUpload(options, form, { label: 'Image editing', path: '/v1/images/edits', model: options.model });
}

export async function createImageVariations(options: ImageVariationInput & ProviderOptions): Promise<ImageResult> {
  options.signal?.throwIfAborted();
  const n = validateImageOptions(options, false);
  const image = decodeImageUpload(options.image, 'Variation image', isDallE2(options.model) ? LEGACY_IMAGE_BYTES : MAX_IMAGE_BYTES);
  if (isDallE2(options.model)) requireLegacyImage(image, 'Variation image');
  const form = new FormData();
  form.append('n', String(n));
  appendImage(form, 'image', image);
  return requestImageUpload(options, form, { label: 'Image variations', path: '/v1/images/variations', model: options.model });
}

export async function getImageJob(options: ProviderOptions & { jobId: string; model?: string; signal?: AbortSignal }): Promise<{ job: MediaJob; images?: EaselImage[] }> {
  if (!MEDIA_JOB_ID_PATTERN.test(options.jobId)) throw new Error('Use the exact queued image job ID from the submission receipt.');
  const apiKey = options.apiKey || '';
  const endpoint = '/v1/images/jobs/' + encodeURIComponent(options.jobId);
  const payload = await requestJson(normalizeEaselBaseUrl(options.baseUrl) + endpoint,
    { method: 'GET', headers: headers(apiKey), signal: requestSignal(options.signal, 45000) }, apiKey, options.fetchImpl || globalThis.fetch,
    { label: 'Queued image retrieval', path: endpoint, model: options.model });
  const job = parseMediaJob(payload.job || payload, apiKey, options.jobId);
  return { job, ...(job.status === 'completed' ? { images: parseEditedImages(await resolveImageUrls(payload, options)) } : {}) };
}

export async function getImageContent(options: ProviderOptions & { url: string }): Promise<EaselImage[]> {
  return parseEditedImages(await resolveImageUrls({ data: [{ url: options.url }] }, options));
}
