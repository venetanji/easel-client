# LiteLLM Chat, Media MCP, and Desktop Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the PR #1 Electron starter into a secure LiteLLM-backed creative app with an offline HTML/JS canvas, a reusable stdio Media MCP server, headless screenshot capture, and passing cross-platform PR builds.

**Architecture:** Electron main is the LiteLLM agent host and MCP client. A separate TypeScript package implements Easel-backed media tools over MCP stdio and can run standalone on a headless Node machine. The renderer displays chat while a separate Electron `BrowserWindow` runs agent-produced HTML/JS with a restrictive CSP and no network or Electron bridge.

**Tech Stack:** Electron 44, Node.js 22, CommonJS for Electron, TypeScript for the MCP package, `openai` JS SDK, `@modelcontextprotocol/sdk`, Playwright for screenshot capture, `tsx` for TypeScript tests, Node built-in test runner, Electron Builder, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-28-easel-client-design.md`

## Global Constraints

- Never return or log API keys; encrypt saved app keys with Electron `safeStorage` and fail closed if encryption is unavailable.
- Configure LiteLLM base URL, model, and optional key separately from Easel base URL and optional key.
- LiteLLM requests use the official OpenAI JS SDK; do not add LangChain.
- The model may call only `list_models`, `generate_image`, `capture_canvas_screenshot`, and the desktop-host `present_canvas` tool.
- Never execute model-supplied code in the Electron main process; never allow arbitrary hosts or filesystem paths from tool arguments.
- Run canvas JavaScript only in a separate sandboxed Electron `BrowserWindow` with no preload/bridge, no Node integration, no parent access, and no outbound network.
- Keep chat history in memory for the app session only. MCP transport is stdio in v1; defer Streamable HTTP and remote multi-Easel orchestration.
- Require Windows, macOS, and Linux package jobs on PRs. Set package version to `0.0.1`; the first post-merge tag is `v0.0.1`.
- Do not sign, notarize, create a GitHub Release, merge, or tag as part of implementation.

## Review Focus

- Empty/malformed LiteLLM and Easel URLs, URL credentials, absent optional keys, and `/v1` duplication; test in Tasks 1 and 4.
- Malformed MCP tool arguments, unknown tool names, tool-call loops over the limit, invalid image payloads, and secrets in errors/logs; test in Tasks 2 and 4.
- Canvas attempts at network requests, parent access, Electron API access, popups, navigation, oversized markup/assets, and runaway scripts; test in Task 5.
- Headless screenshot capture with missing browser, failed render, image assets, and network access attempts; test in Task 3.
- Electron packaging on three OSes, unavailable Electron download markers, and release tags that disagree with `package.json`; test in Task 6 and require actual PR checks before merge.

---

### Task 1: Secure Electron settings and IPC

**Files:**
- Create: `src/settings-store.js`
- Create: `src/ipc-contract.js`
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Modify: `src/renderer.js`
- Modify: `src/index.html`
- Test: `test/settings-store.test.js`
- Test: `test/ipc-contract.test.js`
- Test: `test/preload.test.js`

**Interfaces:**
- `createSettingsStore({ userDataPath, safeStorage, fs })` exposes `loadPublic()`, `loadSecrets()`, and `save(settings)`. Public settings never contain keys; secrets are decrypted only in main.
- `validateSettings(input)` returns normalized non-secret settings and rejects non-HTTP(S) URLs and embedded URL credentials.
- Preload exposes only `getSettings()`, `saveSettings(settings)`, `sendMessage(text)`, and fixed event subscriptions. No renderer method returns credentials.

- [x] **Step 1: Write failing tests** for encrypted-at-rest keys, public settings omitting secrets, unavailable encryption rejected, malformed settings rejected, and unknown IPC channels/payloads rejected.
- [x] **Step 2: Run `node --test test/settings-store.test.js test/ipc-contract.test.js test/preload.test.js`**; expect failures because the modules/channels do not exist.
- [x] **Step 3: Implement settings persistence and IPC validators** with injected filesystem and `safeStorage` dependencies; register fixed handlers in main and a narrow preload bridge.
- [x] **Step 4: Replace renderer API-key forwarding** with settings save/load, clear key fields after saving, and block unexpected navigation/popups/permissions in the Electron window.
- [x] **Step 5: Re-run the focused tests** and expect all settings, IPC, and preload tests to pass.

### Task 2: Standalone Media MCP and Easel tools

**Files:**
- Create: `packages/media-mcp/package.json`
- Create: `packages/media-mcp/tsconfig.json`
- Create: `packages/media-mcp/src/server.ts`
- Create: `packages/media-mcp/src/easel.ts`
- Modify: root `package.json` and `package-lock.json` for npm workspaces/scripts
- Test: `packages/media-mcp/test/easel.test.ts`
- Test: `packages/media-mcp/test/server.test.ts`

**Interfaces:**
- `createMediaServer({ easelBaseUrl, easelApiKey, fetchImpl })` registers MCP tools and returns a server instance without starting stdio.
- `list_models` returns validated Easel model identifiers/names from `GET /v1/models`.
- `generate_image({ prompt, model?, size?, n? })` calls `POST /v1/images/generations` and returns MCP image content plus non-secret metadata. It never accepts a filesystem path or host from tool arguments.
- CLI entrypoint reads `EASEL_BASE_URL` (default `https://easel.ait4x.org`) and optional `EASEL_API_KEY`, uses stdio transport, and writes protocol only to stdout; diagnostics go to stderr.

