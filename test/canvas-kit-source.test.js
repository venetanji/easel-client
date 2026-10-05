const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { parse } = require('parse5');
const { createProjectZip } = require('../src/project-zip');
const { createCanvasStore } = require('../src/canvas-store');
const { createSourceArchiveFixture: sourceArchive } = require('./helpers/canvas-kit-source');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceA = 'window.strudel = { label: "A" };';
const sourceB = 'window.strudel = { label: "B" };';
function unzip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    const bytes = buffer.subarray(start, start + size);
    entries.set(name, method === 8 ? zlib.inflateRawSync(bytes) : bytes);
    offset = start + size;
  }
  return entries;
}
function fixture(t, { archive = sourceArchive(sourceA), installed = sourceA, assetStore } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-source-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kits = { strudel: installed };
  let currentArchive = archive;
  const reopen = () => createCanvasStore({ userDataPath: root, kitBundles: kits, assetStore, readKitSourceArchive: () => currentArchive });
  const store = reopen();
  const created = store.createProject({ title: 'Sound source', kits: ['strudel'] });
  const dependencies = path.join(root, 'canvases', '.dependencies');
  return { store, created, root, dependencies, reopen, changeInstalled(source, bytes) { kits.strudel = source; currentArchive = bytes; } };
}

test('project ZIP carries exact matching source archive and truthful manifest identity', (t) => {
  const archive = sourceArchive(sourceA);
  const f = fixture(t, { archive });
  const exported = f.store.exportProject(f.created.id);
  const kit = exported.manifest.kits.find((kit) => kit.name === 'strudel');
  assert.ok(kit.correspondingSource, 'Strudel distribution must identify its corresponding source');
  assert.equal(kit.correspondingSource.runtimeSha256, sha256(sourceA));
  assert.equal(kit.correspondingSource.sha256, sha256(archive));
  assert.equal(kit.correspondingSource.bytes, archive.length);
  assert.deepEqual(unzip(exported.data).get(kit.correspondingSource.path), archive);
  assert.equal(exported.contributions.kitSourceBytes, archive.length);
});

test('source cache survives app upgrade and never pairs pinned runtime A with source B', (t) => {
  const archiveA = sourceArchive(sourceA), archiveB = sourceArchive(sourceB);
  const f = fixture(t, { archive: archiveA });
  const binding = path.join(f.dependencies, `${sha256(sourceA)}.source.json`);
  assert.ok(fs.existsSync(binding), 'source should be retained when a project pins the installed runtime');
  f.changeInstalled(sourceB, archiveB);
  const exported = f.reopen().exportProject(f.created.id);
  const source = exported.manifest.kits[0].correspondingSource;
  assert.deepEqual(unzip(exported.data).get(source.path), archiveA);
  assert.equal(source.runtimeSha256, sha256(sourceA));
  assert.notEqual(source.sha256, sha256(archiveB));
});

test('legacy pins backfill only an installed archive whose manifest matches their runtime', (t) => {
  const f = fixture(t, { archive: null });
  const before = fs.readFileSync(path.join(f.root, 'canvases', `${f.created.id}.project.json`));
  f.changeInstalled(sourceB, sourceArchive(sourceB));
  assert.throws(() => f.reopen().exportProject(f.created.id), /corresponding source.*(?:mismatch|match|pinned)/i);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'canvases', `${f.created.id}.project.json`)), before);
  f.changeInstalled(sourceA, sourceArchive(sourceA));
  assert.ok(f.reopen().exportProject(f.created.id).manifest.kits[0].correspondingSource);
});

test('missing source blocks artifact distribution but preserves preview, authored source and native WAV input', (t) => {
  const f = fixture(t, { archive: null });
  assert.match(f.store.get(f.created.id).html, /window.strudel/);
  assert.equal(f.store.getProjectKitSource(f.created.id, 'strudel').source, sourceA);
  assert.doesNotMatch(f.store.getDocumentSource(f.created.id).html, /window.strudel/);
  assert.throws(() => f.store.exportProject(f.created.id), /corresponding source.*(?:missing|unavailable)/i);
  assert.equal(typeof f.store.exportDocument, 'function', 'standalone export requires a distribution-only assembly path');
  assert.throws(() => f.store.exportDocument(f.created.id), /corresponding source.*(?:missing|unavailable)/i);
});

