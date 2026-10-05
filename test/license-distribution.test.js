const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const removed = [
  'canopy-part-title', 'code-slice-hero', 'cuboid-carousel', 'embedded-captions',
  'faceless-explainer', 'figma', 'frost-sequence-camera-orbit', 'general-video',
  'glass-shard-title', 'hyperframes', 'hyperframes-animation', 'hyperframes-audio',
  'hyperframes-cli', 'hyperframes-core', 'hyperframes-creative', 'hyperframes-keyframes',
  'hyperframes-registry', 'hyperframes-studio', 'media-use', 'motion-graphics',
  'music-to-video', 'orbit-card', 'pr-to-video', 'product-launch-video',
  'remotion-to-hyperframes', 'slideshow', 'talking-head-recut', 'wireframe-portal-title',
];

test('removed HyperFrames imports cannot silently return to the shipped skill tree', () => {
  const lock = json('skills-lock.json');
  for (const name of removed) {
    assert.equal(fs.existsSync(path.join(root, '.agents/skills', name)), false, `${name} must remain removed`);
    assert.equal(Object.hasOwn(lock.skills, name), false, `${name} lock entry must remain removed`);
  }
  assert.equal(Object.values(lock.skills).some((entry) => entry.source === 'heygen-com/hyperframes'), false);
  for (const name of ['easel-media', 'easel-canvas', 'easel-audio', 'easel-p5', 'easel-three']) {
    assert.ok(fs.existsSync(path.join(root, '.agents/skills', name, 'SKILL.md')), `${name} remains available`);
  }
});

test('GPL-3.0-or-later is declared for both owned packages and their lock entries', () => {
  const lock = json('package-lock.json');
  for (const [manifest, key] of [['package.json', ''], ['packages/media-mcp/package.json', 'packages/media-mcp']]) {
    assert.equal(json(manifest).license, 'GPL-3.0-or-later', manifest);
    assert.equal(lock.packages[key].license, 'GPL-3.0-or-later', key);
  }
  assert.equal(lock.packages['node_modules/p5'].license, 'LGPL-2.1');
  assert.equal(lock.packages['node_modules/mediabunny'].license, 'MPL-2.0');
});

test('the integrated Strudel dependency remains explicitly inventoried under its upstream AGPL terms', () => {
  const entry = json('docs/license-inventory.json').direct_npm_dependencies.find((item) => item.workspace === '.' && item.name === '@strudel/web');
  const dependency = json('package-lock.json').packages['node_modules/@strudel/web'];
  assert.deepEqual(entry, {
    workspace: '.', name: '@strudel/web', version: dependency.version,
    declared_license: 'AGPL-3.0-or-later', group: 'devDependencies',
  });
  assert.equal(json('package.json').devDependencies['@strudel/web'], entry.version);
  assert.equal(dependency.license, entry.declared_license);
});

test('full GPL text and scoped notices accompany desktop and standalone sources', () => {
  for (const dir of ['', 'packages/media-mcp/']) {
    assert.ok(fs.existsSync(path.join(root, `${dir}LICENSE`)), `${dir}LICENSE exists`);
    const license = read(`${dir}LICENSE`);
    assert.match(license, /GNU GENERAL PUBLIC LICENSE/);
    assert.match(license, /Version 3, 29 June 2007/);
    assert.match(license, /END OF TERMS AND CONDITIONS/);
    assert.ok(license.length > 34000, 'complete license text');
    assert.match(read(`${dir}NOTICE`), /GPL-3.0-or-later/);
    assert.match(read(`${dir}NOTICE`), /third-party/i);
    assert.match(read(`${dir}NOTICE`), /ISC/);
    assert.match(read(`${dir}README.md`), /GPL-3.0-or-later/);
  }
  assert.equal(read('LICENSE'), read('packages/media-mcp/LICENSE'));
});

test('desktop and headless manifests include the licensing materials', () => {
  const builder = read('electron-builder.yml').split('asar:')[0];
  for (const filename of ['LICENSE', 'NOTICE', 'docs/license-audit.md', 'docs/license-inventory.json', 'packages/media-mcp/LICENSE', 'packages/media-mcp/NOTICE']) {
    assert.ok(builder.split('\n').includes(`  - ${filename}`), `${filename} is packaged`);
  }
  const mcp = json('packages/media-mcp/package.json');
  assert.ok(mcp.files.includes('LICENSE'));
  assert.ok(mcp.files.includes('NOTICE'));
  const archive = read('.github/workflows/desktop.yml').split('\n').find((line) => line.includes('tar -czf release/easel-media-mcp-'));
  assert.match(archive, /\bLICENSE\b/);
  assert.match(archive, /\bNOTICE\b/);
});

test('current inventory has no imported skills or obsolete preserved notice paths', () => {
  const inventory = json('docs/license-inventory.json');
  assert.deepEqual(inventory.imported_skills, {});
  assert.deepEqual(Object.keys(inventory.removed_imported_skills).sort(), [...removed].sort());
  for (const entry of inventory.preserved_notice_files) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, entry.path))).digest('hex'), entry.sha256, entry.path);
  }
});

test('retained creative-skills adaptations carry the original MIT grant and attribution', () => {
  assert.ok(fs.existsSync(path.join(root, 'licenses/creative-skills-MIT.txt')));
  const license = read('licenses/creative-skills-MIT.txt');
  assert.match(license, /Copyright \(c\) 2026 Venetanji/);
  assert.match(license, /Permission is hereby granted/);
  assert.match(read('.agents/skills/easel-media/NOTICE.md'), /67f185c8f95182690e1ac56e734aa649f71b4df6/);
  assert.match(read('electron-builder.yml').split('asar:')[0], /licenses\/\*\*\/\*/);
});
