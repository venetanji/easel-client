const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createCanvasStore } = require('../src/canvas-store');

test('new canvas metadata names only its newly authored source files with patchable revisions', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-canvas-metadata-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const project = store.createProject({ title: 'Multiple documents' });
  const created = store.createDocument(project.id, { title: 'Sketch', path: 'sketch.html', html: '<main>Sketch</main><style>main{color:teal}</style><script>const count = 1;</script>' });
  assert.deepEqual(created.files.map((file) => file.path).sort(), ['sketch.app.js', 'sketch.html', 'sketch.styles.css']);
  for (const file of created.files) {
    assert.equal(file.revision, store.readFile(project.id, { path: file.path }).revision);
    assert.equal(file.bytes, store.readFile(project.id, { path: file.path }).totalBytes);
  }
  assert.ok(store.listFiles(project.id).files.some((file) => file.path === 'index.html'));
});

test('saves self-contained canvas HTML and lists it by title', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-canvases-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath, idFactory: () => 'c'.repeat(32) });

  const saved = store.save({
    title: 'Poster "A"',
    html: '<h1>Preview</h1><img src="{{asset:hero}}">',
    assets: [{ name: 'hero', data: 'YWJj', mimeType: 'image/png' }],
  });

  assert.equal(saved.id, 'c'.repeat(32));
  assert.equal(saved.title, 'Poster "A"');
  assert.deepEqual(store.list().map(({ id, title }) => ({ id, title })), [{ id: saved.id, title: saved.title }]);
  const loaded = store.get(saved.id);
  assert.equal(loaded.title, saved.title);
  assert.match(loaded.html, /data:image\/png;base64,YWJj/);
  assert.match(loaded.html, /Content-Security-Policy/);
  assert.deepEqual(fs.readdirSync(path.join(userDataPath, 'canvases')).sort(), ['.assets', `${saved.id}.html`, `${saved.id}.project.json`].sort());
  const canonical = JSON.parse(fs.readFileSync(path.join(userDataPath, 'canvases', `${saved.id}.project.json`), 'utf8'));
  assert.equal(canonical.id, saved.id);
  assert.equal(canonical.title, saved.title);
  assert.match(canonical.files[canonical.manifest.entry], /<h1>Preview<\/h1>/);
  assert.equal(canonical.manifest.assets.length, 1);
  assert.equal(canonical.manifest.assets[0].mimeType, 'image/png');
  assert.equal(canonical.manifest.assets[0].bytes, 3);

  store.update(saved.id, '<!doctype html><html><head><title>Changed by canvas JS</title></head><body><h1>Edited</h1></body></html>');
  const updated = store.get(saved.id);
  assert.equal(updated.title, 'Poster "A"');
  assert.match(updated.html, /<h1>Edited<\/h1>/);
  assert.equal((updated.html.match(/Content-Security-Policy/g) || []).length, 1);
});

test('rejects invalid canvas IDs and canvas documents', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-canvases-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });

  assert.throws(() => store.get('..\\settings.json'), /canvas ID is invalid/i);
  assert.throws(() => store.save({ html: '<img src="https://example.com/image.png">' }), /external URLs/i);
  assert.deepEqual(store.list(), []);
});

test('creates a named empty canvas with a modifiable media grid', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-canvases-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });

  const created = store.createEmpty('Mood board');
  const saved = store.get(created.id);
  assert.equal(saved.title, 'Mood board');
  assert.match(saved.html, /data-easel-canvas/);
  assert.match(saved.html, /grid-template-columns/);
  assert.match(saved.html, /Content-Security-Policy/);
});

test('preflights entry deletion without mutation and selects another HTML document', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-entry-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.save({ title: 'Study', html: '<h1>First</h1>' });
  store.writeFile(created.id, { path: 'b.html', content: '<h1>Second</h1>' });
  store.writeFile(created.id, { path: 'a.htm', content: '<h1>Another</h1>' });
  const canonicalPath = path.join(userDataPath, 'canvases', `${created.id}.project.json`);
  const original = fs.readFileSync(canonicalPath, 'utf8');
  const before = store.getProject(created.id);
  const inspected = store.inspectDeletion(created.id, { path: before.manifest.entry });

  assert.equal(inspected.ok, true);
  assert.equal(inspected.isDocument, true);
  assert.equal(inspected.isEntry, true);
  assert.equal(inspected.nextEntry, 'a.htm');
  assert.deepEqual(inspected.referencingFiles, []);
  assert.equal(fs.readFileSync(canonicalPath, 'utf8'), original);
  assert.equal(store.getProject(created.id).projectRevision, before.projectRevision);
  const deleted = store.deleteFile(created.id, { path: inspected.path, expectedRevision: inspected.revision, expectedProjectRevision: inspected.projectRevision });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.previousEntry, before.manifest.entry);
  assert.equal(deleted.nextEntry, 'a.htm');
  assert.equal(store.get(created.id).documentPath, 'a.htm');
  assert.equal(store.getProject(created.id).files.some((file) => file.path === inspected.path), false);
  assert.deepEqual(deleted.documents.map(({ path: documentPath }) => documentPath), ['a.htm', 'b.html']);
});

test('offers project deletion for the last HTML document without deleting it implicitly', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-last-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.createEmpty('Only document');
  const before = store.getProject(created.id);
  const inspected = store.inspectDeletion(created.id, { path: before.manifest.entry });
  assert.equal(inspected.ok, false);
  assert.equal(inspected.requiresProjectDeletion, true);
  assert.match(inspected.reason, /last HTML document/);
  assert.throws(() => store.deleteFile(created.id, { path: before.manifest.entry }), /last HTML document/);
  assert.equal(store.getProject(created.id).projectRevision, before.projectRevision);
});

