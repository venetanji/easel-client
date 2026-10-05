# Template creation and source Undo

Adding a template keeps its source, binding and independent timeline together. The Project files Undo button does not remove a newly added template.

If the project already had source Undo history when a template was added, Undo stops at that creation boundary. The button is disabled there, and a visible explanation says that earlier history is retained. The earlier snapshots are not cleared or silently consumed. They remain subject to the existing session-local history limits and normal oldest-first eviction as further work is recorded; they are not a cross-session backup.

Source edits made after adding a template can still be undone, one edit at a time. When those edits have all been undone, the creation-boundary explanation appears again. Timeline edits have their own Undo and are never erased by this source-history boundary.

To remove a template document, use the normal confirmed deletion action in Project files. Its deletion recovery retains the binding and timeline for Undo within the existing history budget. Source Undo does not jump past creation to remove a template, discard its later timeline work or revert an unrelated older edit.

Creation checks that its small boundary marker fits the bounded history budget before creating source. If it cannot fit, creation reports the problem and leaves the project and earlier history unchanged. A successful creation whose preview cannot open is still saved and protected; retry opening the saved instance rather than creating it again.
