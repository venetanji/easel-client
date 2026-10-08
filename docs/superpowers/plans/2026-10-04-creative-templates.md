# Creative Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one draft PR with a Templates drawer, independent Video and Strudel sketches, in-canvas creative dialogue, and bounded Strudel WAV export to Media.

**Architecture:** A packaged catalog serves the drawer and both agent backends. Host-owned instance records bind editable documents to independent state; Video uses per-instance timelines. Strudel follows the existing offline-kit system and renders exported audio in a disposable isolated renderer using its own native synthesizer.

**Tech Stack:** Existing Electron/CommonJS/vanilla DOM, node:test, esbuild, pinned @strudel/web 1.3.0, Web Audio, existing Mediabunny Video export.

**Spec:** `../specs/2026-10-04-creative-templates-design.md` — approved Library version 2, approved 4 October 2026. Read it with this plan. Subsequent explicit scope clarification adds GPL alignment across client, server and CLI; that is a separate licensing workstream below.

## Global Constraints

- Two working templates: Video editor and Strudel; Create project or Add to current project; multiple independent instances of either.
- Audio export: 1–16 cycles; at most 30 seconds including tail; stereo 48 kHz PCM16 WAV under 6 MiB; at most 4,096 onset events and 32 overlapping voices; one export at a time; 30-second render wall-clock timeout.
- Video remains WebM with audio, at most 60 seconds and 32 MiB.
- No automatic model call, audio playback, media generation, or upload when opening a template. Questions use existing request_canvas_input and submitInput; source-reload interruptions must be explicit.
- No CSP weakening, unsafe-eval, external scripts/samples, microphone access, general worker allowance, Node access, or Tone substitution.
- Target GPL-3.0-or-later for owned code across easel-client, easel server, and easel-cli after provenance audit; retain Strudel AGPL-3.0-or-later and other vendor notices/source obligations. Unresolved rights require a specific question before declarations change.
- Preserve existing edited documents, project media, kits, timeline IDs/history and undo. Do not merge PRs, close drafts, release, deploy, or submit stores under this plan.
- User owns live app/CDP testing. Automated tests may launch a fresh disposable test renderer with temporary data, never attach to a running user instance. Keep runtime evidence separate from unit tests and manual acceptance.

## Review Focus

1. Two documents in one project must never share a timeline accidentally or accept each other’s selections (Tasks 2–3).
2. Project switch/cancel after rendering but during save must not lose a durable asset or attach it to the wrong project (Task 6).
3. Keyboard Play and reopening after Stop must work without a mousedown-only initialization deadlock or stale audio (Tasks 1, 5).
4. Adding Strudel to a project near source/kit limits must fail without deleting prior work or silently dropping its kits (Task 3).
5. A pending canvas answer or agent source patch must not restart sound unexpectedly or claim gapless co-creation (Task 7).

## Execution and branch boundary

Recommended method: subagent-driven in the current authorized workspace, with one implementer and a fresh reviewer for each of eight meaningful tasks. Parallelize only Task 2 with Task 1 after interfaces are agreed. This costs more contexts than a single implementer but isolates the two highest-risk areas: legacy project migration and audio lifecycle. Do not create cloud coding tasks.

Before implementation, review this plan and select that method or a single implementer with one final independent review. No implementation has begun.

Known base: PR #9 stacks on PR #6. Local `easel-media-simplify` commit 85d283c has the same tree as published PR #9 e0f8ea16b0b8c3d9f2d95fb5f9dc052e5fe2a630. Audit findings: #8 (52e4aa8) is independent setup/keyring work and merges cleanly with #6/#9; #7 (1445be5) remains based on older #6 (4b01c9c) and conflicts with #9 guidance. Recommended cleanup order is #8 → #6 → #9 → refreshed #7, subject to review and user-authorized merges; #5 is redundant after #6. Two inherited P2 probe-harness findings in #6/#9 need resolution. Never use unpublished 80c6c27 or silently cherry-pick #7/#8. At execution time use the worktree skill, verify exact remote/base tree and clean status, and create an isolated `feat/templates-video-strudel` branch. If #6/#9 have merged, start from the verified new main; otherwise stack on #9 and state the dependency. Do not create a competing fresh-main branch by guessing merge order.