test('corrupt cached archive and conflicting binding fail closed without installed replacement', (t) => {
  const f = fixture(t);
  const bindingPath = path.join(f.dependencies, `${sha256(sourceA)}.source.json`);
  assert.ok(fs.existsSync(bindingPath), 'expected exact-runtime source binding');
  const binding = JSON.parse(fs.readFileSync(bindingPath));
  const archivePath = path.join(f.dependencies, `${binding.archiveSha256}.source.zip`);
  const original = fs.readFileSync(archivePath);
  const corrupt = Buffer.from(original); corrupt[40] ^= 1;
  fs.writeFileSync(archivePath, corrupt);
  assert.throws(() => f.store.exportProject(f.created.id), /corresponding source.*corrupt/i);
  assert.deepEqual(fs.readFileSync(archivePath), corrupt);
  fs.writeFileSync(archivePath, original);
  binding.runtimeSha256 = sha256(sourceB); fs.writeFileSync(bindingPath, JSON.stringify(binding));
  assert.throws(() => f.store.exportProject(f.created.id), /corresponding source.*(?:binding|conflict|corrupt)/i);
  assert.equal(JSON.parse(fs.readFileSync(bindingPath)).runtimeSha256, sha256(sourceB));
});

test('ZIP compiled documents link to their retained source from nested and root paths', (t) => {
  const f = fixture(t);
  f.store.writeFile(f.created.id, { path: 'sketches/sound/index.html', content: '<main>Another sound</main>' });
  const exported = f.store.exportProject(f.created.id), entries = unzip(exported.data);
  const sourcePath = exported.manifest.kits[0].correspondingSource?.path;
  assert.ok(sourcePath, 'export must publish a source archive path');
  for (const document of exported.documents) {
    const html = entries.get(document.path).toString();
    const relative = path.posix.relative(path.posix.dirname(document.path), sourcePath);
    assert.ok(html.includes(`href="${relative}"`), `source link missing from ${document.path}`);
    assert.match(html, /Strudel corresponding source/);
    assert.doesNotMatch(entries.get(`.easel/source/${document.path}`).toString(), /corresponding source/);
  }
});

test('standalone HTML embeds byte-exact non-executable source download only in its distribution output', (t) => {
  const archive = sourceArchive(sourceA), f = fixture(t, { archive });
  assert.equal(typeof f.store.exportDocument, 'function', 'standalone source-aware export method');
  const exported = f.store.exportDocument(f.created.id);
  const match = /href="data:application\/zip;base64,([A-Za-z0-9+/=]+)"/.exec(exported.html);
  assert.ok(match, 'standalone HTML must contain a retrievable corresponding-source archive');
  assert.deepEqual(Buffer.from(match[1], 'base64'), archive);
  assert.match(exported.html, /download="strudel-[a-f0-9]{16}\.source\.zip"/);
  assert.match(exported.html, /Strudel corresponding source/);
  assert.equal(exported.bytes, Buffer.byteLength(exported.html));
  assert.doesNotMatch(f.store.get(f.created.id).html, /application\/zip|corresponding source/);
});

test('source footer is outside scripts, comments and templates and standalone retains the authored snapshot', (t) => {
  const f = fixture(t);
  f.store.writeFile(f.created.id, { path: 'index.html', content: '<html><head></head><body><!-- </body> --><template></body></template><script>window.literal = "</body>";</script><main>Sound</main></body></html>' });
  const exported = f.store.exportDocument(f.created.id);
  assert.ok(exported.html.lastIndexOf('data-easel-corresponding-source=') > exported.html.indexOf('<main>Sound</main>'), 'source footer must follow real authored content');
  assert.match(exported.html, /easel-project-snapshot/, 'standalone retains the original export snapshot contract');
  assert.match(exported.html, /window.literal = "<\/body>";/);
});

