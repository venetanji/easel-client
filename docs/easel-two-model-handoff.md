# Two-Model Easel and Media Skill Handoff

## Scope and status

This draft PR packages agent guidance and the implementation handoff requested
for another session. It does not retire server models, change MCP schemas,
deploy Easel, restart ComfyUI, download weights or submit GPU jobs.

Target: serve only `qwen-image-2.1` (image generation/reference editing) and
`ltx-2.5` (video). The request said `flux-2.5`; this handoff assumes LTX-2.5,
the existing video model. Do not introduce a fictitious Flux alias. Clarify with
the user if they actually intend a different base model.

Preserve the existing v0.0.2 durable receipt/monitor workflow, expose validated
advanced features, and keep the easel-media skill honest about availability.
Adapters are options on LTX-2.5, not additional served base models. Do not remove
other providers or native Codex generation from this multi-endpoint client.

## Verified starting point

- Client `main` / v0.0.2: `2c2ae89`; release published October 1, 2026.
- Live Easel discovery currently returns `flux2-9b`, `flux2-4b`,
  `qwen-image-2.1` and `ltx-2.5`. Both ComfyUI queues were idle at inspection;
  recheck before any operational change.
- Server checkout: `/home/venetanji/dev/easel`, HEAD `7def1c5`, with substantial
  pre-existing uncommitted async-image, video-adapter and queue work. Preserve
  those changes. Advanced behavior below comes from that working tree, not
  necessarily published server `main`.
- The local `/home/venetanji/dev/creative-skills` checkout also has existing
  modifications and older guides. The clean canonical source used for newer
  profile/guide guidance is `/home/venetanji/dev/agentic-media/creative-skills`,
  revision `0e208b2`.
- GPU 0: RTX 3080 Ti, 12 GiB, primary ComfyUI. GPU 1: RTX 3090, 24 GiB,
  video ComfyUI. These are different physical devices; do not assume one shared
  GPU or serialize both queues unnecessarily. They share model/custom-node
  storage, not automatically scheduler state.

The bundled `references/lora-catalog.json` is a byte-for-byte snapshot of the
server's unpublished `easel/video_loras.json`: 38 entries, SHA256
`3faba4af15374f19d833556527ba77efb6fc22d18318cf43fdec1608f92af556`.
It records pinned filenames, revisions, sizes, checksums, requirements and
validation. It deliberately contains no credentials, weights or generated media.
Live discovery remains authoritative for installation/support after deployment.

The client skill loader (`src/skill-catalog.js`) injects only `SKILL.md`, not
linked reference files. The entrypoint therefore includes compact creative
practices, camera/guide boundaries and all 38 IDs within its 32,000-character
instruction budget. Supporting resources are additional detail for file-aware
agents; do not assume in-app agents have filesystem tools to read them.

## 1. Retire Flux in the server without losing accepted jobs

Server files: `easel/config.py`, `easel/app.py`, `.env.example`, `compose.yaml`,
`tests/test_config.py`, `tests/test_app.py`, `tests/test_image_jobs.py` and
integration tests. The server currently defines both Flux IDs in `MODELS` and
uses `DEFAULT_MODEL = "flux2-9b"`.

- Remove Flux IDs from new-request discovery/resolution; default omitted image
  models to Qwen. `/v1/models` must return exactly Qwen and LTX in the intended
  deployment with a configured video backend. Explicit retired IDs must fail
  with a model error, never silently become Qwen.
- Keep retrieval of previously accepted Flux image receipts/cached content
  working through its original 24-hour retention. Retirement controls new
  admission, not cache/history deletion or automatic replacement submissions.
- Preserve the `EASEL_JOB_DIR` SQLite store and Compose `image-jobs` volume.
  Do not delete old weights, receipts, output, backups or unrelated state.
- Retain Qwen's model-specific 25-step default, VAE/text encoder, reference
  editing/cache path and up-to-16 reference inputs. Do not inherit Flux's global
  8-step setting. LTX's distilled two-pass graph remains 8+3 steps.
- Rename legacy `COMFY_URL_FLUX` only with backward-compatible configuration
  handling and documented precedence. Do not break deployment because an env
  var's name contains Flux. Stop choosing production backend placement through
  an agent-supplied `server` override; make supported routing server-owned.

## 2. Measure backend placement and preserve queue semantics

