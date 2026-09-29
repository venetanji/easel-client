# Easel Studio

A local-first Electron chat client for Easel image generation. LiteLLM supplies the language model; a standalone Media MCP server exposes Easel tools over stdio. Chat history stays in memory for the current app session.

## Configure

1. Install and run Easel at `https://easel.ait4x.org` (or enter your own Easel HTTP(S) endpoint in Connections).
2. Enter your LiteLLM OpenAI-compatible endpoint, model ID, and optional key. The default endpoint is `http://127.0.0.1:4000/v1`.
3. Enter an Easel API key only if your deployment requires one, then save connections.

Keys are encrypted with Electron `safeStorage` and are only decrypted in the main process. The app fails closed if secure storage is unavailable. LiteLLM and Easel endpoints are configured separately.

## Run in development

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
npm start
```

## Headless Media MCP

`@easel/media-mcp` is a reusable stdio server for local/headless agents. See [`packages/media-mcp/README.md`](packages/media-mcp/README.md) for standalone configuration and screenshot-browser setup. V1 uses stdio only; Streamable HTTP and remote multi-Easel orchestration are future work.

## Canvas and image assets

The agent may open generated HTML/JavaScript in a separate sandboxed Electron window. It has no preload bridge, Node integration, filesystem access, permissions, or outbound network. Generated images are stored locally under opaque IDs and passed to the canvas as local data URLs. Canvas state resets when the canvas window is replaced.

## Test and package

```sh
npm test
npm run build
npm run dist:dir
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The test workflow installs Chromium and verifies a real offline screenshot. Desktop PR checks build unsigned Windows, macOS, and Linux artifacts and upload them for review; they do not sign, notarize, merge, or publish a release. The first planned post-merge tag is `v0.0.1`; `RELEASE_TAG` must match `package.json`.
