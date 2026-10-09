const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const { prepareStrudelBundle } = require('../src/strudel-kit');
const { createProjectZip } = require('../src/project-zip');
const { BUNDLED_CANVAS_KITS, MAX_CANVAS_KIT_BYTES, prepareToneBundle } = require('../src/canvas-kits');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'canvas-kits');
const packageRoot = (name) => path.dirname(require.resolve(`${name}/package.json`));
const threeRoot = path.resolve(path.dirname(require.resolve('three')), '..');

function withLicense(source, filename, directory) {
  const license = fs.readFileSync(path.join(directory, filename), 'utf8').trim();
  return `/*!\n${license}\n*/\n${source}`;
}

// Build the published source entry with our exact installed dependency graph.
// Keep all source packages and an input-hash manifest alongside the artifact.
function buildStrudelKit(destination = outputPath) {
  const strudelRoot = packageRoot('@strudel/web');
  const metadata = JSON.parse(fs.readFileSync(path.join(strudelRoot, 'package.json'), 'utf8'));
  if (metadata.version !== '1.3.0') throw new Error('The Strudel kit requires @strudel/web 1.3.0.');
  const build = { entryPoints: ['src/strudel-kit-entry.mjs'], bundle: true, write: false,
    minify: false, format: 'iife', globalName: 'strudel', platform: 'browser', target: ['chrome120'],
    legalComments: 'inline', metafile: true, absWorkingDir: root };
  const built = esbuild.buildSync(build);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const sourceRoot = path.join(destination, 'strudel-source');
  const supplementsRoot = path.join(root, 'build/strudel-notices');
  const supplements = JSON.parse(fs.readFileSync(path.join(supplementsRoot, 'manifest.json'), 'utf8'));
  const visited = new Set();
  const packages = [];
  const notices = [];
  function collect(directory) {
    if (visited.has(directory)) return;
    visited.add(directory);
    const relative = path.relative(path.join(root, 'node_modules'), directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Strudel source dependency is outside node_modules.');
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const pinned = lock.packages[`node_modules/${relative.split(path.sep).join('/')}`];
    if (!pinned?.integrity || pinned.version !== pkg.version) throw new Error(`Missing exact source pin for ${pkg.name}.`);
    const licenseFiles = fs.readdirSync(directory).filter((name) => /^(license|licence|copying|notice)([.-].*)?$/i.test(name) && fs.statSync(path.join(directory, name)).isFile());
    for (const filename of licenseFiles) {
      const license = fs.readFileSync(path.join(directory, filename), 'utf8').trim();
      // A pre-existing comment terminator must never make the script executable.
      if (license.includes('*/')) throw new Error(`Unsupported comment delimiter in ${pkg.name}/${filename}.`);
      notices.push(`/*! ${pkg.name} ${pkg.version} — ${filename}\n${license}\n*/`);
    }
    const supplementalLicense = supplements[`${pkg.name}@${pkg.version}`];
    if (supplementalLicense) {
      const license = fs.readFileSync(path.join(supplementsRoot, supplementalLicense.file), 'utf8').trim();
      if (license.includes('*/')) throw new Error(`Unsupported supplemental comment delimiter for ${pkg.name}.`);
      notices.push(`/*! ${pkg.name} ${pkg.version} — source-matched upstream notice\n${license}\n*/`);
    }
    fs.cpSync(directory, path.join(sourceRoot, 'packages', relative), {
      recursive: true,
      filter: (filename) => path.basename(filename) !== 'node_modules',
    });
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license || pinned.license || null,
      resolved: pinned.resolved, integrity: pinned.integrity, sourcePath: `packages/${relative.split(path.sep).join('/')}`, licenseFiles, ...(supplementalLicense ? { supplementalLicense } : {}) });
    const resolve = createRequire(path.join(directory, 'package.json'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).sort()) {
      // Some dependencies export their entry point but hide package.json.
      const dependency = resolve.resolve.paths(name).map((base) => path.join(base, name))
        .find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
      if (!dependency && Object.hasOwn(pkg.optionalDependencies || {}, name)) continue;
      if (!dependency) throw new Error(`Missing source dependency ${name}.`);
      collect(dependency);
    }
  }
  collect(strudelRoot);
  const inputs = Object.keys(built.metafile.inputs).sort().map((filename) => {
    const fullPath = path.join(root, filename);
    let directory = path.dirname(fullPath);
    while (!fs.existsSync(path.join(directory, 'package.json')) && directory !== root) directory = path.dirname(directory);
    if (directory !== root) collect(directory);
    return { path: filename, sourcePath: filename.startsWith('node_modules/') ? filename.replace(/^node_modules\//, 'packages/') : `easel/${filename}`,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex') };
  });
  const notice = '/*! Strudel 1.3.0; AGPL-3.0-or-later. Built locally from the published web.mjs entry.\n' +
    'Full exported API retained; Easel worklet-disabled adapter appended.\n' +
    'Source, dependency notices, exact input hashes and build material: strudel-source.zip (strudel-source/manifest.json inside).\n*/\n';
  const bundle = prepareStrudelBundle(`${notice}${notices.join('\n')}\n${built.outputFiles[0].text}`);
  if (Buffer.byteLength(bundle) > MAX_CANVAS_KIT_BYTES) throw new Error('The bundled strudel canvas kit exceeds 8 MiB.');
  new vm.Script(bundle);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'strudel.js'), bundle);
  for (const filename of ['package.json', 'package-lock.json', 'packages/media-mcp/package.json',
    'LICENSE', 'NOTICE', 'packages/media-mcp/LICENSE', 'packages/media-mcp/NOTICE', 'licenses/creative-skills-MIT.txt',
    'scripts/build-canvas-kits.js', 'src/strudel-kit.js', 'src/strudel-kit-entry.mjs', 'src/strudel-score.js', 'src/canvas-kits.js', 'src/project-zip.js']) {
    const target = path.join(sourceRoot, 'easel', filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, filename), target);
  }
  fs.cpSync(supplementsRoot, path.join(sourceRoot, 'easel/build/strudel-notices'), { recursive: true });
  const manifest = { schemaVersion: 1, kitId: 'strudel', version: metadata.version,
    runtimeSha256: crypto.createHash('sha256').update(bundle).digest('hex'),
    build: { entryPoint: build.entryPoints[0], esbuildVersion: esbuild.version, format: build.format,
      platform: build.platform, target: build.target, minify: build.minify, legalComments: build.legalComments }, inputs,
    packages: packages.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)) };
  fs.writeFileSync(path.join(sourceRoot, 'esbuild-metafile.json'), JSON.stringify(built.metafile, null, 2) + '\n');
  fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(sourceRoot, 'README.txt'),
    'Strudel 1.3.0 source distribution material\n\n' +
    'packages/ preserves the installed published packages, preferred source files when provided, licenses, and upstream unminified distribution.\n' +
    'manifest.json and easel/package-lock.json record the installed dependency graph and integrity hashes.\n' +
    'easel/ contains the local adapter and build inputs; npm ci and npm run build:canvas-kits rebuild the local wrapper.\n' +
    'easel/ preserves the repository GPL license and notices byte-for-byte; dependencies retain their own upstream terms.\n' +
    'The runtime is rebuilt from web.mjs with pinned installed dependencies, not copied from the upstream all-in-one IIFE.\n' +
    'manifest.json hashes every actual esbuild input; esbuild-metafile.json records the composition.\n' +
    'Release/ZIP publication remains gated on missing upstream license texts and corresponding-source review; this material alone is not a claim of complete AGPL compliance.\n' +
    'Distributors must retain this entire directory with strudel.js. Never relabel upstream AGPL code under Easel licensing.\n');
  // The normal app file filter drops lockfiles/types and rewrites nested
  // package.json files. An opaque ZIP preserves every source byte through it.
  const archive = createProjectZip({ maxUncompressedBytes: 64 * 1024 * 1024, timestamp: new Date(1980, 0, 1).getTime() });
  function addSourceFiles(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) addSourceFiles(filename);
      else if (entry.isFile()) archive.add(path.relative(destination, filename).split(path.sep).join('/'), fs.readFileSync(filename));
      else throw new Error('Source archives cannot contain special files or symlinks.');
    }
  }
  addSourceFiles(sourceRoot);
  const sourceArchivePath = path.join(destination, 'strudel-source.zip');
  fs.writeFileSync(sourceArchivePath, archive.finish().data);
  return { bundlePath: path.join(destination, 'strudel.js'), sourceDirectory: sourceRoot, sourceArchivePath, manifest };
}

