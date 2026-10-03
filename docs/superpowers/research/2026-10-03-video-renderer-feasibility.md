# Video Renderer Feasibility — 2026-10-03

## Decision

Do not select a renderer dependency for Task 5 yet. Keep the timeline/media interface renderer-neutral. `ffmpeg-static` is the only candidate tested here that met the earlier synthetic correctness case, but the tested build is GPL-3.0-or-later and carries a ~77 MiB Linux binary; Gio has clarified that Easel Client is intended to be GPL-3.0, so GPL compatibility is acceptable in principle. Before distribution, still verify the exact FFmpeg build's corresponding-source, notices, and bundled dependency-license obligations. Cross-platform packaged Electron behavior remains unvalidated. HyperFrames rendered the fixture but requires a browser and FFmpeg/FFprobe runtime and is not a drop-in managed-media timeline engine. Mediabunny's bounded follow-up passed one Linux/Electron synthetic composition but has codec, audio-topology, reproducibility, and cross-platform gaps described below. None passes the complete product gate.

Possible follow-up: retain a typed, app-owned timeline model and compare renderer substrates under a defined output/container and audio-track policy. Do not pass agent-authored HTML/JS or arbitrary FFmpeg arguments. A hybrid is a hypothesis, not a validated product recommendation.

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

The Round 1 figures above are extracted temporary `node_modules` directory sizes, not npm archive downloads. A separate Round 2 minimal Linux fixture-app build below now measures actual ZIP artifacts and unpacked fixture-app trees; those measurements are not an Easel production package, nor Windows/macOS installers. The earlier 87 MiB HyperFrames figure had no retained scope/method and is superseded; the reproducible directory measurements above explain why the prior 120 MiB allocated-size figure was larger than the 106.6 MiB apparent-byte count. They refer to one same dependency tree, not different runtime scopes.

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


## Fix-round 2 evidence: minimal Linux packaged-app size

Built two disposable Electron Linux x64 ZIP targets with `electron-builder@26.16.1` and Electron `44.4.5`: (1) a baseline shell with only a tiny local HTML window, and (2) the same shell bundling the previously tested `ffmpeg-static@5.3.0` Linux executable and its `ffmpeg.LICENSE` as `extraResources`. The candidate includes the exact tested FFmpeg `7.0.2-static` binary (SHA-256 `e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99`) and no separate `ffmpeg-static` npm wrapper dependency. App source, manifests, copied runtime, cache, logs and artifacts are all below `/tmp/easel-video-renderer-probe-20261003/packaging`. Electron distribution `44.4.5` was copied from the already-installed repo Electron into that temp tree and supplied via `electronDist`; build logs confirm the custom temp distribution was used. No product manifest/source/lockfile was changed.

| Linux x64 fixture build | ZIP distributable bytes (`stat -c %s`) | Unpacked tree apparent bytes (`du -sb`) | Unpacked tree allocated bytes (`du -sB1`) |
|---|---:|---:|---:|
| Baseline Electron shell | 119,309,509 | 296,304,699 | 296,476,672 |
| Shell + bundled FFmpeg runtime/license | 147,718,164 | 376,166,158 | 376,340,480 |
| Candidate delta | +28,408,655 | +79,861,459 | +79,863,808 |

The bundled binary itself is 79,826,272 bytes and its license file is 35,147 bytes (79,861,419 bytes total). The small difference from the unpacked delta is directory/app metadata. In the ZIP, FFmpeg compressed to 28,396,592 bytes and the license to 11,559 bytes. Both ZIP archives passed Python `zipfile.testzip()`; the candidate contained `resources/ffmpeg/ffmpeg` and `resources/ffmpeg/ffmpeg.LICENSE`. Running the unpacked candidate binary returned `ffmpeg version 7.0.2-static`; its SHA-256 matched the source binary. `ldd` reported `not a dynamic executable`, so the bundled FFmpeg runtime does not need a host FFmpeg or Python executable. This does not remove normal Linux Electron host-library/desktop requirements, and the Electron GUI itself was not launched in this probe.

