# Video Renderer Feasibility — 2026-10-03

## Decision

Do not select a renderer dependency for Task 5 yet. Keep the timeline/media interface renderer-neutral. `ffmpeg-static` is the only candidate tested here that met synthetic correctness checks, but the tested build is GPL-3.0-or-later and carries a ~77 MiB Linux binary; cross-platform packaged Electron builds and the product's distribution posture remain unvalidated. HyperFrames rendered the same fixture, but requires a browser and FFmpeg/FFprobe runtime and is not a drop-in managed-media timeline engine. The WASM packages were inspected, not rendered.

Possible follow-up: retain a typed, app-owned timeline model and, after licensing review, evaluate FFmpeg for source-media composition with HyperFrames limited to trusted/template-based HTML overlays. Do not pass agent-authored HTML/JS or arbitrary FFmpeg arguments. A hybrid is a hypothesis, not a validated product recommendation.

## Probe scope and environment

- Branch `docs/agent-video-timeline-design-20261003`, base commit `f66c315b1b606ce3fc672a5630739867546c1805`.
- Node `v26.10.0`, npm `12.1.0`, Linux x64; system Chromium `/usr/bin/chromium`; system FFmpeg/FFprobe `n9.0.2`.
- All media, installs, and outputs were synthetic and under `/tmp/easel-video-renderer-probe-20261003`. No product manifest/dependency changes, user media, generation API, model download, or GPU job.
- The assigned `.superpowers/sdd/2026-10-03-agent-video-timeline/task-1-brief.md` was absent. Followed Task 1 in `docs/superpowers/plans/2026-10-03-agent-video-timeline.md` and the renderer gate in `docs/superpowers/specs/2026-10-03-agent-video-timeline-design.md`.

## Candidates and evidence

| Candidate | Exact version | License evidence | Runtime/platform evidence | Footprint observed |
|---|---|---|---|---|
| HyperFrames CLI | `hyperframes@0.8.114` | npm package declares Apache-2.0; upstream repository `LICENSE` is Apache-2.0. | Package README requires Node >=22 and FFmpeg. `doctor` found FFmpeg, FFprobe, Chrome; tested Linux x64 with HeadlessChrome 152. The npm package is not a self-contained browser/media stack. Cross-platform packaging was not tested. | Temporary installed dependency tree 120 MiB at final measurement; HyperFrames package 34 MiB. Browser and FFmpeg/FFprobe excluded. |
| `ffmpeg-static` native CLI | `ffmpeg-static@5.3.0`; downloaded Linux x64 binary reports FFmpeg `7.0.2-static` | npm package declares GPL-3.0-or-later; downloaded `ffmpeg.LICENSE` included and `ffmpeg -version` shows `--enable-gpl`. README notes each binary's license applies. Distribution needs explicit legal review. | README claims macOS x64/arm64, Linux x86/x64/armhf/arm64, Windows x86/x64. It describes FFmpeg 6.1.1, but this package install returned a binary reporting 7.0.2-static. Installer downloads a platform-specific binary; README warns to purge `node_modules` when packaging for another OS. Only Linux x64 executed. | Temporary package tree 78 MiB; binary 77 MiB. npm package unpacked size ~48 KiB excluding binary. |
| `@ffmpeg/ffmpeg` + `@ffmpeg/core` (considered) | `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/core@0.12.10` | npm metadata: wrapper MIT; core GPL-2.0-or-later. Review core FFmpeg build/configuration and distribution obligations. | Browser worker/WASM approach, not a native main-process CLI. Wrapper's Node export is a stub. Pair not executed in Electron renderer; no cross-platform claim validated. | Temporary install 62 MiB; core `dist` 62 MiB. No runtime/performance number because not rendered. |

Authoritative references checked 2026-10-03:

- HyperFrames: `https://github.com/heygen-com/hyperframes` (README, `LICENSE`, `packages/cli/package.json`); installed CLI README/package metadata v0.8.114; npm registry metadata.
- `https://github.com/eugeneware/ffmpeg-static` (README, package metadata, installer, per-binary license); npm registry metadata v5.3.0.
- `https://github.com/ffmpegwasm/ffmpeg.wasm` and npm registry metadata for the exact wrapper/core versions above.

