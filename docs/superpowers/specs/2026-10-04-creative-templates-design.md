Easel creative templates design


Revised proposal for review • 4 October 2026

Make Easel’s creative possibilities easy to discover in class. A student can start from a working, editable sketch, choose a direction with the agent, and develop their own project. The next PR delivers two working templates: Video editor and Strudel sound. Strudel joins the locally bundled kits, with editable HTML and pattern code for class exploration. Other template categories remain clearly labelled Planned.


Recommended approach

- Shared template catalog and editable instances — recommended. One catalog powers the left drawer and agent discovery; canvas questions support live creative dialogue. Each chosen sketch becomes independent editable project files with its own state. This supports classroom exploration and more than one video sketch per project.

- Gallery links to today’s editor — quickest, but unsuitable for the requested first release. Duplicating its HTML would still address the same project-wide timeline. It cannot honestly offer independent video sketches.

- Separate native editors — larger rewrite. This would duplicate the current canvas runtime and weaken the idea that students and agents can inspect and adapt the sketch itself.


Student experience

A Templates button in the left activity rail opens a drawer using the existing Files and Media interaction pattern. Available entries come first. The Video editor and Strudel entries explain what students can change, what is ready, and any output limits. A text-led gallery is enough for this increment; no invented thumbnails or assets are needed.

Selecting either template opens a short detail view with two explicit actions: Create project and Add to current project. The latter is unavailable when no project is open. Each action makes a new sketch; existing sketches reopen from project files or tabs. Names and paths are unique, and previous work is never replaced.

After creation, the sketch is usable immediately. Strudel starts silent until the student presses Play. An optional Explore this idea action prepares a visible chat prompt asking the agent to help develop a creative brief. Opening a template never starts a model call, creates generated media, or spends credits. Students can edit the proposed prompt before sending it.


First release boundaries

Ship the Templates drawer, two ready templates, Video editor and Strudel, independent instances, create-or-add flow, agent discovery, in-canvas creative questions, existing Video WebM export to Media, and Strudel playback with editable patterns and bounded WAV loop export to Media. Planned entries may describe presentations, games, image editing, SVG editing, and voxel soundscapes, but cannot offer Open or imply working implementations. Planned video editing extensions should be distinguished from the ready Video editor.

What Easel supports and what changes



Available foundations

- Editable multi-file HTML projects, multiple documents and tabs, revision-aware source editing, managed media, and project ZIP export already exist.

- The Video editor already supports timeline editing, managed-media use, independent timeline undo and redo within its current singleton model, and WebM export with audio through Mediabunny, limited to 60 seconds and 32 MiB.

- Offline Canvas 2D, HTML, Three.js, p5.js, Tone.js, Matter.js, and Phaser kit definitions exist; non-built-in kits must be installed. These are creative building blocks, not evidence that every proposed editor is already available.

- Prompt starters already populate the composer. Canvas input and selection flows already let the agent ask questions and use a selected timeline range.


New template and agent contract

Each catalog entry has a stable template ID and version, readiness status, short purpose, supported actions and outputs, required kits, limitations, and suggested creative questions. Only ready entries have an instantiation function. The catalog is packaged locally; there is no marketplace, remote template download, or new account requirement.

The agent receives a read-only catalog discovery tool and can recommend a relevant ready template while explaining why. Instantiation uses the same validated host service as the drawer and follows an explicit student request to create or add a sketch. The agent can discuss planned entries but must state their status. Starter text is guidance, not permission to run tools, generate media, or share files.

For a video sketch, questions might be “What do you want the viewer to feel?” or “Do you already have footage, or should we start by planning shots?” Ask one useful question at a time, use existing project context, and avoid a compulsory questionnaire. No student profile or classroom analytics is introduced.


Independent video sketches are required

Today the launcher uses video-editor/index.html, storage contains one timeline per project, and project export writes one .easel/timeline.json. Multiple independent video sketches therefore require a state-model change, not simply multiple HTML files.

Introduce a host-owned instance record binding project ID, instance ID, document path, template ID/version, and, for Video, timeline ID. Give each new video instance unique source paths and timeline state/history. All editor, agent, selection, export, and change-event calls target that instance. The host resolves this binding from the loaded document; editable HTML cannot claim another instance’s identity.

Legacy projects retain their existing timeline ID, revision, history, and source unchanged. A versioned migration binds the legacy video document to one instance; it is idempotent and keeps recoverable original data until validation succeeds. Ambiguous legacy copies are surfaced for a choice, never silently split or merged. ZIP export includes every instance and timeline in a versioned manifest while preserving legacy compatibility.

Safety lifecycle and review



