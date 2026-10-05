# Client PR integration: October 4, 2026

This branch combines the existing client changes into one reviewable pull request.
It does not contain the upcoming Templates/Strudel feature or a licensing change.

## Source manifest

The branch starts at main `a38c1e59978ad492663cd9560e2c7815fff21fa4`.
Normal merge commits preserve all source histories:

- #8, setup bounds and Linux keyring: `52e4aa8fb54f092d4d9f7c570a9f8b4c1da952b9`
- #6, editable video editor: `b711ea6ca8ea825eab162ef14a1669fa71c029d9`
- #5, probe/design source, already contained in #6: `e707cec5950307a55b5065ebf7775ed00ce3bdf7`
- #9, simplified editor and stitching guidance: `e0f8ea16b0b8c3d9f2d95fb5f9dc052e5fe2a630`
- #7, typed advanced generation controls: `1445be5f12c16764c896e67f753a100c70b3b6c8`

The separate unpublished combined branch ending at `80c6c27` is excluded.
Selected-range guide capture, agent track-reorder additions and the canceled
server-test handoff from that unpublished work are not claimed here.

## Integration decisions

- Preserve #9's concise shared instructions, revision-safe hard cuts, source/frame
  arithmetic and user-driven export; add #7's real discovery and typed controls.
- Correct auto-merged stitching text to permit LTX timed still guides, including
  first/last positions, without claiming guide-video/audio upload support or exact
  endpoint pixels. Still-reference modes remain mutually exclusive.
- Preserve setup fixes alongside editor preview, timeline controls, media import,
  managed references, source immutability and persistent undo/redo.
- Repair the inherited research probe's failure termination and stale-output
  handling. These are probe reliability fixes, not new export features.

## Validation boundaries

The integration PR records the final exact-head test, build, review and CI results.
Tests use synthetic/offline fixtures; no paid generation is part of integration.
Automated browser/native fixtures do not substitute for owner live-app/CDP testing
or target-platform visual/audio review. Create a new Video editor project to test
updated template sources; existing authored HTML/CSS/JS is intentionally preserved.

## Owner merge and cleanup checklist

- [ ] Review the final integration head and its Test/Desktop Builds results.
- [ ] Complete desired live-app checks on a new and an existing project.
- [ ] Merge only the integration PR when satisfied. A normal merge preserves
      source ancestry; a squash still preserves code but not original ancestry.
- [ ] Verify main contains the integrated functionality before closing #5–9 as
      incorporated (some may close automatically when their commits reach main).
- [ ] Do not delete original branches until any remaining dependent work is safe.
- [ ] Start the Templates/Strudel feature from that refreshed main, or explicitly
      stack it on the tested integration head if main is not merged yet.

No existing PR is closed or merged by creating this integration branch.
