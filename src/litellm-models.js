const OpenAI = require('openai');
const { normalizeLiteLLMBaseUrl } = require('./litellm-client');

const NO_AUTH_API_KEY = 'easel-client-no-auth';

function normalizeModelCatalog(response) {
  const entries = Array.isArray(response) ? response : response?.data;
  if (!Array.isArray(entries)) throw new Error('LiteLLM returned an invalid model catalog.');
  const seen = new Set();
  return entries.flatMap((entry) => {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    return [{ id, name }];
  });
}

function createLiteLLMModelService({
  settingsStore,
  openAIClientFactory = (options) => new OpenAI(options),
  fetchImpl = globalThis.fetch,
}) {
  function createClient() {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
    const settings = settingsStore.loadPublic();
    const secrets = settingsStore.loadSecrets();
    const apiKey = typeof secrets.litellmApiKey === 'string' ? secrets.litellmApiKey.trim() : '';
    const requestFetch = apiKey ? fetchImpl : async (input, init = {}) => {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.delete('authorization');
      return fetchImpl(input, { ...init, headers });
    };
    return {
      apiKey,
      client: openAIClientFactory({
        baseURL: normalizeLiteLLMBaseUrl(settings.litellmBaseUrl || ''),
        apiKey: apiKey || NO_AUTH_API_KEY,
        fetch: requestFetch,
        maxRetries: 0,
        timeout: 30_000,
      }),
    };
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
    async listModels() {
      const { client, apiKey } = createClient();
      try {
        return normalizeModelCatalog(await client.models.list());
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