Lifecycle and export guarantees

Source edits and timeline edits retain separate expected revisions. Switching documents, replacing runtime HTML, or deleting an instance invalidates pending selections and bridge operations. Each Video instance has its own timeline undo/redo history; Strudel uses existing source revisions for its editable code; stale edits require a refresh and rebase. Source changes never reset timeline data automatically.

Export captures the intended instance and revision, validates the output, and returns a durable asset receipt. Repeated completion requests with the same export ID and content do not create duplicates. A change of active document cannot attach the result to the wrong sketch. If saving succeeds but attachment fails, show the saved Media asset and a recovery action rather than repeating the export.

Template updates never overwrite student-edited files. Deleting a sketch removes its binding and timeline only through the existing confirmed deletion flow; deleting a project handles all its instances. Media references are checked across all timelines before detaching or deleting a shared asset. Creation failures roll back only newly created files/state and leave existing work intact.


Security and future extensions

Keep the existing sandbox, context isolation, no Node access, no external network resources, and host-validated bridge schemas. Apply size and resource limits; scope every asynchronous response to its originating runtime and instance. Agent-editable HTML is not privileged merely because it started as a bundled template.

Image editing can later reuse managed PNG/JPEG/WebP assets, with crop and alpha-preserving PNG output. Automatic background removal is a separate capability. SVG source files already work, but SVG in Media needs explicit validation and inert preview support. A Three.js/Tone.js showcase needs user-initiated audio, Stop/volume controls, and resource cleanup. Existing generic canvas recording omits audio; audiovisual showcase export is additional work.


Acceptance checks for the first release

- A student can discover both ready templates, create a project or add them to one, and create two video sketches whose timelines remain independent.

- Reload, source edits, undo/redo, selection sharing, project export, and deletion preserve correct instance identity and existing media references.

- Legacy projects migrate once without losing timeline contents or history; failures remain recoverable. Stale revisions and cross-instance requests are rejected.

- Exports appear in Media once, with useful failure recovery. Opening entries and inserting prompts make no automatic model or generation calls.

- Keyboard focus, Escape, drawer exclusivity, busy/error states, and narrow layouts follow the existing app. Planned entries remain visibly unavailable.

Source basis: easel-media-simplify at 85d283c; workspace, project, timeline, export, and sandbox modules. Source inspection only; no new runtime test.

Strudel sound template



Working scope for this PR

Bundle Strudel locally through Easel’s existing kit catalog and build pipeline. Supply an editable HTML sketch using a small Strudel pattern API with Play, Stop, tempo, and volume controls. Begin with synthesized sounds so the starter works without remote samples. Students and the agent edit ordinary project source; this increment does not embed the full Strudel website or a live code evaluation console.

The kit must be available to both newly created projects and sketches added to existing projects. Preserve the project’s existing kit choices and validate the resulting bundle and size limits before committing the new instance. Multiple Strudel sketches keep separate source and settings; switching sketches stops the old scheduler and audio rather than layering playback unintentionally.


Creative questions and discovery

Catalog metadata includes the sound sketch’s purpose, installed kit requirement, playback controls, editable pattern affordances, and bounded WAV loop export, plus in-canvas questions that shape the music as the student listens. Suggested questions include “Do you want to begin with a rhythm or a melody?” and “Should it feel calm, playful, or tense?” The agent adapts these to the student’s answers and existing work instead of sending a fixed questionnaire.

Explore this idea begins with a visible, editable composer prompt that the student sends. During co-creation, the agent uses the existing request_canvas_input tool for mood, rhythm, or energy choices inside the canvas. EaselHost.submitInput saves the answer and automatically resumes the conversation. Use restorePreviousView or clear; avoid resetState, which reloads source. Opening a template still starts no model call or playback by itself.

The existing question UI is a dismissible modal overlay, not an inline music panel. Reuse its verified answer bridge; preserve a clear way to dismiss the question and Stop audio. Local tempo/volume controls respond immediately. Agent changes take a model round trip and source patches may reload the canvas, so do not promise uninterrupted playback. Quantize local pattern swaps to a cycle boundary only where supported and tested; provide source undo and an explicit restart after reload.


Playback safety and compatibility gate

Playback must start from a genuine Play gesture, remain silent on opening, stop reliably, and dispose schedulers and audio nodes on replacement or closure through EaselCanvas.registerApp. A visible error and retry action handle initialization failure. Microphone access is unnecessary. The starter uses no external sample URLs, CDN imports, or new filesystem permissions.

