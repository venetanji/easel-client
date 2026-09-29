# Easel Client Plan

## Goal

Build a local-first Electron chat client that uses LiteLLM for reasoning, a separate stdio Media MCP server for image tools, and an offline HTML/JS canvas for composition and screenshots.

## Milestones

1. **Secure the desktop host** — Keep endpoint settings and credentials in Electron's main process; expose only typed IPC; encrypt saved keys.
2. **Build the Media MCP package** — Add a standalone TypeScript/Node stdio server backed by `https://easel.ait4x.org`, with image/model tools and a headless canvas screenshot tool. Keep Streamable HTTP as future work.
3. **Add the LiteLLM agent host** — Use the official OpenAI JS SDK configured for LiteLLM; bridge only allowlisted MCP tools into model tool calls.
4. **Add the local canvas** — Run generated HTML/JS in an isolated sandbox with no Electron bridge or network access. Pass generated images as managed local assets.
5. **Build on pull requests** — Run tests and Windows/macOS/Linux packaging checks. All platform jobs must pass on PR #1 before merge. Upload unsigned artifacts.
6. **First tagged build** — After PR #1 merges, tag `v0.0.1` to build unsigned desktop and standalone MCP artifacts. Do not create a GitHub Release or sign packages in this increment.

## First-version boundaries

The model can call only Media MCP tools (`list_models`, `generate_image`, and `capture_canvas_screenshot`). MCP uses stdio locally; Streamable HTTP and remote multi-Easel orchestration are future work. Canvas JavaScript can animate and handle local interactions but cannot access the Electron API, parent DOM, filesystem, or network. Chat history is session-only.

## Creative runtime roadmap

Keep the isolated HTML/JavaScript canvas as the host for interactive work. It already supports ordinary HTML and inline JavaScript, so Canvas 2D and browser WebGL prototypes can live there today. Extend the host with opt-in runtime kits and asset access in stages:

1. Add project starters for Deckgen.js presentations, Phaser games, and Three.js/WebGL scenes. Add opt-in local bundles for a physics engine and Tone.js, with prompt shortcuts that tell the agent which runtime APIs are available.
2. Bundle pinned runtime libraries locally; do not depend on CDNs. Review CSP and worker permissions per kit while keeping each canvas offline and isolated from the app window, credentials, and filesystem.
3. Make the asset catalog runtime-neutral. Preserve generated images and add validated glTF/GLB models and textures as managed assets. Expose them through opaque IDs and canvas-scoped data sources, with previews and insertion actions across supported runtimes.
4. Add size/type limits, model previews, and project-level asset manifests so game scenes can reuse media without embedding large 3D payloads into every saved HTML document.
5. Connect video mode only after selecting the generation provider/tool. Then add managed video assets and an editing workspace for previewing, trimming, splitting, and exporting clips using local video tooling.

## Acceptance checks

- LiteLLM base URL, model, and optional key are configurable independently from the Easel URL and optional key.
- Saved keys are encrypted at rest and never sent back to the renderer or logged.
- Unit tests cover settings, OpenAI SDK/LiteLLM requests, MCP tool schemas, Easel calls, tool limits, IPC, canvas sandbox policy, and offline screenshot rendering without live credentials.
- `npm test` passes locally; Linux desktop and MCP package smoke builds succeed locally.
- GitHub Actions builds Windows, macOS, and Linux on PR #1 before merge.
- After merge, `v0.0.1` builds unsigned desktop and MCP artifacts.
