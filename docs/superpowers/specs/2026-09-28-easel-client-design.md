# Easel Client: LiteLLM Agent, Media MCP, and Canvas

## Status

Current direction: local-first Electron app, official OpenAI JS client pointed at LiteLLM Responses streaming, separate TypeScript Media MCP server over stdio, an in-window sandboxed HTML/JS canvas with canvas-scoped CDP controls, and a headless screenshot tool. Streamable HTTP transport is deferred.

## Goal

Turn the PR #1 Electron starter into a local-first desktop app where a user chats with a LiteLLM-backed agent, the agent calls a small Media MCP toolset backed by `https://easel.ait4x.org`, and the user can compose/preview images in a local HTML/JS canvas. The same MCP server can run without Electron for headless generation and screenshot capture.

## Current starting point

PR #1 supplies a plain Electron application and a direct call to `POST /v1/images/generations`. It does not include LiteLLM, chat, MCP, a canvas, credential isolation, or desktop packaging. Its current API key is passed from the renderer to the preload bridge, so the bridge alone does not keep the secret out of renderer JavaScript.

## Proposed architecture

### Electron app / agent host

- Use the official `openai` Node.js SDK, configured with LiteLLM's OpenAI-compatible base URL, model identifier, and optional API key. Do not use LangChain in v1.
- Keep the LiteLLM client, conversation/tool loop, MCP client, settings, and credentials in Electron's main process.
- Connect to the separate Media MCP server using stdio. Translate MCP tool definitions/results to/from the LiteLLM Responses tool-calling interface. Add host-owned tools for `present_canvas`, canvas inspection, bounded canvas JavaScript, and adding managed images. Do not expose arbitrary tools or the CDP connection to the model.
- Store settings in the app's user-data directory and encrypt keys with Electron `safeStorage`. Keep keys out of renderer state, IPC responses, logs, and model messages.
- Use the existing Easel default `https://easel.ait4x.org`; allow configuration for other Easel deployments and optional API keys.
- Keep chat history in memory only for the app session.

### Media MCP package

- Add a separate TypeScript/Node package in this repository that implements MCP over stdio and can also run as a standalone headless process.
- Configure Easel base URL and optional API key in the MCP process environment for standalone/headless usage. The Electron host supplies its saved Easel configuration to the spawned process without including secrets in tool arguments or logs.
- Initially expose only `list_models`, `generate_image`, and `capture_canvas_screenshot`. Add future media tools behind this server boundary; do not add Streamable HTTP transport in v1. `present_canvas` remains a desktop-host tool, not an MCP tool.
- Use MCP image content for generated images and screenshot results. Validate all input schemas and response data. Never let model-supplied arguments select arbitrary hosts or local filesystem paths.
- Implement screenshot capture with a headless browser in an isolated context. It accepts bounded HTML/JS plus local image assets, blocks all network requests, and returns a screenshot image result.

### Canvas

- Show the media library and chat in a left rail, with the live HTML canvas in the right side of the same app window. Use a dedicated Electron `WebContentsView` for the canvas so it remains isolated from the app renderer.
- The canvas view has no preload/bridge, no Node integration, no access to the app DOM or credentials, and no network access. Enforce a restrictive CSP and block navigation, popups, forms, permissions, and outbound requests.
- Attach CDP only to the canvas view's `webContents`. Expose host-owned inspect, bounded JavaScript, and saved-image insertion tools; never expose a debugging port or the main app's target.
- Store media under opaque IDs with small thumbnails. Save each canvas as self-contained HTML with embedded image data, reopen it from the library, and export it through a user-selected path.
- Bound artifact, script, snapshot, and asset sizes. The headless screenshot tool uses the same offline asset/markup contract.

### Settings and credentials

- Provide independent settings for LiteLLM base URL, model, optional key, and Easel base URL/optional key.
- Normalize the LiteLLM base URL for OpenAI-compatible chat completions without duplicating `/v1`; validate HTTP(S) and reject URL-embedded credentials.
- Encrypt saved keys with `safeStorage`; if secure encryption is unavailable, refuse to persist them and show an actionable error. A missing key is allowed for unauthenticated endpoints.

## Desktop build workflow

Adapt the useful packaging pattern from `venetanji/tetrilaunch` without copying its game/store, notarization, or signing-specific steps:

- Run unit tests and a Windows/macOS/Linux packaging matrix on pull requests so builds pass before merge.
- Keep manual dispatch and version-tag builds. The first intended post-merge tag is `v0.0.1`.
- Package the Electron app with Electron Builder, package the standalone MCP server for headless use, and upload unsigned artifacts to the workflow run.
- Do not sign, notarize, create a GitHub Release, merge, or tag as part of implementation. Streamable HTTP transport is future work.

## Scope and non-goals

Included: main-process credential isolation; LiteLLM chat via the OpenAI JS SDK; a separate stdio Media MCP server; Easel model discovery/image generation; local-JS sandboxed canvas; headless screenshot capture; unit tests; cross-platform desktop build artifacts; a repository roadmap in `docs/PLAN.md`.

Not included in v1: LangChain, Streamable HTTP MCP transport, remote multi-Easel orchestration, durable chat history, arbitrary agent tools, arbitrary network access from canvas code, canvas access to the local filesystem, image editing/video tools, automatic retries that may duplicate paid generations, auto-updates, code signing/notarization, or public release publication.

## Verification

- Unit-test settings secrecy, endpoint validation, OpenAI SDK request/tool-call adaptation, MCP schemas and tools, Easel calls, IPC allowlisting, canvas isolation policy, and headless screenshot output without live credentials.
- Confirm canvas network requests/navigation are blocked and app secrets/IPC are inaccessible from canvas scripts.
- Run `npm test` and a Linux desktop/MCP package smoke build locally.
- GitHub Actions must successfully package Windows, macOS, and Linux on PR #1 before merge.
- After merge, tag `v0.0.1` to build unsigned desktop and headless MCP artifacts.
- Manually smoke-test against LiteLLM and `easel.ait4x.org` before claiming live integration is verified.
