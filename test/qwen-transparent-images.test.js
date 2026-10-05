const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { readInstalledSkills, assertHarnessSkills } = require('../src/skill-catalog');
const { formatSkillInstructions } = require('../src/agent');

function transparencySkills() {
  const catalog = readInstalledSkills(path.join(__dirname, '../.agents/skills'));
  return ['qwen-transparent-images', 'easel-media'].map((name) => {
    const skill = catalog.find((entry) => entry.name === name);
    assert.ok(skill, `${name} must be bundled`);
    assert.equal(skill.compatibility, 'supported');
    assert.equal(skill.truncated, false);
    assertHarnessSkills([skill], catalog);
    return skill;
  });
}

test('focused Qwen guidance and media recipes fit the installed and turn instruction limits', () => {
  const skills = transparencySkills();
  assert.deepEqual(skills[0].requiredKits, []);
  const combined = formatSkillInstructions(skills);
  for (const skill of skills) {
    assert.ok(combined.includes(skill.instructions), `${skill.name} must reach the agent unchanged`);
    assert.ok(skill.instructions.includes('This is an RGBA image with transparency. <foreground description>. The image has alpha channel and the background is transparent.'));
  }
  const probes = skills.map((skill) => skill.instructions.match(/```javascript\n([\s\S]*?)\n```/)[1]);
  assert.equal(probes[0], probes[1], 'Both workflows must teach the same alpha probe');
});

test('documented alpha probe decodes PNGs and leaves visible content unchanged', {
  skip: process.env.EASEL_RUN_BROWSER_TESTS !== '1', timeout: 30_000,
}, async (t) => {
  const code = transparencySkills()[0].instructions.match(/```javascript\n([\s\S]*?)\n```/)[1];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(/^https?:/, (route) => route.abort());
    await page.setContent('<p>Existing video overlay canvas</p>');
    const cases = [
      { name: 'transparent margins with faint residue and an opaque foreground', size: 20, kind: 'cutout',
        expected: { width: 20, height: 20, minAlpha: 0, maxAlpha: 255, totalPixels: 400,
          zeroPixels: 379, nearZeroPixels: 384, cornerAlpha: [1, 3, 4, 2],
          topBottom5PercentBands: { minAlpha: 0, maxAlpha: 9, meanAlpha: 0.475, pixels: 40 } } },
      { name: 'opaque background', size: 20, kind: 'opaque',
        expected: { width: 20, height: 20, minAlpha: 255, maxAlpha: 255, totalPixels: 400,
          zeroPixels: 0, nearZeroPixels: 0, cornerAlpha: [255, 255, 255, 255],
          topBottom5PercentBands: { minAlpha: 255, maxAlpha: 255, meanAlpha: 255, pixels: 40 } } },
      { name: 'single transparent pixel with overlapping margin bands', size: 1, kind: 'clear',
        expected: { width: 1, height: 1, minAlpha: 0, maxAlpha: 0, totalPixels: 1,
          zeroPixels: 1, nearZeroPixels: 1, cornerAlpha: [0, 0, 0, 0],
          topBottom5PercentBands: { minAlpha: 0, maxAlpha: 0, meanAlpha: 0, pixels: 1 } } },
    ];
    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        const result = await page.evaluate(async ({ code, size, kind }) => {
          const source = document.createElement('canvas');
          source.width = source.height = size;
          const context = source.getContext('2d');
          if (kind === 'opaque') {
            context.fillRect(0, 0, size, size);
          } else if (kind === 'cutout') {
            context.fillRect(8, 8, 4, 4);
            const pixels = context.getImageData(0, 0, size, size);
            for (const [x, y, alpha] of [[0, 0, 1], [19, 0, 3], [0, 19, 4], [19, 19, 2], [10, 0, 9]]) {
              pixels.data.set([255, 128, 0, alpha], (y * size + x) * 4);
            }
            context.putImageData(pixels, 0, 0);
          }
          const png = source.toDataURL('image/png');
          const before = document.documentElement.outerHTML;
          const assetIds = [];
          const EaselCanvas = { whenReady: async () => {}, assets: { ready: Promise.resolve(),
            getUrl: async (id) => { assetIds.push(id); return png; } } };
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const measurements = await new AsyncFunction('EaselCanvas', code.replace('ASSET_ID_FROM_COMPLETION', 'fixture-png'))(EaselCanvas);
          return { measurements, assetIds, unchanged: document.documentElement.outerHTML === before };
        }, { code, size: fixture.size, kind: fixture.kind });
        assert.deepEqual(result.measurements, fixture.expected);
        assert.deepEqual(result.assetIds, ['fixture-png']);
        assert.equal(result.unchanged, true);
      });
    }
  } finally { await browser.close(); }
});