test('reports remaining document and module references before deleting source', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-references-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.createEmpty('References');
  store.writeFile(created.id, { path: 'lib/shared.js', content: 'export const value = 1;' });
  store.writeFile(created.id, { path: 'scenes/second.html', content: '<script type="module" src="../lib/shared.js"></script>' });
  store.writeFile(created.id, { path: 'scenes/unused.mjs', content: 'import { value } from "../lib/shared.js";' });
  const before = store.getProject(created.id).projectRevision;
  const inspected = store.inspectDeletion(created.id, { path: 'lib/shared.js' });
  assert.equal(inspected.ok, false);
  assert.deepEqual(inspected.referencingFiles, ['scenes/second.html', 'scenes/unused.mjs']);
  assert.throws(() => store.deleteFile(created.id, { path: 'lib/shared.js' }), (error) => error.code === 'CANVAS_DELETE_BLOCKED' && error.referencingFiles.length === 2);
  assert.equal(store.getProject(created.id).projectRevision, before);
});

test('validates every surviving document before deleting an unrelated source file', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-validation-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.createEmpty('Validation');
  store.writeFile(created.id, { path: 'notes.txt', content: 'An unused source file.' });
  // Simulate an invalid secondary document persisted by an older client.
  const filename = path.join(userDataPath, 'canvases', `${created.id}.project.json`);
  const legacy = JSON.parse(fs.readFileSync(filename, 'utf8'));
  legacy.files['broken.html'] = '<script src="missing.js"></script>';
  fs.writeFileSync(filename, JSON.stringify(legacy));
  const before = store.getProject(created.id).projectRevision;
  const inspected = store.inspectDeletion(created.id, { path: 'notes.txt' });
  assert.equal(inspected.ok, false);
  assert.equal(inspected.validationErrors[0].path, 'broken.html');
  assert.match(inspected.reason, /missing\.js/);
  assert.throws(() => store.deleteFile(created.id, { path: 'notes.txt' }), /invalid project documents/);
  assert.equal(store.getProject(created.id).projectRevision, before);
});

test('rejects invalid secondary HTML references and syntax before persisting source', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-source-preflight-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const project = store.createEmpty('Preflight');
  store.writeFile(project.id, { path: 'second.html', content: '<main>Original</main>' });
  const filename = path.join(userDataPath, 'canvases', `${project.id}.project.json`);
  const original = fs.readFileSync(filename, 'utf8');
  const before = store.getProject(project.id).projectRevision;
  for (const [content, error] of [
    ['<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.4/p5.min.js"></script>', /Only relative local project references/],
    ['<link rel="stylesheet" href="missing.css">', /missing\.css/],
    ['<img src="https://example.com/image.png">', /external URLs/],
    ['<script>return 1;</script>', /invalid JavaScript/],
  ]) {
    assert.throws(() => store.writeFile(project.id, { path: 'second.html', content }), error);
    assert.equal(store.getProject(project.id).projectRevision, before);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
    assert.equal(store.readFile(project.id, { path: 'second.html' }).text, '<main>Original</main>');
  }
});

test('batch patches reject invalid secondary documents without saving any edit', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-batch-preflight-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const project = store.save({ title: 'Batch', html: '<main>First</main>' });
  store.writeFile(project.id, { path: 'second.html', content: '<main>Second</main>' });
  const before = store.getProject(project.id).projectRevision;
  for (const [replacement, error] of [
    ['<script src="https://example.com/library.js"></script>', /Only relative local project references/],
    ['<script>return 1;</script>', /invalid JavaScript/],
    ['<script type="module">import "./missing.mjs";</script>', /missing\.mjs/],
  ]) {
    assert.throws(() => store.patchFiles(project.id, { expectedProjectRevision: before, edits: [
      { path: project.documentPath, find: 'First', replace: 'Changed' },
      { path: 'second.html', find: '<main>Second</main>', replace: replacement },
    ] }), error);
    assert.equal(store.getProject(project.id).projectRevision, before);
    assert.match(store.readFile(project.id, { path: project.documentPath }).text, /First/);
    assert.equal(store.readFile(project.id, { path: 'second.html' }).text, '<main>Second</main>');
  }
});

test('repairs a legacy invalid secondary document and then enables its offline kit', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-kit-repair-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath, kitBundles: { p5: 'window.p5 = function () {};' } });
  const project = store.createEmpty('Repair');
  const filename = path.join(userDataPath, 'canvases', `${project.id}.project.json`);
  const legacy = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const bad = '<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.4/p5.min.js"></script>';
  legacy.files['second.html'] = `<main>Planets</main>${bad}`;
  fs.writeFileSync(filename, JSON.stringify(legacy));
  const file = store.readFile(project.id, { path: 'second.html' });
  store.patchFile(project.id, { path: file.path, find: bad, replace: '', expectedRevision: file.revision, expectedProjectRevision: file.projectRevision });
  store.updateManifest(project.id, { kits: ['canvas-2d', 'p5'] });
  assert.deepEqual(store.getProjectKits(project.id).kits, ['canvas-2d', 'p5']);
  assert.match(store.getDocument(project.id, 'second.html').html, /data-easel-canvas-kit="p5"/);
  assert.equal(store.readFile(project.id, { path: file.path }).text, '<main>Planets</main>');
});