Build versions and command: Node `v26.10.0`, npm `12.1.0`, Linux x64 (`7.2.7-arch1-1`), Electron `44.4.5`, electron-builder `26.16.1`. Baseline and candidate commands were the same apart from `--projectDir` and `APP` (`baseline` or `candidate`):

```sh
P=/tmp/easel-video-renderer-probe-20261003/packaging
export HOME="$P/home" TMPDIR="$P/cache/tmp" XDG_CACHE_HOME="$P/cache/xdg"
export electron_config_cache="$P/cache/electron" ELECTRON_CACHE="$P/cache/electron"
export ELECTRON_BUILDER_CACHE="$P/cache/electron-builder"
export npm_config_cache="$P/cache/npm" NPM_CONFIG_CACHE="$P/cache/npm"
node /home/venetanji/dev/easel-client-timeline-design-20261003/node_modules/electron-builder/cli.js \
  --projectDir "$P/apps/baseline" --linux zip --x64 --publish never
node /home/venetanji/dev/easel-client-timeline-design-20261003/node_modules/electron-builder/cli.js \
  --projectDir "$P/apps/candidate" --linux zip --x64 --publish never
stat -c '%n %s bytes' \
  "$P/artifacts/baseline/easel-renderer-fixture-baseline-1.0.0.zip" \
  "$P/artifacts/candidate/easel-renderer-fixture-candidate-1.0.0.zip"
du -sb "$P/artifacts/baseline/linux-unpacked" "$P/artifacts/candidate/linux-unpacked"
du -sB1 "$P/artifacts/baseline/linux-unpacked" "$P/artifacts/candidate/linux-unpacked"
```

The app manifests set `build.electronDist` to `/tmp/easel-video-renderer-probe-20261003/packaging/runtime/electron-dist`. The candidate additionally copies the existing tested runtime directory with electron-builder `extraResources` into `resources/ffmpeg`; its application `files` allowlist includes only the minimal `main.js`, `index.html` and `package.json`, so the extra-resource staging copy is not duplicated in `app.asar`. The output is a distributable Linux ZIP and the corresponding unpacked electron-builder tree, not an installed Easel application, signed production package, AppImage/deb, or Windows/macOS build. It does not represent Easel-specific files/dependencies and must not be used to forecast Easel's final package size without a product build.

Lifecycle-script boundary and cache history: an earlier temporary `npm install` attempt for the candidate printed `npm warn install-scripts 1 package had install scripts blocked because they are not covered by allowScripts: ffmpeg-static@5.3.0 (install: node install.js)`. I did not approve or invoke that blocked script. Per the follow-up authorization, the candidate uses only the pre-existing tested binary from `/tmp/easel-video-renderer-probe-20261003/ffmpeg-static`; this packaging run copied that binary and license to the temp app's extra-resources input. No install was rerun after the cache correction. The earlier install attempt had written the Electron 44.4.5 archive into the default user Electron cache because the electron-specific lowercase `electron_config_cache` variable was initially omitted. Per Gio's explicit direction, that archive remains untouched; no later operation accessed or modified it. Both fixture-app builds used the four cache variables shown above, all rooted under the packaging `/tmp` directory. The build downloaded its ZIP helper into the redirected Electron Builder cache.

This closes the package-size evidence gap only for the disposable Linux fixture. The earlier full selection decision remains unchanged: no renderer is selected for Easel Task 5, and production packaging, licensing, integration, Linux desktop dependencies, and Windows/macOS packaged behavior remain unvalidated.

## Mediabunny feasibility spike (2026-10-03)

This is a separately scoped follow-up; it does not revise the earlier candidate results or select a Task 5 renderer. Mediabunny's own library API is not a timeline editor/compositor: the successful composition below used a small, handwritten Canvas 2D timeline loop to choose decoded source canvases, blend clip pixels, draw a title, and mix source PCM. Mediabunny provided media demux/decode, WebCodecs encode, and output mux. The observed feature fit is therefore a possible low-level browser media substrate, not an app-owned timeline engine or built-in dissolve/title API.

