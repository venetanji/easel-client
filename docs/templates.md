# Creative templates

Templates are locally packaged, editable starting points for Easel projects.
The first two working templates are **Video editor** and **Strudel sound**.
Presentations, games, image editing, SVG editing and voxel soundscapes remain
labelled **Planned**; they cannot be opened or created.

## Create a sketch

1. Open **Templates** in the left activity rail. It uses the same drawer area as
   Files and Media; opening one closes the other drawer.
2. Choose **Video editor** or **Strudel sound** to see its purpose, outputs,
   required kits and limits.
3. Choose **Create project** for a new project, or **Add to current project** for
   a new sketch in the project you already have open. Add is disabled without an
   open project.
4. Reopen saved sketches from **Project files** or their document tabs. Each
   Create/Add action makes another sketch rather than reopening the last one.

Video requires the built-in Canvas 2D kit. Strudel requires the installed Strudel
kit; an unavailable entry explains the missing kit and points to **Kits** in
Settings. Readiness and installed-kit availability are separate. Planned entries
have no creation action.

Creation saves the current work before switching. The host checks kit availability,
source and bundle limits before committing. Adding a sketch preserves the existing
project's files, media and exact pinned kit bytes, and adds only missing required
kits. Kit selection is shared by every HTML document in the project; it is not a
per-sketch setting. An over-budget or unavailable dependency fails visibly rather
than replacing the project's choices.

If creation succeeds but preview opening fails, the drawer shows **Sketch created**
with **Retry Open** and **Dismiss Open retry**. Retry uses the saved sketch's
identity. Dismiss leaves it in Project files. Do not repeat Create to recover a
failed preview unless you want another sketch. A catalog read failure has a
**Refresh** action; busy controls prevent duplicate creation.

## Independent documents and state

New sketches use unique source directories, normally
`sketches/<instance-id>/index.html`, with editable `app.js` and `styles.css` beside
the HTML. The host owns the binding between the project, document and instance.
Copying HTML does not grant access to another sketch's state.

- Each Video instance has its own timeline ID, revision and persistent timeline
  Undo/Redo. Editing or undoing one timeline does not change another.
- Strudel instances have separate editable pattern source and instance-keyed
  settings. Opening, reloading or restoring settings never restores playback.
  Switching away cleans up the old sketch's sound rather than layering it with
  the next document.
- Documents still share the project's kit selection, attached media and
  `state.json`. Media references are checked across all Video timelines before an
  asset can be detached.

Legacy Video projects retain their authored files, timeline contents and history.
The host binds the original editor to an instance through an idempotent migration.
If multiple legacy documents could own the same timeline, Easel asks which one
owns it; it does not silently duplicate or merge their timelines. The **Video
editor** launcher reopens an existing sole editor, or offers a choice when there
are several. Use Templates → Add to current project to deliberately make another.

## Edit, undo and remove

Edit ordinary Project files and reload the canvas to apply source changes. An app
update does not replace an older sketch with the latest template. There is no
automatic source refresh or migration of student edits.

Source Undo and Video timeline Undo are separate. Adding a template creates a
source-history boundary: later source edits can be undone, but source Undo cannot
jump back through creation and remove the sketch or its later timeline work.
Earlier source snapshots remain under the existing bounded, session-local history
rules. See [Template creation and source Undo](template-source-undo.md).

To remove a sketch, use the normal confirmed deletion action on its HTML document
in Project files. Video deletion retains the host binding and full timeline/history
for deletion Undo within the existing history budget. A failed or cancelled
deletion leaves the sketch intact. The last HTML document uses the project deletion
flow. Deleting a timeline clip or track is a different action: it keeps the source
media and can be undone inside that Video instance.

## Explore with the agent

**Explore this idea** prepares a visible, editable chat prompt. It does not send
the prompt. Opening a template, reading the catalog or inserting a prompt starts
no model call, media generation, upload or audio playback.

Both agent backends use the same `list_templates` catalog and
`create_template_instance` service. Creation needs a specific request and a
destination, `new-project` or `current-project`; a supplied project ID must match
the active project. Planned or unavailable entries cannot be instantiated.

