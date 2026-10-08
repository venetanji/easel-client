---
name: easel-canvas
description: Build and refine offline interactive HTML canvases using Easel project files, lifecycle management, attached media and live validation.
---

# Easel Canvas

Use the in-app tools and local canvas runtime. There is no shell, package manager, unrestricted network, filesystem or worker API. Do not call a CLI or import a library from a CDN. Project kits are selected in Files and shared by every HTML document. Check `list_canvas_files` for the actual kit selection; use `update_canvas_project` for an explicit kit change when needed.

## Efficient editing

1. Inspect `list_canvas_files` and read only relevant files with `read_canvas_file`. Keep HTML, application JavaScript and CSS separate. Never retrieve bundled libraries or serialize live DOM as authored source.
2. Create a document with `present_canvas` or `create_canvas_document`. Preserve existing documents. Use relative project source files; only selected offline kit globals exist.
3. Apply related edits atomically with `apply_canvas_file_patches`, using the revision read from inspection. Read the tool schema before using it. Reload once after the batch; preserve managed state when useful. Source-only changes do not alter live runtime until reload.
4. Await `EaselCanvas.whenReady()`. For attached media, await `EaselCanvas.assets.ready` and resolve `EaselCanvas.assets.getUrl(assetId)`. Attach assets by ID with `attach_canvas_assets`; do not invent IDs or depend on visible image elements.
5. Register the app with `EaselCanvas.registerApp({id, dispose, getState, restoreState})`. Dispose resources and listeners. Use `EaselCanvas.startLoop(callback)` for a managed animation loop; its returned function stops the loop. The getState hook must return JSON. Register compact diagnostics with `EaselCanvas.registerDebugState(id, getter)`.
6. Validate the actual open document with `validate_canvas` and `capture_live_canvas`. Report app errors separately from kit warnings. A successful source write does not prove the runtime works.
7. For the Strudel sound template, inspect its current code and use `window.EaselStrudel.evaluate(source)` through `execute_canvas_javascript` only when the user asked to audition a live change. This updates the running Strudel scheduler without a source reload; it does not start Play. Keep `.play()` out of code pushes. Persisted custom code is displayed, not executed, on reload; push it again and require a user Play gesture. Remote samples are blocked and the sample kit is not bundled yet. The WAV exporter still rejects samples/effects.

## User input and media

Discover packaged sketches with `list_templates`; state readiness and actual installed-kit availability. Planned entries cannot open. Use `create_template_instance` only for a specific user request to create/add a sketch and a chosen target: `new-project` or `current-project`. Preserve existing work. Explore this idea inserts an editable composer prompt; the user sends it.

Use `request_canvas_input` for one useful adaptive question at a time, informed by the existing sketch: rhythm versus melody, calm versus energetic, or what a video should make the viewer feel. Its durable answer resumes the originating conversation once, with document/instance context; end the turn and never poll. Use `restorePreviousView` or `clear`; never use `resetState` for co-creation. The transient modal is dismissible. Changes need a model round trip and source patches may reload the canvas; offer source Undo and an explicit Play restart, never promise uninterrupted sound. Strudel supports Escape to stop while the question has focus; Dismiss question then Stop also works. Local tempo/volume controls respond immediately. Opening a template never starts a model call or playback. Creative questions and existing media do not expand permission to create, generate or share. Device capture requires user consent. Use `window.EaselMedia.photo()`, `window.EaselMedia.recordAudio({seconds})`, and `window.EaselMedia.share(media, {prompt})` for supported capture and sharing. Sharing captures with the model requires separate user approval.

Screenshots and recordings are saved media assets when requested through the host tools. Reference their returned IDs. Do not claim that the user saw or heard output based only on a tool succeeding.
