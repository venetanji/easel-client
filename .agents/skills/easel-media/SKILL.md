---
name: easel-media
description: Create images with the Easel Media MCP server and prepare offline canvas previews.
---

# Easel Media

Use this skill when the user wants to create an image with Easel or preview an HTML composition with the Easel Media MCP tools.

## Available tools

The current Media MCP package exposes:

- `list_models` to inspect image models available from the configured Easel endpoint.
- `generate_image` to create one or more images from a prompt. It accepts an optional model, `WIDTHxHEIGHT` size, and a count from 1 to 4.
- `capture_canvas_screenshot` to render HTML and local image assets in an offline browser and return a PNG screenshot.

Video generation is not available in this server. Do not describe an image as a video or imply that a video job was submitted.

## Image workflow

1. Preserve the user's subject, intended use, and named visual references.
2. Ask a concise follow-up only when a missing choice would materially change the result.
3. Use `list_models` when the user asks for a model choice or the available models are unknown and model choice matters.
4. Call `generate_image` with a concrete prompt. Include composition, lighting, medium, palette, and aspect ratio when they are part of the brief. Set `size` only when the user gives a ratio or a destination needs one.
5. Show the returned image and describe only what the tool actually produced.

## Canvas preview

Use `capture_canvas_screenshot` to inspect a self-contained HTML composition. Pass only local image data in the `assets` field. The renderer blocks network access; do not use remote image URLs. Never put credentials, arbitrary hostnames, or filesystem paths in tool arguments.

When the tool is unavailable, explain that the project includes a local stdio server in `packages/media-mcp` and point to its README for setup. Do not claim to have generated or previewed anything without a tool result.
