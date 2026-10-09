# Strudel kit compatibility and evidence

## Status

The locally bundled kit, editable REPL and bounded WAV/Media export have the
dated runtime evidence below. The 9 October 2026 browser checks additionally
verify live code changes, local worklets, bundled drums and attached sample
playback/export. PR #19's native CI probe verifies the actual template and
production WAV save path; its desktop packages build on Windows, macOS and Linux.
`getStrudelCapabilities()` reports `repl: true`, `localSamples: true` and
`audioExport: true`. Live effects have broader support than the bounded exporter.

Pinned package: `@strudel/web@1.3.0`. Easel builds its published `web.mjs` source
entry using esbuild and the repository lockfile, rather than copying the upstream
all-in-one IIFE with an unknown build dependency graph. The original exported API
is retained. The adapter uses worklet-disabled first-gesture initialization for
ordinary Strudel canvases; only the explicitly marked scratchpad enables local
worklets. Vendor licenses remain intact.

## Supported Subset

Source inspection supports `initStrudel({sync:false})`, the Strudel scratchpad's
`repl.evaluate(source, false)`, `note`, `stack`, `hush`, `getAudioContext`,
`setAudioContext`, `setSuperdoughAudioController`, `registerSynthSounds`, and
`superdough`. Native synth names are `sine`, `triangle`, `square`, and `sawtooth`
(upstream also aliases `saw`). Synths, bundled drums and registered attached
samples run without a network connection.

- Start silent; use a real Run button or Ctrl+Enter gesture.
- The kit adapter calls `initAudioOnFirstClick` once, without awaiting it.
  Ordinary canvases disable worklets; the explicitly marked REPL enables local
  bundled worklets without allowing remote modules.
- Upstream first-click initialization only observes `mousedown`. Keyboard Play
  must explicitly resume `getAudioContext()` and call
  `initAudio({disableWorklets:false})` for the REPL; the native-only probe uses
  `disableWorklets:true`.
  The pinned upstream `initAudio` resume conditional is ineffective; do not rely
  on it to resume the context.
- `hush` stops scheduling, but does not promise instant silence of existing tails.
  The probe also mutes the managed output gain, then verifies silence and restart.
- The pinned kit includes seven original local drums (`bd`, `sd`, `hh`, `oh`,
  `cp`, `tom`, `rim`). `EaselStrudelSamples.add(name, assetId)` registers attached
  short WAV/MP3 samples, including Suno output, without restarting live audio.
  Registration arguments use single quotes because the Strudel transpiler turns
  double-quoted literals into Patterns. Remote `samples('github:...')` remains
  blocked by CSP. Live Strudel code can
  use broader controls/effects than the WAV exporter; export rejects unsupported
  event data. Sync SharedWorker scheduling, microphone and audiovisual capture
  remain unsupported.
- The isolated offline probe uses a fresh renderer, a stereo 48 kHz
  OfflineAudioContext, `setAudioContext`, a reset controller, native synth
  registration and bounded `superdough` calls. It never calls the upstream
  `renderPatternAudio` downloader or changes the live renderer's context.

## Reproducible runtime gate

Build with `npm run build:canvas-kits`. Run
`xvfb-run -a node scripts/probe-strudel-runtime.cjs` on the existing Linux CI
runner, or `node scripts/probe-strudel-runtime.cjs` in a supported desktop session.
The existing test workflow now runs this gate after its build and retains logs.

The probe uses only synthetic patterns in disposable sandboxed BrowserWindows.
It denies permissions and all resource requests other than each local fixture,
uses the actual canvas CSP, and explicitly disables GPU acceleration. No remote
debugging/CDP, live app, user data, external sample, filesystem bridge, or Node
access is used in a renderer. Each run is limited by a 30-second application
watchdog and a 35-second parent timeout. There are no sandbox-disabling flags.

Assertions cover pre-Play silence, native window/webContents/document focus,
trusted keyboard Play, nonzero analyzed native synth output, immediate muted Stop,
restart after all prior fixture voices have ended, four nonempty stereo offline synth segments,
and zero network/CSP errors. Nonzero samples establish a signal, not a human
listening test. The original native-kit fixture now has passing CI evidence below. The extended
starter fixture also has passing CI evidence below. Before restart it keeps output muted for at least three audio-context
seconds after Stop: this exceeds the pinned 0.5-CPS fixture's two-second note,
scheduler lookahead/latency and release tail. Restart requires ten consecutive
nonzero analyser samples after a cleared history. A mutation regression verifies
that a second Play which schedules no note cannot pass.