function activeDocument(html) {
  const document = parse(html), nodes = [];
  const visit = (node) => { nodes.push(node); for (const child of node.childNodes || []) visit(child); };
  visit(document); // Deliberately exclude inert template.content.
  const body = nodes.find((node) => node.tagName === 'body');
  const offers = nodes.filter((node) => node.tagName === 'a' && node.parentNode?.attrs?.some(({ name, value }) => name === 'data-easel-corresponding-source' && value === 'strudel'));
  return { nodes, body, offers };
}
const attribute = (node, name) => node.attrs?.find((attr) => attr.name === name)?.value;
const textContent = (node) => node?.nodeName === '#text' ? node.value : (node?.childNodes || []).map(textContent).join('');

const sourceOfferMarkupCases = [
  ['single-quoted attribute', '<div data-fixture="literal" data-label=\'</body>\'>A label</div>'],
  ['double-quoted attribute', '<div data-fixture="literal" data-label="</body>">A label</div>'],
  ['title and RCDATA', '<title>literal </body></title><textarea data-fixture="literal">literal </body></textarea>'],
  ['raw xmp', '<xmp data-fixture="literal">literal </body></xmp>'],
  ['raw iframe', '<iframe data-fixture="literal">literal </body></iframe>'],
  ['raw noembed', '<noembed data-fixture="literal">literal </body></noembed>'],
  ['raw noframes', '<noframes data-fixture="literal">literal </body></noframes>'],
  ['script and style', '<script data-fixture="literal">window.literal = "</body>";</script><style>p::after{content:"</body>"}</style>'],
  ['comment and quoted template closing text', '<!-- </body> --><template><div data-label="</template>">literal </body></div></template><div data-fixture="literal">Active content</div>'],
];
for (const [name, markup] of sourceOfferMarkupCases) test(`parsed source offer remains active and preserves ${name} in standalone and root/nested ZIP`, (t) => {
  const archive = sourceArchive(sourceA), f = fixture(t, { archive });
  const authored = `<html><head></head><body>${markup}<main>Sound</main></body></html>`;
  const documents = ['index.html', 'sketches/literal/index.html'];
  for (const documentPath of documents) f.store.writeFile(f.created.id, { path: documentPath, content: authored });
  const previews = new Map(documents.map((documentPath) => [documentPath, f.store.get(f.created.id, { documentPath }).html]));
  const canonicalPath = path.join(f.root, 'canvases', `${f.created.id}.project.json`), before = fs.readFileSync(canonicalPath);
  const zip = f.store.exportProject(f.created.id), entries = unzip(zip.data), sourcePath = zip.manifest.kits[0].correspondingSource.path;
  for (const documentPath of documents) {
    const standalone = f.store.exportDocument(f.created.id, { documentPath });
    const preview = activeDocument(previews.get(documentPath));
    const originalNode = preview.nodes.find((node) => attribute(node, 'data-fixture') === 'literal');
    for (const [kind, html, expectedHref] of [
      ['standalone', standalone.html, `data:application/zip;base64,${archive.toString('base64')}`],
      ['ZIP', entries.get(documentPath).toString(), path.posix.relative(path.posix.dirname(documentPath), sourcePath)],
    ]) {
      const exported = activeDocument(html);
      assert.equal(exported.offers.length, 1, `${kind} ${documentPath} needs one actual source anchor`);
      const offer = exported.offers[0];
      assert.equal(attribute(offer, 'href'), expectedHref);
      assert.equal(attribute(offer, 'download'), `strudel-${sha256(sourceA).slice(0, 16)}.source.zip`);
      let ancestor = offer.parentNode;
      while (ancestor && ancestor !== exported.body) ancestor = ancestor.parentNode;
      assert.equal(ancestor, exported.body, 'source offer must be active body content');
      const preserved = exported.nodes.find((node) => attribute(node, 'data-fixture') === 'literal');
      assert.ok(preserved && originalNode, 'original authored node remains present');
      assert.deepEqual(preserved.attrs, originalNode.attrs, 'quoted attributes are unchanged');
      assert.equal(textContent(preserved), textContent(originalNode), 'raw/RCDATA text is unchanged');
    }
    assert.equal(entries.get(`.easel/source/${documentPath}`).toString(), authored);
    assert.equal(f.store.get(f.created.id, { documentPath }).html, previews.get(documentPath), 'internal preview is unchanged');
    const snapshot = activeDocument(standalone.html).nodes.find((node) => attribute(node, 'id') === 'easel-project-snapshot');
    assert.equal(JSON.parse(textContent(snapshot)).files[documentPath], authored, 'standalone authored snapshot is unchanged');
  }
  assert.deepEqual(fs.readFileSync(canonicalPath), before, 'distribution never rewrites authored source');
});