- [x] **Step 1: Write failing tests** for tool registration, input schemas, model response parsing, generation request payload, missing optional keys, API errors, and protocol/log stream separation.
- [x] **Step 2: Run `npm test --workspace=packages/media-mcp`**; expect failures because the workspace/server is absent.
- [x] **Step 3: Add the MCP SDK workspace and implement Easel client functions** with injected `fetch`; validate response shape and accept only supported image content.
- [x] **Step 4: Implement the MCP stdio server and standalone CLI** with typed schemas; keep secrets out of tool results and logs.
- [x] **Step 5: Re-run workspace tests and launch the CLI with an MCP stdio handshake test**; expect tool listing and tool calls to work without live Easel credentials.

### Task 3: Headless canvas screenshot tool

**Files:**
- Create: `packages/media-mcp/src/canvas.ts`
- Create: `packages/media-mcp/test/canvas.test.ts`
- Modify: `packages/media-mcp/src/server.ts`
- Modify: `packages/media-mcp/package.json`

**Interfaces:**
- `captureCanvasScreenshot({ html, assets, viewport? }, { browserFactory })` validates input, renders a self-contained offline page, and returns PNG bytes.
- HTML size is capped at 1 MiB, assets at 8 images/32 MiB total, viewport at 1920x1080, and render time at 10 seconds. Reject external URLs/paths in assets and block all `http:`, `https:`, `file:`, and WebSocket requests.
- Missing Chromium produces an actionable MCP error; the headless install guide specifies `npx playwright install chromium`.

- [x] **Step 1: Write failing tests** for HTML/asset bounds, accepted local image data, blocked network requests, timeout, missing browser, and a successful screenshot using a minimal fixture.
- [x] **Step 2: Run `npm test --workspace=packages/media-mcp`**; expect screenshot tests to fail because the renderer is absent.
- [x] **Step 3: Add Playwright and implement isolated page rendering** with JavaScript enabled, restrictive CSP, request interception, fixed viewport, and timeout.
- [x] **Step 4: Register `capture_canvas_screenshot`** as an MCP tool returning PNG image content and plain metadata.
- [x] **Step 5: Re-run workspace tests**; run the real Chromium fixture when a browser is available. If local network policy prevents downloading Chromium, let only that fixture skip locally and make Task 6 CI install Chromium and set `EASEL_RUN_BROWSER_TESTS=1`; the PR check must verify an actual PNG.

### Task 4: LiteLLM agent host and stdio MCP client

**Files:**
- Create: `src/litellm-client.js`
- Create: `src/media-mcp-client.js`
- Create: `src/agent.js`
- Modify: root `package.json` and `package-lock.json`
- Modify: `src/ipc-contract.js`
- Test: `test/litellm-client.test.js`
- Test: `test/media-mcp-client.test.js`
- Test: `test/agent.test.js`

