const PATH = { type: 'string', minLength: 1, maxLength: 180, description: 'Relative POSIX source path, e.g. app.js, scenes/intro.js, styles.css. No traversal, media bytes, or managed canvas.json.' };
const REVISION = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const MUTATION_OPTIONS = {
  expectedProjectRevision: { ...REVISION, description: 'Optional project revision from list_canvas_files to detect concurrent changes.' },
  reload: { type: 'boolean', default: false, description: 'false persists files only; true replaces the open document with managed lifecycle cleanup.' },
  preserveState: { type: 'boolean', default: false, description: 'Only with reload:true; preserve registered runtime and control state.' },
  validate: { type: 'boolean', default: true },
};

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) } } };
}

const PROJECT_CANVAS_TOOLS = Object.freeze([
  tool('list_canvas_documents', 'List authored HTML documents in the active named project, with paths, titles and revisions. Documents share project files and media; path is document identity. The contract reports the current open documentPath.', {}),
  tool('open_canvas_document', 'Open an existing authored HTML document by its project path. This changes the live view with lifecycle cleanup, without changing the project default entry or source. Use list_canvas_documents first.', { path: PATH }, ['path']),
  tool('create_canvas_document', 'Create and open an empty authored HTML document inside the active project. Every HTML document inherits the persisted project kit selection, source files and attached media. Use update_canvas_project to change kits for all documents; present_canvas creates a complete new document.', { title: { type: 'string', minLength: 1, maxLength: 120 }, path: PATH }, ['title']),
  tool('list_canvas_files', 'List the open canvas project source paths, byte/line counts, file revisions, entry, kit dependencies and media references. Does not retrieve source, bundled libraries or binary assets. Start here for efficient context.', {
    directory: { type: 'string', maxLength: 180, description: 'Optional relative directory filter.' },
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
  }),
  tool('read_canvas_file', 'Read one saved canvas source file as bounded, exact patchable UTF-8 text. Kit binaries and media bytes live outside source; asset placeholders are exact patch targets. Use nextOffset for more content.', {
    path: PATH,
    offset: { type: 'integer', minimum: 0, default: 0 },
    maxBytes: { type: 'integer', minimum: 256, maximum: 24000, default: 24000 },
  }, ['path']),
  tool('write_canvas_file', 'Create or replace one persisted canvas text file (at most 1 MiB, 100 files, 4 MiB source per project). Arbitrary nested source paths are allowed. The entry defaults to index.html; app.js/styles.css are generated for new and migrated canvases. Reference JS/CSS with relative script/link paths. Edits affect source only unless reload:true.', {
    path: PATH, content: { type: 'string', maxLength: 1048576 }, expectedRevision: REVISION, ...MUTATION_OPTIONS,
  }, ['path', 'content']),
  tool('patch_canvas_file', 'Replace one unique exact match in a persisted project source file, without reading or replacing other files. Each find/replace is at most 64 KiB. Use the file revision returned by read_canvas_file. reload:false leaves the live runtime unchanged.', {
    path: PATH, find: { type: 'string', minLength: 1, maxLength: 65536 }, replace: { type: 'string', maxLength: 65536 }, expectedRevision: REVISION, ...MUTATION_OPTIONS,
  }, ['path', 'find', 'replace']),
  tool('apply_canvas_file_patches', 'Apply 1 to 20 source edits atomically in one project revision and one optional reload. Each find must match uniquely against the ORIGINAL file text; edits in the same file must not overlap. JavaScript/module syntax and assembled document are checked before commit. Any failed match, syntax check or revision check leaves every source file unchanged. Returns compact per-file diff metadata.', {
    edits: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['path', 'find', 'replace'], properties: { path: PATH, find: { type: 'string', minLength: 1, maxLength: 65536 }, replace: { type: 'string', maxLength: 65536 }, expectedRevision: REVISION } } },
    ...MUTATION_OPTIONS,
  }, ['edits']),
  tool('delete_canvas_file', 'Request deletion of a persisted source file after a native user confirmation. Cancelled confirmation changes nothing. Remove authored references first; every surviving HTML document must remain valid. Deleting the entry chooses a surviving HTML document. Deleting the last HTML offers deletion of the whole project, with the user choosing to keep media or delete media unused by other projects. Read current file/project revisions before requesting deletion.', {
    path: PATH, expectedRevision: REVISION, expectedProjectRevision: MUTATION_OPTIONS.expectedProjectRevision,
  }, ['path']),
  tool('update_canvas_project', 'Change the open project entry HTML or replace its persisted kit selection. The kit list applies to EVERY HTML document in this project, including later documents and exports; omitted kits are disabled. New documents and chat preferences never add kits automatically. A kit must be available offline in Settings or already saved with this project. Use reload:true,preserveState:true to apply the change to the current runtime with lifecycle cleanup. Bundles never appear in source reads.', {
    entry: PATH, kits: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 64 }, description: 'Complete project-wide selection of offline kits; [] disables all kit bundles. Omit to leave the selection unchanged.' }, ...MUTATION_OPTIONS,
  }),
  tool('attach_canvas_asset', 'Attach an existing generated/uploaded media asset to the canvas project. Returns an exact {{asset:id}} source reference, local assets/ path and MIME/size/dimension metadata. After reload use await EaselCanvas.assets.ready; EaselCanvas.assets.getUrl(id) to resolve it without DOM queries. Binary data stays outside source/chat.', {
    assetId: { type: 'string', pattern: '^(?:[a-f0-9]{32}|[a-f0-9]{64})$' },
    path: { type: 'string', maxLength: 135, description: 'Optional local alias such as assets/cover.png; must start assets/.' },
    ...MUTATION_OPTIONS,
  }, ['assetId']),
  tool('attach_canvas_assets', 'Attach multiple media asset IDs atomically, with duplicate IDs merged, in one project revision and one optional reload. All assets must exist before any attachment is committed. Returns metadata/source references, never binary data. Shared library IDs are 32 hex; an existing attached digest ID may be 64 hex. After reload, await EaselCanvas.assets.ready and resolve attached IDs via EaselCanvas.assets.getUrl(id), independently of DOM content.', {
    assetIds: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', pattern: '^(?:[a-f0-9]{32}|[a-f0-9]{64})$' } },
    ...MUTATION_OPTIONS,
  }, ['assetIds']),
  tool('get_canvas_state', 'Read opt-in persistent JSON state from state.json. Reports missing state explicitly; this is separate from renderer variables and live registered app state.', {}),
  tool('set_canvas_state', 'Persist JSON state in state.json (at most 64 KiB). On document load it is available as window.__easelProjectState. Durable user answers are separately stored by Easel. Runtime JS state is not saved automatically.', {
    state: { description: 'Any JSON-serializable value to persist.' }, expectedRevision: REVISION, ...MUTATION_OPTIONS,
  }, ['state']),
]);

module.exports = { PROJECT_CANVAS_TOOLS };
