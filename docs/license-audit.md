# GPL alignment and HyperFrames removal (5 October 2026)

Status: **Easel-owned source aligned to GPL-3.0-or-later; imported HyperFrames
material removed. Release-specific distribution gates remain.** This is an
engineering provenance review, not a legal guarantee or authorization to release.

## Scope and change

The audited base is `edd8aeda5f3033aeeb0cae2b9b9744af6deed5a9`, refreshed against
origin/main before this change. The root package and `packages/media-mcp` now
declare GPL-3.0-or-later, with full GPLv3 LICENSE files, scoped NOTICE files and
matching lock metadata. The grant applies only to material the maintainer has
the right to license. Historical root package metadata declared ISC; no earlier
grant is revoked. Git author names are not proof of ownership.

Exactly the 28 directories whose `skills-lock.json` source was
`heygen-com/hyperframes` were removed, along with those lock entries: 1,064 tracked
files. Five Easel-native skills remain. `license-inventory.json` keeps removed
import metadata and 22 old notice hashes as explicitly historical evidence, not
as an inventory of files still shipped. It records current retained notices and
root/workspace direct locked dependencies; it is not a complete transitive SBOM.

All previously identified imported GSAP binaries/references, Pixabay MP3s,
embedded/standalone fonts, Frost images, motion-primitives texture collections,
LUT/embedded asset data and bundled HyperFrames vendor code were inside those
28 directories. No such material was found outside that removal set. Removing
the material resolves those current-tree distribution questions by exclusion;
it does not clear earlier packages or relicense removed content.

The native host, timeline and runtime-kit builders have no GSAP dependency.
This change adds no replacement animation engine. Historical research, plans
and specifications are left intact. The README describes the current removal.
A shared names-only compatibility list keeps previously saved HyperFrames copies
disabled in both the renderer and host even after their installed catalog entries
disappear; saved user instructions are not deleted or rewritten.

## Remaining source and asset provenance

The audit inspected source notices, import history, lock metadata, remaining
tracked file types and packaged build routes rather than relying only on authors:

- Initial host code entered in `d9c1fcb1d412956ff6290937fd19242156da0bac`.
  No other restrictive license header was found in retained host/MCP/scripts/tests.
  This is repository lineage evidence, not independent chain-of-title proof.
- The current outline app mark comes from `build/icon.svg`, introduced in
  `e43990003f8c60e0a084a205eec78cc36c4295cf`. `build/README.md` identifies the
  user-selected mark; `scripts/build-app-icons.py` and
  `scripts/render-app-icon.cjs` regenerate the committed platform icons.
  The older fluffy icon was replaced. The inline header mark entered in
  `096bdc9d93441f069310a4d58a59897d5b02ea63`; short UI SVG paths entered in
  `715cd563ccbefe20ee056d9c74afe31f50937092`. No third-party icon-set import
  or attribution is recorded.
- `test/fixtures/video-export/{red.mp4,blue.mp4,tone.wav,overlay.png}` entered
  with their README in `f6f66b9634d99f141ac3dad54b79d1c9be23b157`.
  That README declares original flat-color/tone fixtures and gives generation
  commands. They are not stock or user media. FFmpeg is a development generator,
  not a new bundled dependency in this change.
- `easel-media` entered in `bd7871b89cadf32193c4ef8270551576b9eeb580`;
  `easel-audio`, `easel-canvas`, `easel-p5` and `easel-three` entered in
  `784a498c716ebdfa2cfefccea1d2ec0a6cb77f9a`. They are Easel-specific guidance,
  without imported asset libraries. An 18-token sequence comparison found only
  generic HTML boilerplate shared with the removed material. This supports but
  does not prove absence of copied implementation.
