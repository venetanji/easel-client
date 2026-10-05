const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readInstalledSkills, skillCompatibility, assertHarnessSkills } = require('../src/skill-catalog');
const { availableCanvasKits, assertInstalledKits } = require('../src/canvas-kit-catalog');

test('installed skill shortlist contains self-contained Easel workflows and explains unsupported dependencies', () => {
  const catalog = readInstalledSkills(path.join(__dirname, '../.agents/skills'));
  assert.deepEqual(catalog.filter((skill) => skill.compatibility === 'supported').map((skill) => skill.name).sort(), ['easel-audio', 'easel-canvas', 'easel-media', 'easel-p5', 'easel-three', 'qwen-transparent-images']);
  const hyperframes = catalog.find((skill) => skill.name === 'hyperframes');
  assert.equal(hyperframes.compatibility, 'unsupported');
  assert.match(hyperframes.reason, /in-app agent/);
  assert.ok(catalog.filter((skill) => skill.compatibility === 'supported').every((skill) => skill.description && !skill.truncated));
  assert.throws(() => assertHarnessSkills([{ name: 'hyperframes', instructions: hyperframes.instructions }], catalog), /unavailable in Easel/);
  assert.equal(assertHarnessSkills([{ name: 'My creative brief', instructions: 'Use warm colors.' }], catalog).length, 1);
});

test('skill compatibility uses actual kit installation and does not guess custom dependencies', () => {
  assert.equal(skillCompatibility('easel-audio', availableCanvasKits({})).compatibility, 'unsupported');
  assert.equal(skillCompatibility('easel-audio', availableCanvasKits({ tone: 'bundle' })).compatibility, 'supported');
  assert.equal(skillCompatibility('custom-tone-guide', availableCanvasKits({})).compatibility, 'unreviewed');
});

test('kit catalog distinguishes built-ins, installed bundles and missing bundles', () => {
  const kits = availableCanvasKits({ tone: 'bundle', p5: '' });
  assert.deepEqual(kits.filter((kit) => kit.installed).map((kit) => kit.id), ['canvas-2d', 'html-deck', 'tone']);
  assert.deepEqual(assertInstalledKits(['canvas-2d', 'tone'], { tone: 'bundle' }), ['canvas-2d', 'tone']);
  assert.throws(() => assertInstalledKits(['p5'], {}), /not installed/);
});
