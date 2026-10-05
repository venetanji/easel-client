# Mediabunny feasibility probe

This is the source for the synthetic Linux/Electron feasibility experiment recorded in `docs/superpowers/research/2026-10-03-video-renderer-feasibility.md`. It is **not** production editor code, a supported product API, or a selected renderer. The timeline compositor in `probe.js` is intentionally handwritten test code; Mediabunny supplies demux/decode, WebCodecs encode, and mux.

The probe creates two one-second synthetic H.264/AAC clips (red/12 fps/440 Hz and blue/24 fps/660 Hz), trims and reorders them, adds a cross-dissolve and title overlay, mixes their source audio to one track, renders WebM/VP8/Opus, checks selected video frames and pre-encode source-mix RMS, records decoded output-audio presence/duration, and exercises `Output.cancel()`. It does not assert output audio frequency/content; the FFT spot checks in the research report came from the earlier separate analysis script. It does not test independent audio stems, Windows/macOS, or production integration. AAC support depends on the Electron/OS codec environment.

## Run

Prerequisites: Node/npm, FFmpeg/FFprobe, this checkout's Electron dependency, and a display server (`xvfb-run` is used below for headless Linux).

```sh
export PROBE_TMP="${TMPDIR:-/tmp}/easel-mediabunny-probe-source"
export npm_config_cache="$PROBE_TMP/npm-cache"
export electron_config_cache="$PROBE_TMP/electron-cache"
export ELECTRON_CACHE="$PROBE_TMP/electron-cache"
mkdir -p "$npm_config_cache" "$electron_config_cache"

npm ci --prefix tools/renderer-probes/mediabunny
./tools/renderer-probes/mediabunny/generate-fixtures.sh
xvfb-run -a ./node_modules/.bin/electron tools/renderer-probes/mediabunny
```

The harness writes `out/render.webm` and `out/renderer-result.json` under its own directory. Generated clips, output files, and nested `node_modules` are ignored by its `.gitignore`. It binds its temporary HTTP server to loopback, runs the renderer with sandboxing/context isolation and Node integration disabled, and uses an isolated Electron user-data directory under the OS temporary directory.

Each invocation clears the previous render, partial render, and result before loading the renderer. A successful result with nonempty output bytes writes `render.webm` atomically and exits with code 0. Failed or cancelled results remove render output and exit with code 1. Renderer crashes, a closed window, page/module load failures, server errors, and a 60-second watchdog timeout also terminate with code 1 and record an error in `renderer-result.json` when the output directory is writable. Terminal cleanup destroys the hidden window and closes the HTTP server, including stalled connections; duplicate or late results cannot replace the first terminal result. A missing optional favicon does not fail the probe.

Run the harness lifecycle regressions without Electron, FFmpeg, a display server, or probe dependencies:

```sh
node --test test/mediabunny-probe.test.js
```

These tests use the real HTTP server and filesystem with a fake Electron boundary and controllable watchdog; they do not validate codecs or rendered media.

Mediabunny is pinned to `1.61.0` in the probe-only package manifest and lockfile. This package is separate from the Easel Client runtime manifest; do not add it as a product dependency based on this experiment alone.