async function buildCanvasKits() {
  fs.mkdirSync(outputPath, { recursive: true });
  buildStrudelKit(outputPath);
  await esbuild.build({
    entryPoints: ['three'],
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'THREE',
    platform: 'browser',
    target: ['chrome120'],
    legalComments: 'inline',
    outfile: path.join(outputPath, 'three.js'),
    absWorkingDir: root,
  });
  const threeBundle = fs.readFileSync(path.join(outputPath, 'three.js'), 'utf8');
  fs.writeFileSync(path.join(outputPath, 'three.js'), withLicense(threeBundle, 'LICENSE', threeRoot), 'utf8');

  const copies = [
    { id: 'phaser', file: path.join(packageRoot('phaser'), 'dist', 'phaser.min.js'), license: 'LICENSE.md' },
    { id: 'matter', file: path.join(packageRoot('matter-js'), 'build', 'matter.min.js'), license: 'LICENSE' },
  ];
  for (const { id, file, license } of copies) {
    const source = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(path.join(outputPath, `${id}.js`), withLicense(source, license, packageRoot(id === 'phaser' ? 'phaser' : 'matter-js')), 'utf8');
  }

  const toneRoot = packageRoot('tone');
  const tone = fs.readFileSync(path.join(toneRoot, 'build', 'Tone.js'), 'utf8');
  const toneLicense = fs.readFileSync(path.join(toneRoot, 'build', 'Tone.js.LICENSE.txt'), 'utf8').trim();
  fs.writeFileSync(path.join(outputPath, 'tone.js'), prepareToneBundle(withLicense(`${tone}\n${toneLicense}\n`, 'LICENSE.md', toneRoot)), 'utf8');

  // Use the published classic bundle: its global is p5 and it skips network-loaded translations.
  const p5Root = path.resolve(path.dirname(require.resolve('p5')), '..');
  const p5Version = require(path.join(p5Root, 'package.json')).version;
  const p5Notice = `/*! p5.js ${p5Version}\n` +
    'Unmodified upstream library, LGPL-2.1. Unminified library: p5.source.js.\n' +
    `Upstream source: https://github.com/processing/p5.js/tree/v${p5Version}\n*/\n`;
  for (const [output, input] of [['p5.js', 'p5.min.js'], ['p5.source.js', 'p5.js']]) {
    const source = fs.readFileSync(path.join(p5Root, 'lib', input), 'utf8');
    fs.writeFileSync(path.join(outputPath, output), p5Notice + withLicense(source, 'license.txt', p5Root), 'utf8');
  }

  for (const kit of [...BUNDLED_CANVAS_KITS, 'p5.source']) {
    const filename = path.join(outputPath, `${kit}.js`);
    new vm.Script(fs.readFileSync(filename, 'utf8'), { filename });
  }
}

if (require.main === module) buildCanvasKits().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = { buildCanvasKits, buildStrudelKit };
