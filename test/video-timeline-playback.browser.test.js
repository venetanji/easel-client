const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('native video and a separate audio bed play across a cut without recurring seeks', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 30_000,
}, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.route('http://127.0.0.1/playback', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
    await page.goto('http://127.0.0.1/playback');
    await page.addScriptTag({ path: path.join(__dirname, '../src/video-timeline-view.js') });
    await page.addScriptTag({ path: path.join(__dirname, '../canvas-kits/mediabunny.js') });
    const media = { song: { id: 'song', mimeType: 'audio/wav', data: fs.readFileSync(path.join(__dirname, 'fixtures/video-export/tone.wav')).toString('base64') } };
    await page.evaluate(async media => {
      // VP8 fixtures work in Chromium builds that do not include licensed H.264 decoders.
      for (const color of ['blue', 'red']) {
        const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
        const target = new EaselMediabunny.BufferTarget();
        const output = new EaselMediabunny.Output({ format: new EaselMediabunny.WebMOutputFormat(), target });
        const source = new EaselMediabunny.CanvasSource(canvas, { codec: 'vp8', quality: new EaselMediabunny.Quality({ bitrate: 100_000 }) });
        output.addVideoTrack(source, { frameRate: 24 }); await output.start();
        for (let frame = 0; frame < 24; frame++) {
          const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 96, 64);
          ctx.fillStyle = 'white'; ctx.fillRect(frame * 4, 0, 2, 64); await source.add(frame / 24, 1 / 24);
        }
        source.close(); await output.finalize();
        media[color] = { id: color, mimeType: 'video/webm', data: btoa(String.fromCharCode(...new Uint8Array(target.buffer))) };
      }
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      window.playbackEvidence = { seeks: [], presentedFrames: 0, audioProgress: 0, preloadedAtFrame: null, loadingFlashes: 0 };
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { ...descriptor, set(value) {
        window.playbackEvidence.seeks.push({ kind: this.tagName, time: value }); descriptor.set.call(this, value);
      } });
      const timeline = { schemaVersion: 1, id: 'playback', revision: 1, width: 96, height: 64, frameRate: { numerator: 24, denominator: 1 },
        tracks: [{ id: 'video', type: 'video' }, { id: 'audio', type: 'audio' }], transitions: [],
        items: [
          { id: 'blue', assetId: 'blue', trackId: 'video', startFrame: 0, endFrame: 24, sourceStartSeconds: 0, sourceEndSeconds: 1, gain: 0 },
          { id: 'red', assetId: 'red', trackId: 'video', startFrame: 24, endFrame: 48, sourceStartSeconds: 0, sourceEndSeconds: 1, gain: 0 },
          { id: 'song', assetId: 'song', trackId: 'audio', startFrame: 0, endFrame: 48, sourceStartSeconds: 0, sourceEndSeconds: 0.75, gain: 0 },
        ] };
      const view = createVideoTimelineView({ document, container: document.querySelector('main'), client: {
        readTimeline: async () => timeline, getProjectAssets: async () => ({ assets: Object.values(media) }),
        getProjectAsset: async (_project, id) => media[id],
      } });
      window.previewView = view;
      const observer = new MutationObserver(() => {
        for (const video of document.querySelectorAll('video')) {
          if (video.countingFrames) continue; video.countingFrames = true;
          video.addEventListener('loadeddata', () => { if (video.hidden) window.playbackEvidence.preloadedAtFrame = Number(document.querySelector('[data-role="seek"]').value); });
          const count = () => { if (!video.hidden) window.playbackEvidence.presentedFrames++; if (video.isConnected) video.requestVideoFrameCallback(count); };
          video.requestVideoFrameCallback(count);
        }
        for (const audio of document.querySelectorAll('audio')) {
          if (audio.countingProgress) continue; audio.countingProgress = true;
          audio.addEventListener('timeupdate', () => { window.playbackEvidence.audioProgress = Math.max(window.playbackEvidence.audioProgress, audio.currentTime); });
        }
        const empty = document.querySelector('[data-role="preview-empty"]');
        if (empty && !empty.hidden && empty.textContent.includes('Loading') && Number(document.querySelector('[data-role="seek"]').value) >= 24) window.playbackEvidence.loadingFlashes++;
      });
      observer.observe(document.querySelector('main'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
      await view.open('synthetic');
    }, media);
    await page.waitForFunction(() => [...document.querySelectorAll('audio,video')].length === 2 && [...document.querySelectorAll('audio,video')].every(node => node.readyState >= 3)).catch(async error => {
      throw new Error(`${error.message}: ${JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText, media: [...document.querySelectorAll('audio,video')].map(node => ({ ready: node.readyState, error: node.error?.message })) })))}`);
    });
    await page.evaluate(() => { window.playbackEvidence.seeks = []; });
    await page.locator('[data-role="play"]').click();
    await page.waitForFunction(() => document.querySelector('[data-role="seek"]').value === '48', undefined, { timeout: 12_000 }).catch(async error => {
      throw new Error(`${error.message}: ${JSON.stringify(await page.evaluate(() => ({ evidence: window.playbackEvidence, frame: document.querySelector('[data-role="seek"]').value, media: [...document.querySelectorAll('audio,video')].map(node => ({ time: node.currentTime, paused: node.paused, ended: node.ended, ready: node.readyState, seeking: node.seeking })) })))}`);
    });
    const evidence = await page.evaluate(() => window.playbackEvidence);
    assert.equal(evidence.seeks.filter(event => event.kind === 'AUDIO').length, 0, JSON.stringify(evidence));
    assert.ok(evidence.seeks.filter(event => event.kind === 'VIDEO').length <= 2, JSON.stringify(evidence));
    assert.ok(evidence.presentedFrames >= 20, JSON.stringify(evidence));
    assert.ok(evidence.audioProgress >= 0.65, JSON.stringify(evidence));
    assert.ok(evidence.preloadedAtFrame !== null && evidence.preloadedAtFrame < 24, JSON.stringify(evidence));
    assert.equal(evidence.loadingFlashes, 0, JSON.stringify(evidence));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
