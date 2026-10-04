const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
async function buildVideoRuntime() {
  const packageRoot = path.resolve(path.dirname(require.resolve('mediabunny')), '../..');
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.version !== '1.61.0') throw new Error('The video runtime must use reviewed Mediabunny 1.61.0.');
  const license = fs.readFileSync(path.join(packageRoot, 'LICENSE'), 'utf8');
  const output = path.join(root, 'canvas-kits', 'mediabunny.js');
  const exports = ['Input', 'BufferSource', 'CanvasSink', 'AudioBufferSink', 'CanvasSource', 'AudioBufferSource',
    'Output', 'BufferTarget', 'WebMOutputFormat', 'Quality', 'canEncodeVideo', 'canEncodeAudio',
    'MP4', 'QTFF', 'WEBM', 'WAVE', 'MP3', 'OGG', 'FLAC', 'ADTS'];
  await esbuild.build({ stdin: { contents: `export { ${exports.join(', ')} } from 'mediabunny';`, resolveDir: root },
    bundle: true, minify: true, platform: 'browser', format: 'iife', globalName: 'EaselMediabunny',
    target: ['chrome120'], legalComments: 'inline', outfile: output,
    banner: { js: `/*! Mediabunny 1.61.0, copyright Vanilagy. MPL-2.0.\nUnmodified library compiled for Easel. Source: https://github.com/Vanilagy/mediabunny/tree/v1.61.0\nThe full upstream source and license are also distributed in node_modules/mediabunny.\n${license}\n*/` } });
  const source = fs.readFileSync(output, 'utf8');
  new vm.Script(source);
  if (Buffer.byteLength(source) > 800 * 1024) throw new Error('The bundled video runtime exceeds the template size budget.');
  process.stdout.write(`Mediabunny 1.61.0 offline bundle: ${Buffer.byteLength(source)} bytes\n`);
}
buildVideoRuntime().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
