# Editable video editor template

Video editor is an ordinary editable Easel HTML template. Each new sketch has an independent timeline and history, while persistence and managed-media access remain behind a narrow host bridge. Both agent backends can discover it through the shared [Templates catalog](templates.md).

## Build on your laptop

```sh
npm ci
npm run build
npm test
npm start
```

`npm run dist:mac`, `npm run dist:win`, and `npm run dist:linux` create the corresponding desktop packages. Use the command for your laptop's OS. This PR does not publish a release or change signing credentials.

For the offline media regression, run `npm run test:video-export`. On a headless Linux machine, use an existing display or `xvfb-run -a npm run test:video-export`. It uses committed synthetic fixtures, does not contact a model server, and requires no system FFmpeg or Python.

## Updating the editor template

The full-width preview, compact insertion/clip/selection controls, direct-manipulation timeline controls and visible clip/track deletion actions are included in newly created **Video editor** templates. Existing projects retain their editable source and are not overwritten on app update. To try the current source, open **Templates → Video editor** and choose **Create project** or **Add to current project**. There is no automatic source refresh. The legacy timeline-binding migration described below preserves authored source; it does not replace an older editor's controls.

## Try the complete flow

1. Choose **Templates → Video editor → Create project**, or **Add to current project**. Each action creates a new sketch. Reopen it from Project files or its document tab. The **Video editor** button above the canvas reopens a sole existing editor, offers a choice when there are several, or creates one when none exists. Use Templates to deliberately add a second independent sketch. Opening the editor starts no model call or generation.
2. Use **Import media** in the Media drawer. PNG/JPEG/WebP, MP4/WebM, WAV and MP3 files are saved locally. Import accepts up to 20 files, 32 MiB each. Files are never uploaded to a model by this action.
3. Open the **Media** drawer and drag a media thumbnail onto a compatible timeline track. The insertion marker shows the destination frame. Drop into an empty gap or after a clip; overlapping clips are rejected. Library sources are attached to the project before insertion. Images can occupy a video or overlay track; audio has its own track. For keyboard use, expand **Add clip** below the full-width preview, choose the asset and destination track, then **Add clip** to append it. This compact picker combines project and library sources; import, search and filtering stay in the existing Media drawer. Still images default to five seconds, adjustable in the picker before adding or dropping.
4. Drag the body of a clip to move it in time or to another compatible track. Drag its side grips to trim; source in/out follows the frame edge without stretching playback. Edits snap to the playhead and other clip edges; hold **Shift** to bypass snapping. Overlapping clips on the same track are rejected with a visible preview, while separate video tracks can overlap. Use **Add video track** to add a new upper layer. Drag a track header or use its **Up/Down** controls to change whole-track stacking. The visually highest occupied video/overlay track appears in front in preview and export. **Escape** cancels a gesture; completed edits use the existing persistent **Undo/Redo** history. Source files stay unchanged.
5. Click or drag on the frame ruler to seek, then press **Space** to play/pause from that frame. Clip bodies and trim grips also support **Left/Right** for one-frame nudges or **Shift + Left/Right** for ten frames. Exact timing, source seconds and audio gain/fades remain under the collapsed **Clip details** inspector. Speed changes are still not implemented.
6. Click a clip or drag across empty timeline space to select a visible frame range spanning all crossed tracks. **Alt/Option + drag** inside a current range shifts the time range without moving any clips. Drag either green boundary handle to adjust the range; focus a handle and use **Left/Right** for one frame, **Shift + Left/Right** for ten frames, or **Home/End** for the available bounds. **Escape** cancels an in-progress gesture, or clears a committed selection. Exact numeric controls remain under **Exact selection** below the preview. Range adjustment changes the context for the next message, not the clip trim. A badge in the main composer shows the exact range and revision; its host context also binds the project, instance and timeline. A changed revision marks the range stale and locks its handles until you select again. Switching documents or replacing the runtime invalidates the old selection.
7. Click **Export video**. The finished WebM is saved to Media and normally attached once to the captured project. Select it in Media to play or download it. Cancel discards unfinished rendering. Once a save succeeds, its asset receipt remains useful even if attachment fails: open Media and attach the saved video rather than exporting again just to repair the attachment. Switching must not attach the old result to a new sketch.

