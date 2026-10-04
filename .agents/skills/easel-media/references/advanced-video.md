# Advanced Video: Current Boundaries and Recipes

The target provider model is `ltx-2.5`. Advanced adapters change a workflow, not
the number of served base models. The registry includes older-family adapters;
their family alone is not proof of compatibility with LTX-2.5.

## What can be called now

The v0.0.2 `generate_video` MCP schema exposes `prompt`, `model`, `seconds`,
`size` and a single image reference. In-app that reference is
`inputReferenceAssetId`; standalone MCP uses `inputReference`. It does **not**
expose the camera, LoRA, speed, seed, Ingredients-sheet or guide-video fields
listed here. There is no MCP `list_video_loras` tool yet.

The Easel server has an authenticated `GET /v1/videos/loras` discovery endpoint.
Its records distinguish `supported`, `installed`, required fields and validation
evidence. If the tool cannot discover or submit an advanced feature, explain the
gap. Do not put invented fields into a strict tool schema, accept raw model paths,
or bypass the app's credentials and asset handling with shell/API calls.

## Camera controls

The server accepts either `camera_lora` shorthand or a registered camera ID in
the JSON-string `loras` form field, never the same adapter through both paths.
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

Server-only multipart field examples, **not current MCP arguments**:

```text
camera_lora=dolly-in
camera_lora_strength=0.8
```

```text
loras=[{"id":"camera-static","strength":0.8}]
```

There are no registered pan, tilt or orbit camera IDs. Camera tests established
short T2V execution, not universal direction accuracy or I2V/stack compatibility.

## Enabled non-camera server recipes

All are experimental and must also be installed on the selected backend.

| Adapter | Required inputs and recipe | Important boundary |
| --- | --- | --- |
| `cinemagraph` | `input_reference`; `loras=[{"id":"cinemagraph","strength":1}]`; describe a localized moving element. | The server adds `CINEMAGRAPH_MOTION`; moving-camera combinations are rejected. Do not promise a seamless loop. |
| `slow-motion` | `input_reference`; `loras=[{"id":"slow-motion","strength":1}]`; `motion_speed=0.2` is a tested example. | Speed range is 0.025-1; conditioning FPS changes, playback/audio remain 24 FPS. This generates slow motion, not deterministic interpolation of an uploaded clip. |
| `ingredients` | A separate `lora_reference` image sheet; `loras=[{"id":"ingredients","strength":1}]`; at least 5 seconds. | Match sheet aspect ratio to the canvas. Optional `lora_reference_strength` is 0-1, default 1. No stacking with other adapters; reference geometry is not guaranteed. |

`loras` accepts at most four distinct registered adapters, including any camera
shorthand selection. Strengths are finite 0-2; duplicates and unsupported IDs
are rejected. The numeric cap is not a guarantee that arbitrary stacks work.
Regular camera/LoRA patches feed both sampling passes. IC guides require their
own loader metadata and guide/crop topology, not just a model patch.

The server-only `seed` range is 0 through `2**64-2`, allowing both pass seeds to
fit unsigned 64 bits. Duration is an integer 1-12 seconds. Current default is 4
seconds at 24 FPS, using `seconds * 24 + 1` frames. Omit size unless needed; do
not infer it from a reference image. Short 512x320 pilots are not evidence that
longer/high-resolution jobs fit VRAM.

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
