const path = require('node:path');
const { runAgentTurn } = require('./agent');
const { createLiteLLMClient } = require('./litellm-client');
const { createMediaMcpClient } = require('./media-mcp-client');
const { validateChatMessage } = require('./ipc-contract');

function defaultMcpLaunchOptions(settings, secrets, { isPackaged = false, resourcesPath = '' } = {}) {
  const appRoot = path.resolve(__dirname, '..');
  const serverEntry = isPackaged
    ? path.join(resourcesPath, 'app.asar.unpacked/packages/media-mcp/dist/cli.js')
    : path.join(appRoot, 'packages/media-mcp/dist/cli.js');
  return {
    command: process.execPath,
    args: [serverEntry],
    cwd: appRoot,
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      NODE_PATH: isPackaged
        ? path.join(resourcesPath, 'app.asar/node_modules')
        : path.join(appRoot, 'node_modules'),
      ELECTRON_RUN_AS_NODE: '1',
      EASEL_BASE_URL: settings.easelBaseUrl,
      EASEL_API_KEY: secrets.easelApiKey || '',
    },
  };
}

function createChatService({
  settingsStore,
  assetStore,
  llmFactory = createLiteLLMClient,
  mcpFactory = createMediaMcpClient,
  mcpLaunchOptions = defaultMcpLaunchOptions,
  runtime = {},
  presentCanvas,
  onEvent,
}) {
  const history = [];
  let busy = false;

  async function sendMessage(input) {
    const userMessage = validateChatMessage(input);
    if (busy) throw new Error('A chat turn is already running.');
    busy = true;
    try {
      const settings = settingsStore.loadPublic();
      const secrets = settingsStore.loadSecrets();
      if (!settings.litellmModel) throw new Error('LiteLLM model is required; configure it in Settings before chatting.');
      const llm = llmFactory({
        baseUrl: settings.litellmBaseUrl,
        apiKey: secrets.litellmApiKey,
        model: settings.litellmModel,
      });
      const launchOptions = mcpLaunchOptions(settings, secrets, runtime);
      const mcp = await mcpFactory(launchOptions);
      try {
        const result = await runAgentTurn({
          userMessage,
          history,
          llm,
          mcp,
          assetStore,
          presentCanvas,
          onEvent,
        });
        history.splice(0, history.length, ...result.history);
        return { ok: true, text: result.text };
      } finally {
        await mcp.close();
      }
    } finally {
      busy = false;
    }
  }

  function clearHistory() {
    history.splice(0, history.length);
  }

  return { sendMessage, clearHistory };
}

module.exports = { createChatService, defaultMcpLaunchOptions };