The Media drawer supports name/type/ID search, type filters, and newest, oldest, name, duration and size sorting. Search covers loaded media; the global library currently shows its latest 200 items. Imported image names are retained across restarts.

## Delete clips or tracks

Select a clip and use **Delete clip** above the tracks. A range selection containing several clips changes the action to **Delete selected clips (N)**; it removes the selected clips as one timeline edit. Select at most 100 clips for this action. **Delete/Backspace** also works when the current selection owns timeline focus, without modifiers. It does not run while typing in an input, an inspector or a modal, or while a gesture/export/edit is busy. A stale selection must be made again before deletion.

Each track header has **Delete track**. An empty track can be removed directly. A populated track opens a confirmation naming the track and clip count; confirm to remove the entire track and all its clips atomically, or Cancel/Escape to leave them intact. This single operation can remove a track with more than 100 clips. A changed revision or document while confirmation is open invalidates it; review the current track before trying again.

Timeline **Undo** restores the deleted clips or track in that instance; **Redo** repeats the edit. These actions preserve original source media, project attachments and media bytes. They do not free library storage. A source remains protected from detachment while any Video timeline or authored document still references it. Removing a whole sketch instead uses the confirmed Project files deletion flow, with its separate source/deletion Undo. See [Template creation and source Undo](template-source-undo.md).

## Editable source and host boundary

New templates produce `sketches/<instance-id>/index.html`, `app.js` and `styles.css` under normal Project files. Legacy `video-editor/` files stay at their original paths. Editing uses existing source tools and `reload_canvas`; source changes do not reset the host timeline automatically. The generated source includes the pinned offline Mediabunny bundle with its license; no CDN, external renderer process, Python runtime, model download or FFmpeg binary is needed.

The host owns the binding between project, document, instance and timeline. Each instance's atomic document/history envelope preserves integer frame ranges, rational frame rate, geometry, tracks, items and managed source IDs. Every mutation requires the expected revision. Undo/Redo increases that instance's revision, validates restored source ownership and survives restart. Two Video sketches can share the project's attached media while their timelines and history remain independent.

Legacy migration is idempotent and preserves the original timeline contents, revision, history and authored source. When multiple legacy copies could own one timeline, Easel asks which document should own it. It does not silently split or merge the state. Failed migration remains recoverable.