for (const [name, authored] of [
  ['omitted body and html endings', '<html><head></head><body><main>Omitted endings</main>'],
  ['implicit body', '<html><head></head><main>Implicit body</main></html>'],
  ['open plaintext', '<html><head></head><body><plaintext>literal </body> and all later tags are text'],
]) test(`parsed source offer handles ${name} without appending into inert text`, (t) => {
  const f = fixture(t);
  for (const documentPath of ['index.html', 'sketches/omitted/index.html']) f.store.writeFile(f.created.id, { path: documentPath, content: authored });
  const zip = unzip(f.store.exportProject(f.created.id).data);
  for (const documentPath of ['index.html', 'sketches/omitted/index.html']) {
    for (const html of [f.store.exportDocument(f.created.id, { documentPath }).html, zip.get(documentPath).toString()]) assert.equal(activeDocument(html).offers.length, 1, 'one active source download remains retrievable');
    assert.equal(zip.get(`.easel/source/${documentPath}`).toString(), authored);
  }
});

test('source distribution fails closed when no safe active body insertion exists', (t) => {
  const f = fixture(t);
  for (const authored of ['<html><head></head><frameset><frame></frameset></html>', '<html><head><noscript>unclosed raw head text']) {
    f.store.writeFile(f.created.id, { path: 'index.html', content: authored });
    assert.ok(f.store.get(f.created.id).html, 'preview remains available');
    assert.throws(() => f.store.exportDocument(f.created.id), /corresponding source.*safe.*body/i);
    assert.throws(() => f.store.exportProject(f.created.id), /corresponding source.*safe.*body/i);
    assert.equal(f.store.readFile(f.created.id, { path: 'index.html' }).text, authored);
  }
});

test('standalone distribution verifies actual cached runtime bytes against the source pin', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dependencies, `${sha256(sourceA)}.js`), sourceB);
  assert.throws(() => f.store.exportDocument(f.created.id), /strudel.*(?:kit|dependency).*corrupt/i);
});

test('interrupted source binding write keeps project usable and retries only identical source bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-source-interrupted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let interrupted = true;
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => {
    if (interrupted && to.endsWith('.source.json')) throw new Error('Source binding write interrupted');
    return fs.renameSync(from, to);
  };
  const archive = sourceArchive(sourceA);
  const store = createCanvasStore({ userDataPath: root, fileSystem, kitBundles: { strudel: sourceA }, readKitSourceArchive: () => archive });
  const project = store.createProject({ kits: ['strudel'] });
  assert.match(store.get(project.id).html, /window.strudel/);
  assert.equal(store.getProjectKitSource(project.id, 'strudel').source, sourceA);
  assert.throws(() => store.exportProject(project.id), /Source binding write interrupted/);
  const directory = path.join(root, 'canvases', '.dependencies');
  assert.deepEqual(fs.readFileSync(path.join(directory, `${sha256(archive)}.source.zip`)), archive);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
  interrupted = false;
  const exported = store.exportProject(project.id);
  assert.deepEqual(unzip(exported.data).get(exported.manifest.kits[0].correspondingSource.path), archive);
});