test('source preflight resolves dependencies without reading kit or media bytes', () => {
  const { assembleProject, digest } = require('../src/canvas-project');
  const assetId = 'a'.repeat(32);
  const project = { version: 1, files: {
    'index.html': '<img src="assets/cover.png"><link rel="stylesheet" href="styles.css"><script type="module" src="app.mjs"></script>',
    'styles.css': '@import "colors.css";main{background:url("assets/cover.png")}',
    'colors.css': 'main{color:teal}',
    'app.mjs': 'import { value } from "./value.mjs"; console.log(value);',
    'value.mjs': 'export const value = 1;',
  }, manifest: { entry: 'index.html', kits: [{ name: 'p5', digest: digest('bundle') }], assets: [
    { id: assetId, digest: digest('media'), path: 'assets/cover.png', mimeType: 'image/png', bytes: 5 },
  ] } };
  const options = { validateOnly: true, readKit() { assert.fail('Kit bytes are unnecessary for source validation.'); }, readAsset() { assert.fail('Media bytes are unnecessary for source validation.'); } };
  assert.match(assembleProject(project, options), /blob:easel-preflight/);
  delete project.files['value.mjs'];
  assert.throws(() => assembleProject(project, options), /value\.mjs/);
});

test('checks file and project revisions after deletion confirmation', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-revisions-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.createEmpty('Revisions');
  store.writeFile(created.id, { path: 'notes.txt', content: 'Before' });
  const inspected = store.inspectDeletion(created.id, { path: 'notes.txt' });
  store.writeFile(created.id, { path: 'notes.txt', content: 'After' });
  const before = store.getProject(created.id).projectRevision;
  assert.throws(() => store.deleteFile(created.id, { path: inspected.path, expectedProjectRevision: inspected.projectRevision }), /project changed/);
  assert.throws(() => store.deleteFile(created.id, { path: inspected.path, expectedRevision: inspected.revision }), /file changed/);
  assert.equal(store.getProject(created.id).projectRevision, before);
  const current = store.inspectDeletion(created.id, { path: 'notes.txt', expectedProjectRevision: before });
  const deleted = store.deleteFile(created.id, { path: current.path, expectedRevision: current.revision, expectedProjectRevision: current.projectRevision });
  assert.equal(deleted.isDocument, false);
  assert.equal(deleted.nextEntry, created.documentPath);
  assert.throws(() => store.readFile(created.id, { path: 'notes.txt' }), /not found/);
});

test('blocks detaching authored media references and reports their source files', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-detach-references-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const assetId = 'a'.repeat(32);
  const store = createCanvasStore({ userDataPath, assetStore: { async get(id) { return { id, data: 'YWJj', mimeType: 'image/png' }; } } });
  const created = store.createEmpty('Media references');
  const attached = await store.attachAsset(created.id, { assetId, path: 'assets/cover.png' });
  for (const [file, content] of [
    ['usage.txt', `{{asset:${assetId}}}`],
    ['usage.txt', `asset://${assetId}`],
    ['scenes/usage.css', 'body { background: url("../assets/cover.png"); }'],
    ['usage.txt', `EaselCanvas.assets.getUrl("${assetId}")`],
    ['usage.txt', '"assets\\/cover.png"'],
  ]) {
    store.writeFile(created.id, { path: file, content });
    const before = store.getProject(created.id).projectRevision;
    const inspected = store.inspectAssetDeletion(created.id, { assetId });
    assert.equal(inspected.ok, false);
    assert.ok(inspected.referencingFiles.includes(file));
    assert.throws(() => store.detachAsset(created.id, { assetId }), (error) => error.code === 'CANVAS_DELETE_BLOCKED' && error.referencingFiles.includes(file));
    assert.equal(store.getProject(created.id).projectRevision, before);
    store.writeFile(created.id, { path: file, content: '' });
  }
  assert.equal(store.getAsset(created.id, attached.asset.id).data, 'YWJj');
});

test('detaches project media while preserving shared and other project blob access', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-detach-preservation-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const assetId = 'b'.repeat(32);
  const shared = { async get(id) { return { id, data: 'YWJj', mimeType: 'image/png' }; } };
  const store = createCanvasStore({ userDataPath, assetStore: shared });
  const first = store.createEmpty('First');
  const second = store.createEmpty('Second');
  await store.attachAsset(first.id, { assetId });
  await store.attachAsset(second.id, { assetId });
  const before = store.getProject(first.id);
  const inspected = store.inspectAssetDeletion(first.id, { assetId });
  assert.equal(inspected.ok, true);
  assert.equal(store.getProject(first.id).projectRevision, before.projectRevision);
  store.writeFile(first.id, { path: 'notes.txt', content: 'New source' });
  assert.throws(() => store.detachAsset(first.id, { assetId, expectedProjectRevision: inspected.projectRevision }), /project changed/);
  const current = store.inspectAssetDeletion(first.id, { assetId });
  const detached = store.detachAsset(first.id, { assetId, expectedProjectRevision: current.projectRevision });
  assert.equal(detached.detached, true);
  assert.equal(detached.detachedAssetId, assetId);
  assert.equal(store.listAssets(first.id).assets.length, 0);
  assert.throws(() => store.getAsset(first.id, assetId), /not attached/);
  assert.equal(store.getAsset(second.id, assetId).data, 'YWJj');
  assert.equal((await shared.get(assetId)).data, 'YWJj');
  assert.equal(fs.readFileSync(path.join(userDataPath, 'canvases', '.assets', current.asset.digest)).toString('base64'), 'YWJj');
});