### Authoritative package and licensing evidence

- npm registry metadata and tarball were checked on 2026-10-03 for `mediabunny@1.61.0` (registry `latest` at the time). Exact tarball: `https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz`; SHA-512 SRI `sha512-WciPOYwKZwgYkoBKcEK6JzzIf+w5whypPzFdOihOylZ/5Qv19FmNfRnTcaprH+jD136YpEASU30Eb6VNCJiz3A==`; registry reports 2,178,659 archive bytes and 10,841,167 unpacked bytes. Local `npm pack` archive was 2,178,659 bytes, SHA-256 `2105c960b161cbfcba037c91527e73b89d5208e92d6fb64a14000e7addbe1a8f`.
- Registry/package metadata declares Mediabunny `MPL-2.0`; the installed tarball's `LICENSE` is the full Mozilla Public License 2.0 (SHA-256 `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04`). Upstream README also says MPL-2.0, permits commercial and closed-source use, and describes file-level source disclosure for modifications to Mediabunny-covered source files. Preserve the license/copyright notices and distribute the exact license; modifications to covered files carry MPL source obligations. This is license evidence, not legal advice.
- Exact direct package dependency metadata: `@types/dom-webcodecs@0.1.13` (MIT, Microsoft copyright) and `@types/dom-mediacapture-transform@0.1.12` (MIT, Microsoft copyright; it depends on `@types/dom-webcodecs`). Both installed packages contain MIT `LICENSE` files. The Mediabunny published package declares them in `dependencies`; its README describes the library as zero runtime dependencies, and the tested self-contained browser bundle imported without loading either type package. A normal npm install still includes both and their notices should be inventoried if distributing the full installed package. The fixture ZIP shipped the Mediabunny MPL license alongside its single bundled `.mjs` file.
- Upstream sources: `https://github.com/Vanilagy/mediabunny` (README and `LICENSE`); `https://mediabunny.dev/guide/introduction`; registry `https://registry.npmjs.org/mediabunny`. Installed package API declarations (`dist/mediabunny.d.ts`) corroborate `Input`, `CanvasSink`, `AudioBufferSink`, `CanvasSource`, `AudioBufferSource`, `Output`, and `Output.cancel()`. Its `Conversion` trim options operate on one input conversion; no typed multi-clip timeline/dissolve/overlay composition API was used or found in this tested surface.

### Runtime and package footprint

- Node `v26.10.0`, npm `12.1.0`, Linux x64 / kernel `7.2.7-arch1-1`; Electron package/runtime `44.4.5`, Chromium `152.0.7977.130` (user-agent reported by both development and packaged renderer). Existing `electron-builder@26.16.1`; system FFmpeg `n9.0.2` was used only to generate synthetic source fixtures and inspect the output. All installs, app harnesses, caches, logs and media are under `/tmp/easel-mediabunny-probe-20261003`; `HOME`, `TMPDIR`, `XDG_CACHE_HOME`, `electron_config_cache`, `ELECTRON_CACHE`, `ELECTRON_BUILDER_CACHE`, and npm cache were redirected there for package builds. No lifecycle scripts were bypassed; the package install ran normally, and the disposable electron-builder apps had no native/npm dependencies.
- Temporary install: 3 packages (`mediabunny` plus the two declared type packages), 10,873,414 apparent bytes / 11,571,200 allocated bytes for `node_modules`. The published package alone is reported above. The browser bundle actually included in the fixture app is `dist/bundles/mediabunny.mjs` (1,488,895 bytes); installed Mediabunny `LICENSE` is 16,726 bytes.
- Built baseline and Mediabunny candidate Linux x64 fixture ZIPs with Electron `44.4.5` and `electron-builder@26.16.1`, using a temporary copy of the already-installed Electron distribution and no product manifest/lockfile changes. Baseline ZIP: 119,309,455 bytes; candidate ZIP: 119,579,223 bytes; delta +269,768 bytes. Unpacked apparent trees: 296,304,552 and 297,811,233 bytes; delta +1,506,681 bytes (allocated: 296,476,672 and 297,988,096; delta +1,511,424 bytes). Candidate contains one Mediabunny bundle inside `resources/app.asar` and `resources/mediabunny/LICENSE`. Both ZIPs passed Python `zipfile.testzip()`. This intentionally minimal, disposable Linux fixture is not an Easel production build or Windows/macOS evidence.
- Launched the unpacked candidate fixture under Xvfb. The packaged page successfully imported `mediabunny.mjs`; `VideoEncoder`, `AudioEncoder`, and `VideoFrame` were functions. Browser capability checks returned VP8 encode `true`, Opus encode `true`, AAC encode `false`. This package-level run used the package's actual app.asar and exact Electron distribution, but it remains Linux-only.

