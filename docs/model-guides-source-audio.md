# Model guides and source audio

Start a fresh desktop agent session after rebuilding/restarting the client so its
MCP tool schema includes `get_model_guide` and `sourceAudioAssetId`. Existing
imported skills are not overwritten; update an imported skill only intentionally.
The common built-in, embedded Codex and external instructions tell agents to
retrieve the selected model/mode guide before writing a prompt and reuse it
within the turn. The guide is reference content from the configured authenticated
API, with its original sources. An unavailable guide does not enable unsupported
arguments. Currently reviewed pairs are Qwen `generation`/`editing` and H3
`base`/`reference`; LTX may return an unavailable-guide error.

Apply the retrieved guide to the generation prompt itself, including its field
order and reference/alignment syntax. Image and video prompts describe the
intended media: subject, appearance, action, composition, camera, lighting and
sound. Generic agent directions such as "Create an image...", "Use the provided
image..." or "Continue from the previous video..." belong in the agent workflow,
not as prompt preambles. A guide-required alignment line remains part of the
model prompt. Reference asset IDs and uploads stay in the tool arguments.

Plan the requested/default video geometry before generating an anchor. Resolve
`size_constraints.aliases` and `size_presets` width/height from exact-model
capabilities, then match new anchors to that effective aspect ratio. Existing
references need a geometry check and the canonical model guide's fit guidance;
optional `capabilities.input_reference` describes first-image `fit`, `target`
and `configurable`. These fields survive client discovery unchanged. Explain
mismatches and known effects or unknown geometry/fit before submission. Preserve
requested output dimensions and source framing; omit video size unless requested
and never derive it from reference dimensions.

The companion [API PR #11](https://github.com/venetanji/easel/pull/11) documents
the existing H3 first-image stretch and LTX center-crop paths. It adds read-only
fit metadata and H3 base-guide wording without changing preprocessing or exposing
a fit selector. Reference bytes remain unchanged; prompt wording cannot override
preprocessing. This metadata applies only to ordinary first-image conditioning,
including source audio, not semantic references, timed guides or Ingredients.
Older endpoints still work; missing fit guidance must be reported as uncertainty.
The API changes must be deployed to the configured endpoint to appear in live
capabilities and guides.

For `generate_speech`, `prompt` is the literal spoken text. For example,
`prompt: "I would like some python please?"` and
`tone: "Deep, warm adult male voice; natural conversational delivery"` keep the
words separate from voice directions. Do not prepend "Say exactly:" or append
voice instructions to the text. If those phrases are themselves part of the
user's requested speech or visible image text, preserve them literally.

For a speech-driven H3 first-image example:

1. Use `list_models` to find the exact configured `minimax-h3` route, then
   `discover_video_capabilities` for that same ID. Require
   `source_audio.supported` and `source_audio.available` to be true.
2. Select real saved image and WAV IDs from `list_media_assets`. The WAV must
   cover at least `124 / 24 = 5.1667` seconds; longer audio is trimmed.
3. Fetch the H3 `base` guide. Submit `generate_video` once, using the exact
   configured model ID in this example and replacing both illustrative IDs. The
   prompt below is a visible-action brief: expand it with the freshly fetched H3
   base guide before submission, rather than treating it as a complete formatted
   H3 prompt:

```json
{
  "model": "minimax-h3",
  "prompt": "The person visibly articulates the supplied speech, with natural mouth movement and closed lips during brief pauses between phrases.",
  "inputReferenceAssetId": "REAL_SAVED_IMAGE_ID",
  "sourceAudioAssetId": "REAL_SAVED_WAV_ID",
  "size": "768x512",
  "frames": 124
}
```

Do not add `seconds` to H3. Desktop uploads the first image as `input_reference`
and audio as exactly one `source_audio`; standalone MCP accepts
`sourceAudio:{data,mimeType,name?}` with base64 bytes instead of saved IDs.
Audio conditions motion and becomes the trimmed normalized output soundtrack.
It is separate from Suno generation. Perfect lip synchronization is not promised
for arbitrary inputs. Preserve accepted receipts; the desktop host monitors and
saves the job without agent polling or automatic generation retries.

Audio and all image references have independent 32 MiB bounds. API audio inputs
include WAV, MP3, FLAC, Ogg and M4A (server MIME aliases apply); desktop uses
saved WAV/MP3/M4A. The server owns decoding, MIME/format consistency, 48 kHz
stereo normalization and duration coverage. LTX coverage is `(seconds*24+1)/24`.
Missing or unavailable audio must be reported, never silently omitted. Older
capability responses block supplied audio only; ordinary generation is unchanged.
Saved H3 semantic/temporal image-group adaptation and full reference/control
video uploads remain outside this desktop change.


### Pinned offline contract CI

The existing CI workflow now runs the consumer's production adapter against
server commit `796086b346937e6dda0d66f7bd44bbee789c0d51` from API PR #11 with fake backends and installed ffmpeg/ffprobe.
The client job builds Media MCP before running the server's MCP, model-guide and video-sizing suites;
the CLI job runs its local `contract/server_contract.py` with the server's dev
dependencies. An absent or invalid configured checkout fails the job.

The public `venetanji/easel` checkout uses only the existing GitHub token;
hosted checkout and contract verification have passed. If checkout fails, CI
fails visibly: no skip, alternate unpinned source, or new secret is added.
Local contract verification with all three checkouts succeeds independently
of hosted checkout access. These are protocol and graph tests, not GPU or
visual lip-sync verification.