test('deletion preflight does not migrate or mutate a legacy HTML canvas', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-legacy-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const directory = path.join(userDataPath, 'canvases');
  fs.mkdirSync(directory);
  const id = 'c'.repeat(32);
  const html = '<html><head></head><body><h1>Legacy</h1></body></html>';
  fs.writeFileSync(path.join(directory, `${id}.html`), html);
  const store = createCanvasStore({ userDataPath });
  assert.throws(() => store.inspectDeletion(id, { path: 'index.html' }), /legacy canvas.*migrated/);
  assert.throws(() => store.inspectAssetDeletion(id, { assetId: 'a'.repeat(32) }), /legacy canvas.*migrated/);
  assert.deepEqual(fs.readdirSync(directory), [`${id}.html`]);
  assert.equal(fs.readFileSync(path.join(directory, `${id}.html`), 'utf8'), html);
});

test('delete tool requires host confirmation and only accepts revision options', () => {
  const { PROJECT_CANVAS_TOOLS } = require('../src/canvas-project-tools');
  const descriptor = PROJECT_CANVAS_TOOLS.find((tool) => tool.function.name === 'delete_canvas_file').function;
  assert.match(descriptor.description, /user confirmation/);
  assert.equal(descriptor.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(descriptor.parameters.properties).sort(), ['path', 'expectedRevision', 'expectedProjectRevision'].sort());
});

test('deletes a project while retaining embedded media IDs in the global library', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-project-keep-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.save({ title: 'Texture study', html: '<img src="{{asset:cover}}">', assets: [{ name: 'cover', data: 'YWJj', mimeType: 'image/png' }] });
  const asset = store.listAssets(created.id).assets[0];
  const inspected = store.inspectProjectDeletion(created.id);
  assert.equal(inspected.documentCount, 1);
  assert.equal(inspected.mediaCount, 1);
  assert.equal(inspected.exclusiveMediaCount, 1);
  assert.equal(fs.existsSync(path.join(userDataPath, 'canvases', '.library-media.json')), false);
  const deleted = store.deleteProject(created.id, { expectedProjectRevision: inspected.projectRevision });
  assert.equal(deleted.projectDeleted, true);
  assert.deepEqual(deleted.keptAssetIds, [asset.id]);
  assert.deepEqual(store.list(), []);
  assert.equal(store.getLibraryAsset(asset.id).data, 'YWJj');
  assert.equal(store.listLibraryAssets()[0].orphaned, true);
  const restarted = createCanvasStore({ userDataPath });
  assert.equal(restarted.getLibraryAsset(asset.id).data, 'YWJj');
  const next = restarted.createEmpty('New study');
  await restarted.attachAssets(next.id, { assetIds: [asset.id] });
  assert.equal(restarted.getAsset(next.id, asset.id).data, 'YWJj');
  assert.equal(restarted.listLibraryAssets()[0].referenceCount, 1);
});

test('global media shares IDs across projects and preserves other project media on project deletion', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-project-shared-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const sharedId = 'd'.repeat(32);
  const exclusiveId = 'e'.repeat(32);
  const store = createCanvasStore({ userDataPath, assetStore: { async get(id) { return { id, data: id === exclusiveId ? 'ZGVm' : 'YWJj', mimeType: 'image/png' }; } } });
  const first = store.createEmpty('First');
  const second = store.createEmpty('Second');
  await store.attachAssets(first.id, { assetIds: [sharedId, exclusiveId] });
  await store.attachAsset(second.id, { assetId: sharedId });
  const list = store.listLibraryAssets();
  assert.equal(list.length, 2);
  assert.deepEqual(list.find((asset) => asset.id === sharedId).projectIds, [first.id, second.id].sort());
  const inspected = store.inspectProjectDeletion(first.id);
  assert.equal(inspected.sharedMediaCount, 1);
  assert.equal(inspected.exclusiveMediaCount, 1);
  const deleted = store.deleteProject(first.id, { deleteMedia: true });
  assert.deepEqual(deleted.sharedAssetIds, [sharedId]);
  assert.deepEqual(deleted.deletedAssetIds, [exclusiveId]);
  assert.deepEqual(deleted.mediaDeletionCandidates, [exclusiveId]);
  assert.equal(store.getAsset(second.id, sharedId).data, 'YWJj');
  assert.equal(store.getLibraryAsset(sharedId).data, 'YWJj');
  assert.throws(() => store.getLibraryAsset(exclusiveId), /not found/);
  assert.equal(store.listLibraryAssets().length, 1);
});

test('project deletion preserves shared bytes referenced under another ID', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-project-alias-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const firstId = 'f'.repeat(32);
  const secondId = 'a'.repeat(32);
  const first = store.save({ html: '<h1>First</h1>', assets: [{ assetId: firstId, name: 'texture', data: 'YWJj', mimeType: 'image/png' }] });
  const second = store.save({ html: '<h1>Second</h1>', assets: [{ assetId: secondId, name: 'texture', data: 'YWJj', mimeType: 'image/png' }] });
  assert.equal(store.inspectProjectDeletion(first.id).sharedMediaCount, 1);
  assert.deepEqual(store.deleteProject(first.id, { deleteMedia: true }).deletedAssetIds, []);
  assert.equal(store.getAsset(second.id, secondId).data, 'YWJj');
});

