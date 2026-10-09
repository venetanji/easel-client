const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { createStrudelTemplate } = require('../src/strudel-template');
const { buildCanvasDocument } = require('../src/canvas-policy');
const { buildStrudelKit } = require('../scripts/build-canvas-kits');
const instanceId = 'c'.repeat(32);
const options = { skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 45_000 };
let kitBundle;

function browserKit() {
  if (kitBundle) return kitBundle;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-strudel-browser-kit-'));
  try {
    buildStrudelKit(directory);
    kitBundle = fs.readFileSync(path.join(directory, 'strudel.js'), 'utf8');
    return kitBundle;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function legacyBrowserKit() {
  // Rebuild the 0.0.7 entry: the project pin predates EaselStrudelSamples.
  const { prepareStrudelBundle } = require('../src/strudel-kit');
  const built = require('esbuild').buildSync({ stdin: {
    contents: `export * from '@strudel/web';
import { appendStrudelLayer, highlightStrudel } from './strudel-score.js';
window.EaselStrudelScore = Object.freeze({ appendLayer: appendStrudelLayer, highlight: highlightStrudel });`,
    resolveDir: path.resolve(__dirname, '../src'), loader: 'js',
  }, bundle: true, write: false, format: 'iife', globalName: 'strudel', platform: 'browser', target: ['chrome120'] });
  return prepareStrudelBundle(built.outputFiles[0].text);
}

async function fixture(t, saved, kit = browserKit(), documentHtml) {
  const source = createStrudelTemplate({ instanceId }).files['index.html'];
  let html = documentHtml || buildCanvasDocument({ html: source, kits: ['strudel'], kitBundles: { strudel: kit } });
  if (saved) html = html.replace('<script id="easel-runtime-lifecycle">', `<script>window.__easelProjectState=${JSON.stringify({ strudel: { [instanceId]: saved } })};</script><script id="easel-runtime-lifecycle">`);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const audioErrors = []; page.on('console', message => {
    if (/could not load AudioWorklet|not found!|processor.*not found/.test(message.text())) audioErrors.push(message.text().slice(0,300));
  });
  // AudioWorklet modules require a real origin; file: gives blobs an opaque
  // origin. Fulfill this one local document and block every network request.
  const fixtureUrl = 'http://127.0.0.1:8765/strudel-editor';
  await page.route(/^https?:/, route => route.request().url() === fixtureUrl
    ? route.fulfill({ body: html, contentType: 'text/html' }) : route.abort());
  await page.goto(fixtureUrl);
  await page.waitForFunction(() => window.EaselStrudel && /Ready/.test(document.querySelector('.status').textContent));
  return { page, editor: page.getByRole('textbox', { name: 'Strudel code' }), errors, audioErrors,
    async reloadSource(code, preserved) {
      const updated = source.replace(/const DEFAULT_LIVE_CODE = [^\n]+;/, `const DEFAULT_LIVE_CODE = ${JSON.stringify(code)};`);
      html = buildCanvasDocument({ html: updated, kits: ['strudel'], kitBundles: { strudel: browserKit() } });
      html = html.replace('<script id="easel-runtime-lifecycle">', `<script>window.__easelPreservedState=${JSON.stringify(preserved)};</script><script id="easel-runtime-lifecycle">`);
      await page.reload();
      await page.waitForFunction(() => window.EaselStrudel && /Ready/.test(document.querySelector('.status').textContent));
      await page.evaluate(() => EaselCanvas.restoreControls());
    },
  };
}

test('new templates in projects pinned to 0.0.7 disable unavailable samples and retain synth playback', options, async t => {
  const { page, editor, errors, audioErrors } = await fixture(t, undefined, legacyBrowserKit());
  assert.equal(await page.evaluate(() => typeof window.EaselStrudelSamples), 'undefined');
  for (const title of ['Kick', 'Snare', 'Hi-hats']) {
    assert.equal(await page.getByRole('button', { name: `Add ${title} and run` }).isEnabled(), false,
      `${title} must not offer to play a missing sample`);
  }
  assert.equal(await page.getByText(/older Strudel kit/).isVisible(), true);
  assert.equal(await page.getByRole('heading', { name: 'Your samples', exact: true }).isVisible(), false);
  await page.getByRole('button', { name: 'Add Melody and run' }).click();
  await hasSignal(page);
  await editor.press('Escape');
  for (const title of ['Kick', 'Snare', 'Hi-hats']) {
    assert.equal(await page.getByRole('button', { name: `Add ${title} and run` }).isEnabled(), false,
      'running or stopping must not re-enable missing samples');
  }
  for (let i = 0; i < 5; i++) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => document.querySelector('.code-highlight').clientWidth === document.querySelector('.code-editor').clientWidth);
    await page.setViewportSize({ width: 360, height: 640 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      'the highlight overlay must not overflow while its resize callback is pending');
  }
  await page.screenshot({ path: '/tmp/easel-strudel-old-kit-360.png' });
  assert.deepEqual(errors, []); assert.deepEqual(audioErrors, []);
});

async function hasSignal(page) {
  await page.waitForFunction(() => strudel.getIsStarted() === true && strudel.getSuperdoughAudioController().output.destinationGain?.gain.value > 0);
  await page.evaluate(() => {
    window.__signalMeter?.disconnect();
    const context = strudel.getAudioContext();
    const meter = context.createAnalyser(); meter.fftSize = 2048;
    strudel.getSuperdoughAudioController().output.destinationGain.connect(meter);
    window.__signalMeter = meter;
  });
  await page.waitForFunction(() => {
    const samples = new Float32Array(__signalMeter.fftSize);
    __signalMeter.getFloatTimeDomainData(samples);
    return samples.some(value => Math.abs(value) > 0.001);
  }, undefined, { timeout: 6000 });
  assert.equal(await page.evaluate(() => strudel.getAudioContext().state), 'running');
}

test('Ctrl+Enter runs only selected code, retains the editor, and stops reliably', options, async t => {
  const { page, editor, errors } = await fixture(t);
  assert.equal(await page.evaluate(() => strudel.getIsStarted() === true), false);
  const valid = 'note("c4 e4 g4").s("triangle").gain(.3)';
  const buffer = valid + '\nthis is invalid';
  await editor.fill(buffer);
  await editor.evaluate((node, length) => node.setSelectionRange(0, length), valid.length);
  await editor.press('Control+Enter');
  await hasSignal(page);
  assert.equal(await editor.inputValue(), buffer, 'partial execution must not erase the rest of the buffer');
  assert.deepEqual(await page.evaluate(() => EaselStrudel.snapshotPattern().pattern.queryArc(0, 1).map(h => h.value.note)), ['c4', 'e4', 'g4']);
  const version = await page.evaluate(() => EaselStrudel.getState().patternVersion);
  await editor.evaluate(node => node.setSelectionRange(0, 0));
  await editor.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('.status').getAttribute('role') === 'alert');
  assert.equal(await page.evaluate(() => EaselStrudel.getState().patternVersion), version);
  assert.equal(await page.evaluate(() => strudel.getIsStarted()), true, 'an invalid edit must preserve playback');
  await editor.press('Control+.');
  assert.equal(await page.evaluate(() => strudel.getIsStarted() === true), false);
  assert.equal(await page.evaluate(() => strudel.getSuperdoughAudioController().output.destinationGain.gain.value), 0);
  assert.deepEqual(errors, []);
});

