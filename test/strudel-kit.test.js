const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { BUNDLED_CANVAS_KITS, MAX_CANVAS_KIT_BYTES, loadCanvasKitBundles } = require('../src/canvas-kits');
const { availableCanvasKits, assertInstalledKits } = require('../src/canvas-kit-catalog');
const { buildCanvasDocument, CSP } = require('../src/canvas-policy');
const root = path.resolve(__dirname, '..');
const adapterPath = path.join(root, 'src/strudel-kit.js');
const baselineCsp = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src data: blob:; media-src data: blob:; font-src data:; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

function adapter() {
  assert.ok(fs.existsSync(adapterPath), 'a local Strudel adapter is required');
  return require(adapterPath);
}

test('kit_is_local_and_pinned', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.devDependencies['@strudel/web'], '1.3.0');
  assert.ok(BUNDLED_CANVAS_KITS.includes('strudel'));
  assert.equal(MAX_CANVAS_KIT_BYTES, 8 * 1024 * 1024);
  const absent = availableCanvasKits().find((kit) => kit.id === 'strudel');
  assert.equal(absent.installed, false);
  const bundles = { strudel: 'window.strudel = {};' };
  assert.equal(availableCanvasKits(bundles).find((kit) => kit.id === 'strudel').installed, true);
  assert.deepEqual(assertInstalledKits(['strudel'], bundles), ['strudel']);
  const document = buildCanvasDocument({ html: '<html><head></head><body></body></html>', kits: ['strudel'], kitBundles: bundles });
  assert.match(document, /data-easel-canvas-kit="strudel"/);
});

test('adapter_precedes_init', () => {
  const { prepareStrudelBundle, getStrudelCapabilities } = adapter();
  const calls = [];
  const strudel = {
    initAudioOnFirstClick(options) { calls.push(['audio', options.disableWorklets]); return new Promise(() => {}); },
    initStrudel(options) { calls.push(['init', options]); return 'original-result'; },
    note() { return 'original-pattern'; },
    hush() { return 'original-hush'; },
  };
  const context = { window: { strudel }, document: { documentElement: { dataset: {} } } };
  const source = '/*! upstream notice */\nwindow.originalBundleLoaded = true;';
  const prepared = prepareStrudelBundle(source);
  vm.runInNewContext(prepared, context);
  assert.equal(context.window.originalBundleLoaded, true);
  assert.deepEqual(calls, [['audio', true]]);
  assert.equal(strudel.initStrudel({ prebake: true }), 'original-result');
  assert.deepEqual(calls, [['audio', true], ['init', { prebake: true }]]);
  assert.equal(strudel.note(), 'original-pattern');
  assert.equal(strudel.hush(), 'original-hush');
  assert.equal(prepareStrudelBundle(prepared), prepared);
  const capabilities = getStrudelCapabilities();
  assert.deepEqual(capabilities.nativeSynths, ['sine', 'triangle', 'square', 'sawtooth']);
  assert.equal(capabilities.audioExport, true, 'bounded WAV export passed the production runtime/Media gate at b3cb58a');
  assert.equal(capabilities.externalSamples, false);
  assert.equal(capabilities.repl, true);
  const scratchCalls = [];
  const scratchStrudel = { initAudioOnFirstClick(options) { scratchCalls.push(options.disableWorklets); } };
  const scratchContext = { window: { strudel: scratchStrudel }, document: { documentElement: { dataset: { easelStrudelRepl: 'v1' } } } };
  vm.runInNewContext(prepareStrudelBundle('window.scratchLoaded = true;'), scratchContext);
  assert.deepEqual(scratchCalls, [false]);
});

