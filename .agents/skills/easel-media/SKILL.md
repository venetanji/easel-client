---
name: easel-media
description: Create images and video jobs with the Easel Media MCP server and prepare offline canvas previews.
---

# Easel Media

Use this skill when the user wants to create an image or video with Easel or preview an HTML composition with the Easel Media MCP tools.

## Available tools

The current Media MCP package exposes:

- `list_models` to inspect enabled Media model IDs, endpoint names and discovered output types.
- `generate_image` to create one or more images from a prompt. It accepts an optional model, `WIDTHxHEIGHT` size, and a count from 1 to 4.
- `edit_image` and `create_image_variation` to transform saved reference images when supported by the endpoint.
- `generate_video` to submit one video job with a video model, prompt, optional reference image, seconds and size.
- `get_video` to retrieve a job and save completed MP4/WebM output.
- `capture_canvas_screenshot` to render HTML and local image assets in an offline browser and return a PNG screenshot.

Audio generation tools are not available yet, even if discovery lists audio output models. Do not imply that a job was submitted or finished without its tool result.

## Video workflow

1. Select a video model using its exact `list_models` ID. In-app tools resolve credentials from that model's endpoint.
2. Submit `generate_video` once. Optional `inputReferenceAssetId` identifies a saved PNG/JPEG/WebP image in the app; standalone MCP uses an `inputReference` upload object.
3. Preserve `job.id` and `job.modelId`. Call `get_video` with that same `videoId` and `model`, optionally `waitSeconds:15` once.
4. If pending, return the status to the user and retrieve it in a later turn. Never consume the tool budget polling, or resubmit merely because a job or download is unfinished.
5. Completed video downloads are saved to Media and attached to the active project. They can be previewed, downloaded and shared with chat as sampled frames. Saved tool messages contain job/asset references, not binary media.

Stop cancels local work, not an accepted remote job. Durations and reference support depend on the model; defaults are 4 seconds and 1280x720. Downloads are bounded to 32 MiB. See the package README for endpoint contracts and limits.

## Image workflow

1. Preserve the user's subject, intended use, and named visual references.
2. Ask a concise follow-up only when a missing choice would materially change the result.
3. Use `list_models` when the user asks for a model choice or the available models are unknown and model choice matters.
4. Call `generate_image` with a concrete prompt. Include composition, lighting, medium, palette, and aspect ratio when they are part of the brief. Set `size` only when the user gives a ratio or a destination needs one.
5. Show the returned image and describe only what the tool actually produced.

## Canvas preview

Use `capture_canvas_screenshot` to inspect a self-contained HTML composition. Pass only local image data in the `assets` field. The renderer blocks network access; do not use remote image URLs. Never put credentials, arbitrary hostnames, or filesystem paths in tool arguments.

When the tool is unavailable, explain that the project includes a local stdio server in `packages/media-mcp` and point to its README for setup. Do not claim to have generated or previewed anything without a tool result.
