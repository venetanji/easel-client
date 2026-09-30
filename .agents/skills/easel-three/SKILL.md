---
name: easel-three
description: Build offline Three.js canvases in Easel with local textures, managed rendering and explicit GPU cleanup.
---

# Easel Three

Requires the installed Three.js kit, enabled for the project in Files. Use `window.THREE`. Addons such as OrbitControls, external loaders and bare package imports are not guaranteed; inspect actual availability and write a small local control implementation when needed. Network requests, workers and shell commands are unavailable.

1. Read relevant project files and kit selection. Keep one authored mount element and create one renderer, scene and camera after `EaselCanvas.whenReady()`.
2. Size the renderer to the mount's bounds, update the camera aspect on resize and cap pixel ratio when appropriate. Reuse geometry/materials instead of allocating each frame.
3. Attach texture assets by ID; await asset readiness, then load `EaselCanvas.assets.getUrl(id)`. Check the loaded image before rendering. Preserve authored source as the persistence authority.
4. Use `EaselCanvas.startLoop` for rendering and retain its stop function. Register disposal that stops the loop, disconnects observers, removes listeners, disposes geometries/materials/textures and the renderer, and removes its DOM canvas. Share resources carefully to avoid double disposal.
5. Expose small JSON debug state via `EaselCanvas.registerDebugState`. Implement getState/restoreState for useful camera and control values rather than serializing a scene graph.
6. Patch related files together and reload once. Use `validate_canvas` and `capture_live_canvas` to check app errors, camera/renderer state, bounds and duplicate canvases. Separate bundled-kit warnings from authored app failures.

Never insert a renderer-created canvas into saved HTML. Live probing can diagnose a scene; a permanent fix must update source.