**Interfaces:**
- `createLiteLLMClient({ baseUrl, apiKey, model, openAIClientFactory })` normalizes the OpenAI-compatible base URL and returns OpenAI-compatible chat/tool-call requests using the official `openai` SDK.
- `createMediaMcpClient({ command, args, env, transportFactory })` connects via stdio, lists tools, invokes only the allowlisted media tools, and closes its child on app exit.
- `runAgentTurn({ userMessage, history, settings, llm, mcp, assetStore, presentCanvas, maxToolCalls })` returns updated session history and structured events; tool calls are capped at 3 per turn.
- `present_canvas({ html, title, assets: [{ name, assetId }] })` is a host-only tool that resolves only app-managed asset IDs and sends a canvas artifact to the renderer; it is not registered on the MCP server.

- [x] **Step 1: Write failing LiteLLM tests** for `/v1` normalization, SDK baseURL/model/key configuration, assistant/tool-call responses, malformed responses, and redacted errors.
- [x] **Step 2: Run `node --test test/litellm-client.test.js`**; expect failures because the connector is absent.
- [x] **Step 3: Implement the OpenAI SDK connector** using injected client creation for deterministic tests.
- [x] **Step 4: Write failing MCP-client tests** for tool discovery, allowlisting, unknown-tool rejection, stdio errors, cleanup, and secret handling.
- [x] **Step 5: Run `node --test test/media-mcp-client.test.js`**; expect failures because the MCP client is absent.
- [x] **Step 6: Implement the stdio client** that launches the bundled server in development/packaged mode and terminates it with its owner.
- [x] **Step 7: Write failing agent tests** for normal response, one/multiple tool calls, `present_canvas`, unknown tool, malformed arguments, and the three-call limit.
- [x] **Step 8: Implement `runAgentTurn`** to map only MCP tools plus `present_canvas` into OpenAI function tools, validate calls, append MCP results, and emit ordered progress/results.
- [x] **Step 9: Run all Task 4 tests** and expect the connector, client, and tool loop to pass without live endpoints.

### Task 5: Chat UI and isolated HTML/JS canvas

**Files:**
- Create: `src/chat-service.js`
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Modify: `src/renderer.js`
- Modify: `src/index.html`
- Create: `src/canvas-window.js`
- Create: `src/canvas-policy.js`
- Create: `src/asset-store.js`
- Test: `test/chat-service.test.js`
- Test: `test/renderer.test.js`
- Test: `test/canvas-policy.test.js`
- Test: `test/canvas-window.test.js`
- Test: `test/asset-store.test.js`

**Interfaces:**
- `createChatService({ settingsStore, assetStore, llmFactory, mcpFactory, mcpLaunchOptions, presentCanvas, onEvent })` reads encrypted settings in main, holds one in-memory conversation, starts the stdio MCP client per turn, and closes it in `finally`.
- Renderer sends a chat message through `window.easelClient.sendMessage(text)` and receives structured assistant, tool-status, image, and canvas events.
- `createAssetStore({ userDataPath, fs })` saves validated image bytes to generated filenames and resolves opaque asset IDs without accepting caller paths.
- `buildCanvasDocument({ html, assets })` validates limits, converts managed image bytes to data URLs, and wraps the artifact in a CSP-protected HTML document.
- `createCanvasWindow({ BrowserWindow, sessionFactory, artifact })` opens a dedicated sandboxed BrowserWindow with a separate session, no preload, and request/navigation/popup/permission blocking. Destroying and recreating the window resets canvas state.

