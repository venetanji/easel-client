---
name: easel-p5
description: Build offline p5.js sketches in Easel with one managed instance, responsive sizing and reliable cleanup.
---

# Easel p5

Requires the installed p5 kit, enabled for the project in Files. Use the bundled `window.p5` in instance mode. Do not load p5 from a CDN or assume the p5.sound addon exists. Tone.js is a separate project kit for audio.

1. For a new sketch use `present_canvas` directly with the enabled p5 kit. For an edit, inspect only relevant source. Keep sketch logic in app.js, visual styles in CSS and a single authored mount element in HTML.
2. Await `EaselCanvas.whenReady()` before creating one `new p5(...)` instance. Give its mount a definite height before measuring it; use `min-height:0` within a bounded flex/grid layout so the canvas cannot grow its parent on each resize. Size it to the mount, use a ResizeObserver to resize, and avoid creating another canvas on every update.
3. Load local images through attached asset IDs and `EaselCanvas.assets.getUrl(id)` after asset readiness. Never derive URLs from a visible DOM image or a remote host.
4. Store user controls in a small JSON state object. Register the app with disposal calling the p5 instance's `remove()`, disconnecting the observer and removing custom listeners. Add getState/restoreState if retaining controls across reloads helps.
5. Use `apply_canvas_file_patches` for related source changes, then one reload. Validate renderer bounds, app errors and the actual live view. Check that only one drawing canvas exists.

Prefer the p5 draw loop for rendering; do not run a second animation loop for the same scene. User gestures and consent still govern audio, camera and microphone access.
