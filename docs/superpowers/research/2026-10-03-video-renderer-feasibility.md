# Video Renderer Feasibility — 2026-10-03

## Decision

Do not select a renderer dependency for Task 5 yet. Keep the timeline/media interface renderer-neutral. `ffmpeg-static` is the only candidate tested here that met synthetic correctness checks, but the tested build is GPL-3.0-or-later and carries a ~77 MiB Linux binary; cross-platform packaged Electron builds and the product's distribution posture remain unvalidated. HyperFrames rendered the same fixture, but requires a browser and FFmpeg/FFprobe runtime and is not a drop-in managed-media timeline engine. The WASM packages were inspected, not rendered.

Possible follow-up: retain a typed, app-owned timeline model and, after licensing review, evaluate FFmpeg for source-media composition with HyperFrames limited to trusted/template-based HTML overlays. Do not pass agent-authored HTML/JS or arbitrary FFmpeg arguments. A hybrid is a hypothesis, not a validated product recommendation.

## Probe scope and environment

- Branch `docs/agent-video-timeline-design-20261003`, base commit `f66c315b1b606ce3fc672a5630739867546c1805`.
- Node `v26.10.0`, npm `12.1.0`, Linux x64; system Chromium `/usr/bin/chromium`; system FFmpeg/FFprobe `n9.0.2`.
- All media, installs, and outputs were synthetic and under `/tmp/easel-video-renderer-probe-20261003`. No product manifest/dependency changes, user media, generation API, model download, or GPU job.
- I read the original Task 1 brief at `.superpowers/sdd/2026-10-03-agent-video-timeline/task-1-brief.md`, the Task 1 plan, and the renderer gate in the design spec. The earlier report's statement that the brief was absent was incorrect; this fix-round report corrects that process record.

## Candidates and evidence

| Candidate | Exact version | License evidence | Runtime/platform evidence | Footprint observed |
|---|---|---|---|---|
| HyperFrames CLI | `hyperframes@0.8.114` | npm package declares Apache-2.0; upstream repository `LICENSE` is Apache-2.0. | Package README requires Node >=22 and FFmpeg. `doctor` found FFmpeg, FFprobe, Chrome; tested Linux x64 with HeadlessChrome 152. The npm package is not a self-contained browser/media stack. Cross-platform packaging was not tested. | Linux temp install `node_modules`: 111,841,190 apparent bytes (106.6 MiB); 125,108,224 allocated bytes (119.3 MiB). HyperFrames package subtree: 33,425,375 apparent / 34,676,736 allocated bytes. Browser and FFmpeg/FFprobe excluded. |
| `ffmpeg-static` native CLI | `ffmpeg-static@5.3.0`; downloaded Linux x64 binary reports FFmpeg `7.0.2-static` | npm package declares GPL-3.0-or-later; downloaded `ffmpeg.LICENSE` included and `ffmpeg -version` shows `--enable-gpl`. README notes each binary's license applies. Distribution needs explicit legal review. | README claims macOS x64/arm64, Linux x86/x64/armhf/arm64, Windows x86/x64. It describes FFmpeg 6.1.1, but this package install returned a binary reporting 7.0.2-static. Installer downloads a platform-specific binary; README warns to purge `node_modules` when packaging for another OS. Only Linux x64 executed. | Linux temp install `node_modules`: 80,978,274 apparent / 81,584,128 allocated bytes. `ffmpeg-static` package subtree including executable: 79,911,849 apparent / 79,933,440 allocated bytes; executable 79,826,272 bytes. |
| `@ffmpeg/ffmpeg` + `@ffmpeg/core` (considered) | `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/core@0.12.10` | npm metadata: wrapper MIT; core GPL-2.0-or-later. Review core FFmpeg build/configuration and distribution obligations. | Browser worker/WASM approach, not a native main-process CLI. Wrapper's Node export is a stub. Pair not executed in Electron renderer; no cross-platform claim validated. | Linux temp install `node_modules`: 64,767,285 apparent / 64,856,064 allocated bytes; core subtree 64,689,644 apparent / 64,704,512 allocated bytes. |

