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
    "apiKey": "configured-secret"
  }
]
```

With this configuration, image tools require the exact `id` returned by `list_models`. The server selects that entry's endpoint, key, and provider model. An empty array disables image tools. Without the array, standalone tools use `EASEL_BASE_URL` and `EASEL_API_KEY`, and the provider model is optional.

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
