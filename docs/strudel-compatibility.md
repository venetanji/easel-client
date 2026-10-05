# Strudel kit compatibility and evidence

## Status

The locally bundled kit and source package are unit/build verified. The narrow
native-kit playback and OfflineAudioContext gate passed CI on 5 October 2026
(see the dated evidence below). The editable starter remains gated until its
extended controls/lifecycle fixture passes; native-kit proof alone is insufficient. WAV export is
not advertised: `getStrudelCapabilities().audioExport` remains `false` until the
separate bounded-export renderer is implemented and verified.

Pinned package: `@strudel/web@1.3.0`. Easel builds its published `web.mjs` source
entry using esbuild and the repository lockfile, rather than copying the upstream
all-in-one IIFE with an unknown build dependency graph. The original exported API
is retained. The adapter appends worklet-disabled gesture initialization without
awaiting its gesture-pending promise at startup. Vendor licenses remain intact.

## Candidate supported subset

Source inspection supports `initStrudel({sync:false})`, `note(...).s("sine").play()`,
`hush`, `getAudioContext`, `setAudioContext`, `setSuperdoughAudioController`,
`registerSynthSounds`, and `superdough`. Native synth names are `sine`, `triangle`,
`square`, and `sawtooth` (upstream also aliases `saw`). The native-kit checks
below are proven; newly added starter controls/lifecycle checks are pending.

- Start silent; use a real Play button gesture.
- Call `initAudioOnFirstClick({disableWorklets:true})` before `initStrudel`.
  The kit adapter does this once, without awaiting it.
- Upstream first-click initialization only observes `mousedown`. Keyboard Play
  must explicitly resume `getAudioContext()` and call
  `initAudio({disableWorklets:true})` within the button's trusted click handler.
  The pinned upstream `initAudio` resume conditional is ineffective; do not rely
  on it to resume the context.
- `hush` stops scheduling, but does not promise instant silence of existing tails.
  The probe also mutes the managed output gain, then verifies silence and restart.
- No sample packs, remote URLs, microphone, REPL/evaluate, sync SharedWorker
  scheduler, worklet effects, or generated-code evaluation are supported.
  These APIs have not been removed from upstream; they are outside the supported
  subset and remain subject to the existing sandbox/CSP.
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
starter fixture is test preparation, not yet passing runtime evidence. Before restart it keeps output muted for at least three audio-context
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
`audioExport:false` and the starter's `strudelReady:false` host gate remain in
place until their respective verification passes. No human listening check is
claimed by measured nonzero sample evidence.

## Editable starter and Task 6 handoff

`createStrudelTemplate({instanceId})` returns
`{files:{'index.html': html}, entry:'index.html'}`. The trusted service supplies its
new opaque instance ID and validates the single-entry result. The existing atomic
store extracts ordinary `app.js` and `styles.css` alongside the instance HTML.
There is no source rewrite of older sketches and no new renderer IPC.

The editable source exposes `createPattern(params)` and
`window.EaselStrudel.snapshotPattern() -> {pattern,params}`. The first snapshot
prepares and caches one pattern; Play and later snapshots reuse it, including
random choices made by authored source. Each call returns fresh frozen numeric
`params = {bpm,volume,patternVersion}` without starting audio. Tempo/volume changes
do not rebuild the prepared pattern. `patternChanged()` stops, increments the
local pattern version and invalidates the cache; source reload discards it too.
Export should call `snapshotPattern()` exactly once and freeze/query that returned
pattern with those returned parameters. It must not trust authored instance IDs
or patternVersion as source identity: the host supplies source revision/runtime
scope independently.

- Four beats per cycle: `cps = bpm / 240`, with BPM 30–240.
- Event gain belongs to `createPattern`. The starter uses gain 0.3; UI volume
  (0–1) multiplies `output.destinationGain` exactly once. Task 6 should fold the
  frozen volume into validated snapshot event gains once, using offline output
  gain 1. Do not apply both output gain and scaled events.
- State hooks use app ID `strudel-<instanceId>` and always return `playing:false`.
  Optional saved settings are read only from
  `window.__easelProjectState.strudel[instanceId]`. Shared root settings are never
  treated as an instance's settings. Live changes are not automatically persisted
  to `state.json`; the existing host state tool can persist that keyed structure.
- Stop synchronously mutes managed output and hushes scheduling. Before explicit
  restart the pinned controller's public `reset()` disconnects the old graph.
  The extended CI fixture must prove no old eight-second voice reappears during
  an immediate zero-gain-pattern restart with nonzero destination gain, then
  require ten fresh nonzero samples after a positive-pattern restart on that
  same starter. Measurements follow each active output graph. The original
  no-op-restart mutation gate remains intact.
- Capture-phase Escape stops audio even when the existing canvas question overlay
  owns focus. It does not submit answers or implement a second question system.
- Disposal invalidates pending operations, hushes, disconnects output and closes
  the one context. Async start guards prevent a late scheduler from surviving.
  Initialization failure offers silent reload/retry; playback errors require a
  new genuine Play gesture.

The extended disposable fixture additionally checks trusted starter controls,
BPM/volume changes, question-overlay Escape, source-edited reload with settings
but no playback, two instance keys and repeated lifecycle cleanup. No local
Electron run was used for Task 5. WAV output remains explicitly unavailable.

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
`npm run build:canvas-kits` validates all kit scripts. Neither command substitutes for the pending extended starter/Media renderer gates.
