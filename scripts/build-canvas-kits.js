const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const vm = require('node:vm');
const { BUNDLED_CANVAS_KITS, prepareToneBundle } = require('../src/canvas-kits');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'canvas-kits');
const packageRoot = (name) => path.dirname(require.resolve(`${name}/package.json`));
const threeRoot = path.resolve(path.dirname(require.resolve('three')), '..');

function withLicense(source, filename, directory) {
  const license = fs.readFileSync(path.join(directory, filename), 'utf8').trim();
  return `/*!\n${license}\n*/\n${source}`;
}

async function buildCanvasKits() {
  fs.mkdirSync(outputPath, { recursive: true });
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

buildCanvasKits().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