test('checks project revisions after confirmation and guards deletion paths', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-project-revision-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.createEmpty('Revision');
  const before = store.inspectProjectDeletion(created.id);
  store.writeFile(created.id, { path: 'notes.txt', content: 'Changed while confirming' });
  assert.throws(() => store.deleteProject(created.id, { expectedProjectRevision: before.projectRevision }), /project changed/);
  assert.equal(store.list().length, 1);
  assert.throws(() => store.deleteProject('../settings'), /ID is invalid/);
  assert.throws(() => store.deleteProject(created.id, { deleteMedia: 'yes' }), /option is invalid/);
  assert.equal(store.list().length, 1);
});

test('blocks orphan media deletion if another project attaches it during confirmation', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-orphan-revision-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const first = store.save({ html: '<h1>Texture</h1>', assets: [{ name: 'texture', data: 'YWJj', mimeType: 'image/png' }] });
  const asset = store.listAssets(first.id).assets[0];
  store.deleteProject(first.id);
  const inspected = store.inspectLibraryAssetDeletion(asset.id);
  assert.equal(inspected.ok, true);
  const second = store.createEmpty('Attach during confirmation');
  await store.attachAsset(second.id, { assetId: asset.id });
  assert.throws(() => store.removeLibraryAsset(asset.id, { expectedLibraryRevision: inspected.libraryRevision }), /media changed/);
  assert.equal(store.inspectLibraryAssetDeletion(asset.id).ok, false);
  assert.throws(() => store.removeLibraryAsset(asset.id), /used by 1 project/);
  store.deleteProject(second.id);
  const orphan = store.inspectLibraryAssetDeletion(asset.id);
  const removed = store.removeLibraryAsset(asset.id, { expectedLibraryRevision: orphan.libraryRevision });
  assert.equal(removed.blobDeleted, true);
  assert.deepEqual(store.listLibraryAssets(), []);
});

test('retains detached project-only media as global media', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-detach-orphan-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.save({ html: '<h1>Unused attachment</h1>', assets: [{ name: 'texture', data: 'YWJj', mimeType: 'image/png' }] });
  const asset = store.listAssets(created.id).assets[0];
  store.detachAsset(created.id, { assetId: asset.id });
  assert.equal(store.getLibraryAsset(asset.id).data, 'YWJj');
  assert.equal(store.listLibraryAssets()[0].orphaned, true);
});

test('unreadable other projects prevent unsafe deletion and legacy references protect media', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-delete-project-reference-integrity-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath });
  const created = store.save({ html: '<h1>Texture</h1>', assets: [{ assetId: 'b'.repeat(32), name: 'texture', data: 'YWJj', mimeType: 'image/png' }] });
  const directory = path.join(userDataPath, 'canvases');
  const otherId = 'c'.repeat(32);
  fs.writeFileSync(path.join(directory, `${otherId}.project.json`), 'corrupted');
  assert.throws(() => store.deleteProject(created.id, { deleteMedia: true }), /Cannot inspect media references/);
  assert.equal(store.get(created.id).id, created.id);
  fs.unlinkSync(path.join(directory, `${otherId}.project.json`));
  const legacyHtml = '<html><body><img src="asset://' + 'b'.repeat(32) + '"></body></html>';
  fs.writeFileSync(path.join(directory, `${otherId}.html`), legacyHtml);
  assert.equal(store.inspectProjectDeletion(created.id).sharedMediaCount, 1);
  assert.deepEqual(store.deleteProject(created.id, { deleteMedia: true }).deletedAssetIds, []);
  assert.equal(fs.readFileSync(path.join(directory, `${otherId}.html`), 'utf8'), legacyHtml);
});

test('reuses cached reference metadata and thumbnails while noticing atomic project changes', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-library-cache-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let metadataReads = 0;
  let thumbnails = 0;
  const countedFs = { ...fs, readFileSync(filename, ...args) { if (filename.endsWith('.project.json')) metadataReads += 1; return fs.readFileSync(filename, ...args); } };
  const store = createCanvasStore({ userDataPath, fileSystem: countedFs, thumbnailFactory(bytes) { thumbnails += 1; return `data:image/png;base64,${bytes.toString('base64')}`; } });
  const created = store.save({ html: '<h1>Texture</h1>', assets: [{ name: 'texture', data: 'YWJj', mimeType: 'image/png' }] });
  const first = store.listLibraryAssets({ thumbnail: true });
  const afterFirst = metadataReads;
  store.listLibraryAssets({ thumbnail: true });
  assert.equal(metadataReads, afterFirst);
  assert.equal(thumbnails, 1);
  assert.equal(store.getAsset(created.id, first[0].id, { thumbnail: true }).thumbnail, first[0].thumbnail);
  assert.equal(thumbnails, 1);
  store.writeFile(created.id, { path: 'notes.txt', content: 'Changed' });
  const beforeRefresh = metadataReads;
  store.listLibraryAssets({ thumbnail: true });
  assert.ok(metadataReads > beforeRefresh);
  assert.equal(thumbnails, 1);
});

test('new projects default to installed Tone and explicit kit selections stay independent', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-project-kit-defaults-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath, kitBundles: { tone: 'window.Tone = { version: "test" };', three: 'window.THREE = { version: "test" };' } });
  const first = store.createProject({ title: 'Default kits' });
  const second = store.createProject({ title: 'Explicit none', kits: [] });
  const third = store.createProject({ title: 'Three only', kits: ['three'] });
  assert.deepEqual(store.getProjectKits(first.id).kits, ['canvas-2d', 'tone']);
  assert.deepEqual(store.getProjectKits(second.id).kits, []);
  assert.deepEqual(store.getProjectKits(third.id).kits, ['three']);
  const unavailable = createCanvasStore({ userDataPath });
  const plain = unavailable.createProject();
  assert.deepEqual(unavailable.getProjectKits(plain.id).kits, ['canvas-2d']);
  assert.match(store.get(first.id).html, /data-easel-canvas-kit="tone"/);
});

