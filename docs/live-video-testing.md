# Easel API → library → timeline → export verification

This runner calls the production media provider, `importMediaFiles`, the managed media/image stores, `createCanvasStore`, the revision-safe timeline controller/store, and the bundled Electron/Mediabunny exporter. It preserves a separate test profile; it never opens or changes your normal Easel profile or decrypts saved settings.

## Current contract and supported subset

Audited against [Easel main `10f118a`](https://github.com/venetanji/easel/commit/10f118a818615595d53521d0ddae02b9c1d14d27):

- [Models and routes](https://github.com/venetanji/easel/blob/10f118a818615595d53521d0ddae02b9c1d14d27/easel/app.py): `qwen-image-2.1` for images; `ltx-2.5` appears only when the video backend is configured. Discover your actual deployment with authenticated `GET /v1/models`. A catalog entry alone does not verify successful execution.
- [Video API](https://github.com/venetanji/easel/blob/10f118a818615595d53521d0ddae02b9c1d14d27/VIDEO_API.md): multipart `POST /v1/videos`; required `model`, `prompt`; optional whole `seconds` 1–12, preset `size`, and PNG/JPEG/WebP `input_reference`. Poll `GET /v1/videos/{id}`; optional queue diagnostics at `/v1/videos/queue/{id}`; download completed MP4 at `/v1/videos/{id}/content`. States are `queued`, `in_progress`, `completed`, `failed`, `cancelled`. Content before completion is HTTP 409, unknown/expired IDs 404. Credentials are bearer headers and redirects are not followed.
- [Durable image jobs](https://github.com/venetanji/easel/blob/10f118a818615595d53521d0ddae02b9c1d14d27/IMAGE_JOBS.md) are shipped: `Prefer: respond-async` on generation/edit/variation returns HTTP 202 and an exact receipt; poll `/v1/images/jobs/{id}`. Without that preference, synchronous image output remains supported. Preserve the receipt; polling never regenerates.
- [LoRA discovery](https://github.com/venetanji/easel/blob/10f118a818615595d53521d0ddae02b9c1d14d27/VIDEO_LORAS.md): `/v1/videos/loras` distinguishes `supported`, validation evidence, required fields, and live `installed` state. Installed is not validated. The server has additional camera/LoRA/seed/ingredients controls. The desktop's public Media MCP deliberately exposes the basic video/reference subset, not every server field. Do not invent extra tool arguments.

The earlier CLI default `flux2-9b` does not match the current two-model server catalog. Use the synchronized CLI branch and `models` discovery; do not assume an old installed CLI knows the current server. The server is the API source of truth; no server runtime change is required for this test.

## Build and credentials

Requires Node.js 22+, a supported Electron desktop runtime, and the current checkout:

```sh
npm ci
npm run build
```

Set `EASEL_BASE_URL` explicitly to your intended server (the runner accepts a trailing `/v1`). Remote endpoints must use HTTPS; HTTP is accepted only for loopback. Supply `EASEL_API_KEY` through a local secret manager or a hidden terminal prompt. Do not put a real key in shell arguments, source files, screenshots, commits, reports, or chat.

For Bash, with shell tracing disabled:

```sh
set +x
export EASEL_BASE_URL='https://easel.ait4x.org'
read -r -s -p 'Easel API key: ' EASEL_API_KEY; printf '\n'
export EASEL_API_KEY
```

Use your actual authorized deployment URL if different. The runner does not save the key or send it to the renderer. Authentication is not evidence of permission to generate; only the explicit live flags below enable submission.

## 1. Read-only deployment probe

```sh
node scripts/test-live-video-workflow.cjs --probe
```

Reads the catalog, OpenAPI route presence (if exposed), and adapter discovery. No generation, no uploads, no capability-check generation, and no settings changes. An unavailable OpenAPI document or adapter backend is reported separately; it cannot prove model execution. Compare this result with the source contract above. Desktop **Settings > Models > Check** may generate media and incur charges; it is not this read-only probe.

## 2. Offline integration, no API key or network

```sh
node scripts/test-live-video-workflow.cjs --offline
```

Uses the committed synthetic MP4/WAV/PNG fixtures. It proves the actual local import, project attachment, timeline edits/reload, render, decoded output, saved export, and source-preservation path. It does not prove server submission or generation. The output explicitly says `offline-fixtures` and `liveGenerationVerified: false`.

Linux needs an existing desktop `DISPLAY`; for a headless development machine with Xvfb already installed:

```sh
xvfb-run -a node scripts/test-live-video-workflow.cjs --offline
```

Do not expose an unauthenticated display server to run these tests. macOS and Windows normally use their desktop session.

## 3. Explicit opt-in live generation

```sh
node scripts/test-live-video-workflow.cjs --live --allow-generation-cost
```

This submits **exactly two** text-to-video jobs, each `ltx-2.5`, **1 second, 512×320**, without reference uploads or adapters. Total requested generation is 2 seconds. These bounds cannot be increased by command-line flags. A local encoder/decoder preflight runs before submission. Generation requests are never retried automatically.

The API publishes no monetary price or enforceable spend cap. We cannot provide a dollar estimate from this contract. Check the provider/host's pricing before running; even failed or interrupted jobs may consume GPU resources. Low-resolution success does not establish delivery-resolution quality, high-resolution VRAM capacity, or adapter support.

After downloading both real outputs, the runner:

1. Decodes actual source dimensions/duration/audio metadata. LTX generates `seconds × 24 + 1` frames; it does not assume the receipt contains duration or that requested dimensions equal decoded dimensions.
2. Imports each original file intact into a fresh managed library, stores decoded metadata, and attaches it to a new test project.
3. Uses typed timeline operations to insert, trim each clip to source `[0.25, 0.75)` seconds, and reverse their order into a 24-frame / 1-second, 512×320 output. This deliberate short retained span is recorded in `timeline.json`; it is not an accidental whole-clip duration truncation.
4. Adds the committed WAV audio layer with fades and the PNG image overlay. These two layers are synthetic local fixtures; only the two video sources are generated live.
5. Reloads the durable timeline, renders real WebM locally, decodes all 24 frames and audio, and compares pixels at the two cut boundaries against the corresponding generated source frames. It does not judge whether the model followed each prompt.
6. Saves the render back to the managed library and project, and verifies that downloaded, library, and attached source SHA-256 hashes are unchanged.

The evidence directory printed before work begins contains `receipts.json`, `discovery.json`, downloaded source media, `timeline.json`, `stitched.webm`, `evidence.json`, isolated renderer directories, and a fresh test app profile. These include user-owned job IDs/media and local paths; review them before sharing. The key is excluded. Keep or delete this disposable directory yourself after inspection.

## Timeout and recovery

Polling defaults to 1200 seconds total for both jobs. You can choose 30–3600 seconds:

```sh
node scripts/test-live-video-workflow.cjs --live --allow-generation-cost --timeout-seconds 1800
```

A timeout, failed download, or closed terminal does **not** cancel jobs. Current Easel video has no cancellation or idempotency/recovery endpoint. It retains video IDs for 24 hours from creation, and the ComfyUI backend must still retain history/output. Do not start another live run merely because polling stopped.

Resume a run that saved both exact IDs, with the same endpoint and key:

```sh
node scripts/test-live-video-workflow.cjs --resume /path/to/easel-video-integration-XXXXXX
```

Resume only polls/downloads those IDs and reruns the local workflow in a new test profile. It cannot submit generation. If submission failed before a receipt was saved, the runner intentionally refuses to invent or replace the missing ID. Recover known IDs individually with the CLI and inspect server logs/queue for the missing receipt; the original request may have been accepted. A content mismatch against an already downloaded source also stops rather than overwriting it.

Unset the process credential afterward:

```sh
unset EASEL_API_KEY
```

## Coverage and remaining limits

- `node --test test/live-video-workflow.test.js`: offline safety/receipt checks.
- `npm run test:video-export`: independent deterministic compositor tests, including A/V timing, audio mixing/fades, layer order, cancellation, repeat exports, malformed input, and source hashes.
- `npm test`: full application and Media MCP regression suites.
- This runner invokes production modules and the real Electron codec path, not UI clicks. It does not test the built-in LLM conversation, unattended completion after an app restart, file-picker interaction, every model/adapter, every OS codec combination, or remote deployment correctness without a successful live run.
- Source/download/export limit is 32 MiB per media file. The renderer has its normal bounded export limits; the test uses only one second at 512×320. A decoder or renderer failure remains a failure even if the API succeeded.
- Automated live calls were not run while preparing this code. An offline pass and source audit must never be reported as a successful live generation test.