These are extracted temporary `node_modules` directory sizes, not npm archive downloads and not an Easel packaged-app measurement. No isolated app package was built: doing so would require product/build manifest changes outside this no-product-dependency task. No archive byte size or app/installer delta is claimed. The earlier 87 MiB HyperFrames figure had no retained scope/method and is superseded; the reproducible directory measurements above explain why the prior 120 MiB allocated-size figure was larger than the 106.6 MiB apparent-byte count. They refer to one same dependency tree, not different runtime scopes.

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

Both matched duration, count, boundaries, dissolve location, overlay span, and deterministic output on this small Linux fixture. A second explicit trim/reorder case and scoped repeat-render timings are recorded below in the fix-round evidence. This does not establish VFR behavior, broader codec support, long-form performance, or Windows/macOS packaging.

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


## Fix-round evidence: trimmed/reordered edit and render timings

A second, explicitly matched case used the same synthetic red 12 fps A, blue 24 fps B, and yellow still. Both candidates output B before A, trimming each clip to source interval `[0.25, 0.75)`: B occupies timeline `[0, 0.5)`, A `[0.25, 0.75)`. A 0.25 s cross-dissolve spans `[0.25, 0.5)` and the 50%-opacity yellow overlay spans `[0.25, 0.5)`. Output is 24 fps, 18 frames, 0.75 s. Audio policy is matched: retain both trimmed clips' original audio, time-align B at 0 and A at 0.25 s, and mix them into one output stream. This case intentionally has no independent audio track; it does not verify three-way mixing, separate stem preservation, gain automation, or track editability.

| Check | HyperFrames | `ffmpeg-static` |
|---|---|---|
| Trim/order and output | 18 frames, 24/1 fps, 0.750 s; blue B at frames 0-5, transition frames 6-11, red A at frames 12-17. | Same frame count/rate/duration and source-color spans; same transition frames. |
| Overlay | Yellow overlay visible only in its authored interval (measured transition-frame RGB shifts, e.g. frame 11 mean RGB `(229,125,19)`). | Same authored interval (frame 11 mean RGB `(232,126,18)`; small codec/blend-path difference). |
| Audio | One AAC stream, 0.750 s. Decoded FFT peaks near 662 Hz at 0.10 s (B), both ~438 and ~662 Hz at 0.40 s (overlap), and ~438 Hz at 0.60 s (A). | One AAC stream, 0.750 s; same source-tone presence at the corresponding positions. |
| Repeat render | SHA-256 identical across the two renders: `4ebe0bbab454d385fe991c1bf3fe68dadba17d96e3a72059df53ea6b703c4129`. | SHA-256 identical across the two renders: `c8d3d3b395caaed3fdbbc7f087147acf9121e55a4d68697d77228a8328e46bfd`. |
| Wall time | 2.875 s and 2.783 s; median 2.829 s. | 0.074 s and 0.072 s; median 0.073 s. |

Timing method: immediately before/after each full CLI render, capture `date +%s%N` and calculate elapsed wall-clock milliseconds; no CPU/RSS profile. Same Linux x64 host, 18-frame case, 24 fps, output settings above; each run launched a fresh renderer process. These were sequential warm-host/filesystem-cache runs, not a cold-machine benchmark. HyperFrames wall time includes its headless Chromium launch and screenshot/render path; native timing includes FFmpeg process startup and encode. These are operational round-trip numbers for this fixture, not a controlled codec/backend throughput comparison or production performance claim.

Trim/reorder probe invocations (all fixture/output files remain below `/tmp/easel-video-renderer-probe-20261003/trim-reorder`):

