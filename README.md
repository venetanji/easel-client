# Easel Studio

A local-first Electron client for Easel canvases and media. Choose a built-in OpenAI-compatible agent, an external MCP controller, or embedded Codex. Prompts and conversation progress are saved on this device while a turn runs. The last conversation reopens on launch; the left rail opens **Chat** or a full-column **History** view with **New chat**. Choosing a saved conversation returns to Chat. Conversations are independent of projects: changing the current project keeps the conversation, and opening history keeps the current project.

## Video editor

Choose **New project → Template → Video editor**, or use **Video editor** above the canvas. It is a regular HTML/JavaScript/CSS project the built-in agent can modify. Import local images, audio and video, assemble a revision-safe timeline, select an exact range for chat, and export WebM locally with the bundled Mediabunny runtime. Media search, filters and sorting help find sources.

Timeline selections expose **Delete clip** or **Delete selected clips**. Delete/Backspace works while the selected clips or range own timeline focus; typing in fields is unaffected. Up to 100 selected clips can be deleted in one edit. Each track has **Delete track** with a clip count; deleting a populated track asks for confirmation and removes its clips in one edit, including tracks with more than 100 clips. Timeline **Undo** restores deleted clips and tracks. Source files stay in Media.

These controls are included in newly generated Video editor starters. Existing projects keep their editable HTML, JavaScript and CSS unchanged; opening them does not replace user-edited source.

See [the video editor guide](docs/video-editor.md) for laptop build instructions, supported editing/export limits and reproducible offline verification.

## Configure

New installations open a three-step setup wizard: choose an agent, add credentials or sign in, and select a chat model. For the built-in agent, choosing a model enables it and makes it active. Codex requires a signed-in account and a selected model; External MCP waits for a controller connection. Image and video endpoints are optional and do not replace a chat model. Use **Set up later** to skip, or **Settings > Setup wizard** to run it again. Existing configured installations keep their workspace on launch.

1. In **Settings > Credentials**, add any OpenAI-compatible endpoint and its API key, including Easel. Local endpoints can leave the key blank. Each connection can provide both text and image models; existing LiteLLM and Easel credentials carry over automatically.
2. **Settings > Models** discovers and groups models by endpoint. Enable the models you want. Read-only icons show automatic **Agent** and **Media** categories: muted icons are discovery suggestions and green icons are confirmed by **Check**. Check sends a Responses API tool call request and an image generation request, which may incur endpoint charges. Authentication, network, and ambiguous errors stay unverified and can be retried. New models start disabled; existing compatible selections carry over.
3. Choose an enabled **Agent** model from the model picker in chat. Enabled **Media** models are exposed through the agent's media tools, with generation routed to each model's endpoint and key. Image generation currently uses the OpenAI-compatible images API.

Keys are encrypted with Electron `safeStorage` and are decrypted in the main process for API requests and the local Media MCP process. The app fails closed if secure storage is unavailable. Credentials are shared by all models from their endpoint; categories are assigned per model. Video and audio generation models are not exposed as image generators solely because they share a media endpoint. Changing an endpoint URL or key clears its saved capability checks.

On Linux, Easel selects Secret Service/libsecret on non-KDE desktops, including Hyprland and Sway. KDE retains its wallet selection, and an explicit `--password-store` option takes precedence. The system keyring must be running and unlocked; restart Easel after unlocking it if secure storage was unavailable at launch. Easel does not enable plaintext key storage.

Saving credentials refreshes discovery automatically; **Refresh models** can repeat it. A successful refresh replaces that endpoint's catalog and removes models it no longer returns, preserving settings for models that remain. A failed refresh keeps the previous catalog and displays the error. OpenRouter discovery uses its authenticated `/models/user?output_modalities=all` catalog, which applies the key's provider, privacy and guardrail restrictions, rather than the public model list.

Assistant chat messages render Markdown, including lists, headings, code blocks, and tables. Raw HTML is displayed as text, generated asset links use local previews, and HTTP(S) links open in your browser.

Harness instructions travel separately from conversation input through the Responses API `instructions` field. The first user message and its attachments remain ordinary user input on every resumed request.

