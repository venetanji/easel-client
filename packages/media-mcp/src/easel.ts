export const DEFAULT_EASEL_BASE_URL = 'https://easel.ait4x.org';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface EaselImage {
  data: string;
  mimeType: 'image/png';
}

export function normalizeEaselBaseUrl(value = ''): string {
  const candidate = value.trim() || DEFAULT_EASEL_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Easel URL must be a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Easel URL must use HTTP(S).');
  if (url.username || url.password) throw new Error('Easel URL must not contain embedded credentials.');
  if (url.search || url.hash) throw new Error('Easel URL must not contain a query or fragment.');

  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/v1')) pathname = pathname.slice(0, -3);
  return `${url.origin}${pathname}`;
}

function headers(apiKey = ''): Record<string, string> {
  const result: Record<string, string> = { Accept: 'application/json' };
  if (apiKey.trim()) result.Authorization = `Bearer ${apiKey.trim()}`;
  return result;
}

function safeErrorMessage(value: unknown, apiKey: string, status: number): string {
  const message = typeof value === 'string' && value.trim() ? value.trim() : `Easel request failed (${status}).`;
  return apiKey ? message.split(apiKey).join('[redacted]') : message;
}

async function requestJson(url: string, init: RequestInit, apiKey: string, fetchImpl: Fetch): Promise<any> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new Error('Could not reach the configured Easel server.');
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw new Error(`Easel request failed (${response.status}).`);
    throw new Error('Easel returned invalid JSON.');
  }

  if (!response.ok) {
    throw new Error(safeErrorMessage(payload?.error?.message || payload?.message, apiKey, response.status));
  }
  return payload;
}

export async function listModels(options: {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: Fetch;
} = {}): Promise<string[]> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const apiKey = options.apiKey || '';
  const payload = await requestJson(
    `${normalizeEaselBaseUrl(options.baseUrl)}/v1/models`,
    { method: 'GET', headers: headers(apiKey), signal: AbortSignal.timeout(30_000) },
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

export async function generateImages(options: {
  baseUrl?: string;
  apiKey?: string;
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  fetchImpl?: Fetch;
}): Promise<EaselImage[]> {
  const prompt = typeof options.prompt === 'string' ? options.prompt.trim() : '';
  if (!prompt) throw new Error('Prompt is required.');
  if (prompt.length > 5_000) throw new Error('Prompt must be at most 5000 characters.');
  if (options.model && options.model.length > 200) throw new Error('Model name is too long.');
  if (options.size && !/^\d{2,5}x\d{2,5}$/.test(options.size)) throw new Error('Size must use WIDTHxHEIGHT format.');
  const n = options.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) throw new Error(`Image count must be between 1 and ${MAX_IMAGES}.`);

  const payload: Record<string, unknown> = {
    prompt,
    response_format: 'b64_json',
    n,
  };
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
      signal: AbortSignal.timeout(180_000),
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
