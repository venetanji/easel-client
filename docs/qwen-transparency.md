# Qwen transparent images

Enable **Qwen Transparent Images** in the app's Skills picker for transparent
overlays, cutouts, stickers, and sprites. **Easel Media** includes the same
prompting and alpha-verification recipe alongside the broader media workflows.
These skills are opt-in; only selected skills accompany an agent request.
Previously imported skills are local copies. To refresh one, preserve any custom
edits, remove the old local copy from Skills, add the updated bundled skill, and
enable it. Importing a `SKILL.md` file creates a separate local copy.

## Prompt and verify

Qwen's official recommended format is:

> This is an RGBA image with transparency. <foreground description>. The image has alpha channel and the background is transparent.

Use the exact enabled model ID from `list_models`; configured IDs may have an
endpoint prefix. Describe the foreground and transparent margins between the
two sentences. Preserve requested text exactly and respect the user's generation
limit. Accepted asynchronous jobs finish through the existing host monitor.

Once an image is available, inspect its appearance and decode the original PNG's
alpha channel. The skill supplies a detached-canvas probe for the existing
`execute_canvas_javascript` tool. It does not append visible content, persist
source, or edit the timeline. For an existing image, use its saved asset ID
without generating a replacement. If the probe is unavailable or fails, report
that limitation instead of claiming transparency from the preview alone.

A white or purple visual preview can conceal a transparent alpha channel.
Opaque text or icon pixels are expected. Sampled margin bands count as background
evidence only when inspection confirms that they contain no foreground content.
Distinguish usable transparency from exact zero alpha: Qwen can leave faint
residual opacity even with the official prompt. Do not repeat a billed generation
on visual uncertainty alone.

## Live agent validation

Tested on 2026-10-05 through CDP on PR10's packaged build (`ae57313`), with the
built-in `gpt-6-luna` agent and configured `qwen-image-2.1` endpoint. Each of four
generation trials used a fresh chat and one image call, with no retries or
reference edits. A fifth fresh chat verified an existing text PNG only.

| Instructions | Official format | Empty top/bottom margin alpha (0-255) | Agent result |
| --- | --- | --- | --- |
| No active skill | No | 255 throughout | Could not verify transparency |
| Existing media skill | No | 0-4, mean 0.552 | Incorrectly called the preview opaque purple |
| Initial media instruction revision | Yes | 0-5, mean 0.544 | Skipped numerical verification; incorrect visual assessment |
| Final focused skill, paw icon | Yes | 0-4, mean 0.546 | Automatically measured alpha and accurately disclosed residue |

The final focused skill is bundled unchanged from the passing trial. Its fresh
generation used the official wrapper and automatically called
`inspect_media_asset` followed by `execute_canvas_javascript`. All four corner
pixels had alpha 0. The agent's numerical results matched independent FFmpeg
decoding exactly. The verification-only text chat also ran the probe without
another generation and matched the independent decoder: corner alpha 0,
empty margin alpha 0-5, mean 0.544.

The final mandatory-verification recipe is also included in Easel Media. The
complete revised media skill has not had a separate live generation trial.
Earlier direct MCP tests with the official format produced transparent cutouts
in three outputs. These limited samples do not establish a success rate or
guarantee perfect zero-alpha backgrounds. The agent trials identified prompting
and verification gaps; they did not demonstrate client-side alpha flattening.

Offline regression checks verify that both skills are supported and reach the
agent without truncation. A Chromium test executes the documented probe on PNGs
with known transparent margins, faint residue, opaque foregrounds, an opaque
background, and a one-pixel image, and checks that the visible DOM is unchanged.

Official reference:
https://github.com/QwenLM/Qwen-Image-2.1#transparent-image-generation-rgba
