# Easel API → library → timeline → export verification

This runner calls the production media provider, `importMediaFiles`, the managed media/image stores, `createCanvasStore`, the revision-safe timeline controller/store, and the bundled Electron/Mediabunny exporter. It preserves a separate test profile; it never opens or changes your normal Easel profile or decrypts saved settings.

## Current contract and discovery

The Easel API's validated, typed request contract is authoritative. The client and CLI consume it; they do not port or accept arbitrary Comfy graphs. Existing baseline routes were audited against [Easel `10f118a`](https://github.com/venetanji/easel/commit/10f118a818615595d53521d0ddae02b9c1d14d27). The coordinated generation-controls changes add the versioned capability endpoint and ordinary still-image guiding frames. A checkout does not establish that your deployment has those changes.

- Authenticated `GET /v1/models` discovers the actual deployment. Select the exact enabled model ID; LTX video uses `ltx-2.5`. In-app IDs can include an endpoint prefix and must not be replaced with a bare provider name.
- `GET /v1/videos/capabilities` returns `video.capabilities`, `schema_version: 1`, the model, 24 FPS, duration/size/seed limits, upload bounds and guide support. `guiding_frames.supported` describes code support; `available` checks required live nodes; `validation: "graph_contract_tested"` describes graph/source evidence, not successful GPU execution or visual fidelity.
- `GET /v1/videos/loras` separately reports `supported`, live `installed`, `requires`, validation/workflow evidence and provenance. Installed weights do not establish support or visual quality. Advanced cases require compatible runtime discovery before any generation.
- Multipart `POST /v1/videos` accepts one job. Poll `GET /v1/videos/{id}`, optionally inspect `/v1/videos/queue/{id}`, and download completed content at `/v1/videos/{id}/content`. States are `queued`, `in_progress`, `completed`, `failed`, `cancelled`. Content before completion is HTTP 409; unknown/expired IDs return 404. Credentials are bearer headers and redirects are not followed.
- Durable image jobs use `Prefer: respond-async` and `/v1/images/jobs/{id}`; synchronous image responses remain supported. Preserve any accepted receipt; polling never regenerates.