Keep spec and plan with the new branch before product commits. Documentation-only commits are permitted after the branch audit; no merge or publication of unrelated work. Draft-PR publication is already authorized, but must follow verification and the agreed stack.

## Integration prerequisite after execution approval

- [ ] Refresh client remote heads and compare the audit snapshot (main a38c1e5, #6 b711ea6, #9 e0f8ea1, #8 52e4aa8, #7 1445be5). If changed, recheck ancestry/conflicts before choosing the base.
- [ ] In a disposable integration worktree, rehearse #8 → #6 → #9 → refreshed #7 without altering main or closing drafts. Resolve the actual #7/#9 conflict in `src/harness-instructions.js`; semantically review the four other overlapping guidance/test files. Preserve #9 stitching and #7 verified capabilities. Do not claim published #7 supplies H3 temporal fields or a selected-range helper.
- [ ] Resolve the two inherited probe-harness P2 cases (unbounded hang and stale output), reproduce with focused regression tests, and run the affected guidance suites plus one integration build. Individual PR green CI is not evidence that the combined tree passes.
- [ ] Present the verified integration/merge order for separate user approval of merges and closures. If the user merges it, verify fresh main before branching. Otherwise proceed on the explicitly identified integration branch and make the feature draft dependent on it; do not wait indefinitely or present the stack as already merged. Close redundant #5 only after explicit approval and proven containment in landed #6.

## File map and shared contracts

Existing integration points: `src/main.js`, `preload.js`, `ipc-contract.js`, `canvas-preload.js`, `project-workspace.js`, `renderer.js`, `index.html`, `canvas-project.js`, `canvas-store.js`, `canvas-view.js`, `canvas-runtime.js`, `canvas-kits.js`, `canvas-kit-catalog.js`, `canvas-policy.js`, timeline modules, agent/tool-host modules and deletion service.

New focused modules:
- `template-catalog.js`: immutable entry metadata, no filesystem or execution.
- `template-instance-store.js`: versioned host-owned instance registry and migration.
- `template-service.js`: validated transactional create/open operations.
- `templates-drawer.js`: catalog rendering and actions.
- `template-tools.js`: discovery/instantiation tool schemas shared by both backends.
- `strudel-kit.js`: pinned kit adapter and supported feature contract.
- `strudel-template.js`: editable starter source and local controls.
- `strudel-export-policy.js`: event snapshot/WAV budgets and validation.
- `strudel-export-renderer.js`: offline synthesis and PCM encoding inside isolated realm.
- `strudel-export-controller.js`: admission, lifecycle, isolated renderer and cancellation.
- `strudel-export-bridge.js`: trusted scope and durable save receipts.

Common records: `Instance = {id, projectId, templateId, templateVersion, documentPath, timelineId?}`. IDs use 32 lowercase hex characters. Host scope is `{projectId, instanceId, documentPath, runtimeGeneration}` and is derived from the active document, never accepted on trust from authored HTML. Export request is `{exportId, expectedSourceRevision, snapshot}`; snapshot is `{bpm, cycles, tailSeconds, parameterDigest, events}`; each event is `{timeSeconds, durationSeconds, absoluteCycle, midiNote, waveform, gain, attackSeconds, releaseSeconds, envelopeMode}` with no extra keys/functions. `envelopeMode` is strictly `native-default` or `explicit`: a minimal Task 6 review correction preserves the pinned synth's all-omitted ADSR branch versus an explicit attack/release branch. Native-default events require canonical attack/release metadata 0.001/0.01 but omit those controls in synthesis; explicit events keep the supplied bounded controls. This does not add authored decay or sustain controls. One cycle is four beats, so `cps = bpm / 240`. A host-computed content digest binds the receipt to this snapshot. Event and envelope validation belongs to Task 6.

## Licensing workstream — Align the three Easel repositories

This is separate from template behavior commits and client-only PR cleanup. Work on isolated branches of `venetanji/easel-client`, `venetanji/easel`, and `venetanji/easel-cli`; verify fresh remote heads before edits. Available local copies are reference material, not permission to overwrite their work.

**Files:** each repository root `LICENSE`, `NOTICE`, `README.md`, `docs/license-audit.md`; client `package.json`/lock metadata; server and CLI `pyproject.toml` and packaging metadata. Keep vendor licenses in their existing paths. CLI currently has an MIT LICENSE; client metadata says ISC; no server root license was found in the inspected copy. These observations require verification against selected remote heads.

**Output:** a per-repository rights/dependency inventory and reviewable GPL-3.0-or-later own-code declaration, with unchanged third-party terms and matching source/build distribution documentation.

- [ ] Read contributor history and existing notices, inventory redistributed code/models/assets/fonts/dependencies, and record provenance or uncertainty per component. Git authors alone are not rights proof. Compare actual published package/container contents to source inventory; do not assume downloaded model weights become GPL.
- [ ] Add a small metadata/notices test in each repository: assert owned-code license identifier is GPL-3.0-or-later only after rights review, root license text exists, third-party notices remain present, and package metadata contains no stale contradictory declaration. Run each targeted test red before changing declarations. Use Node node:test for client and existing pytest for Python repositories.
- [ ] Make permitted declarations and packaging/documentation alignment; preserve prior copyright/permission notices where required and explain that earlier MIT/ISC grants are not revoked. Preserve Strudel AGPL and combined-work obligations; include source/build instructions for the actual application, container, CLI and exported project bundles. If rights are unclear, stop that component’s declaration and ask a specific question while independent template work continues.
- [ ] Run the targeted tests green; inspect package metadata/contents once without publishing. Keep `chore: align owned code licensing with GPL-3.0-or-later` commits separate from behavior. Create draft PRs per repository when verified, without merges or deployments. Client-only draft cleanup stays with the separate PR audit.

## Task 1 — Prove and package the Strudel subset

**Files:** create `src/strudel-kit.js`, `scripts/probe-strudel-runtime.cjs`, `test/strudel-kit.test.js`, `docs/strudel-compatibility.md`; modify `package.json`, lockfile, `scripts/build-canvas-kits.js`, `src/canvas-kits.js`, `canvas-kit-catalog.js`, `canvas-policy.js`, `ipc-contract.js`, `agent.js`, and `easel-tool-host.js` kit enums/limits only; license declarations belong to the separate workstream.

**Interfaces:** `prepareStrudelBundle(source) -> string`; `getStrudelCapabilities() -> {nativeSynths, audioExport, externalSamples:false, repl:false}`. Adapter uses `strudel.initAudioOnFirstClick({disableWorklets:true})` before `initStrudel`, without awaiting the gesture-pending promise at startup. Preserve the original kit API and license text.

- [ ] Write tests `kit_is_local_and_pinned`, `adapter_precedes_init`, `bundle_preserves_notices`, and `policy_still_blocks_workers_and_eval`: assert pin 1.3.0, catalog/install visibility, max 8 MiB bundle, and unchanged CSP string. Run `node --test test/strudel-kit.test.js` and capture meaningful red results.
- [ ] Add the minimal bundled-kit adapter and build/copy path. Carry upstream license text with the bundle and report new dependencies to the separate licensing workstream. Do not mix GPL declaration changes into this behavior commit.
- [ ] Run targeted tests and `npm run build:canvas-kits`. Use one fresh automated Electron fixture to prove native synth audible/nonzero output, keyboard Play, Stop/restart, and no network/CSP failures. Probe an OfflineAudioContext with Strudel’s exported setters and superdough to confirm nonzero buffer without worklets. Do not call renderPatternAudio or attach live CDP.
- [ ] Record exact evidence and supported API in compatibility notes. If the fixture cannot run, mark this gate blocked; do not announce Strudel ready or substitute Tone. If CSP change is required, pause and ask for the exact security change.
- [ ] Commit only this independently verified kit/audit slice: `feat: bundle constrained offline Strudel kit`.

Representative Task 1 assertions: `assert.equal(getStrudelCapabilities().externalSamples, false)` and `assert.equal(getStrudelCapabilities().repl, false)`; compare CSP to its captured baseline string.

## Task 2 — Independent instance and timeline storage

**Files:** create `src/template-instance-store.js`, `test/template-instance-store.test.js`; modify `video-timeline-store.js`, `video-timeline-controller.js`, `video-timeline-tools.js`, `video-timeline-bridge.js`, `video-timeline-template.js`, `canvas-store.js`, `deletion-service.js` and their tests.

**Interfaces:** `instances.list(projectId) -> Instance[]`, `instances.resolveDocument(projectId, documentPath) -> Instance|null`, `instances.create(record) -> Instance`, `instances.remove(projectId, instanceId)`, `instances.migrateLegacy(projectId) -> {status, instance?}`. Timeline store methods take `(projectId, timelineId, input?)`; legacy project-only resolution is allowed only when exactly one timeline exists, otherwise return `TIMELINE_AMBIGUOUS`.

- [ ] Write `two_timelines_are_independent`, `legacy_migration_is_idempotent`, `ambiguous_legacy_copy_requires_choice`, `all_timeline_references_block_detach`, `zip_preserves_all_instances`, `stale_selection_rejected`. Assertions: edit/undo A leaves B byte-identical; old timeline ID/revision/history survive; migration failure preserves old file; wrong instance selection rejects. Run `node --test test/template-instance-store.test.js test/video-timeline-store.test.js test/video-timeline-controller.test.js` and capture failures.
- [ ] Persist registry version 1 atomically under host-managed user data; key timeline storage by project/timeline, preserve old file during validated migration. Extend event/selection/agent/export identity to timeline and instance. Keep existing function names where practical; update every caller explicitly.
- [ ] Update ZIP manifest version 2 with instance list and per-timeline entries; retain legacy `.easel/timeline.json` only for single-timeline compatibility. Enforce reference checks across all timelines and confirmed deletion cleanup. Never silently map ambiguous requests to the first instance.
- [ ] Run those tests plus `node --test test/video-timeline-bridge.test.js test/canvas-store.test.js test/deletion-service.test.js`. Confirm old tests still pass and corrupted/partial migration recovers.
- [ ] Commit: `feat: isolate template instances and video timelines`.

Representative Task 2 assertions: `assert.deepEqual(store.read(projectId, timelineB), beforeB)` after editing A, and `assert.throws(() => resolveLegacy(projectId), {code: 'TIMELINE_AMBIGUOUS'})` when multiple timelines exist. `resolveLegacy` is the project-only compatibility resolver in the timeline controller.

## Task 3 — Catalog and transactional create or add

**Files:** create `src/template-catalog.js`, `template-service.js`, `test/template-catalog.test.js`, `test/template-service.test.js`; modify `main.js`, `ipc-contract.js`, `preload.js`, `canvas-store.js` and project export metadata.

**Interfaces:** `listTemplates({includePlanned=true}={}) -> TemplateEntry[]`; `createTemplateInstance({templateId,target:'new-project'|'current-project',projectId?,title?}) -> {projectId,instanceId,documentPath}`; `openTemplateInstance({projectId,instanceId})`. Entry contains ID/version/status/title/purpose/requiredKits/outputs/limitations/questions. Ready IDs: `video-editor`, `strudel-sound`.

- [ ] Write `planned_cannot_instantiate`, `add_requires_project`, `unique_paths_preserve_existing`, `missing_kit_rolls_back`, `kit_budget_preserves_existing_project`. Assert 100-file/1 MiB per-source/4 MiB project constraints remain enforced and partial creation removes only newly created entries. Run `node --test test/template-catalog.test.js test/template-service.test.js` red.
- [ ] Implement service using existing save-before-switch and createDocument flows. Allocate stable instance IDs and `sketches/<instanceId>/index.html` paths; generate Video from existing template and Strudel from Task 5. Validate installed kits and merged kit budget before writes. Return the same host-derived identity to drawer and agent callers.
- [ ] Register narrow IPC handlers, derive trusted sender and validate targets; no new broad filesystem API. Transaction failures leave existing source/kits/media untouched. Current video launch button opens an existing Video instance or asks to choose if ambiguous; explicit gallery Create/Add always makes a new one.
- [ ] Run focused tests green and existing project/IPC tests. Use a stub Strudel source factory until Task 5 integration; do not label stub output as ready in a running app.
- [ ] Commit: `feat: add template catalog and instance creation service`.

Representative Task 3 assertions: `assert.notEqual(first.instanceId, second.instanceId)`; `assert.notEqual(first.documentPath, second.documentPath)`; after failed creation `assert.deepEqual(readProject(), beforeProject)`.

## Task 4 — Templates drawer and project actions

**Files:** create `src/templates-drawer.js`, `test/templates-drawer.test.js`; modify `index.html`, `renderer.js`, `project-workspace.js`, relevant DOM tests.

**Interfaces:** `createTemplatesDrawer({document,client,onOpen,onPrompt,onStatus,isBusy}) -> {refresh,setOpen,updateBusy,destroy}`; consumes Task 3 list/create/open APIs. Generalize existing drawer discriminator to `files|media|templates` without changing established focus/ARIA behavior.

- [ ] Write `drawer_exclusive_focus_escape`, `ready_actions_create_or_add`, `planned_has_no_open`, `busy_prevents_duplicate_create`, `prompt_preserves_existing_draft`. Assert clicks do not call sendMessage, generateMedia or play audio. Run `node --test test/templates-drawer.test.js test/project-workspace.test.js` red.
- [ ] Implement the text-led gallery/details with two ready entries, explicit destination actions, installed-kit/errors/busy feedback and truthful Planned entries. Reuse incumbent visual tokens; avoid unrelated app-shell changes.
- [ ] Run tests green. Perform one bounded automated screenshot pass using disposable app data where available; otherwise provide exact user-run visual checks, not a claim of visual completion. No live user CDP.
- [ ] Commit: `feat: add Templates drawer with create and add actions`.

Representative Task 4 assertions: after choosing a prompt, `assert.equal(sendMessageCalls.length, 0)`; after Escape `assert.equal(document.activeElement, templatesToggle)` and all drawers are hidden.

## Task 5 — Editable Strudel sketch and immediate controls

**Files:** create `src/strudel-template.js`, `test/strudel-template.test.js`; extend `strudel-kit.js`, `template-service.js`, and the disposable runtime fixture.

**Interfaces:** template factory `createStrudelTemplate({instanceId}) -> {files,entry}`. Authored source exposes `createPattern(params)` and registers `EaselCanvas.registerApp({id,dispose,getState,restoreState})`; UI owns `{bpm,volume,patternVersion,playing:false}`. Instance settings never use the shared root state.json without an instance key.

- [ ] Write `starts_silent`, `keyboard_play_is_gesture`, `stop_clears_tails`, `reload_does_not_autoplay`, `two_instances_restore_separately`. Run `node --test test/strudel-template.test.js` red.
- [ ] Build a native-synth starter using direct Strudel API/mini-notation strings, not evaluate or raw REPL syntax. Expose Play/Stop, BPM and volume; bound BPM 30–240, gain 0–1. Provide source-edit hints, honest ready/error labels and lifecycle disposal. Pattern changes that are not tested as cycle-boundary swaps stop and require explicit restart.
- [ ] Run tests green and reuse the existing fixture once for audible output, keyboard activation, source reload, repeated open/close and cleanup. Confirm no duplicate scheduler/context survives.
- [ ] Commit: `feat: add editable Strudel sound sketch`.

Representative Task 5 assertions: after open/reload `assert.equal(state.playing, false)`; after disposal `assert.equal(activeSchedulers, 0)` and `assert.equal(activeAudioContexts, 0)`.

## Task 6 — Isolated WAV rendering and durable Media save

**Files:** create `strudel-export-policy.js`, `strudel-export-renderer.js`, `strudel-export-controller.js`, `strudel-export-bridge.js` and matching tests; modify `strudel-template.js`, `main.js`, `canvas-preload.js`, `canvas-media-store.js`, media event handling.

**Interfaces:** `validateStrudelSnapshot(input) -> Snapshot`; `renderStrudelSnapshot(snapshot,{signal}) -> {wavBytes,duration,channels:2,sampleRate:48000}`; controller `start(scope,request) -> Receipt`, `cancel(scope,exportId)`. Receipt is `{exportId,assetId,projectId,instanceId,mimeType:'audio/wav',attachmentStatus,warning?}`. Only the host determines scope.

- [ ] Write `rejects_budget_and_unsupported_events`, `wav_matches_header_and_frames`, `cancel_prevents_late_save`, `durable_save_survives_attach_failure`, `repeat_id_returns_same_receipt`, `changed_content_rejects_same_id`, `switch_never_attaches_wrong_project`. Run `node --test test/strudel-export-*.test.js` red.
- [ ] Freeze score/source revision and local parameters at export click. Query only selected 1–16 cycles; retain onset events with finite numeric fields. Restrict synthesis to proven sine/triangle/square/saw aliases, MIDI notes 24–96, gain 0–1, attack/release 0–0.5 seconds, no samples/effects/callbacks. Normalize aliases once; reject unknown fields. Tail is 0.5 seconds; total including tail cannot exceed 30 seconds. Enforce global event/polyphony/byte budgets before offline synthesis.
- [ ] Render in a disposable sandboxed host-managed renderer with current policy and only plain validated snapshot data. Use OfflineAudioContext, setAudioContext, reset SuperDough controller, register native synth sounds, schedule events and startRendering. Encode PCM16; do not use the upstream downloader or touch live globals. A wall-clock watchdog destroys the renderer; cancel tokens reject late results. Do not claim OfflineAudioContext.close exists.
- [ ] Validate RIFF/WAVE chunks, PCM encoding, channels/rate/bits, exact frame/data lengths, duration and byte cap before saving. Reserve the export ID before asynchronous work. Save through CAPTURE_MEDIA, then attach to the captured project only if still valid. Persist/return success after durable save even when attachment fails; do not repeat saving to recover an attachment error.
- [ ] Run tests green. Extend the single runtime fixture to decode exported WAV and assert nonzero audio, expected length, event timing and live-context isolation. Cover cancellation before/during/after save and failed storage. Document unsupported user-authored patterns clearly.
- [ ] Commit: `feat: export bounded Strudel loops to Media`.

Representative Task 6 assertions: `assert.equal(receipt2.assetId, receipt1.assetId)` for identical retries; `assert.equal(saveCalls.length, 0)` after cancelled late completion; decoded output has `sampleRate === 48000`, `channels === 2`, `bitsPerSample === 16`, `duration <= 30`.

## Task 7 — Agent discovery and live canvas dialogue

**Files:** create `src/template-tools.js`, `test/template-tools.test.js`; modify `easel-tool-host.js`, `agent.js`, `chat-service.js`, `main.js`, and shared tool registration sites, `harness-instructions.js`, `canvas-input-runtime.js` only if needed, matching built-in/Codex tests and injected skill guidance.

**Interfaces:** tools `list_templates({includePlanned?})` and `create_template_instance({templateId,target,projectId?,title?})`, sharing Task 3 service. Continue to use existing `request_canvas_input` and `get_canvas_inputs`; do not introduce a second answer system.

- [ ] Write `both_backends_discover_same_catalog`, `creation_requires_specific_target`, `question_restores_without_reset`, `stale_instance_answer_rejected`, `source_patch_does_not_autoplay`. Assert existing question tool ends turn and answer resumes once, with document/instance context. Run `node --test test/template-tools.test.js test/canvas-input-store.test.js` red.
- [ ] Add bounded catalog context and discovery/creation handlers to shared tool host and both backends. Teach questions such as rhythm versus melody and calm versus energetic inside the canvas. Use restorePreviousView/clear, not resetState. Preserve existing transient overlay and dismissal; explain model latency/source reload and provide a clear path to Stop. Questions and existing media are context, not expanded permission.
- [ ] Run tests green plus backend/tool-host/instruction-budget tests. Confirm no prompt insertion auto-sends or triggers generation; planned entries remain unavailable. Verify exact instruction budgets from baseline, not invented higher limits.
- [ ] Commit: `feat: teach agents template discovery and canvas co-creation`.

Representative Task 7 assertions: built-in and Codex descriptors expose the same template IDs; answer submission yields one continuation; restorePreviousView leaves source revision unchanged and never calls reset/reload.

## Task 8 — Whole-branch verification and draft PR

**Files:** update `docs/video-editor.md`, create `docs/templates.md`, `docs/strudel.md`, license/compatibility evidence; fix only reviewed scope defects.

**Interfaces:** final PR consumes the verified base and all seven completed slices; exports source/build material and reports tested versus user-manual checks.

- [ ] Run `git diff --check`, the targeted suites once after integration, then `npm test` and `npm run build` once. Re-run only failed/affected suites after fixes; do not repeatedly launch all subprocesses per small text change.
- [ ] Run one disposable end-to-end acceptance fixture: two Video instances, two Strudel instances, create/add, kits preserved, canvas answer continuation, WAV save/preview, project ZIP and lifecycle cleanup. Preserve outputs/logs. No live user attachment; UI/GPU/device details not proven remain a short user checklist.
- [ ] Obtain a fresh whole-branch review focused on migration, origin/revision boundaries, cancellation/save races, unexpected network/eval/worklet use, licensing evidence and truthful capabilities. Fix findings with regressions and rerun affected tests.
- [ ] Push the isolated branch and create/update a draft PR using the verified dependency base. State unproven manual checks and whether #6/#9 must merge first. Check exact-head test/build CI through terminal results; do not treat an older green run as this branch’s result.
- [ ] Return draft PR, evidence, blockers and a concise merge-order recommendation coordinated with the separate PR audit. Ask before any merge or draft closure; no release/deploy/store action.

## Plan review and execution choice

The plan is ready for review, not execution. Recommended: task-scoped subagents in the current workspace with per-task review, because migration and audio isolation have independent correctness risks. Alternative: one implementer with a final independent review, reducing context cost. Preserve the user’s live-CDP boundary in either case.

The pre-implementation choice is acceptance of this plan and execution method; no merges or draft closures are authorized by that choice. Actual compatibility or contributor-rights failures may create a later specific blocker; do not ask speculative permission now or silently weaken security to pass a test.

## Planning self-review

Checked coverage against the approved spec: discovery/create-add, independent timelines/migration/ZIP/deletion, both agent backends, live canvas answers, local controls, Strudel kit security, WAV isolation/cancellation/receipts, accessibility, tests and licensing each have an owning task. Five Review Focus cases map to named tests. Cross-repository GPL alignment and client-only integration cleanup are separate workstreams. API names and snapshot fields are consistent; runtime compatibility is a hard gate, not an assumption of success. No product edits, worktree creation, commits, installs or tests were performed while writing this plan.
