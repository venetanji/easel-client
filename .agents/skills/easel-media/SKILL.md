---
name: easel-media
description: Generate and edit Easel images, submit durable video jobs, choose camera and LoRA workflows, and prepare offline canvas previews. Use for Easel media requests, including multiprompt batches and guided-video planning.
---

# Easel Media

Use the Media MCP tools to create media; use saved assets for references and the
host monitor for accepted jobs. Distinguish a planned workflow from one the
current tool schema and endpoint actually support.

## Models and references

The target Easel service has two provider models: `qwen-image-2.1` for images and
reference edits, and `ltx-2.5` for video. The legacy `flux2-9b` and `flux2-4b`
models are being retired. Do not substitute Flux for an unavailable model.
`flux-2.5` is not the LTX video model ID.

Use the exact enabled ID from `list_models`; in-app IDs can include an endpoint
prefix, so do not replace them with bare provider names. Discovery and tool
schemas, not this target configuration, determine what can be called now.

The in-app harness injects this file only, so the essential practices and full
ID inventory are included here. File-aware agents can read more detail as needed:

- [Prompting and review](references/prompting-and-review.md): distilled image,
  shot, reference, continuity and audio practices from creative-skills.
- [Advanced video](references/advanced-video.md): camera controls, adapter
  requirements, guide-video preparation and current tool/API boundaries.
- [LoRA inventory](references/loras.md): all 38 catalog IDs, purposes and support
  states; [pinned catalog](references/lora-catalog.json) contains exact files,
  revisions, checksums and validation metadata.

The catalog is a snapshot, not a live installation or compatibility guarantee.
Before selecting an adapter, verify live discovery when available and require
`supported`, `installed`, required inputs and an exposed tool path. If discovery
or an advanced tool is unavailable, describe the limitation instead of submitting
unknown arguments or falling back to direct host commands.

## Available tools

The current Media MCP package exposes:

- `list_models` to inspect enabled Media model IDs, endpoint names and discovered output types.
- `generate_image` to create images from a prompt, optional model, `WIDTHxHEIGHT` size, and `n` from 1 to 4. Easel also interprets `|||` as independent image prompts; see the batching limits below.
- `edit_image` and `create_image_variation` to transform saved reference images when supported by the endpoint.
- `discover_video_capabilities({model})` and `list_video_loras({model})` for read-only, selected-endpoint discovery of limits, guide-node availability, supported/installed adapters and validation evidence.
- `generate_video` to submit one video job with a video model, prompt, seconds, size, first-image or timed-image references, and the typed advanced controls below.
- `get_video` and `get_image_job` to retrieve accepted jobs in standalone MCP use.
- In-app `list_media_jobs`, `list_media_assets` and `inspect_media_asset` to inspect durable jobs and choose real saved references.
- `capture_canvas_screenshot` to render HTML and local image assets in an offline browser and return a PNG screenshot.

Built-in, embedded Codex and external in-app MCP agents use the same saved-asset
schema. Standalone MCP uses bounded image upload objects. Server capability
schema version 1 is authoritative; unknown/older responses are unknown support,
not permission to guess. Audio generation/source-audio tools and guide-video
uploads are not available. Do not imply that a job was submitted or finished
without its tool result.

## Video workflow

1. Select a video model using its exact `list_models` ID. In-app tools resolve credentials from that model's endpoint.
2. For advanced controls, discover capabilities and LoRAs for that exact model first. Check support, runtime availability, installed assets and recipe requirements separately; discovery is GET-only and does not generate. Submit `generate_video` once. Optional `inputReferenceAssetId` identifies a saved PNG/JPEG/WebP image in the app; standalone MCP uses an `inputReference` upload object.
3. In Easel client, accepted jobs are saved in the host monitor before the turn ends. Return a brief generating status; the host polls and downloads across app restarts without spending agent tool calls. `list_media_jobs` gives a status snapshot.
4. The originating conversation receives a durable completion notification. If it is idle, its original project is open, and its Agent model/endpoint has not changed, the host resumes it automatically. Otherwise the next message receives the notification. Stop pauses agent continuation while polling continues.
5. Completed downloads are saved to Media, attached to the original project, and previewed automatically in chat. Use the notification's asset IDs to continue the original request; never regenerate a completed job. A brief completion message is enough; do not send only a View/Watch link. Removing a job asks the user to confirm losing the monitor's ID; it does not cancel server generation or remove downloaded files.
6. Standalone MCP without the host monitor can retrieve with `get_video`, using the same `videoId` and `model`. Preserve IDs and never resubmit a pending job.