Current image requests default to the primary backend unless their server-only
`server` field selects video; v0.0.2 MCP does not expose that field. Qwen and LTX
can therefore end up on different GPUs or compete on the 24 GiB backend.
Do not call either placement optimal without measuring memory and latency.

Start with the existing ComfyUI FIFO queues. Benchmark one representative Qwen
generation/edit and one short LTX shot, then a mixed queue at approved sizes.
Record cold/warm load time, total latency, offload/peak memory and OOMs. Prefer
independent execution on the two GPUs if Qwen is viable on 12 GiB; otherwise
route both to the capable device and serialize through its actual backend queue.
Do not raise concurrent GPU execution just because clients submit async jobs.

When logical image/video routes share one physical queue, share capacity,
queue snapshots and estimates by real backend identity. Current image admission
is durable/atomic with eight async reservations per logical backend; video
admission has a separate eight-job queue cap. `COMFY_MAX_INFLIGHT` limits
synchronous requests, not those async queues. Aliasing URLs without unified
admission can double-count capacity. Test mixed external ComfyUI jobs too.

Use bounded, fair admission and `429` / `Retry-After`, not client spin-polling.
Batch related Qwen image prompts to avoid repeated submissions/model setup;
benchmark batches before offering the maximum at large sizes. Add model-affinity
reordering only if measured benefits justify it, preserving durable IDs and
bounded waiting for the other model. No queue flush, duplicate dispatcher or
invented percent-progress/ETA is needed for this migration.

Image status/content is persisted; the worker caches terminal successful output
even after client disconnect. Video IDs encode their upstream prompt and still
depend on retained ComfyUI history/output. Image ID/cache survival does not mean
video output survives a backend history purge. GETs must never generate anew.

## 3. Keep the v0.0.2 host monitor as the owner of accepted jobs

Client files: `src/media-job-store.js`, `src/media-job-monitor.js`,
`src/media-job-worker.js`, `src/media-job-worker-client.js`,
`packages/media-mcp/src/media-job.ts`, `src/media-tool-results.js` and the
existing media-job tests.

- Persist `{remoteId, modelId, endpointId, projectId, conversation}` before the
  acceptance turn ends. Poll/download in the host worker, not repeated agent
  calls. Keep original endpoint routing for jobs whose model is now disabled.
- Preserve five-second polling/error backoff, reusable MCP connections,
  restart recovery, contiguous asset checkpoints and attachment retry without
  duplicate downloads. Consider batched status discovery separately only if
  measurements show many pending jobs make polling a bottleneck.
- Completion attaches media to the original project and enqueues a durable
  notification. Resume only the eligible original idle conversation; Stop
  suppresses agent continuation but does not stop remote work or downloads.
- Removing a card forgets monitoring only after confirmation. Failed download
  retrieval retains the accepted ID; it never becomes a regeneration request.
- Keep ambiguous POST failures non-retryable automatically; the server has no
  idempotency-key recovery or cancellation contract. Retry read-only retrieval
  with bounded backoff, not generation.

## 4. Fix multiprompt output limits before advertising 16

The server's `plan_prompts` splits `|||`, drops empty parts and caps at 16.
More than one part produces one image per part with batch size 1, **ignoring
`n`**, rather than multiplying prompt count by `n`. One part keeps `n` (1-4).
Reference edits apply the same references to every segment. It is not video
multi-shot prompting.

Blocker: `packages/media-mcp/src/easel.ts` uses `MAX_IMAGES = 4` for both request
`n` validation and response parsing. Both `generateImages` and
`parseEditedImages` reject larger output; `getImageJob` uses the latter. A valid
16-output server job therefore cannot finish downloading through v0.0.2.

Separate request-count and response/fan-out caps. Preserve `n <= 4`, prompt length
and binary/combined-download limits; permit a bounded 16-output Easel batch
through generation, editing, completed-job retrieval, checkpointing and previews.
Do not blindly increase all generic-provider limits. Test 2/4/16 outputs, the
17-output rejection, empty segments, ignored `n`, common edit references,
synchronous/queued output and recovery after a partial asset-save failure.
Only then change the skill's current four-segment warning.

## 5. Expose adapter discovery and supported fields end to end

Files: `packages/media-mcp/src/server.ts`, `packages/media-mcp/src/video.ts`,
`src/media-mcp-client.js`, `src/media-reference-tools.js`, package README,
video/server/configured-model tests and reference-resolution tests.

