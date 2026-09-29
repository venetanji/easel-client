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

## Acceptance checks

- LiteLLM base URL, model, and optional key are configurable independently from the Easel URL and optional key.
- Saved keys are encrypted at rest and never sent back to the renderer or logged.
- Unit tests cover settings, OpenAI SDK/LiteLLM requests, MCP tool schemas, Easel calls, tool limits, IPC, canvas sandbox policy, and offline screenshot rendering without live credentials.
- `npm test` passes locally; Linux desktop and MCP package smoke builds succeed locally.
- GitHub Actions builds Windows, macOS, and Linux on PR #1 before merge.
- After merge, `v0.0.1` builds unsigned desktop and MCP artifacts.