For text-only video, omit `inputReferenceAssetId` or set it to `null`. Never invent an asset ID or use all-zero placeholders. A local `INVALID_MEDIA_REFERENCE` error means the API was not called; correct the reference or omit it and retry the corrected request.

Stop cancels local work, not an accepted remote job. Easel accepts integer durations from 1 to 12 seconds; other endpoint limits depend on the model. Duration defaults to 4 seconds. Omit size unless the user requests dimensions, allowing the endpoint to choose a supported default. Reference image dimensions do not determine video dimensions. Downloads are bounded to 32 MiB. See the package README for endpoint contracts and limits.

## Image workflow

Image endpoints may honor `Prefer: respond-async` and return an accepted
`{id,status}` job receipt instead of immediate image bytes. Those receipts use the
same persistent monitor as videos: submit once, end the turn after acceptance,
and continue from the completion notification. Synchronous image responses still
work. `GET /v1/images/jobs/{id}` requires upstream support; never assume it from
the model name alone. Completed results include `data:[{b64_json}]`.

1. Preserve the user's subject, intended use, and named visual references.
2. Ask a concise follow-up only when a missing choice would materially change the result.
3. Use `list_models` when the user asks for a model choice or the available models are unknown and model choice matters.
4. Call `generate_image` with a concrete prompt. Include composition, lighting, medium, palette, and aspect ratio when they are part of the brief. Set `size` only when the user gives a ratio or a destination needs one.
5. Show the returned image and describe only what the tool actually produced.

For reference edits, use real `imageAssetIds` in-app (`images` uploads in standalone
MCP). Qwen accepts up to 16 references, subject to the combined 32 MiB upload cap;
use only the references needed for the shot. Easel does not support edit masks.

### Multiprompting with `|||`

On Easel image generation and reference edits, a prompt such as
`A red ceramic cup on linen ||| A blue ceramic cup on linen` requests two
independent outputs in one backend job. Write each segment as a complete prompt
with its own shared subject/style constraints. For edits, all segments use the
same supplied references. This is not a video timeline or a multi-shot clip.

Set `n: 1` for clarity. With multiple nonempty segments, Easel ignores `n` and
uses one image per segment; without splitting, `n` requests variations of one
prompt. Empty segments are discarded. The whole tool prompt must fit 5,000
characters. The separator is endpoint-specific and may be configured differently.

**Current client limit: at most four nonempty segments.** The server permits 16,
but v0.0.2 image result parsing rejects more than four, including queued-job
downloads. Do not create a larger job until that client path is upgraded. Prefer
a small coherent batch over many individual submissions; review before expanding.

## Queue discipline

- Let the host poll; use `list_media_jobs` only when a status snapshot is useful.
- Preserve the receipt ID and original model/endpoint. Stop, model retirement or
  a closed conversation must not trigger regeneration of an accepted job.
- Do not blindly retry a generation POST after receipt loss or a timeout;
  acceptance is ambiguous and the server has no idempotency recovery contract.
- Queue estimates are approximate and may be absent. `estimated_wait_seconds`
  on Easel means time to completion, including generation, not queue time alone.
- HTTP 429 with `Retry-After` is admission backpressure, not permission for a
  burst of retries or a new model fallback.

## Creative practices

These distilled creative-skills practices guide art direction, not model-fidelity
guarantees. Do not transfer Flux-specific sampler settings or prompt tricks.

- Write image prompts as scene-first prose: subject/action, setting, framing,
  materials, lighting and palette. Describe lighting source, quality and
  direction; avoid keyword soup and contradictory instructions.
