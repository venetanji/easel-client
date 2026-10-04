# Generation-control rollout and local verification

This is a coordinated change across `venetanji/easel` (server), `easel-cli`,
`easel-client` and `creative-skills`. Review the linked draft PRs before merging.
A pushed branch or passed test does not deploy the API, publish a client release,
or establish GPU/visual validation.

## One client checkout

The `feat/agent-generation-controls-20261003` client branch includes the video
editor and its reviewed UI polish plus typed generation controls and local
verification. After the branch is published, use a clean checkout:

```sh
git fetch origin
git switch --track origin/feat/agent-generation-controls-20261003
npm ci
npm run build
npm test
npm start
```

If already on that branch, use `git pull --ff-only`. Preserve any local edits
before switching; do not reset them. Create a **new Video editor project** to
use updated template controls. Existing project-authored HTML/CSS/JS is preserved
and is not automatically migrated.

Use the app's existing model/endpoint settings for normal generation. The test
runner below intentionally uses only a key in the local terminal environment,
not the app's saved settings. No key needs to be shared in chat or committed.

## Instructions for a session on the API server

1. Inspect the running checkout, branch and deployment method. Record the current
   commit as the rollback target. Check for local edits and preserve them.
2. Review the server generation-controls PR and its `VIDEO_API.md` and
   `GRAPH_PROVENANCE.md`. After the owner approves the chosen revision, fetch and
   check out that revision. If the PR is merged, a normal fast-forward pull of
   `main` is sufficient; do not assume a merge occurred.
3. Preserve the existing `.env`/secret configuration and `image-jobs` persistent
   volume. The change adds Pillow as a runtime dependency to validate still
   guides. Use the committed `uv.lock`; do not install unpinned ad-hoc models.
4. Run offline checks in the server checkout (`uv run --group dev pytest -q`),
   excluding any opt-in integration environment variables unless a real backend
   test is intentionally authorized. Confirm `uv lock --check` succeeds.
5. If the existing service uses this repository's Docker Compose deployment,
   validate with `docker compose config --quiet`, then have the owner run
   `docker compose up -d --build easel`. Do not run `down -v`, remove model files,
   reset secrets or alter ComfyUI network/security settings. Other deployment
   methods should retain their existing process manager and persistent paths.
6. Check local `/health`, then the authenticated discovery endpoints from the
   intended client: `/v1/models`, `/v1/videos/capabilities`, `/v1/videos/loras`.
   The new capability object must report `schema_version:1` and the expected
   model/limits. `guiding_frames.available:true` requires compatible actual
   AddGuide/CropGuides input types, output slots and numeric ranges. If false,
   inspect the installed ComfyUI node versions instead of submitting a guide job.
7. For adapters, separately confirm `supported`, `installed`, required inputs and
   validation evidence. Do not download arbitrary weights or enable currently
   unsupported IC workflows as part of this deployment.
8. Keep the recorded rollback revision and persistent volume intact. Report the
   deployed commit, health/discovery results and any unavailable nodes without
   including secrets. Deployment success alone is not a successful generation.

The assistant did not access or deploy this server. These are handoff steps for
an owner-controlled server session. Read-only discovery may show that many
existing LoRA options were already deployed; the new timed-guide path still
needs this change and compatible ComfyUI nodes.

## Safe local key setup and read-only probe

In **Bash**, with shell tracing disabled:

```sh
set +x
export EASEL_BASE_URL='https://easel.ait4x.org'
read -r -s -p 'Easel API key: ' EASEL_API_KEY; printf '\n'
export EASEL_API_KEY
node scripts/test-live-video-workflow.cjs --probe
```

Use your actual authorized deployment URL. The prompt hides input; the key stays
in that process environment. Do not paste it into chat, command arguments,
source, screenshots or reports. `--probe` only reads metadata and never uploads
or generates. If it reports an old/missing capability schema, finish the server
rollout before running advanced scenarios.

## Explicit live pilots

Only run a pilot after accepting the provider/GPU cost and inspecting discovery.
Each command separately authorizes at most **two 1-second 512×320 jobs**:

```sh
node scripts/test-live-video-workflow.cjs --live --allow-generation-cost --scenario camera
node scripts/test-live-video-workflow.cjs --live --allow-generation-cost --scenario guided-frames
```

Run one scenario at a time. There is no price in the API contract or enforced
monetary cap. The guide scenario uses a committed synthetic still, not personal
media, and exercises transport/graph/export behavior rather than visual fidelity.
It does not establish seamless joins. No live pilots were run during development.

Accepted receipts are saved before polling. If interrupted, use the exact
printed evidence directory:

```sh
node scripts/test-live-video-workflow.cjs --resume /path/to/saved-evidence
```

Resume is GET-only. Never launch a replacement because a POST response was lost
or a poll timed out. Stop does not cancel backend work. Keep the original IDs
and inspect queue/history for ambiguous submissions. Unset the process key when
finished (`unset EASEL_API_KEY`). See [full test coverage and recovery](live-video-testing.md).
