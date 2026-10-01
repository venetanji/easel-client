const OpenAI = require('openai');
const { abortError, combinedSignal, isTurnAbort, throwIfAborted } = require('./turn-abort');

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

function toResponsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      if (typeof message.content === 'string' && message.content) {
        input.push({
          role: message.role,
          content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.content }],
        });
      } else if (message.role === 'user' && Array.isArray(message.content)) {
        const content = message.content.map((part) => {
          if (part?.type === 'text' && typeof part.text === 'string') return { type: 'input_text', text: part.text };
          if (part?.type === 'image' && typeof part.data === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(part.mimeType)) {
            return { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}` };
          }
          if (part?.type === 'audio' && typeof part.data === 'string' && ['audio/mpeg', 'audio/wav'].includes(part.mimeType)) {
            return {
              type: 'input_audio',
              input_audio: { data: part.data, format: part.mimeType === 'audio/mpeg' ? 'mp3' : 'wav' },
            };
          }
          throw new Error('Unsupported LiteLLM media content.');
        });
        input.push({ role: message.role, content });
      }
      if (message.role === 'assistant') {
        for (const call of message.tool_calls || []) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
      }
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      continue;
    }
    throw new Error(`Unsupported LiteLLM message role: ${String(message.role)}`);
  }
  return input;
}

function toResponsesTools(tools = []) {
  return tools
    .filter((tool) => tool.type === 'function' && tool.function)
    .map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {}, additionalProperties: false },
      // These schemas allow omitted optional fields; do not require fabricated values.
      strict: false,
    }));
}

async function collectStreamedCompletion(stream, { signal, onText } = {}) {
  let completedResponse;
  let text = '';
  const streamedFunctionCalls = new Map();
  const stop = () => stream.controller?.abort();
  signal?.addEventListener('abort', stop, { once: true });
  try {
  if (signal?.aborted) stop();
  throwIfAborted(signal);
  for await (const event of stream) {
    throwIfAborted(signal);
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      text += event.delta || '';
      onText?.(text);
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      streamedFunctionCalls.set(event.output_index, event.item);
    } else if (event.type === 'response.function_call_arguments.delta') {
      const item = streamedFunctionCalls.get(event.output_index);
      if (item) item.arguments = `${item.arguments || ''}${event.delta || ''}`;
    } else if (event.type === 'response.function_call_arguments.done') {
      const item = streamedFunctionCalls.get(event.output_index);
      if (item) item.arguments = event.arguments;
    } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      streamedFunctionCalls.set(event.output_index, event.item);
    } else if (event.type === 'response.failed') {
      throw new Error(event.response?.error?.message || 'LiteLLM Responses request failed.');
    } else if (event.type === 'response.completed') {
      completedResponse = event.response;
    }
  }
  if (signal?.aborted || stream.controller?.signal?.aborted) throw abortError(signal, text);
  } catch (error) {
    if (isTurnAbort(error, signal)) throw abortError(signal, text);
    throw error;
  } finally { signal?.removeEventListener('abort', stop); }

  const output = Array.isArray(completedResponse?.output) && completedResponse.output.length
    ? completedResponse.output
    : [...streamedFunctionCalls.values()];
  const responseText = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text' || item.type === 'refusal')
    .map((item) => item.text || '')
    .join('') || text;
  const toolCalls = output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      id: item.call_id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments || '{}' },
    }));

  if (!responseText && toolCalls.length === 0) {
    const reason = completedResponse?.incomplete_details?.reason;
    throw new Error(reason ? `LiteLLM returned an incomplete response: ${reason}.` : 'LiteLLM returned no message or tool call.');
  }

  return {
    choices: [{
      index: 0,
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: responseText || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    }],
  };
}

function createLiteLLMClient({
  baseUrl,
  apiKey = '',
  model,
  fetchImpl = globalThis.fetch,
  openAIClientFactory = (options) => new OpenAI(options),
  signal: turnSignal,
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
    async createCompletion({ messages, instructions, tools, signal: requestSignal, onText } = {}) {
      const signal = combinedSignal(turnSignal, requestSignal);
      if (!Array.isArray(messages) || messages.length === 0) throw new Error('Chat messages are required.');
      try {
        throwIfAborted(signal);
        const stream = await client.responses.create({
          model: cleanModel,
          input: toResponsesInput(messages),
          ...(typeof instructions === 'string' && instructions ? { instructions } : {}),
          ...(Array.isArray(tools) && tools.length ? { tools: toResponsesTools(tools) } : {}),
          stream: true,
        }, signal ? { signal } : undefined);
        if (signal?.aborted) { stream.controller?.abort(); throw abortError(signal); }
        return await collectStreamedCompletion(stream, { signal, onText: onText ? (text) => onText(redact(text, key)) : undefined });
      } catch (error) {
        if (isTurnAbort(error, signal)) throw abortError(signal, error.partialText ? redact(error.partialText, key) : undefined);
        throw new Error(redact(error, key));
      }
    },
  };
}

module.exports = {
  DEFAULT_LITELLM_BASE_URL,
  createLiteLLMClient,
  normalizeLiteLLMBaseUrl,
  toResponsesInput,
  toResponsesTools,
  collectStreamedCompletion,
};
