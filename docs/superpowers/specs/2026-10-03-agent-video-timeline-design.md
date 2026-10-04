# Agent Video Timeline Design

**Status:** Proposed design for Gio review; implementation is not authorized by this document alone.

## Goal

Let a person assemble and edit a multi-track video in Easel Studio, select an exact timeline range, and describe the desired change in chat. The agent can inspect that selection, make a bounded edit, or use an eligible local video-generation workflow to continue a shot or fill a gap. Finished edits remain ordinary playable Easel media.

The main interaction is human-directed: the user selects the edit target in the visible timeline; Studio binds that selection to the next chat turn; the user describes the edit in natural language; the agent previews and applies a typed operation to the timeline.

## Current Evidence and Boundaries

- Easel Client is JavaScript/Electron with an existing project store, media library, live canvas, and a separate TypeScript Media MCP package. It currently has generated video retrieval and sampled-frame inspection for captured videos, not a general timeline editor.
- The Easel API video MCP contract is intentionally narrow. It must not be widened to expose server-only LoRA or special video fields.
- Local LTX graph knowledge belongs to `creative-skills/comfy-graph`; Studio must not duplicate graph internals or accept arbitrary graphs, model paths, or filesystem paths. Local ComfyUI is the permitted execution route for this model work; do not add a Comfy Partner/API backend.
- The current curated profile documentation supports offline graph validation for selected FLF and continuation combinations, but does not certify every profile/option combination as live-capable. In particular, do not advertise unsupported LoRA/guidance combinations as available.
- HyperFrames describes itself as a deterministic HTML/CSS/media/seekable-animation-to-MP4 framework. It may fit motion graphics and composition rendering, but it is not yet verified as the timeline model, selection UI, or frame-accurate source-footage editor for Studio.

## Proposed Architecture

### 1. Versioned timeline as source of truth

Each Studio project may own a versioned timeline document separate from source media. It contains project frame rate and output geometry, ordered tracks, clip/overlay/audio items, transitions, and a monotonically increasing revision. Items refer to managed asset IDs and source ranges; they do not contain raw media bytes or arbitrary paths.

Timeline positions use integer frame boundaries and half-open spans `[start, end)`, with the project frame rate explicit. Source-media in/out points preserve source timing metadata so mixed frame rates and variable-frame-rate inputs are not silently treated as project frames. The renderer adapter is responsible for deterministic mapping between source timestamps and project frames. Invalid or unrepresentable ranges are rejected before rendering or generation.

The first supported track types are video, audio, and visual overlay. Overlay items use supported template/assets rather than arbitrary executable code supplied as an MCP argument. The initial transition set is hard cuts and cross-dissolves; more complex effects can be added as typed capabilities later. Audio remains non-destructive, retains clip source audio unless explicitly changed, and supports timeline audio tracks with basic gain/fade controls.

### 2. Timeline UI selection becomes chat context

The timeline UI supports selecting a clip, track, or frame range. Before the next chat turn, Studio records a compact selection context containing:

- Project and timeline IDs, timeline revision, frame rate and output geometry.
- Selected track/item IDs and exact half-open frame range.
- Relevant neighboring items and their boundary frames, where needed for continuation or gap filling.
- Compact frame samples/contact sheet and metadata through managed asset references; do not put whole video bytes in chat history.

The context is scoped to the originating project and revision. If the timeline changed after selection, a mutating tool must detect the stale revision and ask the agent to reinspect/rebase rather than overwrite newer edits.

### 3. Narrow typed editing tools

The Studio agent receives typed operations through its tool surface; it never receives shell access or a generic FFmpeg/Comfy graph execution tool. The capability family should include:

- Inspect timeline and selected items; inspect video metadata; sample requested frames/contact sheets from managed assets or a selected timeline range.
- Apply validated non-destructive operations: add/remove/move/trim timeline items, place overlays, adjust supported transitions/audio controls, and create a render/preview.
- Query generation capabilities for a selected workflow/profile and inspect available guides, ingredients, and allowed LoRA choices.
- Continue a selected segment or fill a selected gap using a supported local generation profile, returning a tracked job receipt and inserting the completed asset only once.

Edits use an expected timeline revision and commit atomically. Source assets are never overwritten. Undo/redo is required for user-facing edits. Render/export writes a new managed asset and preserves the editable timeline document.

### 4. Generation is a separate, capability-checked adapter

Video generation acts on the selected span, but is not part of ordinary Easel API `generate_video`:

- Continuation derives its source tail, retained span, overlap, frame count, and master-audio offset from the selected timeline and the canonical model helper. It records exact provenance and does not claim seamlessness.
- Gap fill with FLF2V takes the frames at the gap boundaries as endpoint guides. It admits only profiles with verified FLF2V support, maps generated length to the requested half-open span explicitly, and preserves both endpoint frames. It rejects gaps that cannot be represented by the chosen workflow rather than silently shifting/cropping an endpoint.
- Ingredients and guide frames are selected by managed asset IDs or explicit timeline frames. LoRAs and strengths are exposed only from the selected backend/profile's validated catalog and supported combinations. No arbitrary weights, raw paths, or graph JSON are accepted.
- Model/profile, settings, seed, guides, ingredients, and resulting asset/job IDs are recorded with the timeline item so a user can inspect what produced it.
- Submission follows existing safety practice: validate inputs and backend capability before admission; check the local ComfyUI queue has zero running and zero pending jobs immediately before each submission; submit once; do not retry an ambiguous submission; track accepted jobs durably and place a result once.