- Keep identity descriptions pose-neutral. Let the shot define pose/action;
  expand any storyboard subject tokens before submission. Unresolved `{subject}`
  is not MCP syntax. State each edit reference's role and what must stay fixed.
- Review identity, silhouette, composition and unwanted text in an anchor before
  animating it. Use only necessary references, not all available images.
- Write one coherent video shot in present tense, with action proportional to
  duration. Describe visible expressions rather than internal emotional labels;
  quote dialogue in short phrases and specify desired ambience/voice/music.
- Describe camera motion relative to the subject and what it reveals. A dolly
  translates the camera, not merely zooms the lens. Match prose to the adapter;
  do not request a locked camera and a moving camera at once.
- A first-frame image guides appearance, not an entire camera path. Guide videos
  need actual registered depth/edge/pose frames, not renamed RGB footage.
- For longer sequences, plan cuts and retained frame spans. Use an approved
  anchor or the previous clip's actual retained endpoint for continuity. Guide
  context must not appear as extra delivered frames. Timed stills can guide the
  first/last positions through `guidingFrames`; continuation and source-video
  controls are not exposed. Soft guidance does not guarantee exact endpoints.
- For music videos, review the track and anchors before rendering every scene.
  Derive timing from the real track/phrases; preserve and mux the approved master
  audio once during assembly. Supplied-audio control is a separate capability,
  not an exposed MCP argument or a promise of native beat synchronization.
- Separate execution from visual quality: a receipt/preview/installed weight is
  not proof of correct motion or a final deliverable. Inspect native first,
  middle, last and boundary frames for parallax, drift, flicker and identity.
- Check decoded dimensions, FPS, frame count, duration and audio. The current
  nominal 1280x720 video preset decodes to 1280x704 (portrait 704x1280); do not
  promise exact requested delivery geometry without checking output.
- Start uncertain adapter workflows with a short, low-resolution pilot and
  review before scaling. That pilot does not establish high-resolution VRAM
  capacity. Where settings are exposed, hold seed/other settings fixed and vary
  one parameter; greater guide/LoRA strength is not automatically better.

## Advanced video boundaries and recipes

Use the fields the current tool schema exposes. The validated Easel API owns
the graph contract; do not bypass app asset/credential handling with direct
API/shell calls, raw graphs, model filenames, host paths or download URLs.
The published creative-skills runtime is legacy LTX-2.3; its intended canonical
LTX-2.5 runtime remains unavailable. This client is an Easel API consumer, not a
claimed port of that unpublished runtime.

Both in-app and standalone `generate_video` accept `cameraLora`,
`cameraLoraStrength`, typed `loras: [{id,strength?}]`, exact decimal-string
`seed`, `motionSpeed` and `loraReferenceStrength`. In-app uses
`loraReferenceAssetId` for an Ingredients sheet and
`guidingFrames: [{assetId,frameIndex,strength?}]` for timed stills. Standalone
uses `loraReference: {data,mimeType,name?}` and
`guidingFrames: [{image:{data,mimeType,name?},frameIndex,strength?}]` instead.
All references combined are bounded to 32 MiB and PNG/JPEG/WebP. Use real saved
asset IDs; in-app arguments must never contain image bytes, local paths or URLs.

Camera shorthand: `dolly-in`, `dolly-out`, `dolly-left`, `dolly-right`, `jib-up`,
`jib-down`, `static`. Dolly left/right means camera translation, not pan;
jib up/down means vertical movement. Use `cameraLora: "dolly-in"` with
`cameraLoraStrength: 0.8`, or a registered camera entry in `loras`, not both
for the same adapter. There are no registered pan/tilt/orbit IDs.

`loras` is a typed array, such as `[{"id":"camera-static","strength":0.8}]`,
not a JSON string. At most four distinct registered adapters may be selected,
counting the shorthand camera. Finite strengths are 0–2; camera shorthand
defaults to 0.8, other entries to 1. The stack cap is not evidence that arbitrary
combinations are validated. Support and installation must be discovered live.

- `cinemagraph`: needs `inputReferenceAssetId` (standalone `inputReference`);
  the server inserts `CINEMAGRAPH_MOTION`. Describe localized subject motion;
  moving camera stacks are rejected. A cinemagraph is not a guaranteed loop.