During exploration, the agent can ask one useful question in the existing canvas
modal, such as rhythm versus melody or the feeling a video should convey. Your
answer is saved with its originating conversation, document and instance, then
resumes that conversation once. Answers for a replaced or rebound instance are
rejected. This uses `request_canvas_input`/`EaselHost.submitInput`, not another
answer system.

The question can be dismissed without resetting the source. Co-creation uses
`restorePreviousView` or `clear`. Local Strudel tempo/volume changes respond
immediately; an agent edit takes a model round trip and may reload the canvas.
Reload stops playback and requires a fresh Play gesture. Press **Escape** to stop
Strudel even while a question has focus, or dismiss the question and press Stop.
Answers and attached media do not authorize unrelated generation or sharing.

## Outputs and backups

- [Video editor](video-editor.md): bounded WebM with audio, saved to Media; up to
  60 seconds and 32 MiB. Timeline/source edits leave original media unchanged.
- [Strudel sound](strudel.md): native-synth playback and bounded stereo 48 kHz
  PCM16 WAV loop export to Media; 1–16 four-beat cycles, at most 30 seconds
  including the fixed 0.5-second tail, below 6 MiB.
- **Project ZIP**: editable-source backup plus offline compiled HTML documents,
  attached media, pinned kit runtime and a versioned manifest. The manifest
  records every template instance and per-instance Video timeline. A single
  timeline also retains the legacy `.easel/timeline.json` compatibility entry.
  This is a project backup, not a rendered video or audio mix.

Authored files are preserved under `.easel/source/`; compiled HTML previews are
separate. Strudel's offline bundle can play its supported native pattern in a
modern browser after Play. Easel is required for canvas questions, managed Media
saves and the interactive Video timeline host. Runtime-only setting changes are
not added to a ZIP; save durable settings in project state when needed.

Project ZIP limits are 256 MiB total uncompressed content and 128 MiB per compiled
document. Large projects fail with size contributions and no partial ZIP. A
Strudel-bearing ZIP also preserves the exact pinned runtime's source archive under
`.easel/kits/strudel-<digest-prefix>.source.zip`. Its manifest records the full
runtime/source hashes and byte count; compiled documents include a visible
**Strudel corresponding source** download link. Single-HTML export embeds that
same archive as a non-executable download, so no extra sidecar file is needed.

Missing, mismatched or corrupt source material blocks HTML/ZIP distribution.
Restore the original matching archive rather than replacing an old project pin
with a newer kit. Local preview, editing, history and WAV saves remain available.
Preserving these bytes is not certification of complete corresponding source.
See [Strudel compatibility and source
materials](strudel-compatibility.md#source-and-zip-distribution-contract),
[license audit](license-audit.md), [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
Upstream notices and unresolved source-review caveats still apply; runtime proof
does not constitute release or licensing clearance.

## What has been checked

Focused repository tests cover create/add transactions, independent timelines,
legacy migration/recovery, source-history boundaries, instance-bound questions,
export cancellation/receipts and versioned ZIP contents. The
[mixed-project host integration test](../test/template-workflow-acceptance.test.js)
ties two Video and two Strudel create/add operations, kit/source preservation,
instance-bound answer continuation, Media receipt attachment, ZIP source closure
and deletion recovery together with controlled view/model/PCM dependencies. It
does not run a native app or prove synthesis with its synthetic kit/source bytes.
The disposable native
Strudel fixture passed [Test run
37306231481](https://github.com/venetanji/easel-client/actions/runs/37306231481)
at `b3cb58a` on 5 October 2026, including the actual starter and production WAV
render/Media save/reopen/decode path. See [Strudel verification](strudel.md#verification)
for the exact scope.

These checks do not establish the complete main-shell student journey with two
Video and two Strudel sketches together, a human listening check, or a native
download dialog. On each target desktop, check the drawer/keyboard/narrow layout,
create/add and switching, audible Play/Stop, Media preview/download and offline
ZIP playback. No user's live session is part of the disposable fixture.
