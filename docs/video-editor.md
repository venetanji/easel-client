# Editable video editor template

The first video-editor build extends the October 3 design with an ordinary Easel HTML project template. The editor is source the built-in agent can read and modify, while persistence and managed-media access remain behind a narrow host bridge.

## Build on your laptop

```sh
npm ci
npm run build
npm test
npm start
```

`npm run dist:mac`, `npm run dist:win`, and `npm run dist:linux` create the corresponding desktop packages. Use the command for your laptop's OS. This PR does not publish a release or change signing credentials.

For the offline media regression, run `npm run test:video-export`. On a headless Linux machine, use an existing display or `xvfb-run -a npm run test:video-export`. It uses committed synthetic fixtures, does not contact a model server, and requires no system FFmpeg or Python.

## Try the complete flow

1. Choose **New project → Template → Video editor**. The **Video editor** button above the canvas also adds/opens the editor in the current project.
2. Use **Import media** in the editor or Media drawer. PNG/JPEG/WebP, MP4/WebM, WAV and MP3 files are saved locally. Import accepts up to 20 files, 32 MiB each. Files are never uploaded to a model by this action.
3. Pick **This project** or **Media library**, choose an asset and a compatible track, then **Add clip**. Library sources are attached to the project before insertion. Images can occupy a video or overlay track; audio has its own track.
4. Select a clip to move, trim or remove it and set audio gain/fades. Timeline spans use integer frames with an exclusive end; source in/out values are seconds. Keep source duration and project duration equal for export: speed changes are not implemented.
5. Play or scrub the live preview. Click a clip or select a range to attach that exact project/revision/frame range to the next chat message. A badge in the main composer shows the pending selection. A changed revision requires selecting again.
6. Click **Export video**. The finished WebM is saved to Media and attached once to this project. Select it in Media to play or download it. Cancel discards unfinished output.

The Media drawer supports name/type/ID search, type filters, and newest, oldest, name, duration and size sorting. Search covers loaded media; the global library currently shows its latest 200 items. Imported image names are retained across restarts.

## Editable source and host boundary

The template produces `video-editor/index.html`, `video-editor/app.js`, and `video-editor/styles.css` under normal Project files. Editing those files uses existing source tools and `reload_canvas`. The generated source includes the pinned offline Mediabunny bundle with its license; no CDN, external renderer process, Python runtime, model download or FFmpeg binary is needed.

The versioned timeline is stored independently of editor UI source under the project's opaque ID. Its atomic document/history envelope preserves integer frame ranges, rational frame rate, geometry, tracks, items and managed source IDs. Every mutation requires the expected revision. Undo/redo increases the revision, validates restored source ownership and survives restart. Project ZIPs include `.easel/timeline.json`; the interactive editor needs the Easel host to read/write its managed timeline and media. A project ZIP is an editable-source backup, not a rendered movie.

The agent receives `inspect_timeline`, `create_timeline`, `apply_timeline_edit`, `undo_timeline`, and `redo_timeline`. These operate on the active project, reject raw paths/URLs/code, and keep original media unchanged. The canvas bridge derives its project/document from the trusted active frame, checks navigation/runtime generation, and exposes only bounded timeline/media actions. Exported bytes stay local; selecting a range sends compact references and timing, never video bytes.

## Renderer and first-iteration limits

Mediabunny **1.61.0** supplies decoding, WebCodecs encoding and WebM muxing; Easel owns timeline composition and audio mixing. Export samples every project frame. Live preview uses native browser playback and may differ in real-time smoothness.

- WebM with runtime-supported VP8 or VP9 and Opus. MP4/AAC output is not offered; AAC encoding was unavailable in the tested Electron Linux build.
- Export: up to 60 seconds, 32 items, 60 fps, 1920 pixels on either side and 1920×1080 pixels total, 32 MiB output, 128 MiB compressed source data, and a 16-million-pixel decoded still-image budget. Larger edits fail with an actionable limit rather than silently changing settings.
- Hard cuts and static image overlays; basic gain/fades; source clip audio plus independent mono/stereo audio tracks. Stored track order is also compositing order.
- No cross-dissolves, speed changes, visual keyframes, text-overlay authoring, waveform editing or local generative continuation/gap fill in this first build.
- Opus packet padding can slightly extend container duration beyond the frame timeline. The saved metadata distinguishes encoded duration from nominal timeline duration.
- Source codec support depends on the installed Electron/OS runtime. Damaged, unsupported or out-of-range sources fail before a finished output is admitted.

The public Easel API MCP schema is unchanged. The separate Python `creative-comfy-graph` package/bridge is not bundled or assumed to exist; generation integration remains a separately versioned ecosystem task.

## Verification evidence

The original feasibility source is preserved in `tools/renderer-probes/mediabunny/` from PR #5. The product uses the same pinned media APIs with bounded decoding, independent audio tracks and durable host integration.

The reproducible smoke is `scripts/smoke-video-export.cjs`, with original flat-color/tone fixtures in `test/fixtures/video-export/`. It exercises unlike source frame rates, trim/reorder, image placement, retained source audio plus an independent audio bed, gain/fades, custom track order, malformed input, cancellation including late cancellation, recovery, unchanged source hashes and repeat exports.

On Electron **44.4.5 / Chromium 152**, Linux x64, the synthetic one-second composition decoded to exactly **24 video frames at 24 fps**, with the expected blue-to-red cut and yellow overlay. Decoded audio contained the expected 660/440 Hz source tones and the separately placed 880 Hz bed. Two exports had the same hash in this environment. WebM packet duration was 1.020 seconds for the 1.000-second timeline. This is Linux evidence, not a promise of cross-OS byte identity.

A real Easel application smoke also opened the template, imported a source image, added a clip through the UI, and exported/retrieved a 1920×1080 WebM containing 48 frames over exactly two seconds. Desktop and narrow editor layouts, selection, live playback and cleanup were checked. Linux unpacked packaging and the existing packaged Media MCP startup check passed. Windows/macOS runtime behavior still needs the normal target-platform CI and laptop checks.
