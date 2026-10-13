const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('real isolated Electron decoding saves native last and timestamped stills from managed MP4/WebM', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 45_000,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-frame-decoder-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, EASEL_FRAME_SMOKE_DIRECTORY: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=x11'] : []), path.join(__dirname, 'helpers/video-frame-reference-smoke.cjs')], {
    env, encoding: 'utf8', timeout: 40_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  const evidence = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(evidence.audioTailIgnored, true);
  assert.equal(evidence.digestSource, true);
  assert.equal(evidence.mp4Source, true);
  assert.ok(evidence.jpegBytes > 100 && evidence.jpegBytes < 4 * 1024 * 1024);
});