test('a project kit selection applies to every current and future HTML document', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-project-kit-inheritance-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { managedKitScripts } = require('../src/canvas-project');
  const bundles = { tone: 'window.Tone = {};', three: 'window.THREE = {};', phaser: 'window.Phaser = {};' };
  const store = createCanvasStore({ userDataPath, kitBundles: bundles });
  const project = store.createProject();
  const second = store.createDocument(project.id, { title: 'Second', kits: ['phaser'] });
  assert.deepEqual(second.ignoredDocumentKits, ['phaser']);
  assert.deepEqual(managedKitScripts(store.get(project.id, { documentPath: second.documentPath }).html).map((kit) => kit.name), ['tone']);
  const selection = store.getProjectKits(project.id);
  const changed = store.updateManifest(project.id, { kits: ['canvas-2d', 'three'], expectedProjectRevision: selection.projectRevision });
  assert.deepEqual(changed.kits, ['canvas-2d', 'three']);
  for (const document of store.listDocuments(project.id).documents) {
    assert.deepEqual(managedKitScripts(store.get(project.id, { documentPath: document.path }).html).map((kit) => kit.name), ['three']);
  }
  const third = store.createDocument(project.id, { title: 'Third', kits: ['tone', 'phaser'], html: '<script data-easel-canvas-kit="tone">window.Tone = { stale: true };</script><h1>Third</h1>' });
  assert.deepEqual(third.ignoredDocumentKits, ['tone', 'phaser']);
  assert.deepEqual(store.getProjectKits(project.id).kits, ['canvas-2d', 'three']);
  assert.deepEqual(managedKitScripts(store.get(project.id, { documentPath: third.documentPath }).html).map((kit) => kit.name), ['three']);
  const reopened = createCanvasStore({ userDataPath, kitBundles: bundles });
  assert.deepEqual(reopened.getProjectKits(project.id).kits, ['canvas-2d', 'three']);
  const exported = reopened.exportProject(project.id);
  assert.deepEqual(exported.manifest.kits.map((kit) => kit.name), ['canvas-2d', 'three']);
  assert.equal(exported.manifest.documents.length, 3);
  const zipContents = new Map();
  let offset = 0;
  while (exported.data.readUInt32LE(offset) === 0x04034b50) {
    const method = exported.data.readUInt16LE(offset + 8);
    const bytes = exported.data.readUInt32LE(offset + 18);
    const nameBytes = exported.data.readUInt16LE(offset + 26);
    const extraBytes = exported.data.readUInt16LE(offset + 28);
    const name = exported.data.toString('utf8', offset + 30, offset + 30 + nameBytes);
    const start = offset + 30 + nameBytes + extraBytes;
    const content = exported.data.subarray(start, start + bytes);
    zipContents.set(name, (method === 8 ? zlib.inflateRawSync(content) : content).toString('utf8'));
    offset = start + bytes;
  }
  for (const document of exported.manifest.documents) assert.deepEqual(managedKitScripts(zipContents.get(document.path)).map((kit) => kit.name), ['three']);
});

test('ordinary DOM adoption cannot re-enable disabled project kits from stale runtime tags', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-project-kit-adoption-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { managedKitScripts } = require('../src/canvas-project');
  const store = createCanvasStore({ userDataPath, kitBundles: { tone: 'window.Tone = {};' } });
  const created = store.createProject();
  const staleRuntime = store.get(created.id).html;
  store.updateManifest(created.id, { kits: ['canvas-2d'] });
  store.update(created.id, staleRuntime);
  assert.deepEqual(store.getProjectKits(created.id).kits, ['canvas-2d']);
  assert.deepEqual(managedKitScripts(store.get(created.id).html), []);
  store.update(created.id, staleRuntime, { restoreMetadata: true });
  assert.deepEqual(store.getProjectKits(created.id).kits, ['canvas-2d', 'tone']);
});

test('project kit edits check revisions, availability and idempotence without changing source files', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-project-kit-revisions-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createCanvasStore({ userDataPath, kitBundles: { tone: 'window.Tone = {};' } });
  const created = store.createProject();
  const originalFiles = store.getProject(created.id).files;
  const before = store.getProjectKits(created.id);
  assert.equal(store.updateManifest(created.id, { kits: before.kits }).changed, false);
  assert.throws(() => store.updateManifest(created.id, { kits: ['three'] }), /unavailable.*Settings/);
  assert.throws(() => store.updateManifest(created.id, { kits: ['../tone'] }), /offline kit names/);
  assert.deepEqual(store.getProjectKits(created.id), before);
  store.writeFile(created.id, { path: 'notes.txt', content: 'Concurrent edit' });
  assert.throws(() => store.updateManifest(created.id, { kits: ['canvas-2d'], expectedProjectRevision: before.projectRevision }), /project changed/);
  const changed = store.updateManifest(created.id, { kits: ['canvas-2d'] });
  assert.equal(changed.changed, true);
  assert.deepEqual(store.getProject(created.id).files.filter((file) => file.path !== 'notes.txt'), originalFiles);
  assert.equal(store.getProjectKits(created.id).projectRevision, changed.projectRevision);
});

