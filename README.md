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

The workspace keeps media and chat on the left and an isolated HTML/JavaScript canvas view on the right. It can host Canvas 2D or browser WebGL content within its offline sandbox, which makes it useful for interactive prototypes and small games. Use **Image** to generate a still, or **Chat** to shape a direction and edit the open canvas. Create a named empty image-grid canvas with **New canvas**. Press Enter to send; Ctrl+Enter inserts a new line. Images are stored locally under opaque IDs and embedded into self-contained HTML canvases that can be reopened and exported.

The current asset library supports PNG, JPEG, and WebP images. Optional local kits for Deckgen.js, Phaser, Three.js, physics, Tone.js, and video editing are planned, along with glTF/GLB assets. Video mode stays disabled until a video generation tool is connected. External CDNs and filesystem access remain blocked inside the canvas.

## Creative skills

Open **Skills** to write a reusable instruction, edit one, or import a Codex `SKILL.md`. Easel stores imported skills on this device and includes only the selected skills with a request. The project skill at [`.agents/skills/easel-media/SKILL.md`](.agents/skills/easel-media/SKILL.md) describes the Media MCP workflow for Codex; import it in Easel as well when you want those instructions in studio chat.

Canvas code runs in a dedicated sandboxed `WebContentsView` with no preload bridge, Node integration, filesystem access, permissions, or outbound network. The agent's CDP-backed tools are restricted to that canvas view for inspection, bounded JavaScript edits, and adding saved images; it cannot inspect or control the app window or credentials.

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