- `easel-media/references/prompting-and-review.md` explicitly adapts
  **creative-skills** practices. Its known MIT copyright/grant is preserved in
  `licenses/creative-skills-MIT.txt`, with a scoped skill NOTICE. The license is
  verified at published creative-skills revision
  `67f185c8f95182690e1ac56e734aa649f71b4df6`, license blob
  `26daa8e909e25292eaf5a70a1b9eced041c20d9e`. The historical handoff names
  `0e208b2`, which was not publicly retrievable; exact adaptation lineage remains
  unverified. The known compatible grant and attribution are retained without
  claiming the unavailable revision's contents or labeling all adapted prose new.
- `easel-media/references/lora-catalog.json` is byte-identical to server
  `10f118a818615595d53521d0ddae02b9c1d14d27:easel/video_loras.json`:
  SHA-256 `3faba4af15374f19d833556527ba77efb6fc22d18318cf43fdec1608f92af556`.
  It contains descriptive adapter metadata, not weights. GPL licensing of the
  application does not license referenced external models.

## Third-party runtime boundaries

No runtime-kit builder or vendor library was removed or relicensed.

- p5 2.3.4 retains LGPL-2.1; the builder preserves full license text, an unminified
  `p5.source.js` copy and the exact upstream source reference.
- Mediabunny 1.61.0 retains MPL-2.0; its bundle preserves the full license and exact
  version/source reference. Its installed npm package supplies source and license.
- Three, Phaser, Matter, Tone and their bundled components retain upstream
  copyright/license text. MIT/Apache npm dependencies keep their terms and notices.
- Electron/Chromium licenses must remain with desktop binaries. Inspect the actual
  installed transitive packages in each final artifact, not only lock metadata.

The independent Strudel feature is not part of this base/change. If integrated,
preserve AGPL-3.0-or-later, full transitive notices, preferred source, patches and
build materials. Do not label Strudel GPL-only. Its source/network obligations and
any exported JavaScript bundles need their own artifact-level review.

## Packaging and corresponding source

Electron packaging explicitly includes root/workspace LICENSE and NOTICE files,
`licenses/**/*`, the audit/inventory, retained Easel skills and the existing
runtime bundles. Standalone MCP npm packaging and the headless workflow tarball
include package LICENSE and NOTICE. The creative-skills adaptation and its MIT
notice ship only with the app/retained skill, not the standalone MCP code.

Before distributing GPL binaries, supply matching preferred Corresponding Source,
exact revision/lockfiles, local modifications, build/install scripts and required
materials through an applicable GPL section 6 route. A moving main URL or an
unverified source link is insufficient. Preserve separate third-party notice and
source obligations; minified bundles are not automatically preferred source.
Never include credentials, private projects, user media or unrelated private code.
No release, tag, merge, deployment or store submission is part of this change.

## Verification

Verification results are recorded here after running checks on the changed tree.
Focused removal/license/legacy-copy checks were observed failing before fixes.
The initial broad red run also encountered a missing Markdown dependency while
installation was still running; that environment failure disappeared after
`npm ci` completed.

- `npm run build` passed: release-version guard, MCP TypeScript, canvas kits and
  pinned Mediabunny bundle. The generated Mediabunny bundle is 453,462 bytes.
- The root JavaScript test suite passed: 618 passed, 2 skipped. The ordinary `npm test` command reaches
  the workspace stage but `tsx --test` cannot open its local IPC pipe in this
  sandbox (`listen EPERM`). Running the same workspace tests with
  `node --import tsx --test test/*.test.ts` passed: 38 passed, 1 skipped.
  This is not reported as an unqualified `npm test` pass.
- A Linux x64 `electron-builder --dir` package completed using the installed
  Electron 44.4.5 distribution. Its existing afterPack hook passed isolated MCP
  startup, tool discovery and empty model listing.
- Actual `app.asar` contents were inspected: root/workspace LICENSE and NOTICE
  bytes, creative-skills MIT text, skill attribution, audit/inventory, all five
  retained skills, p5 license/unminified copy and Mediabunny MPL text were present.
  All 28 removed directory prefixes were absent. Mediabunny source/LICENSE
  remained in unpacked node_modules; Electron and Chromium notice files remained
  beside the executable.
