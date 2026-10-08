# Strudel sound template

Strudel sound is an offline live-coding scratchpad, bundled locally through
Easel's pinned Strudel kit. It starts silent and offers Play, Stop, tempo, volume,
a live code editor and bounded WAV loop export. The editor uses Strudel's REPL;
ordinary canvases retain the stricter CSP. Network access remains blocked.

## Start and listen

1. Open **Templates → Strudel sound** and choose **Create project** or **Add to
   current project**. If the kit is missing, check **Kits** in Settings. See
   [Creative templates](templates.md) for independent instances and recovery.
2. Press **Play** yourself. Mouse activation or a focused button's Enter/Space
   activation supplies the genuine gesture needed to resume audio. An agent
   tool call is not that gesture.
3. Adjust **Tempo · BPM** from 30–240 and **Volume** from 0–100%. These local
   controls act immediately and do not need a model call.
4. Press **Stop** or **Escape** for silence. Escape also works while the existing
   canvas question overlay has focus. You can dismiss a question and press Stop.

Stop mutes the managed output as well as stopping the scheduler, so already
scheduled sound tails do not keep playing. Explicit restart disconnects the old
voice graph before unmuting the new pattern. Repeated Play does not create another
context or scheduler. Initialization or pattern errors appear in the sketch;
Retry Play requires another genuine gesture. An initialization reload/retry
remains silent.

## Live-code the pattern

Use the built-in code editor and **Push live**. The pinned Strudel REPL compiles
and replaces the current pattern on its running scheduler; Easel adds no
next-bar wait. If code fails, the previous valid pattern stays in place. While
the editor differs from the active pattern, current playback continues, but Play
and WAV export stay disabled until the draft is pushed. Pushing code does not call Play. Keep `.play()` out of submitted code; use the visible
Play button to start sound with a real user gesture.

The authored `app.js` contains `DEFAULT_LIVE_CODE` and the matching safe starter
pattern factory. When changing that authored default, keep both definitions in
sync. Runtime pushes are available to the agent through
`window.EaselStrudel.evaluate(source)` in `execute_canvas_javascript`; use that
only when the user asked to audition the code. A successful push is retained in
this instance's project state. It is not an `app.js` source edit and does not
create a source-history entry.

Custom saved code is displayed after reload but deliberately is not evaluated
at startup. Push it again, then press Play. Playback never restores. This avoids
a saved code buffer starting audio or running effects while the project opens.

The REPL runs in the isolated canvas and uses dynamic JavaScript evaluation.
Only a document marked `data-easel-strudel-repl="v1"` receives the additional
`unsafe-eval` and `worker-src blob:` CSP sources needed by the pinned evaluator
and local audio worklets. `connect-src` remains limited to `data:` and `blob:`;
remote `samples('github:...')` requests are blocked. No sample bank or Suno
sample-creation workflow is included yet.

The built-in example layers native synth patterns and live effects. The WAV
export contract remains narrower than live playback: it accepts only validated
native note/synth events and rejects samples and effect controls rather than
silently changing their sound.

## Explore an idea

**Explore this idea** in the Templates drawer prepares a chat prompt for you to
edit and send. The agent can then use the existing dismissible canvas question
modal, for example to choose rhythm versus melody or calm versus energetic.
Submitting an answer resumes the originating conversation once with the document
and instance context; stale instance answers are rejected.

Questions restore or clear the previous view without resetting source. Agent
changes take a model round trip and source patches may reload the canvas. Tempo
and volume remain direct local controls; after reload, press Play again. Merely
opening the sketch or preparing a prompt starts no model call, generation,
upload or sound.

## Export a WAV loop

Choose **Cycles · four beats each**, then **Export loop**. You do not have to
start live playback first. Export snapshots the loaded source revision, tempo,
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

Supported authored event fields are only `note`, `s`, `gain`, `attack` and
`release`:

- Native sine/sin, triangle/tri, square/sqr and sawtooth/saw aliases
- Finite MIDI notes 24–96, or the pinned kit's accepted note spelling and
  default-octave rules
- Gain 0–1; omitted gain retains the pinned native 0.8 default
- Attack/release 0–0.5 seconds; omitted envelopes retain the native default
  branch rather than being silently replaced with explicit controls
- Rests and volume-zero loops are valid; actual pattern query errors fail
  visibly rather than becoming a silent rest

Samples, effects, callbacks/stateful event values, continuous events, additional
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

**Cancel export** disposes the separate renderer. Source changes, pending/failed
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
Sample packs (including remote sample loading), MP3 export, microphone recording
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