test('restored code and agent-written drafts run with one gesture and reload silently', options, async t => {
  const code = 'note("d4 f4 a4").s("sine").gain(.25)';
  const { page, editor, errors } = await fixture(t, { code, bpm: 120, volume: .3 });
  assert.equal(await editor.inputValue(), code);
  assert.equal(await page.evaluate(() => strudel.getIsStarted() === true), false);
  assert.equal(await page.getByRole('button', { name: 'Run', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await hasSignal(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const draft = 'setcpm(45)\n$: note("a3 c4 e4").s("sawtooth").gain(.2)';
  const result = await page.evaluate(source => EaselStrudel.setCode(source), draft);
  assert.equal(result.ok, true);
  assert.equal(await editor.inputValue(), draft);
  assert.equal(await page.evaluate(() => strudel.getIsStarted() === true), false, 'agent writing cannot start playback');
  assert.equal(await page.evaluate(() => EaselStrudel.getState().code), draft);
  await editor.press('Control+Enter');
  await hasSignal(page);
  assert.equal(await page.evaluate(() => strudel.getCps()), .75, 'code-defined tempo must survive playback startup');
  await page.reload();
  await page.waitForFunction(() => window.EaselStrudel && /Ready/.test(document.querySelector('.status').textContent));
  assert.equal(await page.evaluate(() => strudel.getIsStarted() === true), false);
  assert.deepEqual(errors, []);
});

test('references collapse, examples extend the score and run, and the workspace fits narrow canvases', options, async t => {
  const { page, editor, errors } = await fixture(t);
  const references = page.getByRole('complementary', { name: 'References and examples' });
  const toggle = page.getByRole('button', { name: 'Reference', exact: true });
  assert.equal(await references.isVisible(), true);
  await toggle.click(); assert.equal(await references.isVisible(), false);
  await toggle.click(); assert.equal(await references.isVisible(), true);
  const examples = page.locator('[data-example]');
  assert.ok(await examples.count() >= 3);
  for (let index = 0; index < await examples.count(); index++) {
    const previous = await editor.inputValue();
    await examples.nth(index).click();
    assert.ok((await editor.inputValue()).includes(previous), 'examples must preserve the score');
    await hasSignal(page);
    await editor.press('Escape');
  }
  await page.screenshot({ path: '/tmp/easel-strudel-editor-1280.png' });
  await page.setViewportSize({ width: 600, height: 600 });
  await page.screenshot({ path: '/tmp/easel-strudel-editor-600.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await toggle.click();
  const box = await editor.boundingBox(); assert.ok(box.width > 500 && box.height > 300);
  assert.deepEqual(errors, []);
});

test('adding an example keeps the original layer playing on the same audio graph', options, async t => {
  const { page, editor, errors } = await fixture(t);
  const original = 'setcpm(30)\n// keep my melody\nnote("d4 f4 a4").s("sine").gain(.2)';
  await editor.fill(original);
  await editor.press('Control+Enter'); await hasSignal(page);
  await page.evaluate(() => {
    window.__originalContext = strudel.getAudioContext();
    window.__originalOutput = strudel.getSuperdoughAudioController().output.destinationGain;
    window.__resetCount = 0;
    const controller = strudel.getSuperdoughAudioController(), reset = controller.reset.bind(controller);
    controller.reset = (...args) => { __resetCount++; return reset(...args); };
  });
  // A preexisting selection must not turn Add & run into selection-only execution.
  await editor.evaluate(node => node.setSelectionRange(0, 10));
  await page.locator('[data-example="0"]').click();
  await page.waitForFunction(() => EaselStrudel.snapshotPattern().pattern.queryArc(0, 1).some(h => h.value.note === 'c4'));
  await hasSignal(page);
  assert.ok((await editor.inputValue()).includes('// keep my melody'));
  const result = await page.evaluate(() => ({
    notes: EaselStrudel.snapshotPattern().pattern.queryArc(0, 1).map(h => h.value.note),
    sameContext: strudel.getAudioContext() === __originalContext,
    sameOutput: strudel.getSuperdoughAudioController().output.destinationGain === __originalOutput,
    resets: __resetCount, cps: strudel.getCps(),
  }));
  assert.ok(result.notes.includes('d4') && result.notes.includes('f4') && result.notes.includes('a4'), 'the original melody must remain in the evaluated score');
  assert.ok(result.notes.includes('c4'), 'the example must become a second audible layer');
  assert.equal(result.sameContext, true); assert.equal(result.sameOutput, true); assert.equal(result.resets, 0);
  assert.equal(result.cps, .5, 'examples must not change the score tempo');
  assert.deepEqual(errors, []);
});

test('an example never destroys an invalid or oversized draft', options, async t => {
  const { page, editor } = await fixture(t);
  for (const draft of ['note(', '// ' + 'x'.repeat(8180) + '\n$: note("d4").s("sine")']) {
    await editor.fill(draft);
    await page.locator('[data-example="0"]').click();
    await page.waitForFunction(() => document.querySelector('.status').getAttribute('role') === 'alert');
    assert.equal(await editor.inputValue(), draft);
    assert.equal(await page.evaluate(() => strudel.getIsStarted() === true), false);
  }
});

test('the editor highlights editable code safely and tracks horizontal and vertical scrolling', options, async t => {
  const { page, editor } = await fixture(t);
  const code = '// bass layer\nconst root = "<img src=x onerror=alert(1)>";\n$: note("c3 e3").s("sine").gain(.2)';
  await editor.fill(code);
  const highlight = page.locator('.code-highlight');
  assert.equal((await highlight.textContent()).trimEnd(), code);
  assert.ok(await highlight.locator('.token-comment').count() > 0);
  assert.ok(await highlight.locator('.token-keyword').count() > 0);
  assert.ok(await highlight.locator('.token-string').count() > 0);
  assert.ok(await highlight.locator('.token-number').count() > 0);
  assert.ok(await highlight.locator('.token-function').count() > 0);
  assert.equal(await highlight.locator('img').count(), 0, 'highlighting must treat source as text');
  const long = Array.from({ length: 40 }, (_, i) => `// ${i} ${'long '.repeat(35)}`).join('\n');
  assert.equal((await page.evaluate(source => EaselStrudel.setCode(source), long)).ok, true);
  await editor.evaluate(node => { node.scrollTop = 200; node.scrollLeft = 160; node.dispatchEvent(new Event('scroll')); });
  const positions = await page.evaluate(() => {
    const input = document.querySelector('textarea'), painted = document.querySelector('.code-highlight');
    return { inputTop: input.scrollTop, paintedTop: painted.scrollTop, inputLeft: input.scrollLeft, paintedLeft: painted.scrollLeft };
  });
  assert.ok(positions.inputTop > 0 && positions.inputLeft > 0);
  assert.equal(positions.paintedTop, positions.inputTop); assert.equal(positions.paintedLeft, positions.inputLeft);
  await editor.fill('note("unfinished');
  assert.equal((await highlight.textContent()).trimEnd(), 'note("unfinished', 'incomplete drafts must remain visible');
});

test('bundled audio worklet effects load locally and produce a signal', options, async t => {
  const { page, editor, errors, audioErrors } = await fixture(t);
  await editor.fill('note("c4 e4 g4").s("sawtooth").gain(.3).crush(8)');
  await editor.press('Control+Enter');
  await hasSignal(page);
  await editor.press('Escape');
  await editor.press('Control+Enter');
  await hasSignal(page);
  assert.deepEqual(audioErrors, [], 'bundled worklets must load within the canvas policy');
  assert.deepEqual(errors, []);
  await editor.press('Escape');
});

test('authored code wins over old controls on preserved reload and cannot export a stale starter', options, async t => {
  const { page, editor, reloadSource } = await fixture(t);
  await editor.fill('note("c2").s("sine")');
  const preserved = await page.evaluate(() => EaselCanvas.captureState());
  const authored = 'note("a4 c5 e5").s("triangle").gain(.3)';
  await reloadSource(authored, preserved);
  assert.equal(await editor.inputValue(), authored, 'generic controls must not undo a newer authored default');
  await page.evaluate(() => window.EaselStrudel.restoreState({ bpm: 100, volume: .5 }));
  assert.equal(await page.locator('[id$="-export"]').first().isEnabled(), false);
  assert.equal(await page.evaluate(() => { try { EaselStrudel.snapshotPattern(); return true; } catch { return false; } }), false, 'no unevaluated factory pattern may be exported');
  await editor.press('Control+Enter'); await hasSignal(page);
  assert.deepEqual(await page.evaluate(() => EaselStrudel.snapshotPattern().pattern.queryArc(0, 1).map(h => h.value.note)), ['a4', 'c5', 'e5']);
});

test('local drums and attached samples play, register live and render offline from captured bytes', options, async t => {
  const { page, editor, errors, audioErrors } = await fixture(t);
  const { nativeRenderScript } = require('../src/strudel-export-renderer');
  const { validateStrudelWav } = require('../src/strudel-export-policy');
  const bank = require('../assets/strudel-drums/bank.json');
  const assetId = 'a'.repeat(32), drum = bank.samples.find(sample => sample.name === 'sd');
  const sampleAssets = { [assetId]: { url: 'data:audio/wav;base64,' + drum.data } };
  await editor.fill('s("bd sd hh oh cp tom rim").gain(.25)');
  await editor.press('Control+Enter'); await hasSignal(page);
  await page.evaluate(() => { window.__sampleLiveContext = strudel.getAudioContext(); window.__sampleLiveController = strudel.getSuperdoughAudioController(); });
  await page.evaluate(assets => {
    window.__easelProjectAssets = Object.freeze(assets);
    window.__easelProjectAssetsReady = Promise.resolve(assets);
  }, sampleAssets);
  const code = `await window.EaselStrudelSamples.add('suno_snare', '${assetId}')\ns("suno_snare*4").gain(.25)`;
  for (let i = 0; i < 2; i++) {
    await editor.fill(code); await editor.press('Control+Enter');
    await page.waitForFunction(() => /Playing/.test(document.querySelector('.status').textContent) || document.querySelector('.status').getAttribute('role') === 'alert');
    assert.equal(await page.locator('.status').getAttribute('role'), 'status', await page.locator('.status').textContent());
    await page.waitForFunction(() => !!EaselStrudelSamples.get('suno_snare'));
    await hasSignal(page);
    assert.equal(await page.evaluate(() => __sampleLiveContext === strudel.getAudioContext() && __sampleLiveController === strudel.getSuperdoughAudioController() && strudel.getIsStarted()), true);
  }
  await page.evaluate(async id => {
    try { await EaselStrudelSamples.add('bd', id); throw new Error('unexpected successful overwrite'); }
    catch (error) { if (!/reserved/.test(error.message)) throw error; }
  }, assetId);
  await hasSignal(page);
  const snapshots = await page.evaluate(() => {
    const names = [...EaselStrudelSamples.list().map(sample => sample.name)];
    const result = names.map(name => ({ name, snapshot: queryStrudelSnapshot(strudel.s(name).fast(4).gain(.25), { bpm: 120, volume: 1 }, 1, 'd'.repeat(64), strudel, EaselStrudelSamples) }));
    result.push({ name: 'oh_attack', snapshot: queryStrudelSnapshot(strudel.s('oh').fast(16).gain(.25).attack(.02), { bpm: 120, volume: 1 }, 1, 'd'.repeat(64), strudel, EaselStrudelSamples) });
    return result;
  });
  const renderer = await page.context().browser().newPage();
  const url = 'http://127.0.0.1:8765/sample-renderer';
  const html = buildCanvasDocument({ html: '<!doctype html><html><head></head><body></body></html>', kits: ['strudel'], kitBundles: { strudel: browserKit() } });
  await renderer.route(/^https?:/, route => route.request().url() === url ? route.fulfill({ body: html, contentType: 'text/html' }) : route.abort());
  await renderer.goto(url);
  for (const { name, snapshot } of snapshots) {
    const result = await renderer.evaluate(nativeRenderScript(snapshot, sampleAssets));
    const bytes = Buffer.from(result.wavBase64, 'base64');
    assert.equal(validateStrudelWav(bytes, snapshot).frames, 120000);
    let peak = 0;
    for (let offset = 44; offset < bytes.length; offset += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
    assert.ok(peak > 32, `${name} must produce nonempty WAV signal`);
    if (name === 'oh_attack') {
      let tail = 0;
      for (let frame = 105600; frame < 110400; frame++) tail = Math.max(tail, Math.abs(bytes.readInt16LE(44 + frame * 4)));
      assert.ok(tail > 32, 'attack-only sample envelopes must preserve the full sample tail beyond its Hap duration');
    }
  }
  const attached = snapshots.find(entry => entry.name === 'suno_snare').snapshot;
  const wrong = { ...attached, events: attached.events.map(event => ({ ...event, sample: { ...event.sample, durationSeconds: 0.01 } })) };
  await assert.rejects(renderer.evaluate(nativeRenderScript(wrong, sampleAssets)), /duration/);
  await hasSignal(page);
  assert.equal(await page.evaluate(() => __sampleLiveContext === strudel.getAudioContext() && strudel.getIsStarted()), true);
  assert.deepEqual(errors, []); assert.deepEqual(audioErrors, []);
  await editor.press('Escape');
});

test('sample identity and export remain stable on a 44.1 kHz playback device', options, async t => {
  const { page } = await fixture(t);
  const { encodePCM16Wav, nativeRenderScript } = require('../src/strudel-export-renderer');
  const frames = 48037;
  const data = Buffer.from(encodePCM16Wav({ sampleRate: 48000, numberOfChannels: 2, length: frames,
    getChannelData: () => Float32Array.from({ length: frames }, (_, i) => Math.sin(i / 40) * 0.2) })).toString('base64');
  const id = 'b'.repeat(32), assets = { [id]: { url: 'data:audio/wav;base64,' + data } };
  const captured = await page.evaluate(async ({ assets, id }) => {
    await EaselCanvas.cleanup();
    const context = new AudioContext({ sampleRate: 44100 });
    strudel.setAudioContext(context);
    window.__easelProjectAssets = Object.freeze(assets);
    await EaselStrudelSamples.add('custom_loop', id);
    return { rate: context.sampleRate, sample: EaselStrudelSamples.get('custom_loop'),
      snapshot: queryStrudelSnapshot(strudel.s('custom_loop').fast(4), { bpm: 120, volume: 0.25 }, 1, 'd'.repeat(64), strudel, EaselStrudelSamples) };
  }, { assets, id });
  assert.equal(captured.rate, 44100);
  assert.equal(captured.sample.durationSeconds, frames / 48000, 'sample identity uses a fixed decode rate');
  const renderer = await page.context().browser().newPage();
  const url = 'http://127.0.0.1:8765/rate-renderer';
  const html = buildCanvasDocument({ html: '<!doctype html><html><head></head><body></body></html>', kits: ['strudel'], kitBundles: { strudel: browserKit() } });
  await renderer.route(/^https?:/, route => route.request().url() === url ? route.fulfill({ body: html, contentType: 'text/html' }) : route.abort());
  await renderer.goto(url);
  const result = await renderer.evaluate(nativeRenderScript(captured.snapshot, assets));
  assert.ok(Buffer.from(result.wavBase64, 'base64').length > 44);
  await page.evaluate(() => strudel.getAudioContext().close());
});

test('saved projects restore attached sample registrations from persisted score and media bytes', options, async t => {
  const { createCanvasStore } = require('../src/canvas-store');
  const { createCanvasMediaStore } = require('../src/canvas-media-store');
  const { createSourceArchiveFixture } = require('./helpers/canvas-kit-source');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-strudel-saved-sample-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kit = browserKit();
  const media = createCanvasMediaStore({ userDataPath: root });
  const data = require('../assets/strudel-drums/bank.json').samples.find(sample => sample.name === 'sd').data;
  const assetId = await media.save({ data, mimeType: 'audio/wav', name: 'My snare.wav' });
  const store = createCanvasStore({ userDataPath: root, kitBundles: { strudel: kit }, assetStore: media,
    readKitSourceArchive: () => createSourceArchiveFixture(kit) });
  const documentPath = `sketches/${instanceId}/index.html`;
  const project = store.createTemplateDocument({ title: 'Saved samples', path: documentPath,
    html: createStrudelTemplate({ instanceId }).files['index.html'], kits: ['strudel'] });
  await store.attachAsset(project.id, { assetId });
  const code = `await window.EaselStrudelSamples.add('my_snare', '${assetId}')\ns("my_snare*4").gain(.25)`;
  store.saveProjectState(project.id, { state: { strudel: { [instanceId]: { code, bpm: 120, volume: .3 } } } });
  // Reopen without an installed kit: playback must use the retained project pin.
  const reopened = createCanvasStore({ userDataPath: root, assetStore: media });
  const { page, editor, errors, audioErrors } = await fixture(t, undefined, kit, reopened.getDocument(project.id, documentPath).html);
  assert.equal(await editor.inputValue(), code);
  assert.equal(await page.evaluate(() => strudel.getIsStarted() === true), false);
  assert.equal(await page.evaluate(id => EaselCanvas.assets.getUrl(id), assetId), 'data:audio/wav;base64,' + data);
  await editor.press('Control+Enter');
  await hasSignal(page);
  assert.equal(await page.evaluate(() => EaselStrudelSamples.get('my_snare').assetId), assetId);
  await editor.press('Escape');
  assert.deepEqual(errors, []); assert.deepEqual(audioErrors, []);
});
