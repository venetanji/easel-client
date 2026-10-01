const DEFAULT_API_URL = 'http://127.0.0.1:8000';

function normalizeBaseUrl(value = '') {
  const candidate = value.trim() || DEFAULT_API_URL;
  const url = new URL(candidate);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Easel URL must use http or https.');
  }

  if (url.username || url.password) {
    throw new Error('Easel URL must not include credentials.');
  }

  url.search = '';
  url.hash = '';

  const pathname = url.pathname.replace(/\/+$/, '');
  const normalizedPath = pathname.endsWith('/v1') ? pathname.slice(0, -3) : pathname;

  url.pathname = normalizedPath || '/';
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
}

function buildHeaders(apiKey = '') {
  const headers = {
    'Content-Type': 'application/json',
  };
  const token = apiKey.trim();
  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }
  return headers;
}

function createGenerationPayload({ prompt, model, size, n }) {
  const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  if (!cleanPrompt) {
    throw new Error('Prompt is required.');
  }

  const payload = {
    prompt: cleanPrompt,
    response_format: 'b64_json',
  };

  if (typeof model === 'string' && model.trim()) {
    payload.model = model.trim();
  }

  if (typeof size === 'string' && size.trim()) {
    payload.size = size.trim();
  }

  const imageCount = Number.parseInt(n, 10);
  if (Number.isInteger(imageCount) && imageCount > 1) {
    payload.n = imageCount;
  }

  return payload;
}

function normalizeRemoteImageUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function extractImageSources(payload) {
  if (!payload || !Array.isArray(payload.data)) {
    return [];
  }

  return payload.data.flatMap((item) => {
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      return [`data:image/png;base64,${item.b64_json}`];
    }

    if (typeof item?.url === 'string' && item.url) {
      const safeUrl = normalizeRemoteImageUrl(item.url);
      return safeUrl ? [safeUrl] : [];
    }

    return [];
  });
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json();
    const message = payload?.error?.message || payload?.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  } catch {
    return `Request failed with status ${response.status}.`;
  }

  return `Request failed with status ${response.status}.`;
}

async function generateImages({ baseUrl, apiKey, prompt, model, size, n, fetchImpl }) {
  const requestImpl = fetchImpl || globalThis.fetch;
  if (typeof requestImpl !== 'function') {
    throw new Error('No fetch implementation available.');
  }

  const response = await requestImpl(`${normalizeBaseUrl(baseUrl)}/v1/images/generations`, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(createGenerationPayload({ prompt, model, size, n })),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = await response.json();
  const sources = extractImageSources(payload);
  if (!sources.length) {
    throw new Error('Easel returned no images.');
  }

  return sources;
}

module.exports = {
  DEFAULT_API_URL,
  buildHeaders,
  createGenerationPayload,
  extractImageSources,
  generateImages,
  normalizeRemoteImageUrl,
  normalizeBaseUrl,
};