test('opaque ZIP parser rejects truncation, altered CRC, central conflicts and explicit size/count bounds', () => {
  const { validateKitSourceArchive, MAX_KIT_SOURCE_ARCHIVE_BYTES, MAX_KIT_SOURCE_UNCOMPRESSED_BYTES, MAX_KIT_SOURCE_ENTRIES } = require('../src/canvas-kit-source');
  const archive = sourceArchive(sourceA), runtime = sha256(sourceA);
  assert.equal(validateKitSourceArchive(archive, runtime).archiveSha256, sha256(archive));
  assert.throws(() => validateKitSourceArchive(archive.subarray(0, archive.length - 1), runtime), /invalid/i);
  const crc = Buffer.from(archive); crc.writeUInt32LE(0, 14);
  assert.throws(() => validateKitSourceArchive(crc, runtime), /checksum/i);
  const central = Buffer.from(archive), offset = central.readUInt32LE(central.length - 6);
  central.writeUInt32LE(1, offset + 42);
  assert.throws(() => validateKitSourceArchive(central, runtime), /conflicting ZIP/i);
  const expanded = Buffer.from(archive); expanded.writeUInt32LE(MAX_KIT_SOURCE_UNCOMPRESSED_BYTES + 1, 22);
  assert.throws(() => validateKitSourceArchive(expanded, runtime), /expanded limit/i);
  const count = Buffer.from(archive); count.writeUInt16LE(MAX_KIT_SOURCE_ENTRIES + 1, count.length - 14); count.writeUInt16LE(MAX_KIT_SOURCE_ENTRIES + 1, count.length - 12);
  assert.throws(() => validateKitSourceArchive(count, runtime), /entry limit/i);
  assert.throws(() => validateKitSourceArchive(Buffer.alloc(MAX_KIT_SOURCE_ARCHIVE_BYTES + 1), runtime), /archive limit/i);
});

test('installed source reader bounds stat before bytes and refuses symlinks', (t) => {
  const { createInstalledKitSourceReader, MAX_KIT_SOURCE_ARCHIVE_BYTES } = require('../src/canvas-kit-source');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-source-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = sourceArchive(sourceA), filename = path.join(root, 'strudel-source.zip');
  fs.writeFileSync(filename, archive);
  assert.deepEqual(createInstalledKitSourceReader(root)('strudel'), archive);
  const fileSystem = Object.create(fs);
  fileSystem.lstatSync = () => ({ isFile: () => true, isSymbolicLink: () => false, size: MAX_KIT_SOURCE_ARCHIVE_BYTES + 1 });
  fileSystem.readFileSync = () => assert.fail('oversized archive must be rejected before read');
  assert.throws(() => createInstalledKitSourceReader(root, { fileSystem })('strudel'), /oversized/i);
  fs.renameSync(filename, path.join(root, 'original.zip')); fs.symlinkSync('original.zip', filename);
  assert.throws(() => createInstalledKitSourceReader(root)('strudel'), /invalid/i);
});

test('ZIP minimum budget counts retained source before attempting unavailable media reads', (t) => {
  const { MAX_PROJECT_EXPORT_BYTES } = require('../src/canvas-store');
  const archive = sourceArchive(sourceA), f = fixture(t, { archive });
  const projectFile = path.join(f.root, 'canvases', `${f.created.id}.project.json`);
  const project = JSON.parse(fs.readFileSync(projectFile));
  project.manifest.assets = ['1', '2', '3', '4'].map((id, index) => ({ id: id.repeat(64), digest: id.repeat(64), path: `assets/${id}.bin`, mimeType: 'application/octet-stream', bytes: index === 3 ? 1 : 32 * 1_048_576 }));
  const sourceBytes = Object.values(project.files).reduce((total, text) => total + Buffer.byteLength(text), 0);
  const minimumWithoutArchive = (last) => {
    project.manifest.assets[3].bytes = last;
    return sourceBytes + Buffer.byteLength(JSON.stringify(project, null, 2)) + project.manifest.assets.reduce((total, asset) => total + asset.bytes + Math.ceil(asset.bytes / 3) * 4, 0) + 2 * Buffer.byteLength(sourceA);
  };
  let low = 1, high = 32 * 1_048_576;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (minimumWithoutArchive(middle) <= MAX_PROJECT_EXPORT_BYTES) low = middle; else high = middle - 1; }
  const without = minimumWithoutArchive(low);
  assert.ok(without <= MAX_PROJECT_EXPORT_BYTES && without + archive.length > MAX_PROJECT_EXPORT_BYTES, 'archive alone must cross the minimum budget');
  fs.writeFileSync(projectFile, JSON.stringify(project));
  assert.throws(() => f.store.exportProject(f.created.id), (error) => /minimum export size.*over budget/i.test(error.message) && error.message.includes(`"kitSourceBytes":${archive.length}`));
});

