const OpenAI = require('openai');
const { normalizeLiteLLMBaseUrl } = require('./litellm-client');

const NO_AUTH_API_KEY = 'easel-client-no-auth';

function normalizeModelCatalog(response) {
  const entries = Array.isArray(response) ? response : response?.data;
  if (!Array.isArray(entries)) throw new Error('LiteLLM returned an invalid model catalog.');
  const seen = new Set();
  return entries.flatMap((entry) => {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || id.length > 256 || seen.has(id)) return [];
    seen.add(id);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    const outputModalities = entry.architecture?.output_modalities || entry.output_modalities;
    if (Array.isArray(outputModalities)) {
      const suggestedMediaTypes = ['image', 'video', 'audio'].filter((type) => outputModalities.includes(type));
      return [{ id, name, suggestedRoles: ['agent', 'media'].filter((role) => role === 'agent' ? outputModalities.includes('text') : suggestedMediaTypes.length > 0), ...(suggestedMediaTypes.length ? { suggestedMediaTypes } : {}) }];
    }
    const mode = entry.mode || entry.model_info?.mode || '';
    const nonGenerative = ['embedding', 'rerank', 'transcription'].includes(mode)
      || (!mode && /(?:^|[/_-])(?:whisper|embedding)(?:[/_.-]|$)/i.test(id));
    if (nonGenerative) return [{ id, name, suggestedRoles: [] }];
    const mediaType = ['video_generation', 'video'].includes(mode) ? 'video'
      : ['audio_generation', 'audio', 'speech', 'tts'].includes(mode) ? 'audio'
      : ['image_generation', 'image'].includes(mode) ? 'image'
      : !mode && /(?:^|[/_-])(?:ltx|sora|veo|wan|hunyuan-video)(?:[/_.-]|$)/i.test(id) ? 'video'
      : !mode && /(?:^|[/_-])(?:tts|kokoro|musicgen|suno|lyria)(?:[/_.-]|$)/i.test(id) ? 'audio'
      : !mode && /(?:image|dall-e|flux|sdxl|stable-diffusion)/i.test(id) ? 'image' : '';
    return [{ id, name, suggestedRoles: [mediaType ? 'media' : 'agent'], ...(mediaType ? { suggestedMediaTypes: [mediaType] } : {}) }];
  });
}

