const { contextBridge } = require('electron');
const { DEFAULT_API_URL, generateImages } = require('./easel-api');

contextBridge.exposeInMainWorld('easelClient', {
  defaults: {
    baseUrl: DEFAULT_API_URL,
  },
  generateImages,
});
