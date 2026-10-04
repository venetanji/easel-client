# Advanced Video: Current Boundaries and Recipes

The target provider model is `ltx-2.5`. Advanced adapters change a workflow, not
the number of served base models. The registry includes older-family adapters;
their family alone is not proof of compatibility with LTX-2.5.

## Current typed contract

The validated Easel API is authoritative. Select the exact `list_models` ID,
including any in-app endpoint prefix, then use
`discover_video_capabilities({model})` and `list_video_loras({model})`.
Both are read-only. The selected model determines the endpoint and credentials.
Unknown/older capability responses fail explicitly; do not infer support from
the model name or silently drop an advanced option.

`generate_video` supports the following strict typed fields:

| Purpose | Built-in / Codex / external in-app MCP | Standalone MCP |
| --- | --- | --- |
| First image | `inputReferenceAssetId` | `inputReference: {data,mimeType,name?}` |
| Camera | `cameraLora`, `cameraLoraStrength` | Same |
| Adapters | `loras: [{id,strength?}]` | Same typed array |
| Seed | `seed`, exact decimal string | Same |
| Slow motion | `motionSpeed` | Same |
| Ingredients | `loraReferenceAssetId`, `loraReferenceStrength` | `loraReference: {data,mimeType,name?}`, `loraReferenceStrength` |
| Timed stills | `guidingFrames: [{assetId,frameIndex,strength?}]` | `guidingFrames: [{image:{data,mimeType,name?},frameIndex,strength?}]` |

All first-image, Ingredients and guide references share one **32 MiB combined**
upload cap and PNG/JPEG/WebP MIME allowlist. The app resolves existing project
or library IDs; saved tool arguments contain no image bytes, paths or URLs.
Do not bypass the app's credentials/asset handling with direct host commands.

Capabilities expose schema version 1, model, FPS, sizes, duration/seed/upload
limits and guiding-frame support. `/v1/videos/loras` preserves separate
`supported`, `installed`, `requires`, validation, tested workflows and provenance.
Installed does not mean supported, executed or visually reviewed. Require all
relevant runtime prerequisites before paid generation.

The server's native LTX-2.5 graph is currently the implementation. Published creative-skills at immutable revision
`67f185c8f95182690e1ac56e734aa649f71b4df6` contains the legacy LTX-2.3 runtime; the intended canonical LTX-2.5 runtime is
unpublished/unavailable. Do not claim a completed port or substitute legacy
samplers, model assets, guide snapping or source-audio behavior.

## Camera controls

Use `cameraLora` shorthand or a registered camera ID in the typed `loras` array,
never the same adapter through both paths. The provider maps these to the
server multipart fields `camera_lora` and JSON-encoded `loras`.
Default camera strength is 0.8; finite strengths range from 0 to 2. Start near
the tested setting rather than assuming stronger always means better.

| Shorthand | Catalog ID | Direction to describe |
| --- | --- | --- |
| `dolly-in` | `camera-dolly-in` | Move the camera toward the subject; reveal changing parallax. |
| `dolly-out` | `camera-dolly-out` | Pull away to reveal the surrounding scene. |
| `dolly-left` | `camera-dolly-left` | Translate the camera left, not merely pan its orientation. |
| `dolly-right` | `camera-dolly-right` | Translate the camera right. |
| `jib-up` | `camera-jib-up` | Raise the camera and describe what becomes visible. |
| `jib-down` | `camera-jib-down` | Lower the camera toward the scene. |
| `static` | `camera-static` | Keep framing locked; put movement in the subject/environment. |

MCP field examples:

```text
cameraLora: "dolly-in"
cameraLoraStrength: 0.8
```

```text
loras: [{"id":"camera-static","strength":0.8}]
```

There are no registered pan, tilt or orbit camera IDs. Camera tests established
short T2V execution, not universal direction accuracy or I2V/stack compatibility.

## Enabled non-camera recipes

All are experimental and must also be installed on the selected backend.

| Adapter | Required inputs and recipe | Important boundary |
| --- | --- | --- |
| `cinemagraph` | `inputReferenceAssetId` (standalone `inputReference`); `loras: [{"id":"cinemagraph","strength":1}]`; describe a localized moving element. | The server adds `CINEMAGRAPH_MOTION`; moving-camera combinations are rejected. Do not promise a seamless loop. |
| `slow-motion` | `inputReferenceAssetId` (standalone `inputReference`); `loras: [{"id":"slow-motion","strength":1}]`; `motionSpeed: 0.2` is a tested example. | Speed range is 0.025-1; conditioning FPS changes, playback/audio remain 24 FPS. This generates slow motion, not deterministic interpolation of an uploaded clip. |
| `ingredients` | A separate `loraReferenceAssetId` sheet (standalone `loraReference`); `loras: [{"id":"ingredients","strength":1}]`; at least 5 seconds. | Match sheet aspect ratio to the canvas. Optional `loraReferenceStrength` is 0-1, default 1. No stacking with other adapters; reference geometry is not guaranteed. |

`loras` accepts at most four distinct registered adapters, including any camera
shorthand selection. Strengths are finite 0-2; duplicates and unsupported IDs
are rejected. The numeric cap is not a guarantee that arbitrary stacks work.
Regular camera/LoRA patches feed both sampling passes. IC guides require their
own loader metadata and guide/crop topology, not just a model patch.

