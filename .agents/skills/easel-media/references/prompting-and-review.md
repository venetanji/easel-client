# Prompting and Review

These are adapted practices from creative-skills' ComfyUI prompt guides,
storyboard anchor workflow, music-video quality gates, curated LTX profiles and
WebGL guide-video experiments. They are not guarantees of Qwen/LTX fidelity.
Do not carry over Flux-specific step counts, prompt tricks or legacy model
defaults. Numerical render settings belong in supported tool fields, not prose.

## Images and reference edits

Write scene-first prose: subject and action, setting, framing, materials,
lighting and palette. Name the light source, direction and quality when they
matter. Avoid keyword soup and contradictory descriptions. Preserve the user's
named model, references and intended use.

Separate identity from pose. An identity description should cover appearance,
wardrobe and distinctive details; the individual shot owns the action and pose.
A standing character sheet should not force every shot to be a standing portrait.
Subject tokens from storyboard YAML are preprocessing conveniences, not MCP
syntax: expand them before calling a tool; do not send unresolved `{subject}`.

For edits, identify the role of each reference in its upload order: identity,
composition, costume, environment or material. State what must remain unchanged
and what should change. Too many competing references can constrain the wrong
details. Review the anchor before animating it; a bad face, silhouette or framing
propagates into dependent shots.

Use `|||` for independent variations sharing references and art direction, not
for instructions that depend on a preceding segment. Current client batches
must remain within four outputs. A focused first pass is cheaper to assess than
an unreviewed large batch.

Example image prompt:

> A weathered red ceramic teapot rests on folded ivory linen beside a small
> window. A close three-quarter view keeps the spout and curved handle distinct.
> Soft light from camera-left reveals the matte glaze and fine chips along the
> rim; muted warm shadows and a pale blue background give it a quiet editorial feel.

## Video shots

Describe one coherent shot in present tense. Cover subject, visible action,
environment, framing, camera movement, lighting and desired audio. Match the
amount of action to the requested duration; an elaborate scene change is not a
two-second shot. Keep important identities and constraints near the beginning.

Describe physical expressions instead of internal labels: lowered eyes, a held
breath and a tightening jaw communicate more than "sad". Put dialogue in quotes,
with short phrases and acting directions between them. Specify language,
accent or voice texture only when relevant. Avoid claiming reliable typography,
exact chaotic physics or exact geometry without reviewing the actual result.

Describe a camera move relative to the subject and what it reveals. A dolly
changes viewpoint and parallax; it is not an optical zoom. Match prose to the
selected adapter. Do not combine a locked camera with a moving camera instruction,
or call a pan/orbit adapter that the catalog does not contain.

Example shot prompt:

> A woman in a red wool coat pauses beneath a rain-darkened arcade. She brushes
> a droplet from her sleeve, then looks toward the street. The camera slowly
> dollies in, keeping her eyes sharp while warm shop lights soften behind her.
> Reflections shimmer on the paving stones. The audio carries light rain and
> distant footsteps, with no music or dialogue.

## Continuity, guides and audio

Use approved anchors and an explicit shot plan for repeated subjects. A reference
image guides appearance; it does not encode a moving camera path. Use registered
per-frame depth/edge/pose guidance when spatial motion is important, but only
through an exposed, validated workflow. See `advanced-video.md` for preparation.

For chained clips, use the previous clip's actual retained endpoint, not an
unrelated authored frame. Guide/context frames must be cropped out of the
delivered timeline. Frame/FPS/overlap bookkeeping must also align the audio;
do not concatenate guide tokens as visible output or guess offsets in seconds.
Easel MCP exposes timed stills through `guidingFrames`, including first/last
pixel-frame positions. They are soft guidance, not exact frame copying or a
seamless-continuity guarantee. Source-video continuation is not exposed.

For a music video, agree on the song and review anchors before rendering every
scene. Derive scene timing from the actual track/phrases. Preserve the approved
master audio and mux it once during final assembly rather than repeatedly
generating or lossy re-encoding it. Native LTX audio generation is not a promise
of exact music synchronization; supplied-audio workflows are separate capabilities.

## Review before scaling

Separate successful execution from successful art direction. A receipt, preview
frame or installed weight is not a finished, visually correct deliverable.

Inspect images for composition, identity, unwanted text and reference drift.
Inspect videos at native resolution, including first/middle/last frames and cuts,
for motion direction, temporal flicker, parallax, silhouette and guide drift.
Verify actual decoded dimensions, FPS, frame count, duration and audio; not just
the requested settings. Easel's nominal 1280x720 video preset currently decodes
to 1280x704, so check before promising exact delivery geometry.

Start with one short, low-resolution pilot when exploring an adapter, then seek
the review needed for the user's brief before producing a larger batch. Low-size
execution does not establish high-resolution VRAM capacity. Keep a seed and
other settings fixed, when exposed, to compare one changed parameter at a time;
higher guide/adapter strength is not automatically better fidelity.
