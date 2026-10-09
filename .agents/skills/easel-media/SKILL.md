---
name: easel-media
description: Generate and edit Easel media, assemble managed clips with revision-safe timeline tools, review stitching and audio continuity, and plan supported video workflows. Use for media requests, timeline edits and guided-video planning.
---

# Easel Media

Create media with MCP; reuse saved references. Host monitoring follows accepted
image/video jobs and captured audio tracks. Require exposed tools and endpoint support.

## Models and references

Known models: `qwen-image-2.1` for images/edits, `ltx-2.5` for video; discover enabled IDs. Legacy `flux2-9b`/`flux2-4b` are retiring. Do not substitute Flux; `flux-2.5` is not LTX.

Use exact IDs from `list_models`, including endpoint prefixes. Discovery and exposed schemas determine current tools.

The in-app harness injects this file only. File-aware agents can also read:

- [Prompting and review](references/prompting-and-review.md): distilled image,
  shot, reference, continuity and audio practices from creative-skills.
- [Advanced video](references/advanced-video.md): camera controls, adapter
  requirements, guide-video preparation and current tool/API boundaries.
- [LoRA inventory](references/loras.md): all 38 catalog IDs, purposes and support
  states; [pinned catalog](references/lora-catalog.json) contains exact files,
  revisions, checksums and validation metadata.

The catalog is a snapshot. Require live `supported`, `installed`, required
inputs and an exposed tool path. Otherwise explain the limitation; never guess
arguments or fall back to direct host commands.

## Available tools

The current Media MCP package exposes:

- `list_models` to inspect enabled Media model IDs, endpoint names and discovered output types.
- `generate_image`: prompt, model, `WIDTHxHEIGHT` size, `n` 1–4. `|||` separates independent image prompts; see batching below.
- `edit_image` and `create_image_variation` to transform saved reference images when supported by the endpoint.
- `discover_video_capabilities({model})` and `list_video_loras({model})` for read-only, selected-endpoint discovery of limits, guide-node availability, supported/installed adapters and validation evidence.
- `generate_video`: one job with model, prompt, seconds, size, first-image/timed-image references and advanced controls below.
- `get_video` and `get_image_job` to retrieve accepted jobs in standalone MCP use.
- Suno: `generate_music`, `generate_speech`, `generate_sound`, `get_audio_generation_status`, `get_audio_track`, `download_audio`, `abandon_audio_generation`; require matching exposed tools and exact configured IDs.
- In-app `list_media_jobs` and `list_media_assets` to inspect jobs and real saved references; `inspect_media_asset` shows saved images, not decoded video frames.
- In-app `inspect_timeline`, `create_timeline`, `apply_timeline_edit`, `undo_timeline` and `redo_timeline` for revision-safe hard-cut assembly; `attach_canvas_assets` attaches existing managed media to the active project.
- `capture_canvas_screenshot` to render HTML and local image assets in an offline browser and return a PNG screenshot.

Built-in, embedded Codex and external in-app MCP agents use the same saved-asset
schema. Standalone MCP uses bounded image upload objects. Server capability
schema version 1 is authoritative; unknown/older responses are unknown support,
not permission to guess. Source-audio and guide-video uploads for video generation
are not available. Do not imply that a job was submitted or finished
without its tool result.

## Suno audio

Submit once; preserve `attempt_id`/track UUIDs. Status observes the shared browser,
not a durable queue: match the attempt; after takeover, use captured track IDs.
Studio monitors captured UUIDs, saves audio and notifies chat. End the turn;
do not poll monitored tracks. Uncaptured attempts need a later check;
`list_audio_generations` recovers receipts. CAPTCHA needs manual noVNC; never
automatically resubmit or abandon. `dryRun` uses the live browser. Download by
`trackId`: Studio saves WAV/MP3/M4A to Media/project/chat, no output directory.
Storage failure: keep the receipt; never regenerate. Omit `sunoModel` to keep the
native browser selection; it is not the routing model.

## Timeline stitching and review

### Hard-cut assembly

Use local timeline edits when the request is to arrange, trim or join existing
clips. This preserves source files and does not submit a generation job.

1. Call `inspect_timeline` for the active project and `list_media_assets` for
   real managed sources. Read the current revision, frame rate, track types and
   capabilities. Use `create_timeline` only if no timeline exists. Preserve the
   user's selected range; if it is stale, request a fresh selection rather than
   silently changing its scope.
