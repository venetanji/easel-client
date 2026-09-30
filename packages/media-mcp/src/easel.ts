import {
  MAX_IMAGE_BYTES, MAX_IMAGE_INPUTS, MAX_INPUT_BYTES, LEGACY_IMAGE_BYTES,
  appendImage, decodeBase64, decodeImageUpload, imageMimeType, requireLegacyImage,
  type ImageMimeType, type ImageUpload,
} from './image-upload.js';

import { headers, normalizeEaselBaseUrl, requestJson, requestSignal, type MediaOperation, type ProviderOptions } from './media-http.js';
export { DEFAULT_EASEL_BASE_URL, normalizeEaselBaseUrl } from './media-http.js';

export interface EaselImage {
  data: string;
  mimeType: ImageMimeType;
}

const MAX_IMAGES = 4;

export interface GenerateImageInput {
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  signal?: AbortSignal;
}

export interface EditImageInput extends GenerateImageInput {
  images: ImageUpload[];
  mask?: ImageUpload;
}

export interface ImageVariationInput {
  image: ImageUpload;
  model?: string;
  size?: string;
  n?: number;
  signal?: AbortSignal;
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

export async function generateImages(options: GenerateImageInput & ProviderOptions): Promise<EaselImage[]> {
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
  };
  if (!isGptImage(options.model)) payload.response_format = 'b64_json';
  if (options.model?.trim()) payload.model = options.model.trim();
  if (options.size) payload.size = options.size;

  const apiKey = options.apiKey || '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const result = await requestJson(
    `${normalizeEaselBaseUrl(options.baseUrl)}/v1/images/generations`,
    {
      method: 'POST',
      headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: requestSignal(options.signal, 180_000),
    },
    apiKey,
    fetchImpl,
  );
  if (!Array.isArray(result?.data) || result.data.length === 0) throw new Error('Easel returned no images.');
  if (result.data.length > MAX_IMAGES) throw new Error('Easel returned too many images.');

  return result.data.map((item: any) => {
    if (typeof item?.b64_json !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.b64_json)) {
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
  options: ProviderOptions & { model?: string; size?: string },
  form: FormData,
  operation: MediaOperation,
): Promise<EaselImage[]> {
  if (options.model?.trim()) form.append('model', options.model.trim());
  if (options.size) form.append('size', options.size);
  // GPT image models always return base64 and reject the legacy response_format field.
  if (!isGptImage(options.model)) form.append('response_format', 'b64_json');
  const apiKey = options.apiKey || '';
  const result = await requestJson(
    `${normalizeEaselBaseUrl(options.baseUrl)}${operation.path}`,
    { method: 'POST', headers: headers(apiKey), body: form, signal: requestSignal(options.signal, 180_000) },
    apiKey,
    options.fetchImpl || globalThis.fetch,
    operation,
  );
  options.signal?.throwIfAborted();
  return parseEditedImages(result);
}

export async function editImages(options: EditImageInput & ProviderOptions): Promise<EaselImage[]> {
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

export async function createImageVariations(options: ImageVariationInput & ProviderOptions): Promise<EaselImage[]> {
  options.signal?.throwIfAborted();
  const n = validateImageOptions(options, false);
  const image = decodeImageUpload(options.image, 'Variation image', isDallE2(options.model) ? LEGACY_IMAGE_BYTES : MAX_IMAGE_BYTES);
  if (isDallE2(options.model)) requireLegacyImage(image, 'Variation image');
  const form = new FormData();
  form.append('n', String(n));
  appendImage(form, 'image', image);
  return requestImageUpload(options, form, { label: 'Image variations', path: '/v1/images/variations', model: options.model });
}