The published [creative-skills lineage](https://github.com/venetanji/creative-skills/tree/67f185c8f95182690e1ac56e734aa649f71b4df6) contains the legacy LTX-2.3 runtime and documentation of later work. The intended canonical LTX-2.5 runtime is unavailable in that published tree. Do not claim it has been imported or ported, or substitute its older model, sampler, source-audio or multi-guide semantics. Easel currently owns the validated LTX-2.5 graph.

### Agent and CLI controls

Built-in, embedded Codex and external in-app MCP agents share the asset-ID schema and selected-model endpoint routing. Standalone Media MCP uses the upload schema:

| Control | In-app / external app controller | Standalone MCP |
| --- | --- | --- |
| Read-only discovery | `discover_video_capabilities({model})`, `list_video_loras({model})` | Same tools |
| First image | `inputReferenceAssetId` | `inputReference: {data,mimeType,name?}` |
| Camera | `cameraLora`, `cameraLoraStrength` | Same fields |
| Curated adapters | `loras: [{id,strength?}]` | Same typed array, not a JSON string |
| Exact seed | `seed: "18446744073709551614"` | Same decimal string, never a JavaScript/JSON number |
| Slow motion | `motionSpeed` with `slow-motion` and first image | Same fields with upload |
| Ingredients sheet | `loraReferenceAssetId`, `loraReferenceStrength` | `loraReference: {data,mimeType,name?}`, `loraReferenceStrength` |
| Timed stills | `guidingFrames: [{assetId,frameIndex,strength?}]` | `guidingFrames: [{image:{data,mimeType,name?},frameIndex,strength?}]` |

All image references combined must fit **32 MiB** and use PNG/JPEG/WebP. In-app saved arguments contain asset IDs, never local paths, URLs or image bytes. Seed is an exact decimal string from `"0"` to `"18446744073709551614"`. Up to four distinct registered LoRAs, including camera shorthand, use finite strengths 0–2; camera default is 0.8 and regular default is 1. Registry-specific compatibility still applies.

The server decodes each guide, verifies its format against the declared MIME and rejects animated/malformed files or images exceeding 32 million pixels before upstream work. Guiding frames contain **1–8 stills**, unique integer **pixel-frame** indices from `0` through `seconds * 24` inclusive, step **one**, with strength 0–1 (default 1). They are exclusive with first-image and Ingredients/reference-sheet modes. Cinemagraph and slow-motion need a first image and therefore cannot be used in guide mode. Guidance is soft, including at strength 1: it does not guarantee exact endpoint pixels, frame copying, continuity or a seamless loop. The two-pass guide graph is source/graph-contract tested; this implementation has not been GPU/visually verified.

The synchronized Python CLI exposes `easel video capabilities`, `easel video loras`, repeatable `--lora ID[=STRENGTH]` and `--guide-frame FRAME IMAGE STRENGTH` generation options. Legacy `--loras` JSON is mutually exclusive with typed `--lora`. CLI guide images are explicit bounded local regular files; metadata contains upload indices, not local paths. Python can preserve integer seeds exactly. Use the installed command's help to verify its version before sending advanced requests.

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

Reads the catalog, OpenAPI route presence (if exposed), and the provider's exported `discoverVideoCapabilities` / `listVideoLoras` functions. Those discovery functions validate the versioned schema and issue GETs only. No generation, no uploads, no capability-check generation, and no settings changes. An unavailable OpenAPI document, unsupported capability schema or adapter backend is reported separately; it cannot prove model execution. Compare this result with the source contract above. Desktop **Settings > Models > Check** may generate media and incur charges; it is not this read-only probe.

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

With no `--scenario`, this is the unchanged **baseline** case. It submits **exactly two** text-to-video jobs, each `ltx-2.5`, **1 second, 512×320**, without reference uploads or adapters. Total requested generation is 2 seconds. These bounds cannot be increased by command-line flags. A local encoder/decoder preflight runs before submission. Generation requests are never retried automatically.

The API publishes no monetary price or enforceable spend cap. We cannot provide a dollar estimate from this contract. Check the provider/host's pricing before running; even failed or interrupted jobs may consume GPU resources. Low-resolution success does not establish delivery-resolution quality, high-resolution VRAM capacity, or adapter support.

### Named advanced cases, separately opted in

Choose exactly one case. There is no `all` mode, automatic scenario expansion, arbitrary image URL, or job-count/duration/size override:

```sh
node scripts/test-live-video-workflow.cjs --live --allow-generation-cost --scenario camera
node scripts/test-live-video-workflow.cjs --live --allow-generation-cost --scenario guided-frames
```

Each command submits **at most two**, and on successful acceptance exactly two, 1-second 512×320 jobs. Running both commands is two separate paid runs; consent is required each time. Both use the exact decimal-string seeds `"0"` and `"18446744073709551614"`.

- `camera`: tests `cameraLora: "dolly-in"` with strength 0.8 in the first job and typed `loras: [{id:"camera-static",strength:0.8}]` in the second. Discovery must report both adapters supported and installed with no extra required inputs.
- `guided-frames`: each job uploads the committed original synthetic `test/fixtures/video-export/overlay.png` still twice, at pixel-frame positions 0 and 24, strength 0.7. The fixture is a simple yellow image, not user media. There is no extra image generation or remote image fetch. Capabilities must report available guide nodes, step-one indices, two or more guides and the expected PNG/upload contract. This exercises submission/graph plumbing and export, not guide fidelity; inspect the outputs yourself before any visual claim.

Both advanced cases fail before submission if the versioned capability schema, model, requested size, seed encoding or scenario requirements are unknown or unavailable. The baseline remains usable on older endpoints and records discovery errors without claiming advanced support. OpenAPI route visibility is diagnostic only; the typed capability response is the advanced gate. All cases run the same local codec preflight and retain accepted IDs before polling.

After downloading both real outputs, the runner:

1. Decodes actual source dimensions/duration/audio metadata. LTX generates `seconds × 24 + 1` frames; it does not assume the receipt contains duration or that requested dimensions equal decoded dimensions.
2. Imports each original file intact into a fresh managed library, stores decoded metadata, and attaches it to a new test project.
3. Uses typed timeline operations to insert, trim each clip to source `[0.25, 0.75)` seconds, and reverse their order into a 24-frame / 1-second, 512×320 output. This deliberate short retained span is recorded in `timeline.json`; it is not an accidental whole-clip duration truncation.
4. Adds the committed WAV audio layer with fades and the PNG image overlay. These two layers are synthetic local fixtures; only the two video sources are generated live.
5. Reloads the durable timeline, renders real WebM locally, decodes all 24 frames and audio, and compares pixels at the two cut boundaries against the corresponding generated source frames. It does not judge whether the model followed each prompt.
6. Saves the render back to the managed library and project, and verifies that downloaded, library, and attached source SHA-256 hashes are unchanged.

The evidence directory printed before work begins contains `receipts.json` (scenario, fixed bounds, expected job count and original receipts), `discovery.json`, downloaded source media, `timeline.json`, `stitched.webm`, `evidence.json`, isolated renderer directories, and a fresh test app profile. These include user-owned job IDs/media and local paths; review them before sharing. The key is excluded. Keep or delete this disposable directory yourself after inspection.

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

Resume checks the saved scenario, fixed bounds and two-receipt count, then only polls/downloads those IDs and reruns the local workflow in a new test profile. It cannot submit generation, choose another scenario or replace a receipt. Older version-1 baseline receipts remain readable. If submission failed before a receipt was saved, the runner intentionally refuses to invent or replace the missing ID. Recover known IDs individually with the CLI and inspect server logs/queue for the missing receipt; the original request may have been accepted. A content mismatch against an already downloaded source also stops rather than overwriting it.

Unset the process credential afterward:

```sh
unset EASEL_API_KEY
```

## Coverage and remaining limits

- `node --test test/live-video-workflow.test.js`: offline flags/cost gate, named requests, discovery preflight, schema/bounds and receipt/resume checks. Provider and renderer fakes make no network or paid calls.
- `npm run test:video-export`: independent deterministic compositor tests, including A/V timing, audio mixing/fades, layer order, cancellation, repeat exports, malformed input, and source hashes.
- `npm test`: full application and Media MCP regression suites.
- This runner invokes production modules and the real Electron codec path, not UI clicks. It does not test the built-in LLM conversation, unattended completion after an app restart, file-picker interaction, every model/adapter, every OS codec combination, or remote deployment correctness without a successful live run.
- Image references share one combined 32 MiB upload limit; source/download/export limit is 32 MiB per media file. The renderer has its normal bounded export limits; the test uses only one second at 512×320. A decoder or renderer failure remains a failure even if the API succeeded.
- Automated live calls were not run while preparing this code. An offline pass and source audit must never be reported as a successful live generation test.
