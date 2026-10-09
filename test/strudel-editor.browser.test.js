const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { createStrudelTemplate } = require('../src/strudel-template');
const { buildCanvasDocument } = require('../src/canvas-policy');
const instanceId = 'c'.repeat(32);
const options = { skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 45_000 };

async function fixture(t, saved) {
  const source = createStrudelTemplate({ instanceId }).files['index.html'];
  let html = buildCanvasDocument({ html: source, kits: ['strudel'], kitBundles: { strudel: fs.readFileSync(path.join(__dirname, '../canvas-kits/strudel.js'), 'utf8') } });
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
  await page.waitForFunction(() => window.EaselStrudel && /Ready/.test(document.querySelector('[id$="-status"]').textContent));
  return { page, editor: page.getByRole('textbox', { name: 'Strudel code' }), errors, audioErrors,
    async reloadSource(code, preserved) {
      const updated = source.replace(/const DEFAULT_LIVE_CODE = [^\n]+;/, `const DEFAULT_LIVE_CODE = ${JSON.stringify(code)};`);
      html = buildCanvasDocument({ html: updated, kits: ['strudel'], kitBundles: { strudel: fs.readFileSync(path.join(__dirname, '../canvas-kits/strudel.js'), 'utf8') } });
      html = html.replace('<script id="easel-runtime-lifecycle">', `<script>window.__easelPreservedState=${JSON.stringify(preserved)};</script><script id="easel-runtime-lifecycle">`);
      await page.reload();
      await page.waitForFunction(() => window.EaselStrudel && /Ready/.test(document.querySelector('[id$="-status"]').textContent));
      await page.evaluate(() => EaselCanvas.restoreControls());
    },
  };
}

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
  await page.waitForFunction(() => document.querySelector('[id$="-status"]').getAttribute('role') === 'alert');
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
  await page.waitForFunction(() => window.EaselStrudel && /Ready/.test(document.querySelector('[id$="-status"]').textContent));
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
    await page.waitForFunction(() => document.querySelector('[id$="-status"]').getAttribute('role') === 'alert');
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
