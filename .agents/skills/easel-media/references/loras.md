# Complete LoRA Inventory

This is the 38-entry curated Easel server snapshot, not a list of 38 callable
MCP adapters. See [the pinned JSON catalog](lora-catalog.json) for every file,
source repository/revision, byte size, SHA256, required input, trigger and
execution-validation record. Use registered IDs, not filenames or arbitrary
paths. Live authenticated `/v1/videos/loras` discovery supersedes this snapshot.

`supported:true` here means enabled by the inspected **server workflow**, not
exposed by v0.0.2 MCP or installed everywhere. None of the advanced adapter
selection fields are currently exposed by `generate_video`. Require all three:
supported workflow, installed asset and callable tool path. See
[advanced video](advanced-video.md) before planning a recipe.

The deployment handoff recorded installation/checksums for the 12 LTX-2.5
Creative Lab entries. That does not make the other collections installed, or
the nine disabled LTX-2.5 V2V paths runnable. Do not download legacy collections
or gated weights simply to satisfy an inventory; keep weights/tokens out of Git.

## Camera collection

These older LTX-2-family weights have explicit short T2V execution evidence on
the current LTX-2.5 server path. That evidence does not generalize to arbitrary
older adapters, stacks, image-conditioned inputs or visually exact direction.

| ID | Intended control | Server snapshot | Required extra input |
| --- | --- | --- | --- |
| `camera-dolly-in` | Camera translates toward subject | Enabled | None |
| `camera-dolly-left` | Camera translates left | Enabled | None |
| `camera-dolly-out` | Camera translates away from subject | Enabled | None |
| `camera-dolly-right` | Camera translates right | Enabled | None |
| `camera-jib-down` | Camera lowers | Enabled | None |
| `camera-jib-up` | Camera rises | Enabled | None |
| `camera-static` | Locked framing | Enabled | None |

Default shorthand strength: 0.8. Finite range: 0-2. Do not select an invented
orbit, pan or tilt ID. Describe motion consistently with the selected control.

## LTX-2.5 Creative Lab

| ID | Intended workflow | Server snapshot | Required extra input |
| --- | --- | --- | --- |
| `cinemagraph` | Localized motion from an image | Enabled, experimental | `input_reference`; automatic `CINEMAGRAPH_MOTION` trigger |
| `slow-motion` | Generated slow-motion shot | Enabled, experimental | `input_reference`, `motion_speed` |
| `clean-plate` | Video clean-plate transformation | Disabled | `reference_video`, `ic_guide` |
| `colorization` | Video colorization | Disabled | `reference_video`, `ic_guide` |
| `day-to-night` | Day/night video transformation | Disabled | `reference_video`, `ic_guide` |
| `deblur` | Video deblurring | Disabled | `reference_video`, `ic_guide` |
| `decompression` | Compressed-video restoration | Disabled | `reference_video`, `ic_guide` |
| `ingredients` | Reference-sheet-conditioned generation | Enabled, experimental | `lora_reference`; >=5 seconds, no stack |
| `pixel-upscaler` | Pixel spatial x2 video upscale | Disabled | `reference_video`, `ic_guide` |
| `refine-details` | Tiled video detail refinement/upscale | Disabled | `reference_video`, `ic_guide`, specialized fusion workflow |
| `restore` | Video restoration | Disabled | `reference_video`, `ic_guide` |
| `water-simulation` | Video water-effect transformation | Disabled | `reference_video`, `ic_guide` |

The three enabled non-camera entries passed short execution/decoder tests;
their creative effect and reference fidelity remain experimental. Ingredients
can reinterpret framing/geometry. Cinemagraph is not a seamless-loop guarantee;
Slow Motion is not interpolation of an existing uploaded clip.

The other entries are video-conditioned IC workflows, not drop-in T2V patches.
In particular, Refine Details requires the selected tiled-fusion graph and
source-video/audio handling; `LoraLoaderModelOnly` is not sufficient.

## Additional LTX-2 controls

All are disabled in the inspected Easel registry. Do not infer compatibility
with LTX-2.5 merely because a separate ComfyUI prototype used Union guidance.

| ID | Intended workflow | Server snapshot | Required extra input |
| --- | --- | --- | --- |
| `ltx-2-canny-control` | Edge-video motion/shape guidance | Disabled | `reference_video`, `ic_guide` |
| `ltx-2-depth-control` | Depth-video layout/parallax guidance | Disabled | `reference_video`, `ic_guide` |
| `ltx-2-detailer` | Video detail enhancement | Disabled | `reference_video`, `ic_guide` |
| `ltx-2-pose-control` | Pose-video guidance | Disabled | `reference_video`, `ic_guide` |
| `ltx-2-union-control` | Union control-video guidance | Disabled | `reference_video`, `ic_guide` |

## LTX-2.3 Creative Lab

These are cataloged for provenance and workflow planning, not served as another
base model or silently substituted for their LTX-2.5 counterparts. All are
disabled and have no execution validation in this Easel snapshot.

| ID | Intended workflow | Server snapshot | Required extra input |
| --- | --- | --- | --- |
| `ltx-2.3-cinemagraph` | Legacy cinemagraph generation | Disabled | No extra fields declared in snapshot; workflow not validated |
| `ltx-2.3-clean-plate` | Clean-plate transformation | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-colorization` | Video colorization | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-cross-eyed` | Cross-eyed transformation | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-day-to-night` | Day/night transformation | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-deblur` | Video deblurring | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-decompression` | Compressed-video restoration | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-foley-v2a` | Video-conditioned Foley audio | Disabled | `reference_video`, `audio_generation_workflow` |
| `ltx-2.3-in-outpainting` | Video in/outpainting | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-ingredients` | Reference-sheet conditioning | Disabled | `reference_sheet`, `ic_guide` |
| `ltx-2.3-instant-shave` | Instant-shave transformation | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-pixel-spatial-upscaler` | Pixel spatial upscale, x2 and x4 files | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-relight` | Video relighting | Disabled | `reference_video`, `ic_guide` |
| `ltx-2.3-water-simulation` | Video water-effect transformation | Disabled | `reference_video`, `ic_guide` |

The Foley entry does not enable an audio tool. Discovery of a filename or model
type does not create a callable generation endpoint.