```sh
# HyperFrames; index.html encodes B first, A second, each data-media-start=0.25.
HYPERFRAMES_TELEMETRY=0 HYPERFRAMES_SKIP_SKILLS=1 \
  /tmp/easel-video-renderer-probe-20261003/hyperframes/node_modules/.bin/hyperframes \
  render /tmp/easel-video-renderer-probe-20261003/trim-reorder/hf \
  -o /tmp/easel-video-renderer-probe-20261003/trim-reorder/out/hf-1.mp4 \
  --fps 24 --workers 1 --no-browser-gpu --quiet
# Repeat with output hf-2.mp4.

# ffmpeg-static; B input 0 and A input 1; filter graph trims each source to
# 0.25..0.75, xfade duration=0.25/offset=0.25, overlays at 0.25..0.5,
# trims source audio identically and mixes B at 0 s with A delayed 250 ms.
/tmp/easel-video-renderer-probe-20261003/ffmpeg-static/node_modules/ffmpeg-static/ffmpeg \
  -i /tmp/easel-video-renderer-probe-20261003/fixtures/clip-b-24fps.mp4 \
  -i /tmp/easel-video-renderer-probe-20261003/fixtures/clip-a-12fps.mp4 \
  -loop 1 -framerate 24 -t 0.75 -i /tmp/easel-video-renderer-probe-20261003/fixtures/overlay-yellow.png \
  -filter_complex '[0:v]trim=start=0.25:duration=0.5,setpts=PTS-STARTPTS,fps=24,settb=1/24,format=yuv420p[bv];[1:v]trim=start=0.25:duration=0.5,setpts=PTS-STARTPTS,fps=24,settb=1/24,format=yuv420p[av];[bv][av]xfade=transition=fade:duration=0.25:offset=0.25[x];[2:v]fps=24,settb=1/24,format=rgba,colorchannelmixer=aa=0.5[ov];[x][ov]overlay=enable='gte(t,0.25)*lt(t,0.5)':shortest=1[outv];[0:a]atrim=start=0.25:duration=0.5,asetpts=PTS-STARTPTS,adelay=0|0[b];[1:a]atrim=start=0.25:duration=0.5,asetpts=PTS-STARTPTS,adelay=250|250[a];[b][a]amix=inputs=2:duration=longest:normalize=0,atrim=duration=0.75[outa]' \
  -map '[outv]' -map '[outa]' -r 24 -frames:v 18 -c:v libx264 \
  -preset ultrafast -crf 0 -c:a aac -b:a 192k -t 0.75 -map_metadata -1 \
  -y /tmp/easel-video-renderer-probe-20261003/trim-reorder/out/ffmpeg-1.mp4
# Repeat with output ffmpeg-2.mp4.
```

Footprint measurement command and scope:

```sh
for x in /tmp/easel-video-renderer-probe-20261003/hyperframes/node_modules \
  /tmp/easel-video-renderer-probe-20261003/ffmpeg-static/node_modules \
  /tmp/easel-video-renderer-probe-20261003/ffmpeg-wasm/node_modules; do
  du -sb "$x"; du -sB1 "$x";
done
stat -c '%n %s bytes' /tmp/easel-video-renderer-probe-20261003/ffmpeg-static/node_modules/ffmpeg-static/ffmpeg
```

Package versions remain HyperFrames `0.8.114` and `ffmpeg-static` `5.3.0`; runtime versions observed in this probe were Node `v26.10.0`, npm `12.1.0`, Chromium `153.0.8010.52` (HyperFrames log identified HeadlessChrome `152.0.7977.30`), and bundled FFmpeg `7.0.2-static`. Only Linux x64 was available. Windows and macOS packaged behavior remain explicitly unverified; upstream platform support declarations are not execution evidence.

Mediabunny was identified as a promising potential pure-TypeScript/WebCodecs candidate (`mediabunny`, reportedly MPL-2.0), but was not installed or tested in this fix round. Its trim, reorder, overlays, audio mux semantics, codec availability in the target Electron Chromium, footprint, and license details must be independently verified before consideration; it does not alter this report's conclusion.