- Actual root npm, workspace npm and headless workflow tar archives were opened.
  LICENSE and NOTICE bytes were checked, and removed skill paths were absent.
  The standalone MCP npm archive has 24 files; the headless tar has 25 entries.
- This does not validate the full Electron UI, live media/GPU generation,
  Windows/macOS packaging, signing, or final release Corresponding Source delivery.
  Existing conditional integration/browser tests remain skipped when unavailable.

## Primary sources

- [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)
- [GNU license FAQ](https://www.gnu.org/licenses/gpl-faq.html)
- [Retained creative-skills MIT license](https://github.com/venetanji/creative-skills/blob/67f185c8f95182690e1ac56e734aa649f71b4df6/LICENSE)
- [p5 2.3.4 source](https://github.com/processing/p5.js/tree/v2.3.4)
- [Mediabunny 1.61.0 source](https://github.com/Vanilagy/mediabunny/tree/v1.61.0)

## Unreleased Strudel integration addendum (5 October 2026)

The template foundation from `8de2e635a8a501e2806d9b182e6ec41f58055398`
has been integrated with GPL/HyperFrames-removal main
`9931a8045d13a00fe872972f141bb5e997839c1e`. The original audit and verification
above describe the earlier base; they are retained as historical evidence and
do not certify this combined tree or any release artifact.

The direct dependency inventory now includes pinned `@strudel/web` 1.3.0 as
AGPL-3.0-or-later. Its vendor license, dependency notices and source terms remain
separate from the Easel-owned GPL declaration. The runtime and opaque
`canvas-kits/strudel-source.zip` both remain in the desktop packaging manifest.
The archive's `easel/` source inputs now preserve the root and MCP workspace
LICENSE/NOTICE files and the retained creative-skills MIT grant byte-for-byte;
existing upstream source packages, notice supplements and input hashes remain.
The archive's license-preservation and real Electron filter/rebuild regressions
cover this integration boundary.

This is an unreleased, incomplete template foundation. The missing
`chord-voicings` notice, final corresponding-source review, sandboxed Strudel
renderer proof and final artifact-level distribution checks remain open. No
upstream license is replaced, no release clearance is claimed, and no binary
release is authorized by this integration. See
[strudel-compatibility.md](strudel-compatibility.md) for source provenance,
packaging contracts and the remaining runtime/source gates.

## Latest-main Qwen guidance addendum (5 October 2026)

The subsequent main revision `6044a6b861f8f10d439fa47abdac8d872d8067d6`
merged the Qwen transparency guidance originally introduced by
`c31fa867de5c13b05b6934c82a063b8ccf13f5c2`. The retained-skill inventory now also
lists `.agents/skills/qwen-transparent-images/SKILL.md`; that source and the
matching alpha-verification recipe in `.agents/skills/easel-media/SKILL.md`
are preserved byte-for-byte from the merged main. This records source provenance,
not an independent ownership or licensing determination. The original five-skill
audit above remains historical evidence. Existing license/notice files and their
hashes are unchanged; no new grant or vendor relabeling is asserted.

## Strudel Runtime and Sample Update (9 October 2026)

The 5 October unreleased-foundation addendum is historical. Strudel shipped in
0.0.6 and 0.0.7. PR #19 at `377361949ab955452d20c57fbae126b19dee8825` passes
the native renderer/production WAV probe and Windows, macOS and Linux packaging;
see the dated [compatibility evidence](strudel-compatibility.md). Runtime proof
is no longer pending. The original procedural drum bank, generator and sample
adapter are retained in the pinned kit's corresponding-source archive.

The existing `chord-voicings@0.0.1` notice gap remains: the exact npm gitHead
`447ee7932851562dcfc480f54f5011430174a30d` declares ISC, but its source tree and
the current upstream repository contain no LICENSE file. The exact source,
package metadata and prior verification remain retained under
`build/strudel-notices/`; no notice text or copyright year has been invented.
Runtime and packaging results do not close that gap or replace final
artifact/source review.