Local evidence on 5 October 2026:

1. Initial headless fixture timed out; its Electron entry guard may have skipped
   startup. The log also contained X display/EGL initialization failures.
2. The corrected entry guard and explicit GPU-disable flags reached
   `electron-main-entered` and `app-ready`, then Electron exited with SIGSEGV
   before the playback page loaded. D-Bus/NETLINK/udev access failures were logged.
   No Strudel, worklet or CSP result was obtained. This is not evidence that
   Strudel is incompatible with Easel's policy.

No further local launch or policy relaxation was used. These historical attempts
were superseded by the following disposable CI proof; they are retained to
distinguish the environment failure from native audio behavior.

## Native-kit CI proof — 5 October 2026

[Test run 37294031399](https://github.com/venetanji/easel-client/actions/runs/37294031399)
passed on published PR 13 head `3ecef6a`. Desktop Builds run `37294031390`
also finished green on that head. The retained probe evidence establishes:

- Trusted native keyboard Play from initial silence, with a nonzero live signal.
- Stop silence and a real scheduler restart after at least three audio-context
  seconds, beyond the preceding fixture voice's bounded lifetime.
- Nonzero stereo 48 kHz offline output for sine, triangle, square and sawtooth.
- No unexpected resource requests or CSP violations, with the unchanged canvas
  CSP, sandbox, permission denial and GPU-disabled disposable fixture.

This proves the constrained native kit. It does **not** prove the new editable
starter's controls, state restoration, graph reset, or a WAV file/Media save.
At that earlier native-kit milestone, export remained gated. The starter and
production WAV gates were subsequently satisfied by the evidence below. No human listening check is
claimed by measured nonzero sample evidence.

## Editable starter CI proof — 5 October 2026

[Test run 37299938626](https://github.com/venetanji/easel-client/actions/runs/37299938626)
passed at `2657bd4`. Its retained evidence verifies initial silence, one live
context, trusted keyboard Play, immediate controls, old-voice graph isolation on
restart, Escape while the canvas question is open, source-edit reload without
autoplay, independent settings and clean scheduler/context disposal. The strict
startup invariant also verifies the suspended AudioParam's current gain is zero.
No network requests or CSP relaxation were needed. The coordinator supplied and
verified this evidence; Task 6 does not claim another local Electron run.

## Bounded WAV export contract and production proof

The save-only production path passed the extended single runtime fixture for
published `b3cb58a` (exact `2e5db98` snapshot). Export is enabled in Easel; controls
still wait for their loaded source context. Standalone exported HTML requires
Easel for Media saves.

At click, the starter freezes the loaded source revision, BPM, volume, pattern
version and selected onset events before any await. One cycle is four beats. It
queries only 1–16 cycles, bounds total audio including a fixed 0.5-second tail to
30 seconds, allows 4,096 onset events and at most 32 simultaneous native voices,
and rounds total sample frames up exactly once at 48 kHz. Voice budgeting includes
the pinned native synth's effective release (minimum 0.01 seconds) plus its
0.01-second node-stop allowance. The kick instead uses its decay plus the same
stop allowance, independently of the pattern duration; the output is explicitly
cropped at the fixed tail. Stereo PCM16 WAV remains below 6 MiB.

Authored event values support `note`, `s`, `gain`, `attack`, `decay`, `sustain`,
`release`, and sample index `n: 0` for registered single-sample names:

- Sine/sin, triangle/tri, square/sqr, sawtooth/saw
- Native `sbd` kick and `white`, `pink`, `brown` noise; no sample packs are needed
- Bundled drums and registered attached WAV/MP3 samples, without sample pitch,
  speed or slicing. Up to 16 names and 8 MiB of attached sample bytes per export;
  each sample is mono/stereo, at most 10 seconds and 4 MiB. Content hashes and
  fixed-rate decoded durations identify the captured samples. Sample voice
  budgeting includes their full duration, with output cropped at the fixed tail.
- Finite MIDI notes 24–96 or the pinned native note spelling/default-octave rules
- Omitted notes use the native default 29 for kick or 36 for other supported synths
- Gain 0–1 (omission uses the pinned native 0.8 default), sustain 0–1 and attack/decay/release 0–0.5 seconds; explicitly supplied null/undefined/non-finite controls reject
- Rests and volume-zero loops are valid; volume multiplies event gain once

Unregistered samples, effects, callbacks/stateful values, continuous events, additional
control fields, `duration` and `clip` overrides are rejected with visible errors.
Actual Hap callback context, including dominant/non-dominant `onTrigger`, rejects;
plain source-location metadata remains harmless. The native bounded query uses
`Pattern.query(new State(new TimeSpan(0, cycles)))` because `queryArc` swallows
underlying query errors into the same empty array as an intentional rest.
Authored query errors therefore fail export, while actual rests remain legal.

The strict plain event's `envelopeMode` discriminates `native-default` from
`explicit`. All-omitted native ADSR uses its pinned decay 0.05/sustain 0.6; numeric
metadata 0.001/0.01 is not materialized as native controls in that branch.
Explicit attack-only, release-only or explicitly-default-valued envelopes retain
the native explicit decay/sustain behavior. Authored decay/sustain use a validated,
frozen `envelopeControls` record that retains only supplied ADSR fields, preserving
the native sustain inference for decay-only sounds. Older oscillator snapshots
retain their existing representation. In the isolated realm only, `setMaxPolyphony(eventCount)` prevents the
native total-scheduled source map from stealing voices before offline time starts;
the separate host 32-overlap/4,096-event caps still apply.

These authored patterns can require a different future exporter; unsupported
semantics are never silently stripped or synthesized using a replacement engine.

The host binds reachable authored source to ordered project-pinned kit
descriptors, verifies the exact cached Strudel bytes, and checks source/runtime
identity before rendering and saving. Native same-URL top-level replacement invalidates loaded-source identity immediately; only host source reload restores it. Same-document fragment navigation is preserved. Source edits, failed/pending reload, hide,
switch, renderer loss and cleanup immediately invalidate the export token. The
disposable no-preload sandbox uses the existing canvas CSP, denies permissions,
navigation and every request except its host-owned document, and is destroyed on
cancel or a 30-second wall-clock watchdog. OfflineAudioContext has no close API;
no upstream download helper or live Strudel globals are used.

RIFF chunks, PCM format, exact frame/data length, rate, channels, bit depth,
duration and byte budgets are validated before `CAPTURE_MEDIA.save`. Provenance
and WAV bytes commit at the same existing Media directory rename. Host-only
receipt lookup is independent of the public 200-item list: restart/eviction
retries recover the original asset, while changed content, ambiguous receipts or
corrupt bytes reject. Cancellation before save creates no asset. Once save is
admitted, its completion is awaited; a successful asset survives cancellation,
attachment or notification failure, with a Media recovery receipt. Attachment
checks the captured project/runtime at its actual post-await commit boundary.
Nothing is sent to chat automatically, and no microphone permission is requested.

The single CI fixture now additionally drives the actual editable export action,
production bridge/controller/renderer, exact pinned kit and real Media storage.
It decodes saved/reopened WAV bytes (not a native save-dialog/download), checks rest/onset/tail timing and exact
frames, tests zero and half-volume scaling, identical retry idempotency, and
sustained live audio/context identity. It additionally measures omitted/native-default versus explicit envelope/gain branches, checks the late nonzero segment of a >128-event score with one long early note, and observes the actual Electron same-URL top-level navigation event. The production extension passed its sandboxed CI execution described below;
local unit/build success alone is not runtime proof.


## Production WAV/Media CI proof — 5 October 2026

[Test run 37306231481](https://github.com/venetanji/easel-client/actions/runs/37306231481)
passed at published `b3cb58a`, the immutable publication of source snapshot
`2e5db981fc63429a16b9b4f2d443f2beef25acac`. Retained artifact
`strudel-runtime-evidence` (`11342839982`) reports `status: passed`.

- The actual starter export action drives the production bridge/controller,
  isolated renderer, pinned kit and durable Media store. Saved/reopened WAV bytes
  decode as 48 kHz stereo with exact onset/rest/tail timing and frame duration.
- Half-volume/full-volume amplitude ratio is `0.5001695438203305`; zero volume
  produces silence. Native omitted/default versus explicit gain/envelope
  branches are preserved, with sustain ratio `0.6000579661049783`.
- A 201-event, 8.5-second score retains the late note with stereo peak
  `0.08999908715486526`, covering the native scheduler's bounded lookahead.
- Identical export retries return the original durable asset. Reopened bytes
  match; export preserves live context identity and ten sustained live samples.
- The fixture observes actual Electron same-URL top-level navigation, verifies
  silent source reload and Escape while a question has focus, and reports no
  network requests or CSP changes. Electron `44.4.5`, Chromium `152.0.7977.130`.

This is measured signal and production-path evidence; no human listening check
or native file-download dialog is claimed. The verified constrained export
subset, time/voice/size bounds and save-only permission boundaries above remain
unchanged. Capability flags and catalog output were activated after this proof;
no export/probe behavior or security policy was changed for activation.

## REPL and Percussion Evidence - 9 October 2026

[PR #19 test run 37902079493](https://github.com/venetanji/easel-client/actions/runs/37902079493)
passed at `377361949ab955452d20c57fbae126b19dee8825`, using Electron 44.4.5 /
Chromium 152.0.7977.130. Its retained `strudel-runtime-evidence` reports
`status: passed` for the native kit, current editable template and production
WAV/Media bridge. It verifies native kick and noise exports, saved/reopened bytes,
idempotent retries, live context identity and zero network requests.
[Desktop Builds run 37902079479](https://github.com/venetanji/easel-client/actions/runs/37902079479)
passed Windows, macOS and Linux packaging, including the Windows storage checks.

`EASEL_RUN_BROWSER_TESTS=1 npm test` at that head passed 1,141 tests with one
skip. The headless Chromium Strudel tests exercise Ctrl+Enter selection, live
score changes on the same graph, local worklet effects, all seven bundled drums,
attached WAV registration and offline rendering, full attack-only sample tails,
and sample identity on a 44.1 kHz playback context with a fresh 48 kHz export.
These are measured signals, not a listening assessment or a native download-dialog
test. Native desktop packaging does not establish audible playback on every
target platform.

## Editable Starter Contract

`createStrudelTemplate({instanceId})` returns
`{files:{'index.html': html}, entry:'index.html'}`. The trusted service supplies its
new opaque instance ID and validates the single-entry result. The existing atomic
store extracts ordinary `app.js` and `styles.css` alongside the instance HTML.
There is no source rewrite or automatic kit upgrade of older sketches. A new
template added to an older project disables sample examples that its pinned kit
cannot play and explains how to get the sample bank in a new project.

The editable source exposes `window.EaselStrudel.setCode(source)`,
`evaluate(source)` and `snapshotPattern() -> {pattern,params}`. Writing a draft
does not start playback. Run/Ctrl+Enter evaluates the selection or whole editor
through the pinned REPL and retains its resulting pattern. A snapshot requires
an executed pattern; it never substitutes an unevaluated starter. Each snapshot
returns fresh frozen numeric
`params = {bpm,volume,patternVersion}` without starting audio. Tempo/volume changes
do not rebuild the prepared pattern. `patternChanged()` stops, increments the
local pattern version and invalidates the cache; source reload discards it too.
Export should call `snapshotPattern()` exactly once and freeze/query that returned
pattern with those returned parameters. It must not trust authored instance IDs
or patternVersion as source identity: the host supplies source revision/runtime
scope independently.

- Four beats per cycle: `cps = bpm / 240`, with BPM 30–240.
- Event gain belongs to the authored pattern; UI volume
  (0–1) multiplies `output.destinationGain` exactly once. The exporter folds the
  frozen volume into validated snapshot event gains once, using offline output
  gain 1. Do not apply both output gain and scaled events.
- State hooks use app ID `strudel-<instanceId>` and always return `playing:false`.
  Optional saved settings are read only from
  `window.__easelProjectState.strudel[instanceId]`. Shared root settings are never
  treated as an instance's settings. Live changes are not automatically persisted
  to `state.json`; the existing host state tool can persist that keyed structure.
- Live evaluations replace the running pattern without resetting the context
  or graph. Stop synchronously mutes managed output and hushes scheduling. Before
  explicit restart the pinned controller's public `reset()` disconnects the old
  graph. The native CI fixture verifies no old eight-second voice reappears during
  an immediate zero-gain-pattern restart with nonzero destination gain, then
  requires ten fresh nonzero samples after a positive-pattern restart on that
  same starter. Measurements follow each active output graph. The original
  no-op-restart mutation gate remains intact.
- Capture-phase Escape stops audio even when the existing canvas question overlay
  owns focus. It does not submit answers or implement a second question system.
- Disposal invalidates pending operations, hushes, disconnects output and closes
  the one context. Async start guards prevent a late scheduler from surviving.
  Initialization failure offers silent reload/retry; playback errors require a
  new genuine Play gesture.

The extended disposable fixture also checks trusted starter controls, BPM/volume
changes, question-overlay Escape, source-edited reload with settings but no
playback, two instance keys and repeated lifecycle cleanup. WAV export uses the
production host bridge in Easel; standalone HTML requires Easel to save to Media.

## Source and ZIP distribution contract

`scripts/build-canvas-kits.js` exports
`buildStrudelKit(destination) -> {bundlePath, sourceDirectory, sourceArchivePath, manifest}`.
Development artifacts include `canvas-kits/strudel.js`, the complete
`canvas-kits/strudel-source/` directory, and `canvas-kits/strudel-source.zip`.
Electron packages the runtime and the opaque ZIP. The archive preserves every
source byte through the application packager, whose ordinary directory filter
otherwise removes lockfiles/type declarations and rewrites nested manifests.
Unzip the archive to recover the complete `strudel-source/` directory before
following the rebuild instructions in its README.

The source directory contains:

- `manifest.json`: kit version, runtime SHA-256, exact dependency versions,
  registry integrity values, package source paths, present license files, esbuild
  version/settings, and a SHA-256 for every actual bundle input
- `esbuild-metafile.json`: actual source-entry/dependency composition
- `packages/`: complete installed published package trees, including preferred
  source files where published, source maps, compiled modules, and notices;
  nested dependency versions retain their own paths
- `easel/`: the local adapter, build script, kit helper, package manifests,
  workspace manifest, lockfile, root/workspace GPL LICENSE and NOTICE files, and
  the retained creative-skills MIT grant, all copied byte-for-byte
- `README.txt`: build instructions and remaining distribution review caveats

A later project-ZIP export carrying Strudel must copy the intact source archive
alongside its offline bundle (or include every extracted source entry byte-for-byte),
retain its relative source paths, and preserve the manifest and notices. Source
sidecars are not executable kit scripts and must not be injected into canvas HTML or counted as another kit. A project ZIP must not
silently drop source material. The runtime bundle still obeys the existing 8 MiB
kit limit; source-package bytes are separate ZIP entries.

This material binds the emitted runtime to the installed inputs and local build;
it is not a legal certification of complete corresponding source. In particular,
`@tonaljs/progression@4.9.3` and `chord-voicings@0.0.1` publish license declarations
but no top-level license file. The Tonal MIT notice is now included from upstream
commit `a1b98c3cb04c7244250ec1de72d155582e96acf8`: its progression source exactly
matches the published source map. This is a source-content match, not a verified
4.9.3 release commit (upstream metadata there says 4.9.2). Supplemental provenance
and the exact notice are retained under `easel/build/strudel-notices/`.
The missing chord-voicings notice and final corresponding-source review remain open.
`chord-voicings` has published preferred source and npm gitHead
`447ee7932851562dcfc480f54f5011430174a30d`; that exact upstream tree also lacks a
LICENSE file. The exact upstream source archive, build inputs and verification
metadata are retained under `easel/build/strudel-notices/`. Do not invent an
upstream notice or relicense these dependencies.
The separate licensing review owns these decisions and Easel's root license.

## Verification

Local sample validation on 9 October 2026 covers the new project-pinned drum
bank and registered attached audio. A browser fixture plays all seven drums,
adds and repeatedly evaluates an attached one-shot on the same live context
and output controller, and renders each sound through a separate offline page.
It rejects mismatched decoded sample durations while the original score keeps
playing. A separate 44.1 kHz context test checks that registration metadata uses
a fixed 48 kHz decode and remains valid in the export realm. An attack-only
sample test measures the full tail beyond its short pattern event. A hidden
native Electron fixture additionally runs all seven drums,
an attached WAV and an attached MP3 through the actual export bridge,
controller, isolated renderer and Media store: nonzero PCM, save, attachment,
identical bytes after reopening and idempotent retries, with no network requests.
These fixtures use disposable profiles and do not focus the user's desktop.
They establish measured signal; they do not establish subjective sample quality
or validate new Suno generation. The original synth validation remains below.

`node --test test/strudel-kit.test.js` tests the exact pin, install/catalog
visibility, adapter order and non-awaited startup, API preservation, actual
license/source artifacts, all bundle-input hashes/source paths, unchanged CSP,
8 MiB budget, and offline probe assembly. `test/strudel-packaging.test.js`
exercises the real installed Electron file filter and transformer, then compares
every unpacked archive entry with the original source byte-for-byte. It then
rebuilds from the extracted material using its archived runtime dependencies and
local copies of already-installed build tools, checking identical runtime bytes.
`test/strudel-runtime-probe.test.js` tests native-focus gating and deliberately
breaks second-Play scheduling to reject the old-voice restart false positive.
`npm run build:canvas-kits` validates all kit scripts. Neither command substitutes for the separately recorded production WAV/Media runtime proof.