The MCP `seed` is an exact decimal string from `"0"` through
`"18446744073709551614"` (`2**64-2`), allowing both pass seeds to fit unsigned
64 bits. Never pass a JavaScript/JSON number or round through `Number`.
Duration is an integer 1-12 seconds. Current default is 4
seconds at 24 FPS, using `seconds * 24 + 1` frames. Omit size unless needed; do
not infer it from a reference image. Short 512x320 pilots are not evidence that
longer/high-resolution jobs fit VRAM.

## Timed still-image guides

`guidingFrames` contains 1–8 still-image entries with unique integer
`frameIndex` values from 0 through `seconds * 24` inclusive. These are
**pixel-frame indices**, step **one**, not latent indices or multiples of eight.
Strength is finite 0–1, default 1. For a 4-second clip, first/last positions are
0 and 96. Use real saved IDs in the app, or bounded upload objects in standalone
MCP; each entry is strict, with no URL/path/timing aliases. The server decodes
each guide to verify a single still image, at most 32 million pixels, and a
format matching its declared MIME. Animated PNG/WebP and malformed guides are
rejected before upstream upload/submission.

Guide mode is exclusive with `inputReferenceAssetId`/`inputReference` and
Ingredients/reference-sheet mode. Cinemagraph and slow-motion require a first
image, so they cannot be combined with timed guides. Other camera/LoRA choices
remain subject to the curated registry; availability alone does not validate a
stack.

Check `guiding_frames.supported`, `available` and `validation` independently.
The new path is **graph-contract tested, not live-GPU or visually verified**.
It uses source-reviewed `LTXVAddGuide` on video-only latents in each of Easel's
two sampling passes and `LTXVCropGuides` before upscale and decode, retaining
Easel's generated-audio path. A missing required node makes runtime availability
false. Official ComfyUI `comfy_extras/nodes_lt.py` at immutable revision
`e9027f2b30f37bb3052714eb08fcf479542f4fc0` is evidence for semantics,
not evidence that this deployment executed the graph.

Guidance is soft even at strength 1. It does not reliably copy an exact frame,
lock first/last pixels, guarantee identity/continuity or close a seamless loop.
Review actual output endpoints and intermediate frames before scaling.

## CLI and wire mapping

The synchronized Python CLI supports `easel video capabilities`, `easel video
loras`, repeatable `--lora ID[=STRENGTH]` and
`--guide-frame FRAME IMAGE STRENGTH`. Each guide takes an explicit local regular
PNG/JPEG/WebP file. `--loras` legacy JSON and repeated `--lora` are mutually
exclusive; Python integer seeds preserve the server's full exact range.

The provider/CLI serialize guides as multipart `guiding_frames` JSON entries
`{image_index,frame_index,strength?}` and repeated `guiding_images` files in
matching zero-based order. Each image is referenced once; no local path enters
the metadata. The server validates the full contract before upstream upload or
queue admission. Agents use their typed schema, not these wire-field names.

Submit once and preserve the accepted ID/model/endpoint. A timeout or missing
receipt never authorizes replacement generation. Use `get_video`/the host
monitor or CLI retrieval for the same ID. The repository
`docs/live-video-testing.md` guide documents the optional local test runner
with individually cost-gated `camera` and `guided-frames` scenarios; each is
bounded to two 1-second 512×320 jobs and has a GET-only discovery preflight.

## Guiding videos: prepare, do not pretend to submit

The current client/MCP has no typed guide-video upload/control path. The LTX
API accepts still-image guidance only; most of its video-conditioned IC entries
remain `supported:false`. H3 server workflows can use temporal video/audio
guides, but the current client cannot submit those fields. Installed weights
or a private ComfyUI graph are not proof of client/MCP/UI support.

For assembly, use the revision-safe timeline recipe in [Easel Media](../SKILL.md).
Hard cuts do not synthesize a transition. Prefer downloaded managed assets for
reuse: H3 receipts can disappear after a ComfyUI restart, and receipt loss never
justifies blindly resubmitting a possibly billed job.

Choose guidance by the constraint: depth for layout, occlusion and parallax;
real Canny edges for silhouettes; pose for body motion. An RGB first frame is
an appearance reference, not a depth/edge video. Colorization, restoration and
Refine Details use video-conditioned transformation workflows rather than
ordinary T2V/I2V adapter stacks.

Prepare registered RGB/control previews at matching aspect, dimensions, frame
count and FPS. For authored WebGL scenes, evaluate animation once per frame and
derive depth from that render's actual depth buffer. Preserve orientation,
registration and fixed-global depth mapping; do not normalize each frame
independently, run depth through RGB tone mapping or rename RGB/grayscale as
Canny. Record any thresholding, dilation or resize. Review the guide before
expensive synthesis when direction/fidelity needs approval.

LTX guide workflows need compatible temporal alignment (`8n+1` frames in the
checked profiles), explicit guide strength and guide-token removal before
upscale/decode. Determine which passes receive guide context from the selected
validated workflow, rather than blindly re-applying the same guide to every
pass. Preserve source-audio alignment and retained frame spans.

Refine Details' specialized workflow uses `LTXVTiledFusionSampler` and
`LTXVGetTilingSizes`, source-video IC guidance, aligned frames/FPS and
source-audio preservation. The old `LTXVTiledSampler` is not equivalent.
Tiled refinement can alter faces, textures and text; it is not lossless upscale.

For periodic guides, inspect the generated first/last boundary and audio. A
looping source, stronger guide or completed render does not certify a generated
loop, exact topology, beat synchronization or camera speed.
