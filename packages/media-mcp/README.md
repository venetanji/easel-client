# Easel Media MCP

Standalone TypeScript MCP server for Easel media tools. It uses the stdio transport so a local or headless agent can run the server as a child process. It does not expose an HTTP listener.

## Build and run

Requires Node.js 22+.

```sh
npm ci
npm run build --workspace=@easel/media-mcp
EASEL_BASE_URL=https://easel.ait4x.org EASEL_API_KEY=optional-secret node packages/media-mcp/dist/cli.js
```

Set `EASEL_BASE_URL` to an alternate HTTP(S) Easel endpoint if needed. `EASEL_API_KEY` is optional. Configure this command and the environment in your MCP host; stdio protocol output uses stdout and diagnostics use stderr.

Tools:
- `list_models` — list validated Easel models.
- `generate_image` — generate an image and return image content plus non-secret metadata.
- `edit_image` - edit one or more reference images with a prompt; optional masks depend on provider support.
- `create_image_variation` - make variations from a reference image.
- `discover_video_capabilities` - read the selected endpoint’s typed bounds and guide-node availability without generation.
- `list_video_loras` - read curated LoRA support, installation, requirements and validation evidence.
- `generate_video` - submit a typed basic or advanced video job, returning its durable job ID and status.
- `get_video` - check that job and download completed MP4/WebM media as an embedded MCP resource.
- `capture_canvas_screenshot` — render offline HTML with local image assets and return a PNG.

## Endpoints and model routing

The server uses OpenAI-compatible `/v1/images/generations`, `/v1/images/edits`, and `/v1/images/variations` endpoints. Edits and variations use multipart uploads; references are sent as `image` for one input or repeated `image[]` fields for multiple inputs. Credentials are applied by the server rather than included in tool arguments or output.

The Easel application supplies `EASEL_MEDIA_MODELS` as a JSON array of enabled models:

```json
[
  {
    "id": "connection-id:provider-model",
    "model": "provider-model",
    "name": "Display name",
    "endpointName": "Endpoint name",
    "baseUrl": "https://example.com/v1",
    "mediaTypes": ["image", "video"],
    "apiKey": "configured-secret"
  }
]
```

With this configuration, media tools require the exact `id` returned by `list_models`. The server selects that entry's endpoint, key, and provider model. Optional `mediaTypes` narrows tool routing to discovered image/video/audio output types; unspecified types remain unknown. An empty array disables generation, video discovery and video retrieval tools. Without the array, standalone tools use `EASEL_BASE_URL` and `EASEL_API_KEY`. A provider model is required for video generation. Audio models can be categorized now, but audio generation tools will be added when an endpoint contract is available.

## Video jobs

In Easel client, accepted jobs are stored under `media-jobs` before ending the agent turn. The host polls about every five seconds, with backoff up to one minute on retrieval errors, and resumes polling on app restart. It retrieves using the original endpoint, model and current credentials; changing/removing that endpoint retains the ID but blocks retrieval. A disabled model does not prevent downloading its accepted jobs. Downloaded asset references are checkpointed before project attachment, so an attachment retry does not download another copy.

Generating cards appear in the original project's media and All media. `/v1/videos/queue/{video_id}` supplies optional queue position and estimated completion time; `get_video({includeQueue:true})` requests those diagnostics and falls back to normal status if unavailable. Estimates are supplied by the service and may be absent or change. Deleting a card requires confirmation, stops monitoring and forgets its monitor ID; it does not cancel the server job or delete downloaded files. Recovery requires the remote job ID.

Completion queues a durable notification for the originating conversation. The idle original conversation resumes automatically only while its original project and Agent endpoint/model are selected. Otherwise it receives the completion in its next turn. Stop ends/pause agent continuation but accepted jobs keep polling. Interrupted continuations are not automatically replayed on restart, since previous tool effects may have occurred.

### Queued Image Contract (Proposed)

Image generation/edit/variation requests send `Prefer: respond-async`. Existing synchronous `data:[{b64_json}]` responses remain supported. A queue-capable endpoint can return HTTP 202 with `{id,status,progress}` and optional `queue_position`, `queue_ahead`, `estimated_wait_seconds`, `estimated_completion_at` (Unix seconds). The adapter preserves that receipt in the shared monitor. Proposed `GET /v1/images/jobs/{id}` returns the same job status and, when completed, `data:[{b64_json}]`. This retrieval path requires upstream support and is used only after receiving an actual image job ID. Audio jobs can reuse the shared receipt/status/storage lifecycle once their generation endpoint is implemented.

Easel's live API exposes multipart `POST /v1/videos`, JSON `GET /v1/videos/{video_id}` and binary `GET /v1/videos/{video_id}/content`. Public server source may lag the deployed API. Video requests use shared endpoint normalization, credentials, cancellation, error handling and bounded download helpers with the image transport.