- `slow-motion`: needs the first-image reference and `motionSpeed` in 0.025–1;
  0.2 is a tested example. Conditioning becomes 120 FPS while output/audio
  remain 24 FPS. It does not interpolate an uploaded clip.
- `ingredients`: needs a separate `loraReferenceAssetId` sheet (standalone
  `loraReference`), at least 5 seconds, and no other adapter stack. Match sheet
  aspect ratio to output. `loraReferenceStrength` is finite 0–1, default 1.
  Frame geometry/identity fidelity remains experimental.

Seed must be an exact decimal string from `"0"` through
`"18446744073709551614"`, never a JSON number, so uint64 precision is retained.
Current LTX output is 24 FPS with `seconds * 24 + 1` frames. Camera/regular
patches feed both sampling passes; IC adapters need loader metadata and
control-specific guide/crop handling, not just model patches.

### Timed still-image guides

`guidingFrames` accepts 1–8 stills at unique integer **pixel-frame** positions
from 0 through `seconds * 24` inclusive, step **one**, not multiples of eight.
Strength is finite 0–1, default 1. The server requires decoded still images
with at most 32 million pixels each and format matching the declared MIME;
animated PNG/WebP and malformed images are rejected before submission.
Guide mode is exclusive with first-image
and Ingredients/reference-sheet modes. Cinemagraph and slow-motion require a
first image and therefore are unavailable with timed guides.

Check `guiding_frames.supported`, `available` and `validation` separately.
The new path is `graph_contract_tested`, not live-GPU/visually verified. The
server applies guides to video-only latents in each pass, crops their context
before spatial upscale and decode, and preserves generated audio. Strength 1
is still soft conditioning: never promise exact frame copying, hard endpoints,
seamless continuity or loop closure. Inspect actual first/middle/last frames.

The synchronized CLI exposes `video capabilities`, `video loras`, repeated
`--lora ID[=STRENGTH]` and `--guide-frame FRAME IMAGE STRENGTH`. Its local image
files are bounded regular files; Python integer seeds retain exact precision.
Legacy `--loras` JSON cannot be combined with typed `--lora`. These CLI forms
are not MCP tool argument syntax.

### Guiding-video preparation

There is no current typed guide-video submission path in Easel API/MCP. Most
video-conditioned IC adapters remain disabled even when their weights are
installed. A private ComfyUI prototype is not a portable callable workflow.

Prepare depth for spatial layout/occlusion/parallax, real Canny for silhouettes,
or pose for body motion. Register RGB and control frames at matching aspect,
dimensions, FPS and frame count. For authored WebGL, evaluate animation once
per frame and use that render's actual depth buffer; keep consistent orientation
and a fixed-global depth mapping. Do not apply RGB tone mapping to depth,
normalize depth per frame or present plain grayscale as Canny. Record any
threshold/dilation/resize; review control previews before expensive synthesis.

Checked LTX guide profiles use `8n+1` frames. Require the selected validated
workflow's guide placement/strength, guide-token crops before upscale/decode,
retained-frame bookkeeping and aligned source audio. Do not blindly copy guide
nodes to every sampling pass. Refine Details uses a specialized IC tiled-fusion
workflow with `LTXVTiledFusionSampler`/`LTXVGetTilingSizes`, not the old
`LTXVTiledSampler`; it can alter faces/text/textures, so it is not lossless
upscale. A periodic guide or stronger conditioning does not certify an output
loop, exact topology, camera speed or beat alignment.

## Complete adapter ID inventory

This compact snapshot is included for in-app agents that cannot open supporting
files. "Enabled" means supported by the inspected server workflow, not installed
on every backend or visually guaranteed. Require live support, installation,
required inputs **and** an exposed tool path before submission. All disabled
entries have no execution validation in this server snapshot.

Seven older-family camera adapters have short T2V execution evidence on the
current LTX-2.5 server path; this does not certify I2V/stacks or exact motion.
The three enabled LTX-2.5 special recipes are experimental. The remaining
families are catalog provenance, not additional served base models.

