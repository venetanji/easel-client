# Strudel Local Samples Implementation Plan

Goal: provide an offline drum bank and let attached audio, including Suno one-shots, join the same bank without stopping playback.

Design: embed a reproducible seven-sound PCM drum bank in the project-pinned Strudel kit. A small registry loads named samples from this bank or from the project's attached media. Frozen export events identify sample content by SHA-256, asset ID and decoded duration; the host captures attached bytes before rendering and the isolated renderer checks the decoded duration and identity.

Constraints: keep existing source edits and projects intact; no remote sample banks; no autoplay; preserve cancellation and export limits. Samples are at most 10 seconds and 4 MiB each, with at most 16 distinct samples and 8 MiB of captured media per export. Existing projects keep their pinned kit and authored source.

- [x] Add failing tests for bundled samples, attached-sample registration, identity validation and sample-aware export budgets.
- [x] Generate the drum bank and add the shared registry to the kit and retained source archive.
- [x] Capture attached samples in the export controller and load them in the isolated renderer.
- [x] Update drum examples, reference copy and agent guidance; verify additions and repeated evaluation keep the live context.
- [x] Run focused, browser and hidden native checks, then build a local preview.

Verified: 1,141 tests passed, one skipped; ten hidden native sample exports
passed save/attach/reopen/retry checks. Browser checks cover live registration,
attack-only sample tails and a 44.1 kHz playback context. Local preview:
`release/rc-20261009-8`; 120 packaged runtime, skill and kit files match source.