## Synthetic fixtures

Generated locally using the temporary `ffmpeg-static` binary:

- `clip-a-12fps.mp4`: 96x64, 12 fps, 1 s solid red; 440 Hz AAC source audio.
- `clip-b-24fps.mp4`: 96x64, 24 fps, 1 s solid blue; 660 Hz AAC source audio.
- `overlay-yellow.png`: 96x64 still, composited at 50% opacity over `[0.5, 0.75)`.
- `track-2-880hz.wav`: mono 48 kHz tone, placed at 0.5 s as an independent audio layer.
- Output: 24 fps, clips overlap 0.25 s/6 frames with a cross-dissolve starting at 0.75 s; expected duration `[0,1.75)` = 42 frames. HyperFrames muted B video so retained A sound plus independent sound make two timeline audio layers; native output mixed both clip-source tracks plus the independent layer.

## Results

| Check | HyperFrames | `ffmpeg-static` |
|---|---|---|
| Output count/duration | 42 frames, 24/1 fps, 1.750 s | 42 frames, 24/1 fps, 1.750 s |
| Boundary identity | Decoded frame 0 is red-source identity; frames 18–23 show transition; frame 24 and 41 are blue-source identity. Yellow overlay is confined to its authored span. | Frame 0 red-source; frame 17 red plus overlay; frame 18 red without overlay; frames 18–23 transition; frame 24 and 41 blue-source. `showinfo` timestamps advance exactly 1/24 s. |
| Audio streams/duration | One stereo AAC stream, 48 kHz, 1.750 s. FFT found 440 + 880 Hz at 0.6 s; B intentionally muted. | One mono AAC stream, 48 kHz, 1.750 s. FFT found 440 + 880 Hz at 0.6 s, 660 + 880 Hz at 1.2 s. Source and independent audio are mixed, not separately selectable streams. |
| Repeatability | Two independent renders had identical SHA-256: `22a8f2fe490842c002a71e9d22b508b685edaf99bb16ab4ff8a49f67d4a3a771`. | Two independent renders had identical SHA-256: `ff8e0b3b6eb8e96099be964e39578d0d8c596231ebab2d9d22dd0576da9fd728`. |
| Cancellation | SIGINT on a 60 s synthetic render exited code 1 (`render_cancelled_by_sigint`); no output remained. CLI observation only, not a programmatic job API test. | SIGINT on a paced 20 s synthetic render exited code 255 and left a 22,884-byte partial MP4. App wrapper must use temp output, terminate child, remove partial, and publish atomically. |
| Failure/unsupported notes | Generated project template includes external GSAP CDN; removed for offline fixture. Requires browser and FFmpeg/FFprobe. Footage layers and dissolve were custom HTML/CSS/JS, not a typed managed-asset timeline API. | Direct mixed-rate `xfade` first failed with `inputs needs to be a constant frame rate; current rate is 1/0`. Normalizing each input to 24 fps intermediate FFV1 fixed it. `drawtext` fixture failed because the binary lacks that filter; solid-color clips were used instead. Output audio is a single mix. |

Both matched duration, count, boundaries, dissolve location, overlay span, and deterministic output on this small Linux fixture. This does not establish VFR behavior, broader codec support, long-form performance, or Windows/macOS packaging.

## Commands and reproduction notes

Installs used `npm install --prefix /tmp/easel-video-renderer-probe-20261003/<candidate> --no-save` with the exact versions above. `ffmpeg-static`'s reviewed install script downloaded its binary to its temporary package directory.

Native render first normalized each clip:

```sh
ffmpeg -i clip-a-12fps.mp4 -vf 'fps=24,settb=1/24,setpts=N' -an -c:v ffv1 normalized-a.mkv
ffmpeg -i clip-b-24fps.mp4 -vf 'fps=24,settb=1/24,setpts=N' -an -c:v ffv1 normalized-b.mkv
# Then xfade=fade:duration=0.25:offset=0.75; overlay enable='gte(t,0.5)*lt(t,0.75)';
# delay/mix audio; map output streams; -r 24 -frames:v 42 -t 1.75.
```