| ID | Purpose | Server snapshot | Extra input |
| --- | --- | --- | --- |
| `camera-dolly-in` | Move toward subject | Enabled | None |
| `camera-dolly-left` | Translate left | Enabled | None |
| `camera-dolly-out` | Pull away | Enabled | None |
| `camera-dolly-right` | Translate right | Enabled | None |
| `camera-jib-down` | Lower camera | Enabled | None |
| `camera-jib-up` | Raise camera | Enabled | None |
| `camera-static` | Locked framing | Enabled | None |
| `cinemagraph` | Localized image motion | Enabled, experimental | `input_reference` |
| `slow-motion` | Generated slow motion | Enabled, experimental | `input_reference`, `motion_speed` |
| `clean-plate` | Clean plate | Disabled | Video + IC guide |
| `colorization` | Colorize video | Disabled | Video + IC guide |
| `day-to-night` | Day/night transformation | Disabled | Video + IC guide |
| `deblur` | Deblur video | Disabled | Video + IC guide |
| `decompression` | Restore compression damage | Disabled | Video + IC guide |
| `ingredients` | Reference-sheet conditioning | Enabled, experimental | `lora_reference`, >=5s, no stack |
| `pixel-upscaler` | Pixel x2 upscale | Disabled | Video + IC guide |
| `refine-details` | Detail refinement/upscale | Disabled | Video + IC guide + fusion workflow |
| `restore` | Restore video | Disabled | Video + IC guide |
| `water-simulation` | Water-effect transformation | Disabled | Video + IC guide |
| `ltx-2-canny-control` | Edge-video guidance | Disabled | Video + IC guide |
| `ltx-2-depth-control` | Depth-video guidance | Disabled | Video + IC guide |
| `ltx-2-detailer` | Detail enhancement | Disabled | Video + IC guide |
| `ltx-2-pose-control` | Pose-video guidance | Disabled | Video + IC guide |
| `ltx-2-union-control` | Union guidance | Disabled | Video + IC guide |
| `ltx-2.3-cinemagraph` | Legacy cinemagraph | Disabled | No declared extras; unvalidated |
| `ltx-2.3-clean-plate` | Clean plate | Disabled | Video + IC guide |
| `ltx-2.3-colorization` | Colorize video | Disabled | Video + IC guide |
| `ltx-2.3-cross-eyed` | Cross-eyed transformation | Disabled | Video + IC guide |
| `ltx-2.3-day-to-night` | Day/night transformation | Disabled | Video + IC guide |
| `ltx-2.3-deblur` | Deblur video | Disabled | Video + IC guide |
| `ltx-2.3-decompression` | Restore compression damage | Disabled | Video + IC guide |
| `ltx-2.3-foley-v2a` | Video-conditioned Foley | Disabled | Video + audio-generation workflow |
| `ltx-2.3-in-outpainting` | Video in/outpainting | Disabled | Video + IC guide |
| `ltx-2.3-ingredients` | Reference conditioning | Disabled | Sheet + IC guide |
| `ltx-2.3-instant-shave` | Instant-shave transformation | Disabled | Video + IC guide |
| `ltx-2.3-pixel-spatial-upscaler` | Pixel x2/x4 upscale | Disabled | Video + IC guide |
| `ltx-2.3-relight` | Video relighting | Disabled | Video + IC guide |
| `ltx-2.3-water-simulation` | Water-effect transformation | Disabled | Video + IC guide |

Video + IC guide denotes catalog requirements `reference_video` and `ic_guide`,
not exposed MCP fields. Listing Foley does not enable audio-generation tools.
Do not download all catalog weights or treat installation as workflow validation.

## Canvas preview

Use `capture_canvas_screenshot` to inspect a self-contained HTML composition. Pass only local image data in the `assets` field. The renderer blocks network access; do not use remote image URLs. Never put credentials, arbitrary hostnames, or filesystem paths in tool arguments.

When the tool is unavailable, explain that the project includes a local stdio server in `packages/media-mcp` and point to its README for setup. Do not claim to have generated or previewed anything without a tool result.