2. Reuse actual asset IDs and available duration/geometry metadata. A remote job
   receipt is not a playable source. Use `attach_canvas_assets` for any library
   sources not yet attached to this project before `apply_timeline_edit`. Match
   video/images to video tracks, audio to audio tracks and images to overlays.
   Never use paths, URLs or invented IDs as timeline sources.
3. Plan retained ranges in integer half-open project frames
   `[startFrame,endFrame)`, with exclusive end. `sourceStartSeconds` and
   `sourceEndSeconds` are source times in seconds, not frame indexes. Compute
   `fps = frameRate.numerator / frameRate.denominator` from the inspected
   timeline. Export requires
   `sourceEndSeconds - sourceStartSeconds = (endFrame - startFrame) / fps`;
   speed changes are unsupported. Keep trims within the actual source duration.
   At 24 fps, `[0,48)` then `[48,96)` is a four-second hard-cut sequence of two
   two-second clips. The first item ends on project frame 47; frame 48 belongs
   to the second. A source offset of 1 second for a two-second item uses source
   seconds `[1,3)`, independent of where the item sits on the timeline.
4. Submit a bounded batch of typed operations with `apply_timeline_edit` and the
   inspected `expectedRevision`. Use actual item/track IDs and only fields for
   each operation. There are no same-track overlaps; place the next cut at the
   prior item's exclusive end. Transitions and retiming are unavailable. On a
   revision conflict, reinspect and rebase instead of overwriting newer edits.
   `undo_timeline` and `redo_timeline` also require the current revision.
5. Review the resulting timeline and retained first/middle/last and boundary
   frames with editor playback/frame stepping and captured views where
   available. Check identity, motion direction, lighting, framing, aspect fit,
   black gaps and duplicate retained boundary frames. A timeline selection is
   compact context, not decoded media or proof that the footage was reviewed.
6. Review source-clip audio and any separate music/voice track across each cut.
   Keep an approved master audio bed once; avoid accidentally doubling it with
   clip sound. Use `set-audio-level` operations with `gain`, `fadeInFrames` and
   `fadeOutFrames` where needed; fades use project frames and must fit the item.
   Ask for playback review if listening is unavailable; never claim to have
   heard audio from metadata or a successful render alone.
7. The user exports through the editor's **Export video** button; there is no
   agent export tool. Do not trigger export via runtime JavaScript as a tool
   workaround. The local WebM export is separate from saving the timeline or
   exporting a project ZIP. Stay within the inspected/export limits (currently
   60 seconds, 32 items and 32 MiB output). Treat editor preview as approximate;
   verify the saved exported asset before claiming a finished video.

### Generative stitching

Generating a transition, extension or gap-fill means synthesizing new content;
putting two clips next to each other is not that capability. Plan the missing
shot and continuity constraints, then check the actual enabled tool schema.
Do not promise exact motion, seamless joins or audio alignment from a still
reference. For LTX, `guidingFrames` accepts 1–8 saved still-image anchors,
including first/last positions, as soft conditioning. Alternatively use one
`inputReferenceAssetId`; these modes are mutually exclusive. Inputs are stills,
not a selected timeline range, guide video or source audio. If usable boundary
stills are already saved, inspect and use their real IDs; otherwise ask the user
to capture/import the intended stills. There is no agent frame-extraction tool.

H3 server workflows support temporal video/audio guides, but the current client
schema cannot submit them. LTX's current API guidance is still-image-only;
temporal video guidance and source-video continuation are not exposed
by this client. Timed stills do not guarantee exact first/last pixels. Do not infer callable support from model discovery, installed
weights, a server feature or a successful text/image-to-video job. Do not invent
fields, tools or direct API/shell bypasses to bridge this gap.

For a currently supported new shot, submit once, let the host finish/download
it, then inspect the saved result and attach it before typed timeline edits.
Plan retained output spans separately from any conditioning context; never
count context as extra delivered frames or duplicate a retained boundary frame.
Review the join's identity, motion and lighting plus both sides' audio before
calling it continuous. Report which continuity checks were actually possible.

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

### Qwen transparent backgrounds

Apply this guidance when the user requests a transparent background, cutout,
sticker, sprite, or image overlay using `qwen-image-2.1`.

#### Generate or edit

Use the exact enabled Qwen ID from `list_models`. The actual image-tool prompt
MUST start and end with these exact sentences:

> This is an RGBA image with transparency. <foreground description>. The image has alpha channel and the background is transparent.

Between them, describe the foreground, composition, style, and transparent
margins in declarative prose. Preserve requested text character for character
in straight double quotes. Keep the background transparent throughout the
description. A solid title panel or drawn checkerboard changes the requested
asset. Respect the user's generation limit. After acceptance, end the turn and
let the host finish the job; never poll or resubmit it.

#### Verify the original PNG

After the host's completion notification, inspect the saved image visually AND
verify its alpha numerically before your final assessment. A white or purple
fill in a visual observation does not prove that the PNG background is opaque.

When `execute_canvas_javascript` is available, you MUST use it to decode the
attached original PNG with a detached canvas and inspect the alpha bytes.
This is a read-only probe: do not append the canvas to the DOM, alter visible
content, save source, reload, or edit a timeline. A user's request to leave the
canvas/timeline unchanged allows this read-only operation. Substitute the
actual saved asset ID into this example:

```javascript
await EaselCanvas.whenReady();
await EaselCanvas.assets.ready;
const image = new Image();
image.src = await EaselCanvas.assets.getUrl('ASSET_ID_FROM_COMPLETION');
await image.decode();
const canvas = document.createElement('canvas');
canvas.width = image.naturalWidth;
canvas.height = image.naturalHeight;
const context = canvas.getContext('2d');
context.drawImage(image, 0, 0);
const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
let minAlpha = 255, maxAlpha = 0, zeroPixels = 0, nearZeroPixels = 0;
let bandMin = 255, bandMax = 0, bandSum = 0, bandPixels = 0;
const bandHeight = Math.max(1, Math.floor(canvas.height * 0.05));
for (let i = 3; i < pixels.length; i += 4) {
  const a = pixels[i];
  minAlpha = Math.min(minAlpha, a);
  maxAlpha = Math.max(maxAlpha, a);
  zeroPixels += a === 0;
  nearZeroPixels += a <= 10;
  const y = Math.floor((i - 3) / 4 / canvas.width);
  if (y < bandHeight || y >= canvas.height - bandHeight) {
    bandMin = Math.min(bandMin, a);
    bandMax = Math.max(bandMax, a);
    bandSum += a;
    bandPixels++;
  }
}
return { width: canvas.width, height: canvas.height, minAlpha, maxAlpha,
  totalPixels: pixels.length / 4, zeroPixels, nearZeroPixels,
  topBottom5PercentBands: { minAlpha: bandMin, maxAlpha: bandMax,
    meanAlpha: bandSum / bandPixels, pixels: bandPixels },
  cornerAlpha: [pixels[3], pixels[canvas.width * 4 - 1],
    pixels[(canvas.height - 1) * canvas.width * 4 + 3], pixels[pixels.length - 1]] };
```

Report only measurements you actually obtained. Foreground letters or icon
pads are expected to be opaque; nonzero whole-image pixels do not establish an
opaque background. Use band statistics as background evidence only when visual
inspection confirms the bands contain empty margins, not the subject. RGBA
format alone is not proof of a transparent background. Distinguish usable transparency from exact zero
alpha throughout the background; Qwen can leave near-zero residue. If the
probe fails or the tool is unavailable, state the limitation and specific
error. A visual uncertainty alone does not justify another billed generation
or reference edit. Never promise exact transparency from the prompt alone.

Official guidance: https://github.com/QwenLM/Qwen-Image-2.1#transparent-image-generation-rgba

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

## Image/video queue discipline

- Let the host poll; use `list_media_jobs` only when a status snapshot is useful.
- Preserve the receipt ID and original model/endpoint. Stop, model retirement or
  a closed conversation must not trigger regeneration of an accepted job.
- Do not blindly retry a generation POST after receipt loss or a timeout;
  acceptance is ambiguous and the server has no idempotency recovery contract.
- H3 job receipts may disappear after a ComfyUI restart. Prefer downloaded
  managed assets over upstream receipts for reuse; the host's persisted job ID
  does not restore lost server history. Check local assets and monitor state,
  report an unresolved receipt, and never blindly resubmit a possibly billed job.
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

The current client has no typed guide-video submission path. The LTX API
still accepts image references only; its video-conditioned IC adapters mostly
remain disabled even when their weights are installed. H3 server temporal
guidance does not expose that capability to this client. A private ComfyUI
prototype is not a portable callable workflow.

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
