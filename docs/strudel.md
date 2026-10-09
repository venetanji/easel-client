# Strudel sound template

Strudel sound is an offline Strudel interpreter with one code editor, Run/Stop,
BPM and volume controls. A collapsible panel on the right holds references,
examples and WAV export. It uses the locally bundled, pinned Strudel runtime.

## Write and listen

1. Create a fresh **Templates → Strudel sound** instance. Existing projects keep
   their authored template source and are not replaced by an app update.
2. Edit the code. Select a passage to execute only that passage, or leave no
   selection to execute the whole buffer.
3. Press **Ctrl+Enter** (Cmd+Enter also works) or **Run**. That one gesture
   evaluates the code and starts sound. During playback it updates the pattern
   on the existing clock. Syntax errors retain the last good pattern.
4. Press **Stop**, **Ctrl+.** or **Escape** for silence, including while a canvas
   question has focus. Stop also mutes already scheduled sound tails.

The editor fills the canvas. **Reference** toggles the right panel; its close
button returns focus to the editor. Syntax highlighting distinguishes functions,
strings, numbers, labels, keywords and comments in the editor and examples.
Each example shows its code and an
**Add & run** button. It appends a layer and evaluates the whole score in one
gesture, preserving existing layers and tempo. During playback it keeps the
same clock and audio graph. A plain final pattern becomes a `$:` layer before
the first example is added; setup code and comments remain intact. Invalid or
oversized drafts are preserved with an error instead of replaced.
Scores using dynamic `.p()` registrations or conditional labels require adding
the example manually; the automatic action leaves these scores unchanged.
Tab inserts two spaces; Shift+Tab moves keyboard focus onward.
Tempo and volume controls apply immediately. Code may also set tempo with
`setcpm(30)` (120 BPM); starting playback preserves that tempo.

Opening or reloading the project stays silent. Restored custom code needs only
Run or Ctrl+Enter, with no separate push step. Managed state includes unexecuted
editor text, settings and panel visibility. An authored default source change
wins over editor state captured from the previous default.

## Agent editing

Inspect `window.EaselStrudel.getState().code` through
`execute_canvas_javascript`. `window.EaselStrudel.setCode(source)` fills the
editor without evaluating or playing it. When the user asks to audition a live
change, `window.EaselStrudel.evaluate(source)` compiles it on the current
scheduler; it does not start audio. The user supplies Run/Ctrl+Enter to start.
Keep `.play()` out of submitted code.

Runtime editor changes participate in managed state preservation; they do not
create source-history entries. To save a pattern change while keeping playback,
patch `DEFAULT_LIVE_CODE` in the instance's `app.js` with `reload:false`, check
the save result, then call `EaselStrudel.evaluate` with that same complete score.
The saved default survives reopening, and live evaluation updates the existing
clock. A failed evaluation keeps the previous good pattern playing; correct
the saved default as well before reporting success. Source-only saves leave
the host's document revision pending reload, so WAV export remains gated until
reload. Changes to the editor UI or libraries still require a reload, which
stays silent until Run. Run always evaluates the editor buffer.

Suno's `generate_sound` tool exposes `soundType: "one_shot"` and `"loop"`.
Generated audio can be saved to Media, attached by its returned asset ID, and
registered in the score using the shared local sample registry:

```js
await window.EaselStrudelSamples.add('suno_snare', 'ATTACHED_MEDIA_ASSET_ID')
s("suno_snare*4").gain(.25)
```

Studio's Media and job attachment paths refresh the current project's asset
resolver without reloading. Registering a sample preloads and decodes its bytes
before changing its name mapping; it does not stop or replace the live audio
context. Repeating the same registration is harmless. Keep this line in saved
score source to restore the mapping after reopening or exporting project HTML.
Use single quotes for the plain name and asset ID; Strudel interprets double
quotes as patterns. Use lowercase names with underscores, at most 48 characters. Built-in names
are reserved; choose a new name for generated alternatives.

Samples must be WAV, MP3 or M4A, mono or stereo, at most 10 seconds and 4 MiB each.
Suno M4A (`audio/mp4`, also `audio/x-m4a`) decodes directly in Studio's Electron
runtime for playback and WAV export. The duration limit applies to decoded
audio; ask Suno for at most 9 seconds to leave room for AAC padding.
Use `generate_sound` for short one-shots or loops; full generated songs usually
need trimming first. Check attacks, duration and loop boundaries. Generation
does not automatically trim, normalize, tune or register audio.

Existing projects retain their kit pin. Check
`window.EaselStrudelSamples?.supportedFormats?.includes('m4a')` before using M4A on an
older project. To refresh on the user's request, read `list_canvas_files` and
collect every `kit.name` from `manifest.kits`, then pass that complete list to `update_canvas_project`
with `reload:true,preserveState:true`. This takes installed bundles while
preserving authored source, attached media and editor text. Playback stops at
reload and stays silent until the user presses Run.

## Local sounds and effects

The reference panel lists working native sounds: sine, triangle, square,
sawtooth, sbd (synth kick), supersaw, pulse and white/pink/brown noise. Melody,
rhythm and layered examples work offline.

