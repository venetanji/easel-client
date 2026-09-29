const OpenAI = require('openai');

const DEFAULT_LITELLM_BASE_URL = 'http://127.0.0.1:4000/v1';
const NO_AUTH_API_KEY = 'easel-client-no-auth';

function normalizeLiteLLMBaseUrl(value = '') {
  const candidate = value.trim() || DEFAULT_LITELLM_BASE_URL;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('LiteLLM URL must be a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('LiteLLM URL must use HTTP(S).');
  if (url.username || url.password) throw new Error('LiteLLM URL must not contain embedded credentials.');
  if (url.search || url.hash) throw new Error('LiteLLM URL must not contain a query or fragment.');

  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/v1')) pathname = `${pathname}/v1`;
  return `${url.origin}${pathname}`;
}

function redact(value, secret) {
  const text = value instanceof Error ? value.message : String(value);
  return secret ? text.split(secret).join('[redacted]') : text;
}

function createLiteLLMClient({
  baseUrl,
  apiKey = '',
  model,
  fetchImpl = globalThis.fetch,
  openAIClientFactory = (options) => new OpenAI(options),
}) {
  const normalizedBaseUrl = normalizeLiteLLMBaseUrl(baseUrl || '');
  const cleanModel = typeof model === 'string' ? model.trim() : '';
  if (!cleanModel) throw new Error('LiteLLM model is required.');
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  const requestFetch = key ? fetchImpl : async (input, init = {}) => {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.delete('authorization');
    return fetchImpl(input, { ...init, headers });
  };
  const client = openAIClientFactory({
    baseURL: normalizedBaseUrl,
    apiKey: key || NO_AUTH_API_KEY,
    fetch: requestFetch,
    maxRetries: 0,
    timeout: 120_000,
  });

  return {
    model: cleanModel,
    baseUrl: normalizedBaseUrl,
    async createCompletion({ messages, tools, signal } = {}) {
      if (!Array.isArray(messages) || messages.length === 0) throw new Error('Chat messages are required.');
      try {
        return await client.chat.completions.create({
          model: cleanModel,
          messages,
          ...(Array.isArray(tools) && tools.length ? { tools } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw new Error(redact(error, key));
      }
    },
  };
}

module.exports = {
  DEFAULT_LITELLM_BASE_URL,
  createLiteLLMClient,
  normalizeLiteLLMBaseUrl,
};