- [ ] **Step 1: Write failing chat-service tests** for main-process secret access, session history, missing LiteLLM model, and MCP cleanup on errors.
- [ ] **Step 2: Run `node --test test/chat-service.test.js`**; expect failures because the service is absent.
- [ ] **Step 3: Implement `createChatService`** using the LLM/MCP adapters and per-session history; always close the MCP child in `finally`.
- [ ] **Step 4: Write failing UI tests** for chat send/busy state, tool status, image results, assistant text rendering, and IPC error recovery.
- [ ] **Step 5: Run `node --test test/renderer.test.js`**; expect chat-flow tests to fail because the chat UI is absent.
- [ ] **Step 6: Replace the direct-generation form** with chat/settings/results and render all assistant/user content via text nodes.
- [ ] **Step 7: Write failing asset-store tests** for valid PNG/JPEG/WebP saves, generated opaque IDs, unknown IDs, path traversal attempts, and asset size limits.
- [ ] **Step 8: Implement `createAssetStore`** so persisted paths derive only from random generated IDs and MIME types.
- [ ] **Step 9: Write failing canvas-window/policy tests** for CSP, data-only assets, markup bounds, blocked requests/navigation/popups/permissions, and reset behavior.
- [ ] **Step 10: Run focused canvas tests**; expect failures because the secure canvas is absent.
- [ ] **Step 11: Implement the separate canvas BrowserWindow** with scripts enabled only there, no preload/Node integration, restrictive CSP, isolated session, and request/navigation/popup/permission blocking; route `present_canvas` events into it and ignore canvas messages.
- [ ] **Step 12: Wire the IPC chat handler to `createChatService`** and map main-process events to the preload event stream.
- [ ] **Step 13: Re-run all Task 5 tests** and expect chat-service, renderer, asset-store, and canvas security tests to pass.

### Task 6: Cross-platform desktop and MCP builds

**Files:**
- Modify: root `package.json` and `package-lock.json`
- Create: `electron-builder.yml`
- Create: `.github/workflows/test.yml`
- Create: `.github/workflows/desktop.yml`
- Test: `test/package-config.test.js`

**Interfaces:**
- Root scripts include `test`, `build`, `dist:dir`, `dist:win`, `dist:mac`, `dist:linux`, and `build:media-mcp`.
- Desktop package version is `0.0.1`; when `RELEASE_TAG` is set, it must equal `v${package.json.version}`.
- `desktop.yml` builds Windows/macOS/Linux on PRs, manual dispatch, and `v*` tags; uploads unsigned installers and a headless MCP package as workflow artifacts.

- [x] **Step 1: Write failing tests** for version `0.0.1`, target scripts, app/server inclusion, and matching/mismatching `RELEASE_TAG`.
- [x] **Step 2: Run `node --test test/package-config.test.js`**; expect failures because packaging config is absent.
- [x] **Step 3: Add Electron Builder scripts/config and npm workspace builds**; ensure packaged app includes the MCP stdio entry point and runtime dependencies.
- [x] **Step 4: Update the lockfile** using `npm install --package-lock-only` and run config tests.
- [x] **Step 5: Add `test.yml`** for Node 22 install/tests on pushes and pull requests; cache Chromium, run `npx playwright install --with-deps chromium`, and set `EASEL_RUN_BROWSER_TESTS=1` so CI verifies an actual headless PNG.
- [x] **Step 6: Add Tetrilaunch-inspired `desktop.yml`** for PR/tag/manual matrix builds, Electron download caching, version validation, Electron binary marker verification, and artifact upload without signing/release publication.
- [ ] **Step 7: Run `npm test`, `npm run build`, and `npm run dist:linux`**; expect tests and local Linux package smoke-build to pass.
- [ ] **Step 8: Validate workflow YAML and artifact paths**; all three actual GitHub PR build jobs must pass before merge.

### Task 7: User-facing setup and build documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/PLAN.md`
- Create: `packages/media-mcp/README.md`

- [x] **Step 1: Document LiteLLM endpoint/model/key setup** and Easel's `https://easel.ait4x.org` default plus optional deployment override.
- [x] **Step 2: Document standalone/headless MCP installation and run** with stdio configuration, environment variables, and `npx playwright install chromium`.
- [x] **Step 3: Document canvas isolation, local image assets, tests, build commands, PR build gate, and post-merge tag `v0.0.1`**; note Streamable HTTP is future work.
- [ ] **Step 4: Run `npm test`** and confirm documentation changes leave the whole suite passing.