Add authenticated adapter discovery through configured model routing and an
allowlisted MCP tool. Return requirements, support, installation and validation
without credentials. Use live registry IDs rather than arbitrary model paths.
Do not enable all 38 adapters merely because they are listed or installed.

Expose server-supported camera selection/strength, registered LoRA stacks,
motion speed, seed and Ingredients reference/strength as typed MCP arguments.
Use structured adapter selections, serializing the server's JSON-string `loras`
field in the transport. In-app sheet input must use a saved asset ID resolved
by the host; standalone input uses a bounded image upload. Keep snake_case
wire fields out of agent argument guessing. Validate required inputs and
conflicting/duplicate selections locally and again on the server.

Supported server snapshot: seven cameras plus Cinemagraph, Slow Motion and
Ingredients. Camera shorthand defaults to strength 0.8; strengths are finite
0-2, at most four total adapters. Cinemagraph needs an image and rejects moving
cameras; Slow Motion needs image + speed 0.025-1; Ingredients needs a separate
sheet, >=5 seconds, sheet strength 0-1 and no stack. Installation/execution
evidence is not a visual-fidelity certification. Keep unsupported V2V entries
discoverable but disabled, with targeted explanations.

## 6. Implement guide-video workflows before making them callable

Current API/MCP has no reference-video control endpoint. The canonical
creative-skills profile path also rejects arbitrary Union/IC control-video
options; verified prototype graphs are evidence, not a typed portable API.
Promote reviewed workflow knowledge into canonical `creative_comfy_graph`
builders/contracts and consume it from Easel rather than duplicating mutable
ComfyUI graph recipes across client, skill and server.

Design typed source-video/control-kind/strength/FPS/frame-span fields and
bounded asset upload/resolution. Preserve full guide provenance and reject
missing nodes/weights, incompatible families or wrong dimensions/FPS before
uploads and submission. Keep RGB appearance anchors distinct from depth,
Canny and pose guides. Test IC loader metadata, per-workflow guide placement,
guide-token crops before upscale/decode and source-audio alignment.

Refine Details needs its specialized tiled-fusion workflow, not only an ordinary
LoRA patch. The durable creative-agent note reports that upstream custom nodes
were subsequently upgraded to `bf2ca0264f706db64cb8931155695ca481fc9d91` and the
fusion/tiling nodes registered. This supersedes the older missing-node section
in local `VIDEO_LORAS.md`; re-inspect actual `/object_info` rather than repeating
the upgrade. Node presence still does not establish a live V2V render.

Use one bounded, approved pilot per promoted workflow, inspect actual output,
and update registry `supported`/validation only with evidence. Do not restart
shared backends, download all collections or replay historical experiments
automatically. Guide previews and weights stay out of Git.

## Acceptance checks and pickup

1. Review the dirty server worktree and document ownership before editing.
   Recheck live queues/GPU usage, current revisions and real tool schemas.
2. Finish server retirement/routing with tests for exactly two discovered
   models, Qwen default/steps, retired-ID rejection and old receipt retrieval.
3. Run mixed image/video async tests for atomic admission, queue backpressure,
   correct physical backend counts, external jobs, restart recovery, terminal
   output guards, ETA semantics and no duplicate POSTs on retries.
4. Upgrade fan-out parsing and advanced MCP/asset transport with mock tests;
   keep unrelated providers and disabled-model retrieval working.
5. Validate only promoted guide/adapter paths. Distinguish offline topology,
   real execution and reviewed visual fidelity in discovery and the skill.
6. Run `npm test`, `npm run build:media-mcp`, the skill validator and applicable
   server tests. Deploy in an idle window without deleting the persistent job
   volume; verify authenticated discovery/status/content and no job loss.

Primary implementation references:

- Server working tree: `IMAGE_JOBS.md`, `VIDEO_API.md`, `VIDEO_LORAS.md`,
  `easel/image_jobs.py`, `easel/video_loras.py`, `easel/video_graph.py`.
- Creative skills: `comfyui/references/ltx-prompt-guide.md`,
  `storyboard/references/prompting-guide.md`, `music-video/SKILL.md`,
  `comfy-graph/LTX-PROFILES.md`, `comfyui/references/webgl-video-guidance.md`.
- Durable deployment note:
  `/home/venetanji/.openclaw-gateway/workspace-creative-skills/memory/2026-09-30-easel-lora-handoff.md`.

These machine-local paths are handoff provenance, not portable runtime
dependencies of the bundled skill. Keep its references self-contained.
