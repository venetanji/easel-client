export const DEFAULT_EASEL_BASE_URL = 'https://easel.ait4x.org';
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: Fetch;
  signal?: AbortSignal;
}

export interface MediaOperation { label: string; path: string; model?: string }

export function normalizeEaselBaseUrl(value = ''): string {
  const candidate = value.trim() || DEFAULT_EASEL_BASE_URL;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error('Easel URL must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Easel URL must use HTTP(S).');
  if (url.username || url.password) throw new Error('Easel URL must not contain embedded credentials.');
  if (url.search || url.hash) throw new Error('Easel URL must not contain a query or fragment.');
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/v1')) pathname = pathname.slice(0, -3);
  return `${url.origin}${pathname}`;
}

export function headers(apiKey = '', accept = 'application/json'): Record<string, string> {
  const result: Record<string, string> = { Accept: accept };
  if (apiKey.trim()) result.Authorization = `Bearer ${apiKey.trim()}`;
  return result;
}

export function safeErrorMessage(value: unknown, apiKey: string, status: number): string {
  const message = typeof value === 'string' && value.trim() ? value.trim() : `Easel request failed (${status}).`;
  return [...new Set([apiKey, apiKey.trim()])].filter(Boolean)
    .reduce((safe, secret) => safe.split(secret).join('[redacted]'), message).slice(0, 2_000);
}

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function operationError(operation: MediaOperation | undefined, status: number, detail: string): Error {
  if (!operation) return new Error(detail);
  const model = operation.model?.trim() ? ` for model ${JSON.stringify(operation.model.trim())}` : '';
  if ([404, 405, 501].includes(status)) {
    return new Error(`The configured endpoint does not support ${operation.label.toLowerCase()} at ${operation.path}${model} (HTTP ${status}). ${detail}`);
  }
  return new Error(`${operation.label} failed${model} (HTTP ${status}): ${detail}`);
}

async function request(url: string, init: RequestInit, fetchImpl: Fetch, operation?: MediaOperation): Promise<Response> {
  init.signal?.throwIfAborted();
  try {
    // Credentials are only sent to the configured endpoint, never to redirect targets.
    return await fetchImpl(url, { ...init, redirect: 'error' });
  } catch {
    init.signal?.throwIfAborted();
    throw new Error(operation ? `Could not reach the configured media endpoint for ${operation.label.toLowerCase()} (redirects are not followed).` : 'Could not reach the configured Easel server.');
  }
}

async function jsonResponse(response: Response, signal: AbortSignal | null | undefined, apiKey: string, operation?: MediaOperation): Promise<any> {
  let payload: any;
  try { payload = await response.json(); } catch {
    signal?.throwIfAborted();
    if (!response.ok) throw operationError(operation, response.status, `Easel request failed (${response.status}).`);
    throw new Error('Easel returned invalid JSON.');
  }
  signal?.throwIfAborted();
  if (!response.ok) throw operationError(operation, response.status, safeErrorMessage(payload?.error?.message || payload?.message || payload?.detail, apiKey, response.status));
  return payload;
}

export async function requestJson(url: string, init: RequestInit, apiKey: string, fetchImpl: Fetch, operation?: MediaOperation): Promise<any> {
  return jsonResponse(await request(url, init, fetchImpl, operation), init.signal, apiKey, operation);
}

export async function requestBinary(url: string, init: RequestInit, apiKey: string, fetchImpl: Fetch, limit: number, operation: MediaOperation): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await request(url, init, fetchImpl, operation);
  if (!response.ok) await jsonResponse(response, init.signal, apiKey, operation);
  const length = Number(response.headers.get('content-length'));
  if (length > limit) { await response.body?.cancel(); throw new Error(`Returned media exceeds the ${limit / 1_048_576} MiB limit.`); }
  if (!response.body) throw new Error('The media endpoint returned no content.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      init.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error(`Returned media exceeds the ${limit / 1_048_576} MiB limit.`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  init.signal?.throwIfAborted();
  if (!total) throw new Error('The media endpoint returned empty content.');
  if (response.headers.has('content-length') && total !== length) throw new Error('The media endpoint returned truncated content.');
  return { bytes: Buffer.concat(chunks, total), mimeType: (response.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase() };
}