## Run in development

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
npm start
```

## Headless Media MCP

`@easel/media-mcp` is a reusable stdio server for local/headless agents. See [`packages/media-mcp/README.md`](packages/media-mcp/README.md) for standalone configuration and screenshot-browser setup. Its media APIs are separate from the live app control server described here.

## Agent controllers

**Settings > Agent** selects **Built-in**, **External MCP**, or **Codex**. Switching restores the selected backend's conversation and preserves unsent text and attachments. History lists Built-in and Codex conversations. Stop interrupts the active turn; accepted generation jobs keep their saved IDs and continue downloading.

### External MCP control

Keep Easel open and select **External MCP**. Chat moves to your external agent; the Easel composer is hidden. Copy the loopback URL and explicitly reveal/copy the private token in Agent settings. Supply the token as `EASEL_MCP_TOKEN` in the controller's process environment, then use the command shown in settings:

```sh
codex mcp add easel --url "http://127.0.0.1:PORT/mcp" --bearer-token-env-var EASEL_MCP_TOKEN
```

Replace `PORT` with the displayed port. Restart a controller launched before its environment/configuration changed. Easel does not modify global Codex configuration. The URL/token persist across Easel restarts; the port changes only if occupied. One controller can connect at a time. **Disconnect controller** cancels current tool requests, including during a run.

The server exposes live canvas inspection/editing/capture, project listing/opening/creation, media references and generation, and deletion requests with native confirmation. It listens only on loopback and checks Host, Origin and bearer authentication before parsing requests. Endpoint keys remain inside Easel; MCP grants access to its creative tools and configured media generation.

Use `get_control_events({after,limit})` for saved media completions, canvas answers/captures and project changes. `easel://events` supports resource subscriptions. Events and jobs survive app restarts. External conversation wakeup depends on the controller; MCP notifications do not guarantee that Codex desktop starts a new turn. Read pending events at the next turn instead of polling or resubmitting media jobs.

### Embedded Codex

Install the official Codex CLI on PATH, then select **Codex**. Use browser or device sign-in to start its managed ChatGPT authentication. Browser sign-in opens the returned address; device sign-in displays a verification address and code. Codex manages login and token refresh. Easel does not read its authentication cache or store ChatGPT access tokens. The account is shared with the installed CLI, so sign-out affects that CLI account.

Embedded Codex enables its native image generation and editing tool. Completed PNG, JPEG, and WebP images are imported into Media, attached to the originating project when it is still open, and previewed in chat. Saved chat history retains Easel asset IDs; the agent can find them with `list_media_assets` and use them in canvas source. This uses the signed-in account's Codex usage limits, independently of endpoint credentials. Availability depends on the installed CLI, model/provider, and account. See [Codex image generation](https://learn.chatgpt.com/docs/image-generation). External MCP controllers use their own native image tools; Easel imports only native results emitted by its embedded app-server.

Native image tools and configured Easel Media endpoints are available in the same Codex session. Request a configured model by name to use that endpoint; the agent discovers its exact ID with `list_models`. Easel checks that its MCP tools are ready before starting a turn. Routine Easel tools are authorized through the selected controller; destructive operations retain native user confirmation.

The child process uses only Easel MCP, the OpenAI provider, a dedicated working directory, disabled shell/other host tools, and a read-only sandbox. It does not inherit unrelated MCP servers or OpenAI API-key/base-URL environment settings. Canvas edits use the same host executor as Built-in and External MCP. Native command/file/network approvals are unavailable. The app-server protocol is experimental; this integration is exercised with Codex CLI 0.159.2.

Choose a model in the chat composer. Each conversation retains its Codex thread ID. Saved canvas answers and media completions continue that thread only when its controller, conversation, model and canvas/project are selected. Interrupted responses require an explicit retry. This route accepts images and sampled video frames; audio attachments are rejected while preserving the draft.