### Matched synthetic edit

- FFmpeg generated two one-second 96x64 H.264/AAC clips locally: A red at 12 fps with 440 Hz mono audio (SHA-256 `242e3bbae831f5ba2e4632da5d34c3f1734754563df92ba6cf019c048d54bb88`), B blue at 24 fps with 660 Hz mono audio (SHA-256 `4d10144fe399a97dc4b123a0b87906054be66ea49ef2a6d338187fa77ae6d984`). `ffprobe` verified their source frame rates, one-second duration, and AAC/48 kHz audio streams. No external/user media was involved.
- Matched timeline case: reorder B before A; trim each source to `[0.25, 0.75)`; place B on `[0, 0.5)` and A on `[0.25, 0.75)`; dissolve across `[0.25, 0.5)`; draw a translucent yellow `TITLE: MIX` bar on that same selected span. Each retained source audio was decoded, trimmed to the same source bounds, aligned to its clip, mixed at 50% gain per source into one two-channel 48 kHz buffer, and encoded into the output. This is retained/mixed source audio, not an independent third audio track or separate stems.
- Run inside an Electron `BrowserWindow` renderer with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; the probe used real Chromium `VideoEncoder`/`AudioEncoder`/`VideoFrame`, `CanvasSink`, `AudioBufferSink`, `CanvasSource`, `AudioBufferSource`, `WebMOutputFormat`, and `BufferTarget`. Two fresh Electron processes rendered the case. Both output hashes were identical: `c90a88a77710bf7535f3ac55a4f75859582680c22cba26a23e40119902cf1762` (13,510 bytes).
- The output was 18 decoded frames at 24/1 fps, with decoded video timestamps 0 through 0.708 s (18 × 1/24 s). `ffprobe` reports WebM container duration 0.760 s; decoded Opus audio had 36,168 samples / 48 kHz = 0.7535 s, a small container/codec packet-duration extension past the intended 0.750 s timeline. Output has one VP8 video stream and one stereo 48 kHz Opus audio stream. Full FFmpeg decode completed successfully.
- Decoded frame color samples (RGB) were frame 0 `(1,15,249)` and frame 5 `(1,15,249)` (B-only); frame 6 `(1,15,249)` at dissolve start; frame 9 `(128,20,124)` at dissolve midpoint; frame 11 `(212,23,41)` near the dissolve end; frame 12 `(253,25,1)` and frame 17 `(253,25,1)` (A-only). At title-region pixel `(3,3)`, frame 5 was blue `(1,15,249)` with no title while frame 6 under the selected title was `(165,147,90)`; frame 11 was `(238,151,16)`. This verifies this authored overlay/dissolve span, not a library-native transition.
- Decoded output audio spectral checks found ~662 Hz in B-only span at 0.10 s, ~662 and ~438 Hz in the overlap at 0.38 s, and ~437 Hz in A-only span at 0.62 s. Mediabunny's decoded output audio samples had RMS 0.0442, 0.0622, and 0.0442 for B-only, overlap, and A-only windows respectively. This supports the intended source audio trim/alignment/mix for these synthetic tones; it does not test long-form drift, gain automation, separate tracks, or many-channel layouts.

