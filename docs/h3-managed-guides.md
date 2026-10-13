# H3 saved frame guides

Desktop `generate_video` now resolves `semanticReferenceAssetIds` and
`temporalGroups: [{frameIndex,imageAssetIds}]` through the same managed image
reader as LTX guides. The existing MCP serializer uploads each role separately,
including when one saved ID appears in both roles. Canonical selected-model
capabilities gate profile availability, counts, frame bounds and the frame grid.
First-image IA2V and LTX `guidingFrames` keep their existing inputs.

Requires an Easel server advertising H3 reference capabilities. No server change
is needed for this adapter. Prompt guidance remains server-owned through
`get_model_guide`; the common extraction recipe is in
[the media skill](../.agents/skills/easel-media/SKILL.md).

## Local session

With Node >=22, check out `feat/h3-managed-frame-groups`, run `npm ci`,
`npm test`, `npm run build`, then `npm start`. Use your normal local endpoint
settings; refresh Models, import/attach the source media, and start a fresh chat.
No credentials belong in test prompts or repository files.

Paste this after selecting your intended H3 endpoint and importing a short clip:

> Test H3 saved frame guidance using my imported clip. Discover the exact model's
> capabilities and fetch its guide first. Inspect the source, extract five
> successive stills using the existing extraction tool, check their returned
> timestamps and retain their order. Propose a short shot using those five images
> as one temporal group and one of them as a semantic reference. Use the
> advertised frame grid and limits. Show me the planned model, frames, output
> size and guide positions before I authorize generation. Preserve all requested
> conditioning if an asset or capability is unavailable. After authorization,
> submit once, keep the accepted job ID and let the host finish. Review the saved
> result for identity, motion and boundary continuity; do not promise exact pixels
> or seamless stitching.

Repeat with a single still if desired. Source audio can be added with the existing
`sourceAudioAssetId` when current exact-model availability permits it. Desktop
interaction and billed rendering are manual checks, separate from offline tests.

## Offline verification

`npm test` includes managed-asset routing, canonical capability fixture limits,
cancellation, malformed/mismatched requests, audio preservation and production
multipart serialization (ordered indices and duplicated semantic uploads).
From an Easel server checkout, enable the actual consumer/server contract suite:

```sh
EASEL_MEDIA_MCP_SOURCE=/absolute/path/to/easel-client uv run --group dev pytest -q tests/test_mcp_contract.py
```

These tests need ffmpeg/ffprobe for audio cases, not service credentials.
