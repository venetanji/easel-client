const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher');
const { createTransformer } = require('app-builder-lib/out/fileTransformer');
const { buildStrudelKit } = require('../scripts/build-canvas-kits');
const root = path.resolve(__dirname, '..');

function allFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(filename) : [filename];
  });
}
function unzip(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    const content = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(content) : content);
    offset = start + size;
  }
  return files;
}

test('strudel_source_archive_preserves_merged_easel_license_material', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-strudel-licenses-'));
  try {
    const result = buildStrudelKit(directory);
    const contents = unzip(fs.readFileSync(result.sourceArchivePath));
    for (const filename of ['LICENSE', 'NOTICE', 'packages/media-mcp/LICENSE', 'packages/media-mcp/NOTICE', 'licenses/creative-skills-MIT.txt']) {
      const sourcePath = `strudel-source/easel/${filename}`;
      assert.ok(contents.has(sourcePath), `Easel source licensing material missing: ${filename}`);
      assert.deepEqual(contents.get(sourcePath), fs.readFileSync(path.join(root, filename)), `Easel source licensing material changed: ${filename}`);
    }
    assert.equal(JSON.parse(contents.get('strudel-source/easel/package.json')).license, 'GPL-3.0-or-later');
    assert.equal(JSON.parse(contents.get('strudel-source/packages/@strudel/web/package.json')).license, 'AGPL-3.0-or-later');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual_electron_filter_and_transform_preserve_every_source_byte', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-strudel-packaging-'));
  try {
    const result = buildStrudelKit(path.join(appRoot, 'canvas-kits'));
    const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
    const info = { config, projectDir: appRoot, buildResourcesDir: 'build', isPrepackedAppAsar: false, debugLogger: { isEnabled: false } };
    const [matcher] = getMainFileMatchers(appRoot, path.join(appRoot, 'packaged'), (s) => s, {}, { info }, path.join(appRoot, 'release'), false);
    const filter = matcher.createFilter();
    const transformer = createTransformer(appRoot, config, {});
    const originalFiles = allFiles(result.sourceDirectory);
    // Exercise the previous directory packaging path too, so the red result
    // demonstrates the real dropped lockfile rather than a missing new API.
    if (!result.sourceArchivePath) {
      const lock = path.join(result.sourceDirectory, 'easel/package-lock.json');
      assert.equal(filter(lock, fs.statSync(lock)), true, 'actual Electron filter must include the exact source lockfile');
    }
    const archive = result.sourceArchivePath;
    assert.equal(filter(archive, fs.statSync(archive)), true, 'source archive must survive the actual app file filter');
    const originalArchive = fs.readFileSync(archive);
    const transformed = await transformer(archive);
    const packagedArchive = transformed == null ? originalArchive : Buffer.from(transformed);
    assert.deepEqual(packagedArchive, originalArchive, 'Electron must not rewrite the source archive');
    const contents = unzip(packagedArchive);
    assert.equal(contents.size, originalFiles.length);
    for (const filename of originalFiles) {
      const name = path.relative(path.dirname(result.sourceDirectory), filename).split(path.sep).join('/');
      assert.deepEqual(contents.get(name), fs.readFileSync(filename), `packaged source changed: ${name}`);
    }
    for (const name of ['easel/package-lock.json', 'packages/chord-voicings/src/types.d.ts', 'packages/@tonaljs/core/node_modules/@tonaljs/pitch-note/package.json', 'easel/src/project-zip.js']) {
      assert.ok(contents.has(`strudel-source/${name}`), `rebuild material missing: ${name}`);
    }
    const unpacked = path.join(appRoot, 'unpacked');
    for (const [name, bytes] of contents) {
      const target = path.join(unpacked, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    const rebuildRoot = path.join(unpacked, 'strudel-source/easel');
    // Rebuild using archived runtime dependencies and local copies of the
    // already-installed build tools/kits. No npm, network or shared-module writes.
    const rebuiltModules = path.join(rebuildRoot, 'node_modules');
    fs.cpSync(path.join(unpacked, 'strudel-source/packages'), rebuiltModules, { recursive: true });
    const buildPackages = ['esbuild', 'three', 'phaser', 'matter-js', 'tone', 'p5',
      ...Object.keys(require('esbuild/package.json').optionalDependencies || {})];
    for (const name of buildPackages) {
      const installed = path.join(root, 'node_modules', name);
      if (fs.existsSync(installed)) fs.cpSync(installed, path.join(rebuiltModules, name), { recursive: true });
    }
    const rebuilt = spawnSync(process.execPath, ['scripts/build-canvas-kits.js'],
      { cwd: rebuildRoot, encoding: 'utf8', timeout: 20_000 });
    assert.equal(rebuilt.status, 0, `packaged-source rebuild failed: ${rebuilt.error || rebuilt.stderr}`);
    assert.deepEqual(fs.readFileSync(path.join(rebuildRoot, 'canvas-kits/strudel.js')), fs.readFileSync(result.bundlePath));
  } finally { fs.rmSync(appRoot, { recursive: true, force: true }); }
});