The canonical model builder remains in `creative-skills/comfy-graph`. A client-side adapter may orchestrate validated builder capabilities and ComfyUI transport, but must not fork model rules into consumer-specific prompt/graph code. Establish a clean, reproducible package/bridge boundary before shipping; an unpublished editable checkout is not a production dependency.

### 5. Rendering backend is an explicit evaluation gate

Keep the timeline model independent of rendering implementation. Before selecting a renderer, compare HyperFrames and a packaged local media-processing route against the same offline fixtures: mixed source frame rates, clip trim/reorder, overlays, cross-dissolves, audio preservation/mix, exact frame placement, and repeatable export. Measure packaged size, performance, cancellation, and Windows/macOS/Linux feasibility. Adopt HyperFrames only for the capabilities it demonstrates; do not presume it replaces source-footage editing. Any bundled FFmpeg implementation requires an explicit distribution/licensing review and packaged tests.

## Acceptance Criteria

1. A user can create/open a timeline with multiple video/audio/overlay tracks, select a frame-exact range, and send a chat turn whose context identifies that exact project revision, selection, and needed neighboring media.
2. The agent can inspect video metadata and return bounded, useful frame samples without inserting video bytes into conversation history.
3. A typed edit creates/revises timeline items atomically, keeps source assets unchanged, rejects stale revisions, supports undo/redo, and can render a playable new asset.
4. Basic multi-track composition supports ordering, cuts, cross-dissolves, supported visual overlays, audio tracks, clip audio retention, and basic audio gain/fades.
5. Continuation and FLF2V requests consume selected timeline context, preserve endpoint/overlap/audio timing semantics, and add their accepted output at the intended span without duplicate submission or attachment.
6. UI and tools show only generation options valid for the chosen workflow/profile and the currently discovered/allowlisted backend catalog. Unsupported LoRA/guide/ingredient combinations fail locally with actionable errors.
7. Studio's public Easel API MCP schema remains unchanged and excludes API-only LoRA/special video parameters. The local ComfyUI generation route is separately named and permissioned.
8. CI tests use deterministic fixtures/mocks and exercise malformed media/timelines, range mapping, concurrency/stale revisions, process cancellation, interruption, duplicate submissions, asset isolation, and contract exposure. No GPU generation or model downloads run in ordinary CI.
9. Cross-platform packaged builds include the selected runtime dependencies and pass offline smoke checks without relying on a user's system FFmpeg or Python installation.

## Delivery Slices

This is a multi-slice project; do not implement as one large patch:

1. **Renderer feasibility:** compare HyperFrames and packaged media-processing candidates on synthetic fixtures. No product edits, generation jobs, or model downloads during this probe.
2. **Timeline core and selection context:** versioned project timeline, multi-track selection UI, exact chat context, typed inspect/edit operations, local preview and basic export.
3. **Composition:** overlay templates, transitions, audio tracks/mix, cancellation, undo/redo, and cross-platform packaging.
4. **Generation adapter:** selected-range continuation and FLF2V, capability discovery for compatible guides/ingredients/LoRAs, durable job tracking and result placement.

The implementation plan must make each slice independently testable and keep generation separate from ordinary CI. GPU smoke tests, dependency publication, API changes, and deployment are separate approval gates.

## Non-Goals

- Replacing Easel's existing HTML/WebGL canvas authoring experience or adding arbitrary user scripts to the Media MCP package.
- Exposing raw Comfy graphs, arbitrary model/LoRA filesystem paths, arbitrary server endpoints, or server-only Easel API video fields to the agent.
- Generating, downloading, or installing models/LoRAs as part of the editor build.
- Claiming generative continuity, exact audio fidelity, or a renderer's cross-platform behavior without inspecting the rendered output and packaged builds.
- Changing/deploying/restarting the Easel API service.

## Assumptions for Review

- Original imported/generated assets remain immutable; edits create derived items/assets. This matches the app's existing managed-media model and avoids destructive edits.
- The timeline's first renderer scope includes a single project output format and basic cross-dissolve; advanced keyframed effects, transitions, color grading, and waveform editing are later work.
- A user explicitly selects the timeline range. The agent may suggest a range, but may not silently replace the user's active selection.
- LoRA/guidance catalogs are local-backend/model-specific and may be empty. UI presence does not certify that a workflow has been live-validated.

## Evidence and Source Revisions

- Easel Client base: clean `main` at `a38c1e59978ad492663cd9560e2c7815fff21fa4` (`v0.0.4`). Existing source-video and MCP patterns were read from `src/agent.js`, `src/media-reference-tools.js`, `src/easel-tool-host.js`, `src/canvas-store.js`, `src/video-metadata.js`, and `packages/media-mcp/src/{server,video}.ts`.
- Creative Skills source: clean `main` at `0e208b2312b33fbf31b95fb15e25273195baa9be`. Read `README.md`, `comfy-graph/README.md`, `comfy-graph/LTX-PROFILES.md`, `ltx_profiles.py`, and relevant LTX builders. These describe the current checked graph/profile boundary, not universal live GPU capability.
- HyperFrames upstream README (retrieved 2026-10-03): `https://github.com/heygen-com/hyperframes`. Its stated contract is HTML/CSS/media/seekable-animation rendering; Studio footage/timeline suitability remains untested.
