const SOURCE_SELECTION = {
  section: { type: 'string', enum: ['app', 'head', 'body', 'styles', 'scripts'], default: 'app' },
  index: { type: 'integer', minimum: 0, description: 'Only for section scripts/styles. Omit index for app/head/body. Protected runtime scripts do not count.' },
};
const SOURCE_SELECTION_RULE = { if: { properties: { section: { enum: ['scripts', 'styles'] } }, required: ['section'] }, else: { not: { required: ['index'] } } };

const SOURCE_CANVAS_TOOLS = Object.freeze([
  {
    type: 'function', function: {
      name: 'get_canvas_source',
      description: 'Read saved app source separately from runtime DOM. Excludes bundled kits and host bootstraps. Returns bounded UTF-8 chunks, revision, capabilities and persistence contract. origin:live inspects DOM script text but does not retrieve live function definitions.',
      parameters: { type: 'object', additionalProperties: false, allOf: [SOURCE_SELECTION_RULE], properties: {
        ...SOURCE_SELECTION,
        origin: { type: 'string', enum: ['stored', 'live'], default: 'stored' },
        offset: { type: 'integer', minimum: 0, description: 'UTF-8 byte offset; use previous nextOffset.' },
        maxBytes: { type: 'integer', minimum: 256, maximum: 24000, default: 24000 },
        includeAssets: { type: 'boolean', default: false, description: 'Embedded base64 media is omitted by default; omitted placeholders are not exact-match patch targets.' },
      } },
    },
  },
  {
    type: 'function', function: {
      name: 'apply_canvas_patch',
      description: 'Replace one exact, unique match in saved source (64 KiB per text). Protected kits cannot be patched. reload:false (default) persists source without changing runtime. reload:true replaces the document, disposes tracked resources and optionally preserves registered app state and form values. Reports source/runtime effects and validates the actual open view.',
      parameters: { type: 'object', additionalProperties: false, allOf: [SOURCE_SELECTION_RULE], required: ['find', 'replace'], properties: {
        ...SOURCE_SELECTION,
        find: { type: 'string', minLength: 1, maxLength: 65536 },
        replace: { type: 'string', maxLength: 65536 },
        expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        reload: { type: 'boolean', default: false },
        cleanup: { type: 'boolean', description: 'Managed disposal before reload (enabled by default). Only applicable with reload:true.' },
        preserveState: { type: 'boolean', default: false, description: 'Require reload:true. getState/restoreState handle scene state; form values restore without events.' },
        validate: { type: 'boolean', default: true },
      } },
    },
  },
  {
    type: 'function', function: {
      name: 'adopt_canvas_runtime_dom',
      description: 'Explicitly adopt the live DOM into authored project source. Ordinary Save and runtime JavaScript never do this. Requires current project revision and no pending edits. Generated renderer canvases/controls can contaminate source; prefer targeted file editing.',
      parameters: { type: 'object', additionalProperties: false, required: ['expectedProjectRevision'], properties: { expectedProjectRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
    },
  },
  {
    type: 'function', function: {
      name: 'reload_canvas',
      description: 'Apply saved source to the currently open canvas by replacing its document. The old document is discarded; managed disposal runs first. Optional registered app/control state preservation. Unsaved runtime DOM changes are not carried over.',
      parameters: { type: 'object', additionalProperties: false, properties: { cleanup: { type: 'boolean', default: true }, preserveState: { type: 'boolean', default: false } } },
    },
  },
  {
    type: 'function', function: {
      name: 'validate_canvas',
      description: 'Check the actual open canvas: app script syntax, scoped console/runtime/WebGL errors, canvas counts, registered renderer/scene/camera, tracked animation and audio state. Reports limitations and whether saved source has been applied. Use capture_live_canvas to inspect pixels.',
      parameters: { type: 'object', additionalProperties: false, properties: { since: { type: 'integer', minimum: 0, description: 'Only console entries after the errorCursor from an earlier inspection. Runtime/WebGL errors cover the current document generation.' } } },
    },
  },
  {
    type: 'function', function: {
      name: 'capture_live_canvas',
      description: 'Capture pixels directly from the currently open Electron canvas view, including its live WebGL scene and controls. Saves a reusable PNG, attaches it to the current project, and provides the image separately for model inspection. This is distinct from capture_canvas_screenshot, which renders supplied HTML. No application chrome or audio is captured.',
      parameters: { type: 'object', additionalProperties: false, properties: { maxWidth: { type: 'integer', minimum: 320, maximum: 2400, default: 1600 }, frames: { type: 'integer', minimum: 0, maximum: 8, default: 3, description: 'Wait for attached-asset readiness and this many animation frames, bounded by 1500 ms. Includes structured validation with the live screenshot.' } } },
    },
  },
  {
    type: 'function', function: {
      name: 'record_canvas_video',
      description: 'Record the actual bitmap output of one visible canvas element for 1-30 seconds using captureStream/MediaRecorder. Use inspect_canvas to select canvasIndex. Saves a reusable silent WebM or MP4 asset, attaches it to the project without changing source/scene behavior, and provides up to six JPEG samples separately for model inspection. CSS transforms, surrounding DOM controls, app UI, audio and microphone input are excluded. Stop, hiding, closing or replacing the document cancels an unfinished recording. Sampled stills do not describe every video frame.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        canvasIndex: { type: 'integer', minimum: 0, maximum: 99, default: 0, description: 'Zero-based document canvas element index from inspect_canvas; select the output renderer.' },
        seconds: { type: 'number', minimum: 1, maximum: 30, default: 5 },
        fps: { type: 'integer', minimum: 1, maximum: 60, default: 30 },
        maxWidth: { type: 'integer', minimum: 320, maximum: 1920, default: 1600, description: 'Preserves aspect ratio, bounds height to 1920px, and never enlarges the source bitmap.' },
        frameCount: { type: 'integer', minimum: 1, maximum: 6, default: 4 },
        format: { type: 'string', enum: ['auto', 'webm', 'mp4'], default: 'auto', description: 'auto chooses a supported WebM codec first. Explicit MP4 can fail when unavailable.' },
        name: { type: 'string', minLength: 1, maxLength: 160 },
      } },
    },
  },
  {
    type: 'function', function: {
      name: 'get_video_frames',
      description: 'Inspect one to six stored JPEG samples from a video created by record_canvas_video. Returns compact reusable asset metadata and transient model images without putting video/base64 bytes in conversation history. Works for captured library IDs with stored samples; imported project digest videos can instead be shared through the chat attachment UI for a temporary observation. Audio and frames between samples are not inspected.',
      parameters: { type: 'object', additionalProperties: false, required: ['assetId'], properties: {
        assetId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
        maxFrames: { type: 'integer', minimum: 1, maximum: 6, default: 6 },
      } },
    },
  },
]);

const { PROJECT_CANVAS_TOOLS } = require('./canvas-project-tools');

module.exports = { PROJECT_CANVAS_TOOLS, SOURCE_CANVAS_TOOLS };