The kit also embeds seven original electronic WAV one-shots: `bd` (kick), `sd`
(snare), `hh` (closed hat), `oh` (open hat), `cp` (clap), `tom` and `rim`.
These are named samples, not a SoundFont. The JSON bank records names, decoded
durations, SHA-256 identities and provenance, and travels with the project-pinned
kit and corresponding-source archive. `scripts/generate-strudel-drums.cjs`
reproduces every PCM byte. The sample registry prepares these before Run.

Other website sample banks such as piano are not bundled. Remote
`samples('github:...')` requests remain blocked. Live audio effects use bundled
worklets; their embedded bytes load through temporary local blob URLs, released
after loading. Only the marked Strudel document receives the REPL's
`unsafe-eval` and `worker-src blob:` policy. Ordinary canvas policy is unchanged,
and network access stays blocked.

WAV export remains narrower than playback: it accepts validated native
oscillator, kick, noise and registered local sample events, and reports
unsupported effect and sample pitch/speed/slicing controls explicitly.

## Explore an idea

**Explore this idea** in the Templates drawer prepares a chat prompt for you to
edit and send. The agent can then use the existing dismissible canvas question
modal, for example to choose rhythm versus melody or calm versus energetic.
Submitting an answer resumes the originating conversation once with the document
and instance context; stale instance answers are rejected.

Questions restore or clear the previous view without resetting source. Agent
changes take a model round trip and source patches may reload the canvas. Tempo
and volume remain direct local controls; after reload, press Run again. Merely
opening the sketch or preparing a prompt starts no model call, generation,
upload or sound.

## Export a WAV loop

Run the code once, choose **Cycles** in the top bar,
and press **Export WAV**. You can Stop playback before saving. Export snapshots the loaded source revision, tempo,
volume, pattern version and selected onset events before asynchronous work.
It uses the project-pinned Strudel bytes, not an arbitrary newer installed kit.

Limits apply together:

- Integer cycle count 1–16; four beats per cycle
- At most 30 seconds including the fixed 0.5-second tail; slower tempo can make
  fewer than 16 cycles fit
- At most 4,096 onset events and 32 overlapping native voices
- Stereo, 48 kHz, 16-bit PCM WAV below 6 MiB; exact sample frames round up once
- One export at a time, with a 30-second rendering wall-clock watchdog

For example, one cycle at 120 BPM occupies two seconds plus the 0.5-second tail,
or 120,000 sample frames. The fixed tail crops any synth release beyond that
boundary, including its final native node-stop allowance. It is not an arbitrary
recording duration.

Supported authored event fields are `note`, `s`, `gain`, `attack`, `decay`,
`sustain` and `release`, with sample index `n: 0` accepted for single-sample names:

- Native sine/sin, triangle/tri, square/sqr and sawtooth/saw aliases
- Native `sbd` kick and `white`, `pink` and `brown` noise
- Bundled drums and samples registered with `EaselStrudelSamples.add`, without
  `note`, speed or slicing. Up to 16 distinct names and 8 MiB of attached sample
  bytes per export. The host captures attached bytes and checks their hashes;
  the isolated renderer checks the actual decoded duration against the snapshot.
  Sample voices count their full duration, and output is cropped at the fixed tail.
- Finite MIDI notes 24–96, or the pinned kit's accepted note spelling and
  default-octave rules; omitted pitch uses the native kick default 29 or synth default 36
- Gain 0–1; omitted gain retains the pinned native 0.8 default
- Attack/decay/release 0–0.5 seconds and sustain 0–1; omitted controls retain
  the native envelope and sustain inference. Kick polyphony counts its decay
  independently of the pattern event duration
- Rests and volume-zero loops are valid; actual pattern query errors fail
  visibly rather than becoming a silent rest

Unregistered samples, effects, callbacks/stateful event values, continuous events, additional
control fields, and `duration`/`clip` overrides are rejected with an error.
Explicit null, undefined and non-finite numeric controls reject too. Easel does
not strip unsupported semantics or substitute another synthesizer. See the
[compatibility contract](strudel-compatibility.md) for the exact event and native
envelope rules.

The host renders plain validated events through Strudel's own SuperDough in a
separate sandboxed OfflineAudioContext renderer. It never changes the live
sketch's audio context or calls the upstream download helper. It validates the
WAV header, frames, rate, channels, bit depth, duration and bytes before saving.
The finished WAV is saved to **Media** and normally attached once to the captured
project. Open Media to preview, attach or download it. Nothing is sent to chat
automatically.

### Cancel and recover

**Cancel** disposes the separate renderer. Source changes, pending/failed
reload, hide, document/project switching or renderer loss invalidate its token;
late render results cannot create an asset. A cancelled or failed render leaves
live playback intact. OfflineAudioContext has no abort/close method, so the host
destroys its separate realm instead.

Cancellation before saving produces no asset. If saving has already been
admitted, Easel waits for it: a successfully saved loop remains in Media even if
you cancel, the project attachment fails or a notification fails. The returned
receipt names that asset and warns when it is saved-only. Open Media and attach
the saved loop to recover; do not render again just to repair an attachment.

