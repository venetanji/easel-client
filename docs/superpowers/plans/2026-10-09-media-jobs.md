# Media Jobs Implementation Plan

**Goal:** Show generation work in a dedicated Jobs tab with persistent status and cancellation, including captured Suno tracks.

**Architecture:** Reuse the persistent media job store and worker. Register only Suno song UUIDs, retrieve each exact track, and download completed output. Cancellation retains the receipt and stops local work. Media and Jobs share the existing drawer with accessible tabs.

**Constraints:** Preserve earlier UI changes, original media encoding, chat/project ownership, and pending receipts across Stop and restart. Never resubmit generation. Canceling local tracking cannot cancel accepted provider work or refund credits.

## Tasks

- [x] Wire captured audio receipts into the builtin and external submission paths in `src/chat-service.js`, `src/easel-tool-host.js`, and `src/agent.js`; preserve monitoring metadata through result normalization. Verify with `test/audio-track-jobs.test.js`, `test/studio-audio.test.js`, and `test/easel-tool-host.test.js`.
- [x] Add terminal `cancelled` state, monitor cancellation, IPC bridge, and confirmation in `src/media-job-store.js`, `src/media-job-monitor.js`, `src/ipc-contract.js`, `src/preload.js`, and `src/main.js`. Test cancellation during polling and after restart in `test/media-jobs.test.js`.
- [x] Add Media / Jobs tabs, separate job state and status cards, active counts, cancellation and completed output actions in `src/index.html` and `src/project-workspace.js`. Test tab navigation, active indication, and cancellation in `test/project-workspace.test.js`.
- [x] Update Suno guidance in harness instructions, media skill, and MCP README to distinguish monitored captured tracks from manual attempts. Run their existing contract tests.
- [x] Run the full test suite with browser tests, package Linux, restart the idle application with CDP, and inspect both tabs and audio output. Request review of the monitoring and cancellation changes before completion.

## Verification

Use deterministic fake providers for cancellation races and identity checks. Use the already accepted Suno tracks for live retrieval verification without generating replacements. Verify the Jobs tab and spinner in Chromium, keyboard tab navigation, and narrow drawer sizing.

## Audio Naming

Use provider song titles for background and manual audio downloads. If download metadata omits the title, inspect the exact track UUID before saving. Preserve original encoding and duration; show a musical note in the media library.

## Results

- Full suite: 1,053 passed, 1 skipped, 0 failures, including browser coverage for jobs, cancellation, and restored audio downloads.
- Linux AppImage and deb packaging succeeded; packaged MCP startup, discovery, and model listing passed.
- Live CDP inspection confirmed a separate Jobs tab with 19 saved ready jobs and no job cards in Media. Both existing tracks appear as `Hazy Pixel Dreams.m4a`, with musical-note icons, durations, playback, and download controls.
- The packaged naming and monitoring sources match the workspace. Review reported no remaining substantive findings. The app remains running with CDP on port 9222.