```json
{
  "prompt": "A slow orbit around a ceramic sculpture in morning light",
  "model": "connection-id:video-model",
  "seconds": 4,
  "size": "1280x720"
}
```

`generate_video` submits exactly one job with no automatic retries. It returns `job.id`, `job.modelId`, status and available progress/duration/size metadata. Keep the ID even when pending. The optional standalone `inputReference` uses the same validated PNG/JPEG/WebP upload object as image tools and is sent as `input_reference`. The in-app agent supplies `inputReferenceAssetId` instead; the host uploads the saved reference bytes.

### Advanced controls and read-only discovery

Call `discover_video_capabilities({"model":"EXACT_ENABLED_MODEL_ID"})` and
`list_video_loras({"model":"EXACT_ENABLED_MODEL_ID"})` to inspect the same selected
endpoint and credentials used for generation. Standalone use supplies its provider
model ID. Discovery performs authenticated GET requests only, never uploads or
submits a generation. It returns `{modelId,capabilities}` or `{modelId,loras}`.
Unsupported/older capability contracts fail explicitly. A model entry, installed
weight or available node does not establish GPU execution or visual fidelity.

`generate_video` exposes these additional fields:

| Field | Contract |
| --- | --- |
| `cameraLora` | `dolly-in`, `dolly-out`, `dolly-left`, `dolly-right`, `jib-up`, `jib-down`, or `static` |
| `cameraLoraStrength` | Finite 0–2; requires `cameraLora`; server default 0.8 |
| `loras` | Typed `[{id,strength?}]`, up to 4 distinct IDs including camera shorthand; finite strength 0–2, server default 1. Copy curated IDs from live discovery; never pass raw JSON or filenames |
| `seed` | Exact decimal **string** `"0"` through `"18446744073709551614"`; JSON numbers are rejected to avoid rounding |
| `motionSpeed` | Finite 0.025–1; requires the `slow-motion` LoRA and first-image reference |
| `loraReference` | Standalone PNG/JPEG/WebP upload object for `ingredients`; requires at least 5 seconds and no other LoRA |
| `loraReferenceStrength` | Finite 0–1; requires `ingredients`; server default 1 |
| `guidingFrames` | One to eight strict `{image,frameIndex,strength?}` anchors. `image` is a standalone upload object; unique integer pixel-frame positions are 0 through `seconds*24`, strength 0–1 defaults to 1 |

In-app tools replace `loraReference` with `loraReferenceAssetId` and guide `image`
with `assetId`. The host resolves the same project/library IDs used for ordinary
references. All first-image, Ingredients and guiding-image bytes share one 32 MiB
upload budget. No raw bytes, paths or URLs enter saved in-app tool arguments.

For example, an in-app request may use:

```json
{
  "model": "EXACT_ENABLED_MODEL_ID",
  "prompt": "The subject moves smoothly between the two anchors, fixed camera",
  "seconds": 1,
  "seed": "18446744073709551614",
  "cameraLora": "static",
  "guidingFrames": [
    {"assetId": "REAL_SAVED_IMAGE_ID", "frameIndex": 0},
    {"assetId": "ANOTHER_REAL_SAVED_IMAGE_ID", "frameIndex": 24, "strength": 0.8}
  ]
}
```

Guides are exclusive with first-image and Ingredients/reference-sheet modes.
Cinemagraph and slow-motion require a first image, so cannot combine with guides.
Cinemagraph also rejects moving camera LoRAs. Guiding mode supports Easel's 1–12
seconds. Temporal guides currently have graph-contract tests, not live GPU or
visual-quality validation. Check `guiding_frames.available` separately from
`supported`, and preserve its `validation` label when reporting readiness.

On HTTP, typed guide objects become `guiding_frames` JSON metadata with
`image_index`, `frame_index`, and `strength`, plus repeated `guiding_images`
uploads in their original order. Camel-case options map to the corresponding
snake-case API fields. The API remains authoritative for curated supported
LoRA IDs and installed weights. Clients validate structure, bounds, known recipe
conflicts and aggregate bytes before POST; unknown options are never silently
dropped. Basic requests do not require discovery, and generic endpoints retain
existing basic behavior. No generation POST is retried automatically.

Retrieve using `get_video`:

```json
{
  "videoId": "video_JOB_ID_FROM_SUBMISSION",
  "model": "connection-id:video-model",
  "waitSeconds": 15
}
```

