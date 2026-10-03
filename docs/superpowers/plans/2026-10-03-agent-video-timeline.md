# Agent Video Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a non-destructive, multi-track Easel Studio timeline where a user selects a frame-exact range, sends it as chat context, and the agent can inspect/edit/render it through validated tools.

**Architecture:** Add a versioned project timeline and deterministic media adapter separate from canvas HTML. The timeline UI owns selection and preview; selected project/revision/range flows through typed IPC into a single chat turn, while bounded host tools make atomic operations and save rendered outputs as managed media. Renderer implementation is chosen by a fixture-based feasibility gate.

**Tech Stack:** Existing Easel Client JavaScript/Electron, TypeScript Media MCP conventions, `node:test`, existing managed project/media stores; renderer dependency only after Task 1 evidence and licensing/package review.

**Spec:** `docs/superpowers/specs/2026-10-03-agent-video-timeline-design.md`

## Global Constraints

- Timeline positions use integer frame boundaries and half-open spans `[start, end)`, with the project frame rate explicit.
- Items refer to managed asset IDs and source ranges; they do not contain raw media bytes or arbitrary paths.
- Overlay items use supported template/assets rather than arbitrary executable code supplied as an MCP argument.
- Edits use an expected timeline revision and commit atomically.
- Source assets are never overwritten.
- The agent receives typed operations through its tool surface; it never receives shell access or a generic FFmpeg/Comfy graph execution tool.
- Studio's public Easel API MCP schema remains unchanged and excludes API-only LoRA/special video parameters.
- CI tests use deterministic fixtures/mocks; no GPU generation or model downloads run in ordinary CI.
- Cross-platform packaged builds must not rely on a user's system FFmpeg or Python installation.

## Review Focus

- Mixed-rate and variable-frame-rate source boundaries map to the exact requested project frame span; test in Task 1/4.
- Empty, overlong, malformed, or unsupported media fails without corrupting a timeline or destination asset; test in Task 4/8.
- A stale selection/revision never edits a newer project state; test in Task 3/6.
- Project/chat switching cannot apply a selection to the wrong project or conversation; test in Task 6.
- A canceled, interrupted, or retried render cannot duplicate or attach a partial output; test in Task 8.

---

## Plan Scope and Dependency Split

This plan delivers the independent timeline/editor core and its editing tool surface. It does **not** implement local ComfyUI or FLF2V/continuation. The client currently has no local ComfyUI configuration, graph adapter, or reproducible Comfy Graph runtime dependency. The generation adapter is a dependent follow-up plan after the timeline interfaces exist and its bridge to canonical `creative-comfy-graph` builders has a separately reviewed, reproducible package/runtime design. Do not silently widen the Easel API MCP contract to bypass that boundary.

## File Map

- `src/video-timeline.js` — pure versioned document schema, range math, and validated edit operations.
- `src/video-timeline-store.js` — atomic per-project persistence, compare-and-swap revision checks, undo/redo snapshots.
- `src/video-timeline-media.js` — renderer-neutral inspect/sample/render interface; implementation selected by Task 1.
- `src/video-timeline-view.js` — timeline tracks, items, ruler, selection gestures, and preview UI.
- `src/index.html` — timeline container and accessible controls/styles.
- `src/ipc-contract.js`, `src/preload.js`, `src/main.js` — strict timeline IPC validation and main-process ownership.
- `src/renderer.js` — timeline lifecycle and selected-range-to-chat interaction.
- `src/chat-service.js`, `src/agent.js`, `src/easel-tool-host.js` — per-turn selection context and typed agent operations.
- `test/video-timeline*.test.js`, `test/renderer.test.js`, `test/agent.test.js`, `test/easel-tool-host.test.js`, `test/ipc-contract.test.js` — pure, storage, UI, tool, security, and integration tests.
- `electron-builder.yml`, `package.json`, `package-lock.json` — only the renderer dependency and platform resources proven necessary by Task 1.

### Task 1: Renderer and Media Runtime Feasibility

**Files:** Create `docs/superpowers/research/2026-10-03-video-renderer-feasibility.md`; synthetic fixtures and outputs under `/tmp/easel-video-renderer-probe-*` only. Do not add product dependencies in this task.

**Interfaces:** Produce a recorded comparison of HyperFrames and at least one packaged local media-processing option. Fixture inputs include two short clips with unlike frame rates, a still overlay, a two-track audio example, and an explicit cross-dissolve. Record output frame count, boundary-frame identities, audio streams/duration, repeatability, cancellation behavior, packaged size, platform support, dependency license, and exact tested versions.

- [ ] **Step 1: Build the synthetic fixture set** with small locally generated test clips/audio and known frame colors/timecodes; no user media or network assets.
- [ ] **Step 2: Run the same timeline cases through each candidate** and decode outputs to compare selected frames, spans, and audio; record unsupported cases and commands.
- [ ] **Step 3: Inspect candidate license, package contents, and build/platform requirements** from authoritative package files; do not install a dependency into the product manifest.
- [ ] **Step 4: Record the decision and limitations** in `docs/superpowers/research/2026-10-03-video-renderer-feasibility.md`; choose one backend only if it passes frame/audio correctness and cross-platform packaging gates. If none pass, stop and return a concrete blocker/options rather than implement a misleading renderer.
- [ ] **Step 5: Commit the feasibility report** with the selected immutable package versions or the measured blocker.