function createLiteLLMModelService({
  settingsStore,
  openAIClientFactory = (options) => new OpenAI(options),
  fetchImpl = globalThis.fetch,
}) {
  function isOpenRouterEndpoint(baseUrl) {
    return ['openrouter.ai', 'eu.openrouter.ai', 'us.openrouter.ai'].includes(new URL(baseUrl).hostname);
  }

  function createClient(connection, timeout = 30_000) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
    const settings = settingsStore.loadPublic();
    const secrets = settingsStore.loadSecrets(connection?.id);
    const apiKey = typeof secrets.litellmApiKey === 'string' ? secrets.litellmApiKey.trim() : '';
    const baseUrl = normalizeLiteLLMBaseUrl(connection?.baseUrl || settings.litellmBaseUrl || '');
    const requestFetch = apiKey ? fetchImpl : async (input, init = {}) => {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.delete('authorization');
      return fetchImpl(input, { ...init, headers });
    };
    return {
      apiKey,
      baseUrl,
      client: openAIClientFactory({
        baseURL: baseUrl,
        apiKey: apiKey || NO_AUTH_API_KEY,
        fetch: requestFetch,
        maxRetries: 0,
        timeout,
      }),
    };
  }

  async function discoverModels({ client, apiKey, baseUrl }) {
    if (isOpenRouterEndpoint(baseUrl)) {
      if (!apiKey) throw new Error('OpenRouter requires a saved API key to list the models available to this credential.');
      // The public /models catalog does not apply key guardrails. Include media too.
      return normalizeModelCatalog(await client.get('/models/user', { query: { output_modalities: 'all' }, headers: { 'Cache-Control': 'no-cache' } }));
    }
    return normalizeModelCatalog(await client.models.list({ headers: { 'Cache-Control': 'no-cache' } }));
  }

  async function runProbe(model, operation) {
    const cleanModel = typeof model === 'string' ? model.trim() : '';
    if (!cleanModel) throw new Error('LiteLLM model is required.');
    if (cleanModel.length > 256) throw new Error('LiteLLM model is too long.');
    const { client, apiKey } = createClient();
    try {
      await operation(client, cleanModel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(apiKey ? message.split(apiKey).join('[redacted]') : message);
    }
  }

  return {
    async checkCapabilities(selection) {
      const settings = settingsStore.loadPublic();
      const connection = settings.connections.find((entry) => entry.id === selection.connectionId);
      if (!connection) throw new Error('Endpoint was not found.');
      const entry = settings.models?.find((entry) => entry.connectionId === selection.connectionId && entry.model === selection.model);
      const mediaTypes = entry?.discoveryMediaTypes || entry?.mediaTypes || [];
      const nonImageMedia = mediaTypes.length && !mediaTypes.includes('image');
      const connectionRevision = settingsStore.getConnectionRevision?.(connection.id);
      const { client, apiKey } = createClient(connection, 180_000);
      async function probe(operation) {
        try {
          return await operation();
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          const parameterError = /(?:size|resolution|response_format|tool_choice).*(?:unsupported|not supported|only supports)|(?:unsupported|not supported).*(?:size|resolution|response_format|tool_choice)/i.test(raw);
          const unsupported = [404, 405].includes(error?.status)
            || (!parameterError && [400, 422].includes(error?.status) && /(?:does not support|not supported|unsupported (?:model|mode|endpoint)|invalid model|model.*not found|not (?:an? )?(?:image|chat|text) model|only supports)/i.test(raw));
          const status = unsupported ? 'unsupported' : 'unknown';
          return { status, message: (apiKey ? raw.split(apiKey).join('[redacted]') : raw).slice(0, 500) };
        }
      }
      const [agent, media] = await Promise.all([
        nonImageMedia && !entry?.discoveryRoles?.includes('agent')
          ? Promise.resolve({ status: 'unsupported', message: 'Discovery categorizes this model as media output, without text/agent support.' }) : probe(async () => {
          const response = await client.responses.create({
            model: selection.model,
            input: 'Call confirm_connection with no arguments to confirm tool calling works.',
            tools: [{ type: 'function', name: 'confirm_connection', description: 'Confirm this connection.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
            tool_choice: { type: 'function', name: 'confirm_connection' },
          });
          const hasToolCall = response.output?.some((item) => item.type === 'function_call' && item.name === 'confirm_connection');
          return { status: hasToolCall ? 'supported' : 'unknown', message: hasToolCall ? 'Responses API and tool calling confirmed.' : 'The endpoint did not return the requested tool call. Try checking again.' };
        }),
        nonImageMedia ? Promise.resolve({ status: 'unknown', message: `${mediaTypes.join(' and ')} generation is advertised by discovery. Image generation was not probed. Use an actual generation to confirm endpoint support; no video/audio job is billed by this check.` }) : probe(async () => {
          const response = await client.images.generate({ model: selection.model, prompt: 'A small blue dot on a plain white background.', size: '1024x1024', n: 1, response_format: 'b64_json' });
          const hasImage = response.data?.some((item) => {
            if (typeof item.b64_json === 'string' && item.b64_json && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.b64_json)) return true;
            return false;
          });
          return { status: hasImage ? 'supported' : 'unknown', message: hasImage ? 'Image generation with base64 output confirmed.' : 'The endpoint returned no usable base64 image. This is required by the media tools.' };
        }),
      ]);
      if (connectionRevision !== settingsStore.getConnectionRevision?.(connection.id)) {
        throw new Error('Endpoint credentials changed during the capability check. Check this model again with the new credentials.');
      }
      return settingsStore.recordCapabilities(selection, { agent, media, ...(media.status === 'supported' ? { mediaTypes: [...new Set([...mediaTypes, 'image'])] } : mediaTypes.length ? { mediaTypes } : {}) });
    },
    async getCatalog() {
      const { connections = [] } = settingsStore.loadPublic();
      const revisions = new Map();
      const catalog = await Promise.all(connections.map(async (connection) => {
        let apiKey = '';
        try {
          revisions.set(connection.id, settingsStore.getConnectionRevision?.(connection.id));
          const created = createClient(connection);
          apiKey = created.apiKey;
          const models = await discoverModels(created);
          return { connectionId: connection.id, models, error: '' };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { connectionId: connection.id, models: [], error: (apiKey ? message.split(apiKey).join('[redacted]') : message).slice(0, 500) };
        }
      }));
      for (const result of catalog) {
        if (revisions.get(result.connectionId) !== settingsStore.getConnectionRevision?.(result.connectionId)) {
          result.models = [];
          result.error = 'Endpoint credentials changed during refresh. Refresh again to discover models for the new credentials.';
        }
      }
      return { catalog, settings: settingsStore.recordModels(catalog) };
    },
    async listModels() {
      const created = createClient();
      const { apiKey } = created;
      try {
        return await discoverModels(created);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(apiKey ? message.split(apiKey).join('[redacted]') : message);
      }
    },
    async testChat(model) {
      await runProbe(model, async (client, selected) => {
        const response = await client.responses.create({
          model: selected,
          input: 'Reply with a short confirmation that this LiteLLM connection works.',
        });
        if (!(typeof response?.output_text === 'string' && response.output_text.trim())) {
          throw new Error('LiteLLM returned no text response.');
        }
      });
      return { ok: true, message: 'Text response received.' };
    },
    async testImage(model) {
      await runProbe(model, async (client, selected) => {
        const response = await client.images.generate({
          model: selected,
          prompt: 'A simple blue circle on a plain white background.',
          size: '1024x1024',
        });
        const hasImagePayload = (response?.data || []).some((item) => {
          if (typeof item?.b64_json === 'string' && item.b64_json.trim()) return true;
          if (typeof item?.url !== 'string') return false;
          try {
            return ['http:', 'https:'].includes(new URL(item.url).protocol);
          } catch {
            return false;
          }
        });
        if (!hasImagePayload) throw new Error('LiteLLM returned no image payload.');
      });
      return { ok: true, message: 'Image generation response received.' };
    },
  };
}

module.exports = { createLiteLLMModelService, normalizeModelCatalog };