Source inspection of @strudel/web 1.3.0 supports a narrow baseline: initStrudel, direct note(...).s("sine").play(), and hush. No samples load by default. Audio initialization normally attempts embedded AudioWorklets blocked by Easel’s current policy. The candidate adapter calls initAudioOnFirstClick({disableWorklets:true}) before initStrudel; passing that option only to initStrudel is not established. Do not await the gesture-pending initializer during page startup; verify explicit resume from Play and keyboard activation. This is source-derived, not runtime-proven.

Keep the current policy: no eval or full REPL, unsafe-eval, external resources, sync SharedWorker scheduler, or general worker allowance. Use an explicit synth-only supported subset. If initialization still needs a permission change, pause for review of the exact operation; do not weaken policy silently. Exported HTML must include its offline bundle and require Play to start sound.


Playback acceptance

Verify audible output, Play, Stop, tempo, volume, source editing, reopen, instance isolation, cleanup, and offline ZIP playback. Confirm silence before Play, no network or CSP failures, no eval-dependent console, and rejection of stale bridge operations. MP3, microphone recording, full REPL, remote sample packs, and audiovisual capture remain outside this increment.

Audio export and licensing



Bounded WAV export in the first version

Add an Export loop action to Strudel. Choose 1–16 cycles, with at most 30 seconds including a short, bounded release tail. Produce stereo 48 kHz PCM16 WAV, under 6 MiB, and save it directly to the existing Media library with a project attachment. Playback and export use the same explicitly supported native-synth pattern subset. Do not record the microphone, substitute another synthesizer, or send the result to chat automatically.

The proposed route uses Strudel’s queried events and its own SuperDough synthesis in a separate host-managed renderer. Snapshot the selected pattern at its source revision and tempo, query a bounded arc, retain onset events, and convert their timing to seconds. Transfer only validated plain event data, never executable callbacks. In the isolated realm, bind a new OfflineAudioContext, reset the module’s audio controller, register native synth sounds, schedule bounded events through superdough, and call startRendering. Encode the resulting AudioBuffer as WAV.

This is supported by source inspection, not yet a demonstrated end-to-end runtime. It avoids the upstream renderPatternAudio download helper, which closes the live context, resets globals, and returns no media Blob. It also avoids an iframe, eval, and initialization paths that load worklets. Prove the native sine/triangle/square/saw subset before advertising export; unsupported patterns receive a clear error rather than an inaccurate substitute.


Resource cancellation and save contract

Validate cycle count, total duration, tempo, event count, overlap/polyphony, waveform, finite numeric parameters, and timing before rendering. Cap the snapshot at 4,096 onset events and 32 overlapping voices; terminate rendering after 30 seconds of wall-clock time. Tighten these limits if runtime tests reveal excessive load. Admit only one export at a time. The isolated renderer has no network, filesystem, device, or general application access. Revision and runtime identity are checked before admission and before saving.

Cancel, timeout, document replacement, or project switching destroys the export renderer and invalidates its token; late results cannot create an asset. OfflineAudioContext has no abort/close API, so cancellation must dispose the separate realm. The editor’s live context and scheduler must survive failed or cancelled exports. Stop semantics include silencing managed sound tails rather than assuming hush alone instantly mutes everything.

Use a narrow save-only bridge modeled on video exports. Validate WAV structure, channels, sample rate, bit depth, data length, frame-derived duration, MIME type, and limits before CAPTURE_MEDIA.save. Include instance ID, source revision, tempo, cycles, and export ID in bounded provenance. Matching retries return the original durable receipt; reusing an export ID with different content is rejected. Once saved, cancellation cannot erase that success: return its receipt even if project attachment fails, with a Media recovery action.


Licensing direction

Target GPL-3.0-or-later for Easel-owned code, subject to contributor rights and dependency review. Preserve Strudel’s AGPL-3.0-or-later terms, notices, and corresponding-source obligations; GPL metadata cannot relabel third-party code or remove the AGPL obligations of a combined distribution. Audit authorship, existing licenses, bundled dependencies, and packaged/exported artifacts before changing declarations; retain vendor and font notices and align root license, package metadata, and corresponding-source/build materials. If contributor permission is missing, request that specific permission; do not silently relicense their work.


Review and verification gate

Prove audible, nonempty WAV output with the expected cycle duration and waveform; Media save/reopen/download; isolation from live playback; bounded resource use; cancel/timeout cleanup; no duplicate saves or wrong-project attachments; and rejection of malformed files and unsupported pattern features. Tests must distinguish runtime-proven behavior from API/source feasibility.

Review this revised written scope before implementation planning. It adds Strudel WAV export and in-canvas co-creation to the Video and Strudel drawer, with GPL licensing review. No product code or license declaration has changed.