### Task 2: Pure Timeline Model and Editing Operations

**Files:** Create `src/video-timeline.js`, `test/video-timeline.test.js`.

**Interfaces:** Export `TIMELINE_SCHEMA_VERSION`, `validateTimelineDocument(input)`, `validateTimelineSelection(input, document)`, and `applyTimelineOperations(document, operations)`. A document has `{schemaVersion, id, revision, frameRate:{numerator,denominator}, width, height, tracks, items, transitions}`. Each item has stable `id`, `trackId`, half-open timeline `startFrame/endFrame`, `assetId`, and source in/out timestamps. Operations are a strict tagged union for insert, remove, move, trim, set-transition, and set-audio-level; results return `{document, changedItemIds}`.

- [ ] **Step 1: Write tests** for valid/invalid schema versions, stable IDs, duplicate IDs, track-type compatibility, integer frame ranges, source bounds, transition adjacency, audio gain bounds, unsupported properties, and no mutation of the input object.
- [ ] **Step 2: Run `node --test test/video-timeline.test.js`** and confirm the tests fail because the module is absent.
- [ ] **Step 3: Implement the exported validators and pure edit operations** with rejection of unknown fields and preservation of half-open ranges.
- [ ] **Step 4: Add regression tests** for non-overlapping track insertions, cross-dissolve overlap math, reversed/zero-length selections, and frame-rate rational values.
- [ ] **Step 5: Run the focused test and `git diff --check`**, then commit the pure timeline model.

### Task 3: Atomic Per-Project Timeline Persistence and History

**Files:** Create `src/video-timeline-store.js`, `test/video-timeline-store.test.js`; modify `src/main.js` only to construct the store.

**Interfaces:** Export `createVideoTimelineStore({userDataPath,fileSystem,idFactory})` with `create(projectId, initial)`, `read(projectId)`, `apply(projectId,{expectedRevision,operations})`, `undo(projectId,{expectedRevision})`, and `redo(projectId,{expectedRevision})`. `apply` returns the new document and revision; mismatch throws `TIMELINE_REVISION_CONFLICT` without writing.

- [ ] **Step 1: Write temporary-directory tests** for create/read, atomic revision increment, restart recovery, undo/redo, and cleanup after write failure.
- [ ] **Step 2: Run `node --test test/video-timeline-store.test.js`** and confirm missing-function failures.
- [ ] **Step 3: Implement versioned JSON persistence** using validated documents and temp-file-plus-rename writes under a project-ID-derived managed directory.
- [ ] **Step 4: Add tests** for path traversal IDs, malformed persisted JSON, stale expected revisions, concurrent edits, and crash-safe preservation of the prior valid file.
- [ ] **Step 5: Run focused storage tests and `git diff --check`**, then commit the store.

### Task 4: Strict Timeline IPC and Project Lifecycle

**Files:** Modify `src/ipc-contract.js`, `src/preload.js`, `src/main.js`; create/modify `test/ipc-contract.test.js` and a focused main IPC test.

**Interfaces:** Add validated channels for timeline create/read/apply/undo/redo, media metadata/frame sampling, and render lifecycle. Every renderer request carries a project ID and expected timeline revision where it mutates; only the trusted main frame may invoke them. Preload exposes named methods, not generic channel access.

- [ ] **Step 1: Write IPC contract tests** for accepted valid requests and rejected unknown keys, invalid IDs/ranges, unsupported channels, and untrusted senders.
- [ ] **Step 2: Run `node --test test/ipc-contract.test.js`** and confirm missing channel/validator failures.
- [ ] **Step 3: Implement per-channel validators and preload wrappers** following existing trusted IPC patterns.
- [ ] **Step 4: Wire main handlers to the timeline store** and verify project open/switch cannot redirect a mutation to a previously active project.
- [ ] **Step 5: Run focused IPC/lifecycle tests and `git diff --check`**, then commit.

### Task 5: Renderer-Neutral Video Inspection and Render Job Adapter

**Files:** Create `src/video-timeline-media.js`, `test/video-timeline-media.test.js`; implement the selected candidate backend in its own focused module. Modify `package.json`, lockfile, and `electron-builder.yml` only after Task 1 passes.

**Interfaces:** Export `createVideoTimelineMedia({backend,assetReader,assetWriter})`; its methods are `inspectAsset(assetId,{signal})`, `sampleFrames(assetId,{times,maxFrames,signal})`, `render(document,{signal,onProgress})`, and `cancel(renderId)`. Results use managed asset IDs, bounded metadata, and bounded JPEG sample data; no arbitrary paths are accepted from tools.

