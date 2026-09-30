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
3. In Easel client, accepted jobs are saved in the host monitor before the turn ends. Return a brief generating status; the host polls and downloads across app restarts without spending agent tool calls. `list_media_jobs` gives a status snapshot.
4. The originating conversation receives a durable completion notification. If it is idle, its original project is open, and its Agent model/endpoint has not changed, the host resumes it automatically. Otherwise the next message receives the notification. Stop pauses agent continuation while polling continues.
5. Completed downloads are saved to Media and attached to the original project. Use the notification's asset IDs to continue the original request; never regenerate a completed job. Removing a job asks the user to confirm losing the monitor's ID; it does not cancel server generation or remove downloaded files.
6. Standalone MCP without the host monitor can retrieve with `get_video`, using the same `videoId` and `model`. Preserve IDs and never resubmit a pending job.

For text-only video, omit `inputReferenceAssetId` or set it to `null`. Never invent an asset ID or use all-zero placeholders. A local `INVALID_MEDIA_REFERENCE` error means the API was not called; correct the reference or omit it and retry the corrected request.

Stop cancels local work, not an accepted remote job. Easel accepts integer durations from 1 to 12 seconds; other endpoint limits depend on the model. Defaults are 4 seconds and 1280x720. Downloads are bounded to 32 MiB. See the package README for endpoint contracts and limits.

## Image workflow

Image endpoints may honor `Prefer: respond-async` and return an accepted `{id,status}` job receipt instead of immediate image bytes. Those receipts use the same persistent monitor. Synchronous image responses continue to work. Queued image retrieval uses the proposed `GET /v1/images/jobs/{id}` contract, which requires upstream API support; never claim support without a receipt. Completed results include `data:[{b64_json}]`. Audio job submission is not implemented yet.

1. Preserve the user's subject, intended use, and named visual references.
2. Ask a concise follow-up only when a missing choice would materially change the result.
3. Use `list_models` when the user asks for a model choice or the available models are unknown and model choice matters.
4. Call `generate_image` with a concrete prompt. Include composition, lighting, medium, palette, and aspect ratio when they are part of the brief. Set `size` only when the user gives a ratio or a destination needs one.
5. Show the returned image and describe only what the tool actually produced.

## Canvas preview

Use `capture_canvas_screenshot` to inspect a self-contained HTML composition. Pass only local image data in the `assets` field. The renderer blocks network access; do not use remote image URLs. Never put credentials, arbitrary hostnames, or filesystem paths in tool arguments.

When the tool is unavailable, explain that the project includes a local stdio server in `packages/media-mcp` and point to its README for setup. Do not claim to have generated or previewed anything without a tool result.
