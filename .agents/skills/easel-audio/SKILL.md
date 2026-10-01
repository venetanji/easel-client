---
name: easel-audio
description: Create and diagnose interactive audio canvases with the installed Tone.js kit and user-authorized audio testing.
---

# Easel Audio

Requires the installed Tone.js kit, enabled for the project in Files. Check the project's manifest before using `window.Tone`. Easel blocks external scripts, workers and automatic device access. The bundled Tone kit uses a timeout clock; never replace it with a Worker clock or install another Tone copy.

## Playback

- Put Play/Stop controls in the authored source. In the real Play button click handler, call `await Tone.start()` before starting playback. Audio must begin from a user gesture; executing code from an agent tool is not equivalent.
- Connect the intended synth or player to output. Keep gain modest, avoid overlapping starts and provide a reliable Stop action.
- Use the supported worker-free Tone clock. For short sequences, schedule explicit events against `Tone.now()` or the existing Tone transport; cancel scheduled work on stop/disposal. Avoid continuously allocating nodes in the render loop.
- Register app disposal with `EaselCanvas.registerApp`. Stop the transport or loop you own, clear its scheduled events, disconnect and dispose your Tone nodes, and remove listeners. Do not dispose the host's shared context.
- Save durable code in project files, not only live functions. Use a single atomic patch and reload for a coherent change.

## Verification

Inspect `validate_canvas` audio and app diagnostics. Ask the user to click the harness-owned Enable audio testing control when testing is needed. Inspect `EaselCanvas.audio` for supported diagnostics rather than inventing methods. RMS/peak/analyzer activity establishes signal activity; only the user can confirm that sound was audible. Distinguish a suspended context, a disconnected graph and scheduling errors before changing synthesis code. Do not loop through identical failed tests.

Microphone capture is separate from output playback and needs consent through the canvas Devices flow. Do not imply that enabling audio testing grants microphone permission. Audio generation endpoints are not implemented yet.