test('refreshing the current kit list upgrades an old Strudel pin and preserves source, media and saved state', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-strudel-kit-refresh-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const oldKit = 'window.strudel = { old: true };';
  const newKit = 'window.strudel = { m4a: true };';
  const { createCanvasMediaStore } = require('../src/canvas-media-store');
  const media = createCanvasMediaStore({ userDataPath });
  const oldStore = createCanvasStore({ userDataPath, kitBundles: { strudel: oldKit }, assetStore: media });
  const project = oldStore.save({ title: 'Saved score', kits: ['canvas-2d', 'strudel'],
    html: '<main>My score</main><script>const score = "suno_hat";</script>' });
  const assetId = await media.save({ data: fs.readFileSync(path.join(__dirname, 'fixtures/strudel-samples/snare.m4a')).toString('base64'), mimeType: 'audio/mp4', name: 'Hat.m4a' });
  await oldStore.attachAssets(project.id, { assetIds: [assetId] });
  oldStore.saveProjectState(project.id, { state: { strudel: { score: 'saved editor text' } } });
  const before = oldStore.getProject(project.id);
  const store = createCanvasStore({ userDataPath, kitBundles: { strudel: newKit }, assetStore: media });
  assert.equal(store.getProjectKitSource(project.id, 'strudel').source, oldKit, 'installing a new bundle alone must keep the saved pin');
  store.updateManifest(project.id, { kits: store.listFiles(project.id).manifest.kits.map(kit => kit.name) });
  assert.equal(store.getProjectKitSource(project.id, 'strudel').source, newKit);
  const after = store.getProject(project.id);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.manifest.assets, before.manifest.assets);
  assert.deepEqual(store.readProjectState(project.id).state, { strudel: { score: 'saved editor text' } });
  assert.deepEqual(after.manifest.kits.map(kit => kit.name), ['canvas-2d', 'strudel']);
});

test('managed kit recognition preserves ordinary scripts, comments, quoted attributes and templates', () => {
  const { managedKitScripts, stripManagedKitScripts } = require('../src/canvas-project');
  const html = '<!-- <script data-easel-canvas-kit="tone">example</script> -->'
    + '<div title="<script data-easel-canvas-kit=\'three\'>example</script>"></div>'
    + '<script title="data-easel-canvas-kit=\'tone\'">window.userCode = true;</script>'
    + '<script>window.example = "<script data-easel-canvas-kit=\'tone\'>";</script>'
    + '<textarea><script data-easel-canvas-kit="tone">text</script></textarea>'
    + '<template><script data-easel-canvas-kit="tone">inert</script></template>'
    + '<script data-easel-canvas-kit="three" title="a > b">window.THREE = {};</script>';
  const scripts = managedKitScripts(html);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].name, 'three');
  assert.equal(scripts[0].source, 'window.THREE = {};');
  const stripped = stripManagedKitScripts(html);
  assert.equal(stripped, html.slice(0, scripts[0].start));
  assert.match(stripped, /window.userCode = true/);
  assert.match(stripped, /window.example/);
  const unclosedText = '<textarea><script data-easel-canvas-kit="tone">inert text';
  assert.equal(stripManagedKitScripts(unclosedText), unclosedText);
  const unclosedComment = '<!-- <script data-easel-canvas-kit="tone">inert text';
  assert.equal(stripManagedKitScripts(unclosedComment), unclosedComment);
});

test('legacy bundled kits migrate to one shared selection and can be disabled across raw HTML files', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-project-kit-legacy-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { managedKitScripts } = require('../src/canvas-project');
  const directory = path.join(userDataPath, 'canvases');
  fs.mkdirSync(directory);
  const id = 'f'.repeat(32);
  const legacy = '<html><head><script data-easel-canvas-kit="tone">window.Tone = {};</script></head><body><h1>Legacy</h1></body></html>';
  fs.writeFileSync(path.join(directory, `${id}.html`), legacy);
  const store = createCanvasStore({ userDataPath });
  assert.deepEqual(store.getProjectKits(id).kits, ['tone']);
  store.writeFile(id, { path: 'other.html', content: legacy });
  store.updateManifest(id, { kits: [] });
  for (const document of store.listDocuments(id).documents) assert.deepEqual(managedKitScripts(store.get(id, { documentPath: document.path }).html), []);
  assert.match(store.readFile(id, { path: 'other.html' }).text, /data-easel-canvas-kit="tone"/);
});

test('project export includes an editable timeline and protects its referenced media from detachment', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-timeline-export-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let timeline = null;
  const store = createCanvasStore({ userDataPath, readTimeline: () => timeline });
  const project = store.save({ title: 'Video edit', html: '<h1>Editor</h1>', assets: [{ name: 'source', data: 'YWJj', mimeType: 'image/png' }] });
  const assetId = store.getProject(project.id).manifest.assets[0].id;
  timeline = { schemaVersion: 1, id: 'timeline', revision: 0, frameRate: { numerator: 24, denominator: 1 }, width: 1920, height: 1080,
    tracks: [{ id: 'overlay-1', type: 'overlay', name: 'Image' }], items: [{ id: 'still', assetId, trackId: 'overlay-1', startFrame: 0, endFrame: 24, sourceStartSeconds: 0, sourceEndSeconds: 1 }], transitions: [] };
  assert.equal(store.inspectAssetDeletion(project.id, { assetId }).ok, false);
  assert.throws(() => store.detachAsset(project.id, { assetId }), /timeline/i);
  const exported = store.exportProject(project.id);
  assert.equal(exported.manifest.timeline, '.easel/timeline.json');
  const zlib = require('node:zlib');
  let offset = 0;
  let saved;
  while (exported.data.readUInt32LE(offset) === 0x04034b50) {
    const method = exported.data.readUInt16LE(offset + 8), bytes = exported.data.readUInt32LE(offset + 18);
    const names = exported.data.readUInt16LE(offset + 26), extras = exported.data.readUInt16LE(offset + 28);
    const name = exported.data.toString('utf8', offset + 30, offset + 30 + names), start = offset + 30 + names + extras;
    const data = exported.data.subarray(start, start + bytes);
    if (name === '.easel/timeline.json') saved = JSON.parse((method === 8 ? zlib.inflateRawSync(data) : data).toString());
    offset = start + bytes;
  }
  assert.deepEqual(saved, timeline);
});

