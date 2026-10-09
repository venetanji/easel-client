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

Microphone capture is separate from output playback and needs consent through the canvas Devices flow. Do not imply that enabling audio testing grants microphone permission. Studio exposes Suno audio generation when its Media tools are available; use the exact discovered schemas.

## Strudel samples

The Strudel sound template uses its own project-pinned kit, rather than Tone.
New kits include offline drums: `bd`, `sd`, `hh`, `oh`, `cp`, `tom`, `rim`.
Use `s("bd sd hh").gain(.25)` after the user starts playback.

For a generated sample, use Suno `generate_sound` with `soundType: "one_shot"`
or `"loop"`, wait for the managed job to save its real Media asset, and attach
that asset to the intended project. In the complete saved score include
`await window.EaselStrudelSamples.add('suno_snare', 'REAL_ATTACHED_ASSET_ID')`
before `s("suno_snare")`. Use single quotes for the plain registration strings;
Strudel transforms double-quoted strings into patterns. Do not invent asset IDs. Samples must be mono/stereo
WAV, MP3 or M4A, at most 10 seconds and 4 MiB; full songs usually need trimming.
Inspect `EaselStrudelSamples.list()` to discover registered names. Built-in
names are reserved. Older project-pinned kits may lack this registry.

Suno M4A (`audio/mp4`) works directly when the registry's `supportedFormats`
includes `m4a`; do not ask for conversion or generate it again. Duration limits
use decoded audio, so request at most 9 seconds to leave room for AAC padding.
An older registry without this capability still supports only WAV/MP3. On a
user-requested kit refresh, read `list_canvas_files` and collect every name from
`manifest.kits` (`kit.name`). Pass that complete list to `update_canvas_project` with
`reload:true,preserveState:true`. This refreshes installed pins, retaining source,
attachments and editor text. Reload stops playback; the user presses Run again.

Adding a sample and `EaselStrudel.evaluate(completeScore)` preserve the live
context and scheduler. Keep registration lines in durable score source so
reopening restores them. Studio Media/job attachment paths refresh asset URLs
without a reload. WAV export supports these registered samples, at most 16 names
and 8 MiB of sample bytes, with gain/envelopes but without note, speed or slicing.
Never call the offline renderer in a user's live audio document.