Project ZIP manifest version 2 records every instance and timeline under `.easel/timelines/<timeline-id>.json`; a project with one timeline also includes `.easel/timeline.json` for legacy compatibility. Authored source is kept under `.easel/source/`, separately from compiled offline HTML previews and attached media. The interactive editor still needs the Easel host to read/write its managed timeline and Media. A project ZIP is an editable-source backup, not a rendered movie. See [Templates outputs and backups](templates.md#outputs-and-backups) for kit/source distribution caveats and limits.

The agent receives `inspect_timeline`, `create_timeline`, `apply_timeline_edit`, `undo_timeline`, and `redo_timeline`. These target the active or explicitly identified bound instance, reject raw paths/URLs/code, and keep original media unchanged. A selected turn cannot cross to a different instance. The canvas bridge resolves project/document/instance/timeline from the trusted active frame, checks navigation/runtime generation and exposes only bounded timeline/media actions. Editable HTML cannot claim another instance's identity. Exported bytes stay local; selecting a range sends compact references and timing, never video bytes.

For creative questions, the agent uses the existing dismissible canvas modal and answer bridge. A submitted answer resumes its originating conversation once with instance context; `restorePreviousView` or `clear` leaves source intact. **Explore this idea** only inserts an editable composer prompt for you to send. No question or prompt grants permission for unrelated generation, upload or sharing.

## Renderer and first-iteration limits

Mediabunny **1.61.0** supplies decoding, WebCodecs encoding and WebM muxing; Easel owns timeline composition and audio mixing. Export samples every project frame. Live preview uses native browser playback and may differ in real-time smoothness.

- WebM with runtime-supported VP8 or VP9 and Opus. MP4/AAC output is not offered; AAC encoding was unavailable in the tested Electron Linux build.
- Export: up to 60 seconds, 32 items, 60 fps, 1920 pixels on either side and 1920×1080 pixels total, 32 MiB output, 128 MiB compressed source data, and a 16-million-pixel decoded still-image budget. Larger edits fail with an actionable limit rather than silently changing settings.
- Hard cuts and static image overlays; basic gain/fades; source clip audio plus independent mono/stereo audio tracks. Stored track order remains bottom-to-top compositing order. The editor displays those rows in reverse so the highest visible row is the highest layer. Existing authored project sources and their stored track order are not silently migrated.
- No cross-dissolves, speed changes, visual keyframes, text-overlay authoring, waveform editing or local generative continuation/gap fill in this first build.
- Opus packet padding can slightly extend container duration beyond the frame timeline. The saved metadata distinguishes encoded duration from nominal timeline duration.
- Source codec support depends on the installed Electron/OS runtime. Damaged, unsupported or out-of-range sources fail before a finished output is admitted.

The public Easel API MCP schema is unchanged. The separate Python `creative-comfy-graph` package/bridge is not bundled or assumed to exist; generation integration remains a separately versioned ecosystem task.

## Native editor interaction smoke

After `npm run build`, run `node scripts/smoke-video-editor.cjs` (headless Linux: `xvfb-run -a node scripts/smoke-video-editor.cjs`). Set `EASEL_UI_ARTIFACT_DIR` to retain screenshots and the JSON result in a chosen directory.

The additional `node scripts/smoke-timeline-controls.cjs` regression checks direct clip moves, trim, ruler seek/Space, multitrack selection, range-only movement, whole-track reorder, undo/redo, and matching preview/export stacking using native Electron input.

The original selection/drop smoke starts the real app with a temporary profile, imports the committed synthetic image, captures the actual drawer drag payload, delivers it through native browser `DataTransfer` events to the separate sandboxed template, and checks the persisted insertion. It then uses native mouse/keyboard input for boundary adjustment, verifies Escape rollback and checks durable Undo/Redo through the host bridge. The transfer delivery is automated; an OS-level cross-window drag remains a manual target-platform check. No model server, credentials or paid generation are used.

## Verification evidence and remaining checks

The original feasibility source is preserved in `tools/renderer-probes/mediabunny/` from PR #5. The product uses the same pinned media APIs with bounded decoding, independent audio tracks and durable host integration.

The reproducible smoke is `scripts/smoke-video-export.cjs`, with original flat-color/tone fixtures in `test/fixtures/video-export/`. It exercises unlike source frame rates, trim/reorder, image placement, retained source audio plus an independent audio bed, gain/fades, custom track order, malformed input, cancellation including late cancellation, recovery, unchanged source hashes and repeat exports.

On Electron **44.4.5 / Chromium 152**, Linux x64, the synthetic one-second composition decoded to exactly **24 video frames at 24 fps**, with the expected blue-to-red cut and yellow overlay. Decoded audio contained the expected 660/440 Hz source tones and the separately placed 880 Hz bed. Two exports had the same hash in this environment. WebM packet duration was 1.020 seconds for the 1.000-second timeline. This is Linux evidence, not a promise of cross-OS byte identity.

Earlier Video editor baseline evidence also includes a real Easel application smoke that opened the template, imported a source image, added a clip through the UI and exported/retrieved a 1920×1080 WebM containing 48 frames over exactly two seconds. Desktop and narrow editor layouts, selection, live playback and cleanup were checked there. Linux unpacked packaging and the existing packaged Media MCP startup check passed. These are baseline Video checks, not proof of the complete creative-template journey or a new native download-dialog test.

Focused tests additionally cover two independent timelines, instance-bound bridge/tool/selection calls, migration recovery, all-timeline media protection, versioned ZIP contents, confirmed sketch deletion/recovery and visible clip/track deletion with Undo. A separate [mixed-project host integration test](../test/template-workflow-acceptance.test.js) ties two Video/two Strudel create/add, preserved source/kits, answer continuation, a controlled WAV receipt, ZIP source closure and deletion recovery together. Its view/model/PCM/kit dependencies are controlled; it does not run a native app. The native Strudel starter/WAV proof is separately scoped in [Strudel verification](strudel.md#verification). Together these do not claim a full main-shell student journey.

Target-platform checks still include drawer keyboard/Escape and narrow layout, switching between two independent Video sketches, visible deletion/Undo, OS-level media drag, Media playback/download, and source/ZIP reopening. Windows/macOS codec and runtime behavior need their normal platform checks. See [license audit](license-audit.md), [LICENSE](../LICENSE) and [NOTICE](../NOTICE) for retained dependency terms and release/source-review caveats; runtime evidence is not licensing clearance.
