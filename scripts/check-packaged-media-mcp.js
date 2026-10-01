const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Arch } = require('builder-util');
const { defaultMcpLaunchOptions } = require('../src/chat-service');
const { createMediaMcpClient } = require('../src/media-mcp-client');

module.exports = async function checkPackagedMediaMcp(context, { signed = false } = {}) {
  const { appOutDir, packager, electronPlatformName, arch } = context;
  const resourcesPath = packager.getResourcesDir(appOutDir);
  const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked');
  for (const dependency of ['@modelcontextprotocol/sdk', 'zod', 'playwright', 'playwright-core']) {
    await fs.access(path.join(unpackedPath, 'node_modules', dependency, 'package.json'));
  }

  const targetArch = Arch[arch];
  if (electronPlatformName !== process.platform || ![process.arch, 'universal'].includes(targetArch)) {
    console.log('Media MCP dependencies verified; run the startup check on the target platform/architecture.');
    return;
  }
  if (electronPlatformName === 'darwin' && !signed) {
    console.log('Media MCP dependencies verified; startup check will run after macOS signing.');
    return;
  }

  const productName = packager.appInfo.productFilename;
  const command = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName)
    : path.join(appOutDir, electronPlatformName === 'win32' ? `${productName}.exe` : packager.executableName);

  // Isolate the unpacked files so repository dependencies cannot hide packaging errors.
  const isolatedResources = await fs.mkdtemp(path.join(os.tmpdir(), 'easel-mcp-package-'));
  let client;
  try {
    await fs.cp(unpackedPath, path.join(isolatedResources, 'app.asar.unpacked'), { recursive: true });
    const launch = defaultMcpLaunchOptions(
      { easelBaseUrl: 'http://127.0.0.1:1', models: [] },
      {},
      { isPackaged: true, resourcesPath: isolatedResources },
    );
    client = await createMediaMcpClient({ ...launch, command, signal: AbortSignal.timeout(15_000) });
    const tools = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'list_models'), 'Packaged MCP must list media models.');
    assert.ok(tools.some((tool) => tool.name === 'capture_canvas_screenshot'), 'Packaged MCP must load the screenshot tool.');
    const result = await client.callTool('list_models', {});
    assert.ok(!result.isError, 'Packaged MCP model listing must succeed.');
    assert.deepEqual(result.structuredContent.models, []);
    console.log('Packaged Media MCP startup, tool discovery and model listing passed.');
  } finally {
    try { await client?.close(); }
    finally { await fs.rm(isolatedResources, { recursive: true, force: true }); }
  }
};