### Errors, cancellation and limitations

- MP4+AAC output was attempted first. Although the packaged browser could encode AVC, `canEncodeAudio('aac', { sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 })` returned `false`, and `AudioBufferSource.add()` rejected with `This specific encoder configuration (mp4a.40.2, 96000 bps, 2 channels, 48000 Hz) is not supported in this environment.` The matched successful render therefore used WebM/VP8/Opus. This shows codec availability depends on Electron/OS/browser configuration; do not promise MP4/AAC output in this Electron build on Linux based on Mediabunny's generic codec list. Inputs with AAC decoded successfully here.
- Programmatic cancellation was exercised on a second in-progress `Output`: after start and one encoded frame, `Output.cancel()` resolved, target buffer remained 0 bytes, and a subsequent sample-add attempt was rejected. This is stronger cleanup behavior than the prior FFmpeg CLI SIGINT case for this API path, but does not assess cancelling an entire app job with concurrent decoders, memory pressure, worker shutdown, or user-driven UI cancellation.
- Repeatability covers two renders of the same fixture/settings on this one Linux/Electron build. VFR, large/long media, scaling/rotation, broad codecs, performance/RSS, OS-specific hardware acceleration, Windows/macOS packaging, and product UI integration were not tested. The manually implemented canvas compositor is a feasibility harness, not production code.

### Commands and artifacts

The renderer harness files and generated inputs/outputs are retained under `/tmp/easel-mediabunny-probe-20261003`. The retained `app/index.html` and `app/main.cjs` correspond to the successful WebM/VP8/Opus path and its `bytesArray` result handling; `logs/electron-2.log` records the earlier AAC failure, while `logs/electron-7.log` and `logs/electron-8.log` accompany the two successful output/result pairs. However, the exact shell invocation for those successful renderer runs was not captured alongside the artifacts. The retained harness and outputs support the reported observations, but this is not yet a fully reproducible one-command render recipe. Install and package checks included:

```sh
npm install --prefix /tmp/easel-mediabunny-probe-20261003 --no-save --no-audit --no-fund mediabunny@1.61.0
npm pack mediabunny@1.61.0 --pack-destination /tmp/easel-mediabunny-probe-20261003/out --json
npm view mediabunny@1.61.0 version license dist.tarball dist.integrity dist.unpackedSize dependencies --json
# fixture build, run from repo-installed electron-builder with caches exported to temp:
node /home/venetanji/dev/easel-client-timeline-design-20261003/node_modules/electron-builder/cli.js \
  --projectDir /tmp/easel-mediabunny-probe-20261003/packaging/apps/baseline --linux zip --x64 --publish never
node /home/venetanji/dev/easel-client-timeline-design-20261003/node_modules/electron-builder/cli.js \
  --projectDir /tmp/easel-mediabunny-probe-20261003/packaging/apps/candidate --linux zip --x64 --publish never
```

The Electron renderer harness, source/output probing, frame samples, audio FFT checks, package logs, ZIPs and JSON evidence are under the same `/tmp` root. No product source, package manifest, lockfile, dependency tree, Electron cache under `/home/venetanji/.cache/electron`, or unrelated worktree content was changed.

**Mediabunny conclusion:** partial evidence for a bounded Linux/Electron low-level composition spike: the custom app code exercised trim/reorder/blend/title and mixed the two clips' source audio into deterministic 18-frame WebM output, with working cancellation in this fixture. This does not satisfy Task 1's explicit two-track audio example: the output contains one mixed audio stream, not independently selectable audio tracks/stems. Mediabunny is not a validated drop-in timeline renderer. The Linux packaged build has WebCodecs, but its missing AAC encoder constrains the tested output to WebM/Opus unless a separately approved/validated codec strategy is chosen. Keep the timeline renderer-neutral and do not select Mediabunny for Task 5 until codec/container and multi-track audio policy, Windows/macOS packaging/runtime, broader correctness, fully traceable render invocation, cancellation lifecycle and production app integration gates are explicitly tested.
