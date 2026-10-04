---
name: easel-media
description: Generate and edit Easel media, assemble managed clips with revision-safe timeline tools, review stitching and audio continuity, and plan supported video workflows. Use for media requests, timeline edits and guided-video planning.
---

# Easel Media

Use the Media MCP tools to create media; use saved assets for references and the
host monitor for accepted jobs. Distinguish a planned workflow from one the
current tool schema and endpoint actually support.

## Models and references

Known provider models include `qwen-image-2.1` for images/reference edits and
`ltx-2.5` for video; discover the enabled IDs rather than treating this list as
exhaustive. The legacy `flux2-9b` and `flux2-4b`
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
- `generate_video` to submit one video job with a video model, prompt, optional reference image, seconds and size.
- `get_video` and `get_image_job` to retrieve accepted jobs in standalone MCP use.
- In-app `list_media_jobs` and `list_media_assets` to inspect jobs and real saved references; `inspect_media_asset` shows saved images, not decoded video frames.
- In-app `inspect_timeline`, `create_timeline`, `apply_timeline_edit`, `undo_timeline` and `redo_timeline` for revision-safe hard-cut assembly; `attach_canvas_assets` attaches existing managed media to the active project.
- `capture_canvas_screenshot` to render HTML and local image assets in an offline browser and return a PNG screenshot.

There is no current MCP adapter-discovery tool, camera/LoRA argument or guide-video
upload argument. Server-side features in the references are not valid MCP fields
until exposed by the tool schema. Audio generation tools are not available yet,
even if discovery lists audio output models. Do not imply that a job was submitted
or finished without its tool result.

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
reference. Current `generate_video` accepts one saved still-image reference,
not a selected timeline range, guide video or source audio. If a usable boundary
still is already saved, inspect and use its real ID; otherwise ask the user to
capture/import the intended still. There is no agent frame-extraction tool.

H3 server workflows support temporal video/audio guides, but the current client
schema cannot submit them. LTX's current API guidance is still-image-only;
temporal video guidance and continuation/first-last controls are not exposed
by this client. Do not infer callable support from model discovery, installed
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
2. Submit `generate_video` once. Optional `inputReferenceAssetId` identifies a saved PNG/JPEG/WebP image in the app; standalone MCP uses an `inputReference` upload object.
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
  context must not appear as extra delivered frames. Continuation/first-last
  controls are not currently exposed by Easel MCP.
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

These are **server-side recipes, not current MCP arguments**. Use them only
when the actual tool schema exposes the feature. Live authenticated server
discovery is `/v1/videos/loras`; the in-app agent currently has no discovery
tool. Do not bypass app asset/credential handling with direct API/shell calls.

Camera shorthand: `dolly-in`, `dolly-out`, `dolly-left`, `dolly-right`, `jib-up`,
`jib-down`, `static`. Dolly left/right means camera translation, not pan;
jib up/down means vertical movement. Use either `camera_lora=dolly-in` with
`camera_lora_strength=0.8`, or a registered camera entry in `loras`, not both
for the same adapter. There are no registered pan/tilt/orbit IDs.

The `loras` wire field is a JSON string such as
`[{"id":"camera-static","strength":0.8}]`. At most four distinct registered
adapters may be selected, counting the shorthand camera. Finite strengths are
0-2; camera shorthand defaults to 0.8, other entries to 1. The stack cap is not
evidence that arbitrary combinations are validated.

- `cinemagraph`: needs `input_reference`; the server inserts
  `CINEMAGRAPH_MOTION`. Describe localized subject motion; moving camera stacks
  are rejected. A cinemagraph is not a guaranteed seamless loop.
- `slow-motion`: needs `input_reference` and `motion_speed` in 0.025-1; 0.2 is
  a tested example. Conditioning becomes 120 FPS while output/audio remain
  24 FPS. This generates slow motion; it does not interpolate an uploaded clip.
- `ingredients`: needs a separate `lora_reference` sheet, at least 5 seconds,
  and no other adapter stack. Match sheet aspect ratio to the output canvas.
  `lora_reference_strength` is finite 0-1, default 1. Frame geometry/identity
  fidelity remains experimental.

The server-only seed range is 0 through `2**64-2`. Current LTX output is 24 FPS
with `seconds * 24 + 1` frames. Camera/regular patches feed both sampling passes;
IC adapters need loader metadata and guide/crop handling, not just model patches.

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
files. "Enabled" means supported by the inspected server workflow, not exposed
by current MCP or installed on every backend. Require live support, installation,
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
