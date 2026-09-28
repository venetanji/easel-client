const { contextBridge } = require('electron');
const { DEFAULT_API_URL, generateImages: requestImages, normalizeBaseUrl } = require('./easel-api');

function generateImages(options = {}) {
  const payload = {
    baseUrl: normalizeBaseUrl(typeof options.baseUrl === 'string' ? options.baseUrl : ''),
    apiKey: typeof options.apiKey === 'string' ? options.apiKey : '',
    prompt: typeof options.prompt === 'string' ? options.prompt : '',
    model: typeof options.model === 'string' ? options.model : '',
    size: typeof options.size === 'string' ? options.size : '',
    n: typeof options.n === 'number' || typeof options.n === 'string' ? options.n : undefined,
  };

  return requestImages(payload);
}

contextBridge.exposeInMainWorld('easelClient', Object.freeze({
  defaults: Object.freeze({
    baseUrl: DEFAULT_API_URL,
  }),
  generateImages,
}));