Official references: [Codex authentication](https://learn.chatgpt.com/docs/auth), [app-server](https://learn.chatgpt.com/docs/app-server), and [MCP](https://learn.chatgpt.com/docs/extend/mcp).

## Projects, canvases, and images

Choose or create a named **Project** from the header. Each project holds shared source files, media references, and multiple HTML canvases. The folder icon opens the retractable **Files** drawer; the media icon opens a separate **Media** drawer with **In this project** above **All media**. Open documents and media appear as tabs above the viewer. **New HTML** adds another canvas to the selected project. Existing saved canvases appear as projects containing one document.

The viewer has one tab row with a trailing **+** to create an HTML canvas. Clicking the selected document tab toggles the Files drawer. Project ZIP download and Undo live in that drawer, and each HTML document has a camera/microphone settings icon. Chat Copy, New chat, and media Open, Download, and Use in chat actions use labeled icons. Project media and All media are sorted newest first.

Generated images automatically join the current project. In **All media**, use **Add to project** to attach a saved image without inserting it into a canvas. Click a thumbnail to preview its full-resolution image; **Actual size** switches from fit to a scrollable preview, and **Download image** saves the original bytes. **Use in chat** adds the image as a composer attachment, subject to the usual attachment limits and model input support.

Media can belong to several projects. Removing an attachment keeps the saved media in **All media**, including media left with no project. The project trash control asks whether to keep its media or delete media that no other project uses. Deleting the last HTML canvas offers the same project confirmation. Global media deletion is blocked while a project still uses the asset.

The agent can use `edit_image` with saved `imageAssetIds` and an optional PNG `maskAssetId`, or `create_image_variation` with one `imageAssetId`. The host reads the saved references and uploads multipart image data to the selected Media model's endpoint. The model's tool arguments and saved tool results contain IDs rather than image bytes. Support depends on the provider/model; Easel accepts general image references for variations, while DALL-E 2 requires a square PNG under 4 MiB. Edited and varied images automatically join the project like generated images.

`list_media_assets` lists reusable library/project IDs, and `inspect_media_asset` provides a temporary image observation. Live screenshots join the media library and project. `record_canvas_video` records a selected visible HTML canvas as silent video, with bounded JPEG frame samples; `get_video_frames` retrieves those saved samples for the agent. Videos appear in Media and support playback, download and **Use in chat**. Video input uses sampled still frames rather than the full video or its audio track. Recording a DOM-only composition or adding audio to the recording is not supported by this canvas recording path.

Live captures also appear in chat and remain visible when a saved conversation is reopened. For source work, `list_canvas_files({includeAssets:false})` omits the media manifest. `present_canvas` returns actual saved file paths and revisions; related replacements can be batched in `apply_canvas_file_patches` before one reload. Source reads accept at most 24,000 bytes, and live captures wait at most eight frames and already include validation.

**Export project** saves a ZIP containing offline HTML previews at their original paths, real media files, bundled kits, and authored source under `.easel/source/`. A canonical project record lives at `.easel/project.json`. Export preserves authored source rather than transient renderer DOM, with limits of 128 MiB per assembled document and 256 MiB for the full uncompressed archive. Canvas-to-chat actions require the Easel host when viewing exported HTML.

The viewer can host Canvas 2D or browser WebGL content within its offline sandbox, which makes it useful for interactive prototypes and small games. Describe your request in chat, or insert an editable **Template** for image generation, an interactive canvas, an audio sketch, or a video storyboard. Press Enter to send; Ctrl+Enter inserts a new line.

Canvas typography uses installed operating-system fonts and CSS fallbacks. Recognized Google Fonts stylesheet links, preconnects and CSS imports are removed when preparing an offline document; `font-family` declarations remain. Existing canonical source files are preserved when reopened. Other external URLs remain blocked, and exported canvases need the same fonts installed to keep their typography.

During an agent run, **Send** becomes **Stop**. Stopping aborts pending model requests and prevents further tool calls. A media submission already sent waits independently for its receipt so an accepted job ID is not discarded; graceful shutdown waits for that receipt to be saved. A host edit already in progress finishes before the app accepts another message; completed authored edits remain saved. Stopped canvas-response continuations retain the user's answer and offer **Retry response**. Closing the window also stops the run and saves its progress before the native viewer is destroyed.

`generate_video` submits a video job; Easel supports durations from 1 to 12 seconds. Accepted jobs are saved locally and polled by a background worker across app restarts. Generating cards show service queue positions and time estimates when available, then become playable media after download. Completion resumes the original idle conversation when its project and Agent endpoint are still selected, or is delivered on that conversation's next turn. **Stop** stops the agent, while accepted generation continues. Removing a generating card asks for confirmation because it forgets the retrieval ID without cancelling the server job. Queued image generation, editing, and variation receipts use Easel’s shipped `/v1/images/jobs/{id}` contract when `Prefer: respond-async` is accepted; synchronous images continue to work. See [live video testing](docs/live-video-testing.md) for a read-only contract probe and an explicit opt-in end-to-end test.

### Agent video generation controls

Built-in, embedded Codex and external in-app MCP agents can discover `discover_video_capabilities({model})` and `list_video_loras({model})`, using the exact enabled model ID and its endpoint credentials. These tools are read-only. Check code support, runtime availability, installed adapters and validation evidence separately; unknown/older capability responses must not be treated as support.

`generate_video` accepts `cameraLora`, `cameraLoraStrength`, typed `loras: [{id,strength?}]`, exact decimal-string `seed`, `motionSpeed`, `loraReferenceAssetId`/`loraReferenceStrength`, and `guidingFrames: [{assetId,frameIndex,strength?}]`. Standalone MCP uses `loraReference` image uploads and `guidingFrames: [{image,frameIndex,strength?}]` instead of asset IDs. All references share a 32 MiB limit; saved in-app arguments keep IDs rather than bytes or paths.

Timed guides accept 1–8 stills at unique integer pixel-frame positions 0 through `seconds * 24`, step one, with strength 0–1. They cannot be combined with first-image or Ingredients modes. They provide soft guidance, not guaranteed exact frame copying or loop closure. The new graph is source/graph-contract tested, not live-GPU verified. The server's typed API is authoritative; the canonical creative-skills LTX-2.5 runtime is not publicly available for a claimed port.

See [advanced recipes](.agents/skills/easel-media/references/advanced-video.md) for compatibility, exact seeds and CLI `--lora ID[=STRENGTH]` / `--guide-frame FRAME IMAGE STRENGTH`; [live testing](docs/live-video-testing.md) includes individually cost-gated `camera` and `guided-frames` scenarios. Default help and offline mode never read a key or generate. Every live case is bounded to two 1-second 512×320 jobs and resume only retrieves saved IDs.

The current asset library supports PNG, JPEG, and WebP images, MP4/WebM video, and WAV/MP3 audio. **Undo** restores recent assistant-driven canvas source and image-placement changes (up to ten snapshots per canvas in the current app session). Choose offline **Canvas kits** per project in Files: HTML presentations, Three.js, Phaser, Matter.js, Tone.js, and p5.js. Settings lists installed kits. New projects default to Canvas 2D and Tone.js when installed; each HTML document inherits its project's selection. Audio starts from a user gesture such as a Play button. The p5 kit uses p5 2.3.4 in instance mode; load assets in async `setup()`, and register `instance.remove()` for disposal. p5.sound is not included. See [kit exploration notes](docs/canvas-kit-candidates.md) for the Strudel investigation. glTF/GLB assets and audio generation are planned. External CDNs and filesystem access remain blocked inside the canvas.

## Creative skills

Open **Skills** to write a reusable instruction, edit one, or import a Codex `SKILL.md`. Easel stores imported skills on this device and includes only the selected skills with a request. The reviewed in-app shortlist is **Easel Canvas**, **Easel Media**, **Easel Audio**, **Easel p5**, and **Easel Three**. Audio, p5, and Three require their installed kit to be enabled for the project. Custom skills remain editable and are marked as unreviewed.

HyperFrames workflows remain available in the repository for external coding agents, but are unavailable in the studio skill picker: the in-app harness has no shell, package manager, HyperFrames CLI, unrestricted network, or external asset installation. Previously imported copies are disabled with an explanation; their text is retained.

## Project kits and completed media

Choose offline kits in the **Files** drawer. The selection is saved per project and inherited by every HTML document, including future documents and exports. Changing it reloads the active document once with managed lifecycle cleanup and state preservation. New documents do not add kits automatically. **Settings > Kits** reports the centrally bundled libraries that are installed and available; it does not download arbitrary libraries.

Completed video jobs use prompt-derived filenames and locally decoded poster thumbnails. The originating chat receives a playable preview with Open and Download actions, and Media highlights unseen results with a New badge. Automatic opening is limited to an empty viewer in the originating chat and project while there is no draft or active reply. An open canvas remains visible. Chat restoration loads video metadata first and reads the media bytes when the user plays or opens it. Poster decoding failures never prevent retrieval of the completed file.

Canvas code runs in a dedicated sandboxed `WebContentsView` on a secure local origin, with no Node integration, filesystem access, or outbound network. A narrow host bridge accepts declared choice responses and explicitly shared photo/audio captures. Camera and microphone permissions apply to the requesting canvas for the current app session. Other permissions are denied. The agent's CDP-backed tools are restricted to that canvas view; it cannot inspect or control the app window or credentials.

### Canvas projects

Trash controls in **Files**, **Media**, and the source inspector ask for confirmation before deleting. File deletion blocks known references from surviving files. Deleting the default HTML selects a surviving document as the new entry; deleting the last HTML asks whether to delete the project. Removing project media keeps library and other project references. Deleting from **All media** is allowed only after all project references have been removed. Agent tools `delete_canvas_file` and `delete_media_asset` preview the target and use the same host confirmation, with Cancel selected by default. Revisions are checked again before committing.

Each canvas keeps editable text files separately from shared kit bundles and media blobs. New and migrated canvases start with `index.html`, `app.js`, and `styles.css`; the agent can add nested source files and choose another HTML entry. **Files** opens a bounded source viewer. Existing HTML canvases migrate lazily, preserving their original HTML. The atomic `.project.json` record is canonical; HTML export assembles a self-contained offline document.

Relative script and stylesheet paths work inside the project. ES modules support relative static and literal dynamic imports, including cycles, through a local blob import map. Package/HTTP imports and computed dynamic imports are unsupported. Classic scripts execute at their tag position; use a body-end script or `type="module"` for deferred execution. Media uses exact `{{asset:id}}` references or `assets/` aliases in HTML/CSS; use placeholders in JavaScript. Source reads exclude library bundles and media bytes.

| Tool | Behavior |
| --- | --- |
| `list_canvas_files` / `read_canvas_file` | Lists source metadata and reads bounded exact UTF-8 chunks with file/project revisions. |
| `write_canvas_file` / `patch_canvas_file` / `delete_canvas_file` | Persists one file, with optional revision checks, Undo, and managed reload. Write dependencies before referencing them; remove references before deletion. |
| `apply_canvas_file_patches` | Applies up to 20 nonoverlapping replacements against original file text in one transaction. Syntax/assembly checks run before commit; reload validates initialization and restores the previous project on observed app failure. |
| `update_canvas_project` / `attach_canvas_asset` | Changes the entry/kits or attaches saved media without adding binary data to source. |
| `attach_canvas_assets` | Attaches several saved IDs atomically without inserting visible images. IDs are deduplicated, and identical media shares the binary cache. |
| `get_canvas_state` / `set_canvas_state` | Reads/writes opt-in `state.json`, exposed on load as `window.__easelProjectState`. |

Limits are 100 source files, 1 MiB per file, 4 MiB total source, and 64 KiB persistent JSON state. Total project media has no byte cap: saving checks available disk space, including space for atomic replacements. Individual media transfers retain their 32 MiB limit, and ZIP/document exports have separate size budgets. Runtime variables remain separate from persistent state. File mutations default to source-only; `reload:true` applies them with cleanup, and `preserveState:true` also restores registered runtime/control state.

Authored source is authoritative: Save, JavaScript probes and asset attachment never adopt live renderer DOM. `add_image_to_canvas` updates authored HTML and the corresponding live image separately. `adopt_canvas_runtime_dom` is an explicit operation for cases that need a DOM snapshot; generated renderers and controls can become part of source when using it.

After attaching media and reloading, code can call `EaselCanvas.assets.getUrl(assetId)` independently of DOM parsing order. `await EaselCanvas.whenReady()` waits for DOM and bounded image decode checks; `EaselCanvas.assets.manifest` and inspection report MIME, byte sizes, dimensions and readiness without retrieving media bytes. File listings report separate source/media contributions. Modules have generated source filenames for runtime diagnostics.

### Input and devices

`request_canvas_input` presents 2-12 declared choices in a temporary canvas overlay and ends the agent turn. A click saves the answer before dismissing the overlay or reloading saved source, then resumes the original conversation when its canvas is open and chat is idle. `get_canvas_inputs` reads saved response metadata without polling. Unanswered questions can be dismissed. Failed/interrupted continuations have an explicit Retry action; a retry can repeat earlier tool effects. Answers survive restarting the app.

Canvas code can request `navigator.mediaDevices.getUserMedia()` from a user action. **Devices** provides explicit **Allow microphone** and **Allow camera** actions for the current canvas, plus **Revoke access** to stop capture and invalidate requests awaiting permission. Allowing access does not start capture; use the sketch's recording/camera controls afterwards. Your operating system may also ask for permission. Capture stays local until the user confirms sharing with the selected model. Closing, switching, or reloading a canvas stops its streams. Synthesized audio playback does not require microphone permission.

`window.EaselMedia.photo(video)` returns a PNG attachment; `await EaselMedia.recordAudio({seconds:10})` records a mono WAV for 1-30 seconds; `await EaselMedia.share(attachment,{prompt:'Describe this capture'})` asks to send it to chat. Start recording from a real button click. These helpers do not use workers. Captures persist as opaque asset references, and only the current media continuation hydrates their bytes into model context. Image/audio input support depends on the selected endpoint and model. Browser exports have no Studio chat bridge and follow the browser's device permission rules.

### Canvas editing tools

The in-app agent exposes these local tools alongside the Media MCP tools:

| Tool | Behavior |
| --- | --- |
| `get_canvas_source` | Reads saved or live app/head/body/script/style sections in bounded chunks, excluding bundled libraries and host bootstraps. Saved source includes a revision for patching. |
| `apply_canvas_patch` | Replaces one exact unique source match. `reload:false` saves the edit while keeping the current scene running; `reload:true` applies it with managed cleanup. Source patches support Undo. |
| `reload_canvas` | Applies saved source to the open view; can preserve registered app state and form controls. |
| `inspect_canvas` / `validate_canvas` | Reports canvas counts and bounds, registered scenes/cameras/renderers, animation/audio state, scoped errors, sandbox limits, and whether saved source is pending reload. |
| `capture_live_canvas` | Captures the actual open canvas, saves a PNG asset, and supplies a transient image observation to the agent. `capture_canvas_screenshot` instead renders supplied HTML. |

Canvas apps can register with `window.EaselCanvas.registerApp({ id, root, renderer, scene, camera, audio, dispose, getState, restoreState })`. Managed reload cancels observed frames/timers/listeners, closes observed audio contexts, and calls registered disposal. Complete scene cleanup and preservation require app disposal and JSON state hooks. Legacy resources that were never registered cannot all be identified. Form values restore without firing events. A source-only patch survives reopening/export; Save protects it from the older runtime DOM until reload. Runtime variables, renderer objects, and audio nodes are not serialized by Save.

`EaselCanvas.startLoop((time, deltaSeconds) => {})` provides a managed animation loop and returns a stop function. `EaselCanvas.registerDebugState('scene', () => ({frequency,energy}))` exposes bounded JSON diagnostics while keeping other closure variables private. Validation separates `sourceStatus`, `appRuntimeStatus`, `renderStatus`, `kitStatus`, and `audioStatus`; unknown error provenance remains explicit. Live captures wait for bounded readiness and several frames and include validation.

For audio diagnostics, ask the agent to call `EaselCanvas.audio.requestTest()`. Click **Enable audio testing**, then the sketch's Play/Stop controls. Output meters report RMS, peak and possible full-scale clipping at observed native destination connections; they create no sound, microphone capture, or recording. **Stop diagnostics** removes the taps. Measurements are mono and precede device output, so they do not establish audibility. The bundled Tone kit defaults to a timer clock because workers are blocked; existing canvases receive this repair when reopened. Custom `Tone.Context` instances must also use `clockSource:'timeout'`. Start audio from a real user click.

The agent returns argument corrections/examples on tool errors. After two repeated failures it asks the model to change strategy; a third identical failed call is blocked, and three repeated validation failures end the turn with a useful explanation instead of consuming all 12 calls.

Live view tools belong to the Electron canvas controller; the standalone Media MCP process cannot inspect the app's open view. Visual observations require an agent model that accepts image input. Validation does not prove audio is audible; a real Play click is still required.

## Test and package

```sh
npm test
npm run build
npm run dist:dir
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The test workflow installs Chromium and verifies a real offline screenshot. Desktop PR checks build Windows, macOS, and Linux packages without release credentials and upload only the package files (not unpacked app trees) as Actions artifacts for review. PR and local macOS packages use ad hoc signatures. Release and manual macOS builds use Developer ID signing and Apple notarization; see [macOS signing setup](docs/macos-signing.md).

### Publish a release

Push a version tag on the merged release commit:

```sh
git tag -a v0.0.2 -m "Easel Studio 0.0.2"
git push origin v0.0.2
```

The **Desktop Builds** workflow builds all three platforms and creates a GitHub Release with separate Windows EXE/ZIP, macOS DMG/ZIP, and Linux AppImage/DEB downloads. The release job runs only after every platform succeeds. It generates a changelog and prepends `docs/releases/<tag>.md` when that file exists. Publishing a `v*` release from the GitHub UI also runs the build and attaches its packages; reruns replace matching assets on the existing release.

Tags must match the current `package.json` version, optionally followed by a prerelease suffix such as `v0.0.2-rc.1`. Those suffixes mark the release as a prerelease. Manual **Run workflow** builds upload Actions artifacts without publishing a release. Runs for the same ref are serialized so an in-progress release build can finish. Headless MCP tarballs remain available in the Actions artifacts.