test('bundle_preserves_notices', () => {
  const { prepareStrudelBundle } = adapter();
  const source = '/*! AGPL-3.0-or-later upstream notice */\nwindow.strudel = {};';
  assert.ok(prepareStrudelBundle(source).startsWith(source));
  const { buildStrudelKit } = require('../scripts/build-canvas-kits');
  assert.equal(typeof buildStrudelKit, 'function', 'build pipeline must package the pinned local kit');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-strudel-kit-test-'));
  try {
    buildStrudelKit(directory);
    const bundle = loadCanvasKitBundles(directory).strudel;
    const upstreamRoot = path.dirname(require.resolve('@strudel/web/package.json'));
    assert.ok(!bundle.includes(fs.readFileSync(path.join(upstreamRoot, 'dist/index.js'), 'utf8')), 'rebuild from the source entry with the local pinned dependency graph');
    assert.ok(bundle.includes(fs.readFileSync(path.join(upstreamRoot, 'LICENSE'), 'utf8').trim()));
    assert.ok(Buffer.byteLength(bundle) <= MAX_CANVAS_KIT_BYTES);
    new vm.Script(bundle);
    const sourceRoot = path.join(directory, 'strudel-source');
    assert.ok(fs.existsSync(path.join(sourceRoot, 'packages/@strudel/web/web.mjs')));
    assert.ok(fs.existsSync(path.join(sourceRoot, 'packages/superdough/synth.mjs')));
    assert.equal(fs.readFileSync(path.join(sourceRoot, 'easel/src/strudel-kit.js'), 'utf8'), fs.readFileSync(adapterPath, 'utf8'));
    assert.ok(fs.existsSync(path.join(sourceRoot, 'easel/packages/media-mcp/package.json')), 'npm ci needs the declared workspace manifest');
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.packages.find((p) => p.name === '@strudel/web').version, '1.3.0');
    assert.equal(manifest.build.entryPoint, 'src/strudel-kit-entry.mjs');
    assert.ok(manifest.inputs.every((input) => input.sha256 && fs.existsSync(path.join(sourceRoot, input.sourcePath))));
    assert.ok(manifest.packages.some((p) => p.name === 'source-map'), 'include bundled optional dependencies');
    const progression = manifest.packages.find((p) => p.name === '@tonaljs/progression');
    assert.ok(progression.supplementalLicense, 'preserve source-matched upstream Tonal notice');
    assert.equal(progression.supplementalLicense.verification, 'source-content-match');
    assert.ok(bundle.includes(fs.readFileSync(path.join(sourceRoot, 'easel/build/strudel-notices/progression.LICENSE'), 'utf8').trim()));
    assert.ok(manifest.packages.every((p) => p.integrity && p.license));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('scratchpad loads embedded worklets through local blob URLs and releases them', async () => {
  const calls = [], blobs = [], revoked = [];
  class AudioWorklet {
    async addModule(url, options) { calls.push({ url, options }); if (options?.fail) throw new Error('worklet rejected'); }
  }
  const context = { window: { AudioWorklet, strudel: { initAudioOnFirstClick() {} } },
    document: { documentElement: { dataset: { easelStrudelRepl: 'v1' } } },
    atob, Uint8Array, Blob, URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:local/' + blobs.length; }, revokeObjectURL(url) { revoked.push(url); } } };
  vm.runInNewContext(adapter().prepareStrudelBundle('window.loaded = true;'), context);
  const worklet = new AudioWorklet();
  const source = 'registerProcessor("example", class {});';
  const embedded = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  await worklet.addModule(embedded, { credentials: 'omit' });
  assert.equal(calls[0].url, 'blob:local/1');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(await blobs[0].text(), source);
  assert.deepEqual(revoked, ['blob:local/1']);
  await assert.rejects(worklet.addModule(embedded, { fail: true }), /worklet rejected/);
  assert.deepEqual(revoked, ['blob:local/1', 'blob:local/2']);
  await worklet.addModule('blob:already-local');
  assert.equal(calls[2].url, 'blob:already-local');
  assert.equal(blobs.length, 2);
});

test('default_policy_stays_restrictive_while_strudel_advertises_live_repl', () => {
  assert.equal(CSP, baselineCsp);
  const capabilities = adapter().getStrudelCapabilities();
  assert.equal(capabilities.externalSamples, false);
  assert.equal(capabilities.repl, true);
  assert.throws(() => buildCanvasDocument({ html: '<p>test</p>', kits: ['strudel'], kitBundles: { strudel: 'a'.repeat(MAX_CANVAS_KIT_BYTES + 1) } }), /limit/);
});


test('disposable_probe_uses_the_actual_policy_and_local_bundle', () => {
  const { fixtureHtml, TIMEOUT_MS } = require('../scripts/probe-strudel-runtime.cjs');
  for (const offline of [false, true]) {
    const html = fixtureHtml('window.strudel = {};', offline);
    assert.ok(html.includes(`content="${baselineCsp}"`));
    assert.match(html, /data-easel-canvas-kit="strudel">window.strudel = \{\};/);
    assert.ok(html.indexOf("window.probe =") < html.indexOf('data-easel-canvas-kit="strudel"'));
    assert.doesNotMatch(html, /<script[^>]+src=/);
    assert.doesNotMatch(html, /renderPatternAudio|new (?:SharedWorker|Worker)\(/);
  }
  assert.equal(TIMEOUT_MS, 30_000);
});