test('a populated timeline does not block deleting an unrelated project source file', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-timeline-delete-file-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let timeline = null;
  const store = createCanvasStore({ userDataPath, readTimeline: () => timeline });
  const project = store.save({ title: 'Edit', html: '<h1>Edit</h1>', assets: [{ name: 'source', data: 'YWJj', mimeType: 'image/png' }] });
  timeline = { items: [{ assetId: store.getProject(project.id).manifest.assets[0].id }] };
  store.writeFile(project.id, { path: 'unused.txt', content: 'Remove this note.' });
  assert.equal(store.inspectDeletion(project.id, { path: 'unused.txt' }).ok, true);
  store.deleteFile(project.id, { path: 'unused.txt' });
  assert.equal(store.listFiles(project.id).files.some((file) => file.path === 'unused.txt'), false);
});

test('large saved videos attach without recursive base64 validation failures', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-large-attach-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const assetId = 'b'.repeat(32);
  const data = Buffer.alloc(8_000_000).toString('base64');
  const store = createCanvasStore({ userDataPath, assetStore: { get: async () => ({ id: assetId, data, mimeType: 'video/webm' }) } });
  const project = store.createProject({ title: 'Video' });
  await store.attachAssets(project.id, { assetIds: [assetId] });
  assert.equal(store.listAssets(project.id).assets[0].bytes, 8_000_000);
});

test('restoring an older canvas snapshot cannot detach a live timeline source', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-timeline-canvas-undo-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let timeline = null;
  const assetId = 'd'.repeat(32);
  const store = createCanvasStore({ userDataPath, readTimeline: () => timeline,
    assetStore: { get: async () => ({ id: assetId, data: 'YWJj', mimeType: 'video/webm' }) } });
  const project = store.createProject({ title: 'Edit' });
  const before = store.get(project.id).html;
  await store.attachAssets(project.id, { assetIds: [assetId] });
  timeline = { items: [{ assetId }] };
  assert.throws(() => store.update(project.id, before, { restoreMetadata: true }), /timeline/i);
  assert.equal(store.getAsset(project.id, assetId).data, 'YWJj');
});

test('all_timeline_references_block_detach', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-multi-reference-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let timelines = [];
  const store = createCanvasStore({ userDataPath, listTimelines: () => timelines });
  const project = store.save({ title: 'Two sketches', html: '<h1>Editor</h1>', assets: [{ name: 'source', data: 'YWJj', mimeType: 'image/png' }] });
  const assetId = store.getProject(project.id).manifest.assets[0].id;
  timelines = [{ id: 'a'.repeat(32), items: [] }, { id: 'b'.repeat(32), items: [{ assetId }] }];
  assert.equal(store.inspectAssetDeletion(project.id, { assetId }).ok, false);
  assert.throws(() => store.detachAsset(project.id, { assetId }), /timeline/i);
  assert.equal(store.getProject(project.id).manifest.assets.length, 1);
});

test('zip_preserves_all_instances', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-multi-zip-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { createTimelineDocument } = require('../src/video-timeline');
  const timelines = ['a', 'b'].map((id) => createTimelineDocument({ id: id.repeat(32) }));
  const instances = timelines.map((document, index) => ({ instanceId: String(index + 1).repeat(32), timelineId: document.id, documentPath: index ? 'second.html' : 'index.html', templateId: 'video-editor', templateVersion: 1 }));
  const store = createCanvasStore({ userDataPath, listTimelines: () => timelines, listInstances: () => instances });
  const project = store.createProject({ title: 'Multiple sketches' });
  store.createDocument(project.id, { path: 'second.html', html: '<h1>Second</h1>' });
  const exported = store.exportProject(project.id);
  assert.equal(exported.manifest.version, 2);
  assert.deepEqual(exported.manifest.instances, instances);
  assert.equal(exported.manifest.timelines.length, 2);
  assert.equal(exported.manifest.timeline, undefined);
  const entries = new Map(); let offset = 0;
  while (exported.data.readUInt32LE(offset) === 0x04034b50) {
    const method = exported.data.readUInt16LE(offset + 8), size = exported.data.readUInt32LE(offset + 18);
    const length = exported.data.readUInt16LE(offset + 26), extra = exported.data.readUInt16LE(offset + 28), start = offset + 30 + length + extra;
    const name = exported.data.toString('utf8', offset + 30, offset + 30 + length), bytes = exported.data.subarray(start, start + size);
    entries.set(name, (method === 8 ? zlib.inflateRawSync(bytes) : bytes).toString()); offset = start + size;
  }
  assert.equal(entries.has('.easel/timeline.json'), false);
  for (const timeline of timelines) assert.deepEqual(JSON.parse(entries.get(`.easel/timelines/${timeline.id}.json`)), timeline);
  assert.match(entries.get('.easel/source/second.html'), /Second/);
});