Matching retries with the same export ID and content recover the original durable
asset, including after restart or eviction from the public latest-200 Media list.
Reusing an export ID for different content, ambiguous receipts or corrupt bytes
fails instead of silently saving a duplicate. The host checks the captured
project/runtime at attachment time, so switching never redirects an output to
the new sketch.

## Offline use and limits

The kit is pinned to `@strudel/web@1.3.0`, built from its published source entry
and the repository lockfile. Supported playback needs no CDN, microphone or device permission. The ordinary
canvas policy blocks eval and workers; only the marked Strudel scratchpad opts
into local REPL evaluation and blob-backed audio worklets, without network access.
Remote sample packs, MP3 export, microphone recording
and audiovisual capture remain outside this template.

Compiled Project ZIP HTML embeds the offline kit and can play the supported
native pattern in a modern browser after Play. Browser audio gesture rules still
apply. Export loop and canvas-to-chat questions require the Easel host; standalone
HTML is not a Media-save service. Editable source is preserved separately under
`.easel/source/`. A ZIP contains saved project state, not unsaved runtime settings.

The build retains `canvas-kits/strudel-source.zip` with exact inputs, notices,
dependency trees and rebuild material. Desktop packaging preserves that archive.
Project ZIP export copies the matching archive byte-for-byte to
`.easel/kits/strudel-<digest-prefix>.source.zip`; its kit manifest records the full
runtime SHA-256, archive SHA-256 and bytes. Each compiled document has a visible
**Strudel corresponding source** download link to that relative archive.
Single-HTML export embeds the same archive as a non-executable ZIP download link,
with no additional sidecar file to keep track of.

A retained archive belongs to its exact project-pinned runtime. A newer installed
kit cannot replace it. For an older project, source can be backfilled only from an
archive whose manifest matches that runtime hash. Missing, mismatched or corrupt
material blocks HTML/ZIP distribution with a visible error; restore the original
matching archive/source before exporting. Local preview, source/history editing
and WAV saves are not blocked by this distribution check. Preservation is not a
claim of complete corresponding-source or release clearance. Strudel's AGPL terms and
other dependency notices remain separate from Easel's GPL declaration. See
[source/ZIP distribution details](strudel-compatibility.md#source-and-zip-distribution-contract),
[license audit](license-audit.md), [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
The missing `chord-voicings` notice and final source review remain caveats.

## Verification

The current REPL, bundled drums and attached-sample evidence is recorded in the
[9 October 2026 compatibility update](strudel-compatibility.md#repl-and-percussion-evidence---9-october-2026).
PR #19 passed the native Strudel/WAV probe and Windows, macOS and Linux packaging.
Browser tests additionally cover uninterrupted live edits, local worklet effects,
sample playback/export, 44.1 kHz device normalization and saved-project sample
restoration. The earlier native-only evidence below remains a dated baseline.

[Test run 37306231481](https://github.com/venetanji/easel-client/actions/runs/37306231481)
passed the disposable native kit, editable starter and production WAV fixture at
`b3cb58a` on 5 October 2026, on Linux x64 / Electron 44.4.5 / Chromium
152.0.7977.130. Its retained `strudel-runtime-evidence` artifact establishes:

- Initial silence, trusted keyboard Play, Stop/restart, immediate local controls,
  Escape while a question is open, edited-source reload without autoplay,
  independent settings and context/scheduler cleanup
- Nonempty native sine/triangle/square/sawtooth stereo output
- Actual starter export action through the production bridge/controller/renderer
  and real Media store, saved/reopened WAV byte decoding, exact 2.5-second,
  120,000-frame output, onset/rest/tail timing and zero/half-volume scaling
- Native default versus explicit envelope behavior, a 201-event/8.5-second score,
  identical retry idempotency and sustained live audio/context identity
- No unexpected resource requests and no CSP relaxation in that fixture

Measured nonzero samples prove signal, not a human listening check. Saved/reopened
byte decoding is not the app's Media preview UI or an OS download-dialog test.
The fixture uses disposable native windows and production modules; it is not a
full main-shell two-Video/two-Strudel student journey and does not attach to a
user's live session. Source tests additionally cover cancellation, timeout,
save/attachment races, malformed WAVs, unsupported patterns and restart receipt
recovery; those controlled tests are distinct from measured native execution.
The separate [mixed-project host integration
test](../test/template-workflow-acceptance.test.js) connects actual factories,
service/stores and question adapters to two Video/two Strudel create/add,
independent timeline Undo, one answer continuation, controlled valid-rest PCM
save/attachment, mixed ZIP source closure and deletion recovery. Its inert view,
controlled model and synthetic kit/source/PCM are not native audio or preferred
source proof; the native signal evidence remains the dated run above.

Target-platform manual checks remain: audible playback and preferred output
device, mouse/keyboard/narrow-layout controls, switching/reopen, Media preview and
download, and exported ZIP playback in the intended browser. See [compatibility
evidence](strudel-compatibility.md) for the reproducible probe and source audit.