- [ ] **Step 1: Write mocked adapter tests** for metadata, frame sample limits, render receipt, cancellation, and renderer errors.
- [ ] **Step 2: Run `node --test test/video-timeline-media.test.js`** and confirm the adapter does not exist.
- [ ] **Step 3: Implement the adapter and chosen backend** using only validated managed asset reads and temp output paths created by the host.
- [ ] **Step 4: Add synthetic-media integration tests** for exact frame spans, cross-dissolve boundaries, overlay order, source-audio retention, audio track mix, unsupported codec errors, and cancellation cleanup.
- [ ] **Step 5: Run focused integration tests and inspect decoded output metadata/frames**, then commit.

### Task 6: Visible Multi-Track Timeline and Selection UI

**Files:** Create `src/video-timeline-view.js`, `test/video-timeline-view.test.js`; modify `src/index.html` and `src/renderer.js`.

**Interfaces:** Export `createVideoTimelineView({document,client,onSelection,onEdit,onStatus})` with `render(document)`, `setSelection(selection)`, `getSelection()`, and `destroy()`. `TimelineSelection` is `{projectId,timelineId,timelineRevision,trackIds,itemIds,startFrame,endFrame}`. Time ruler, clip rectangles, overlay/audio tracks, and current playhead use the document's rational frame rate.

- [ ] **Step 1: Write DOM tests** for track ordering/types, clip placement from half-open spans, selection boundaries, keyboard-accessible selection, resizing/scrolling, and stale-revision indication.
- [ ] **Step 2: Run `node --test test/video-timeline-view.test.js`** and confirm view/module failures.
- [ ] **Step 3: Implement the timeline view** as an isolated module mounted beside the existing canvas/chat workbench; selecting a gap or item emits exact frame selection.
- [ ] **Step 4: Add view tests** for empty timelines, overlapping tracks, narrow/mobile layout, and selection reset on project switch.
- [ ] **Step 5: Run focused UI tests and manually verify the packaged UI** with fixture data, then commit.

### Task 7: Bind Selection into the Chat Turn

**Files:** Modify `src/renderer.js`, `src/ipc-contract.js`, `src/main.js`, `src/chat-service.js`, and `src/agent.js`; tests in `test/renderer.test.js`, `test/chat-service.test.js`, and `test/agent.test.js`.

**Interfaces:** Extend `sendMessage` options with optional strict `timelineSelection`; validate its IDs/revision/frame range in main, resolve its document from the project store, and attach compact structured context to only that submitted user turn. Context includes nearby boundary samples via asset references, not video bytes. On project/revision mismatch, return a correction before invoking the model.

- [ ] **Step 1: Write a renderer/chat test** proving selection is attached to the user's next submitted message and cleared after submit or selection change.
- [ ] **Step 2: Run the targeted tests** and verify current chat drops the unsupported `timelineSelection` field.
- [ ] **Step 3: Implement validated IPC-to-chat forwarding** and bounded context serialization in `chat-service.js`/`agent.js`.
- [ ] **Step 4: Add tests** for cross-chat/project isolation, stale revision, oversized/empty sample context, and a normal chat turn with no selection.
- [ ] **Step 5: Run the focused suites and commit the selection-context feature.**

### Task 8: Agent Timeline Tools and Atomic Edit/Render Flow

**Files:** Create `src/video-timeline-tools.js`, `test/video-timeline-tools.test.js`; modify `src/easel-tool-host.js`, `src/agent.js`, `src/harness-instructions.js`, and build/runtime check scripts as needed.

**Interfaces:** Export `TIMELINE_TOOLS` with strict schemas for `inspect_timeline`, `inspect_video_frames`, `apply_timeline_edit`, `preview_timeline`, and `export_timeline`. Host tool calls are routed to the main-owned timeline store/media adapter; edits use the active chat's project and expected revision, and outputs are saved/attached once. No tool takes a filesystem path, executable, arbitrary graph, or network URL.

- [ ] **Step 1: Write in-memory tool-host tests** for each valid operation and invalid schemas, expected-revision conflicts, edit atomicity, render receipt, and one-time asset attachment.
- [ ] **Step 2: Run `node --test test/video-timeline-tools.test.js`** and verify all new tools are unavailable/fail.
- [ ] **Step 3: Register and implement the five bounded tools** using the previously defined store and media adapter contracts.
- [ ] **Step 4: Add integration tests** for cancellation, duplicate export requests, failed render preservation, media-size limits, and no operation leakage across projects/chats.
- [ ] **Step 5: Update the built-in agent instructions** to honor explicit user selection, inspect before editing, preview once, and never overwrite source assets.
- [ ] **Step 6: Run `npm test`, `npm run build`, and `npm run dist:dir`**; packaged smoke must inspect tools and render one synthetic fixture without a system media binary or Python runtime.
- [ ] **Step 7: Commit the integrated timeline tool surface and report limitations.**

## Deferred Follow-Up: Generation Adapter

After this plan lands, create a separate reviewed plan for local ComfyUI continuation/FLF2V and model-option discovery. That plan must first settle a reproducible JS-to-canonical-Comfy-Graph runtime/package boundary without editing arbitrary graph or broadening Easel API tools. It will consume Task 2/3 `TimelineDocument` and Task 7 `TimelineSelection`, and must separately cover zero-queue admission, validated profile options, exact gap endpoint mapping, durable generation receipts, and local GPU smoke approval.