Use the **same model ID** to select the original endpoint and credentials. `waitSeconds` is 0-15 (default 0), with checks every three seconds. Return pending work to the user instead of repeatedly polling or resubmitting it. Later chat turns retain the compact job reference. Completed jobs download by default; `download:false` only checks status. A completed result contains an embedded resource with `mimeType` and `blob`, plus structured job metadata. The host saves media locally, attaches it to the active project and displays a chat preview. Repeated completed retrievals reuse an existing asset reference from this conversation if it still exists. Video bytes never enter saved tool messages.

- Duration defaults to 4 seconds. Omitted size uses the endpoint's supported default, independently of reference image dimensions. Easel accepts integer durations from 1 to 12 seconds. The generic tool allows 1-60 seconds for other endpoints; actual model duration, resolution and reference support depend on the endpoint.
- Each video operation has an overall 45-second timeout and respects MCP cancellation. Stop ends local requests/waits; the API does not expose remote job cancellation, so accepted jobs may continue.
- Downloads are limited to 32 MiB and must match MP4/WebM file signatures and their declared MIME type. Credentials never follow HTTP redirects or arbitrary result URLs. Retry a failed download using the job ID instead of creating another job.
- Live OpenAPI currently omits response schemas. The parser accepts `id`/`video_id`, an optional `data` wrapper, and common queued/running/completed/failed status names. Unrecognized statuses are reported without claiming completion.
- Generated videos can be previewed, downloaded, exported with their project and shared from Media as sampled frames. They do not automatically have stored frame samples for `get_video_frames`. A video may include audio, but frame observations do not represent it.
- Refresh Settings > Models to discover video/audio output categories. Video/audio-only capability checks skip the image generation probe and explain that actual generation support is unverified; they do not submit a paid video/audio job.

## Reference image inputs

Standalone MCP image inputs contain base64 bytes without a data URL prefix. They do not accept filesystem paths or remote image URLs:

```json
{
  "prompt": "Change the background to a sunny courtyard",
  "model": "connection-id:provider-model",
  "images": [
    { "data": "BASE64_IMAGE_BYTES", "mimeType": "image/jpeg", "name": "reference.jpg" }
  ],
  "size": "1024x1024",
  "n": 1
}
```

`edit_image` accepts `prompt`, `images`, optional `mask`, `model`, `size`, and `n`. `create_image_variation` accepts one `image` object plus optional `model`, `size`, and `n`. A mask uses the same object shape with `mimeType: "image/png"`. Names are optional and limited to letters, numbers, dots, underscores, and hyphens.

The in-app agent instead supplies saved image asset IDs (`imageAssetIds` and optional `maskAssetId` for edits, `imageAssetId` for variations). The host resolves IDs to bytes before calling this server and saves and attaches returned images to the current canvas.

Limits and compatibility:

- References must be PNG, JPEG, or WebP with matching file signatures and readable dimensions; edits accept 1-16 references, with at most 32 MiB of decoded image and mask bytes combined.
- A mask must be a PNG smaller than 4 MiB with the same dimensions as the first reference image. Fully transparent mask areas identify the region to edit, if the selected provider supports masks.
- Easel's instruction/reference edits support multiple references and reject masks. Easel variations support JPEG and portrait references. Other providers may support only some operations or models; their errors are returned without automatic retries.
- Explicit `dall-e-2` edits require one square PNG smaller than 4 MiB and a prompt of at most 1000 characters. Its variations have the same PNG restriction. Its output sizes are `256x256`, `512x512`, and `1024x1024`.
- General edit prompts are limited to 5000 characters. `n` is 1-4. Sizes use `WIDTHxHEIGHT`; edits also accept `auto` when the provider supports it.
- Returned edits and variations contain image MCP content plus `count` and `mimeTypes` metadata, with a combined 32 MiB limit. The server requires base64 image output and does not follow returned image URLs.

Requests have a 180-second timeout and receive the MCP request's cancellation signal. GPT image models return base64 directly, so their requests omit the unsupported legacy `response_format` field; other models request `b64_json`.

Screenshot capture requires Playwright Chromium. Install it on the headless machine with:

```sh
npx playwright install chromium
```

The renderer caps markup at 1 MiB, accepts at most 8 local images/32 MiB, uses a fixed bounded viewport, blocks network requests, and times out after 10 seconds. Tool inputs do not accept filesystem paths or arbitrary hosts.

## License

Easel-owned code in this package is **GPL-3.0-or-later**. See LICENSE and NOTICE
in this package. Third-party dependencies keep their own license and copyright
notices. This declaration does not revoke any previously granted rights.

Source and build instructions are maintained in
https://github.com/venetanji/easel-client/tree/main/packages/media-mcp.
Distributors must provide the exact source revision and build materials matching
their package under an applicable GPL section 6 route; this moving link alone
is not a corresponding-source offer.