test('main HTML download uses source-aware artifact and preserves save-before-export ordering', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const body = /canvasHandle\(IPC_CHANNELS.EXPORT_CANVAS, async \(event, id\) => \{([\s\S]*?)\n  \}\);/.exec(main)?.[1];
  assert.ok(body, 'expected actual main HTML export handler');
  const calls = [], id = 'a'.repeat(32);
  const handler = vm.runInNewContext(`(async (event,id)=>{${body}})`, {
    assertTrustedSender: () => calls.push('sender'), validateOpaqueId: (value) => value, mainWindow: {},
    requireCanvasView: () => ({ getCurrentCanvasId: () => id, saveCurrent: async () => { calls.push('save'); return {}; } }),
    emitCanvasSaved: () => calls.push('saved'),
    CANVASES: { get: () => assert.fail('internal preview HTML must not be distributed'), exportDocument: (value) => { assert.equal(value, id); calls.push('source-aware'); return { title: 'Sound', html: 'HTML plus exact source' }; } },
    dialog: { showSaveDialog: async () => { calls.push('dialog'); return { canceled: false, filePath: '/test/Sound.html' }; } },
    fs: { writeFileSync: (filename, html, encoding) => { calls.push('write'); assert.equal(filename, '/test/Sound.html'); assert.equal(html, 'HTML plus exact source'); assert.equal(encoding, 'utf8'); } }, path,
  });
  await handler({}, id);
  assert.deepEqual(calls, ['sender', 'save', 'saved', 'source-aware', 'dialog', 'write']);
  assert.match(main, /readKitSourceArchive:\s*createInstalledKitSourceReader\(path\.join\(app\.getAppPath\(\), 'canvas-kits'\)\)/);
});

test('standalone 128 MiB limit includes embedded source base64 and leaves preview available', async (t) => {
  const zip = createProjectZip({ timestamp: new Date(1980, 0, 1).getTime() });
  zip.add('strudel-source/manifest.json', JSON.stringify({ schemaVersion: 1, kitId: 'strudel', version: '1.3.0', runtimeSha256: sha256(sourceA) }));
  zip.add('strudel-source/packages/fixture.bin', crypto.randomBytes(34 * 1_048_576));
  const assetId = 'b'.repeat(32), media = Buffer.alloc(32 * 1_048_576).toString('base64');
  const f = fixture(t, { archive: zip.finish().data, assetStore: { get: async () => ({ id: assetId, data: media, mimeType: 'image/png' }) } });
  await f.store.attachAssets(f.created.id, { assetIds: [assetId] });
  f.store.writeFile(f.created.id, { path: 'index.html', content: `<main><img src="{{asset:${assetId}}}"></main>` });
  const previewBytes = f.store.get(f.created.id).assembledBytes;
  assert.ok(previewBytes < 128 * 1_048_576, 'preview alone must fit the document export budget');
  assert.throws(() => f.store.exportDocument(f.created.id), /128 MiB document limit.*corresponding source/i);
  assert.ok(f.store.getProjectKitSource(f.created.id, 'strudel').source);
});