HyperFrames used offline init (`HYPERFRAMES_SKIP_SKILLS=1`), then `hyperframes render <project> -o <output> --fps 24 --workers 1 --no-browser-gpu --quiet`. Composition had overlapping `<video>` nodes, timed `<img>`, independent `<audio>`, and a seekable dissolve function. `ffprobe`, full decode/showinfo, and decoded-audio FFT were used for inspection.

Exact composition filter and render invocation (all paths are within the temporary probe directory):

```sh
F=/tmp/easel-video-renderer-probe-20261003/ffmpeg-static/node_modules/ffmpeg-static/ffmpeg
D=/tmp/easel-video-renderer-probe-20261003
G="[0:v][1:v]xfade=transition=fade:duration=0.25:offset=0.75[xf];[4:v]fps=24,settb=1/24,format=rgba,colorchannelmixer=aa=0.5[ov];[xf][ov]overlay=enable='gte(t,0.5)*lt(t,0.75)':shortest=1[outv];[2:a]apad=pad_dur=0.75[a0];[3:a]adelay=750|750,apad=pad_dur=0.75[a1];[5:a]adelay=500|500,apad=pad_dur=0.75[a2];[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,atrim=duration=1.75[outa]"
"$F" -i "$D/normalized-a.mkv" -i "$D/normalized-b.mkv" \
  -i "$D/fixtures/clip-a-12fps.mp4" -i "$D/fixtures/clip-b-24fps.mp4" \
  -loop 1 -framerate 24 -t 1.75 -i "$D/fixtures/overlay-yellow.png" \
  -i "$D/fixtures/track-2-880hz.wav" -filter_complex "$G" \
  -map '[outv]' -map '[outa]' -r 24 -frames:v 42 -c:v libx264 \
  -preset ultrafast -crf 0 -c:a aac -b:a 192k -t 1.75 -map_metadata -1 \
  "$D/ffmpeg-render-1.mp4"

HOME="$D/home" HYPERFRAMES_TELEMETRY=0 HYPERFRAMES_SKIP_SKILLS=1 \
  /tmp/easel-video-renderer-probe-20261003/hyperframes/node_modules/.bin/hyperframes \
  render "$D/hf-video" -o "$D/hyperframes-output.mp4" --fps 24 --workers 1 \
  --no-browser-gpu --quiet
```

The same native command was run a second time with output name `ffmpeg-render-2.mp4`; HyperFrames likewise rendered a second output. Fixture generation used `-f lavfi -i color=c=red:s=96x64:r=12:d=1` and `color=c=blue:s=96x64:r=24:d=1`, each paired with `sine=frequency=440`/`660:sample_rate=48000:duration=1` and encoded H.264/AAC; overlay was a synthetic yellow `color` frame, and independent audio was `sine=frequency=880:sample_rate=48000:duration=1` encoded PCM WAV.

## Gate assessment

- Frame/audio correctness: passed synthetic cases for both, with native CFR normalization and single mixed audio output.
- Repeatability: byte-identical on two Linux renders each.
- Cancellation: observed for both; native FFmpeg leaves a partial output that application code must clean.
- Cross-platform packaging without system FFmpeg/Python: not passed. Native only ran Linux x64; HyperFrames requires external browser and FFmpeg/FFprobe; WASM was not run.
- License/package decision: not passed pending GPL review. HyperFrames Apache-2.0 does not resolve its runtime requirements or timeline-model mismatch.

**Conclusion:** no candidate passes the complete product gate. Renderer-neutral timeline/model work can proceed. Before Task 5, approve the GPL terms or select an explicitly licensed FFmpeg build, define per-OS/arch resource inclusion and update/signing implications, then run packaged Windows/macOS/Linux fixture smokes without system FFmpeg/Python. Also test VFR/codecs, cancellation cleanup, and audio policy. Never silently fall back to system FFmpeg.
