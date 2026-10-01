const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const mediaPkg = require('../packages/media-mcp/package.json');
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const desktopWorkflow = fs.readFileSync(path.join(root, '.github/workflows/desktop.yml'), 'utf8');

test('declares versioned cross-platform package scripts and MCP runtime files', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.dependencies['@easel/media-mcp'], mediaPkg.version);
  for (const script of ['build', 'dist:dir', 'dist:win', 'dist:mac', 'dist:linux', 'build:media-mcp']) {
    assert.equal(typeof pkg.scripts[script], 'string', `${script} is configured`);
  }
  assert.match(builder, /packages\/media-mcp\/dist/);
  assert.match(builder, /asarUnpack:/);
  assert.match(builder, /asarUnpack:[\s\S]*?- node_modules\/\*\*\/\*/);
  assert.match(builder, /afterPack: scripts\/check-packaged-media-mcp\.js/);
  assert.match(builder, /afterSign: scripts\/check-signed-media-mcp\.js/);
  assert.match(builder, /AppImage/);
  assert.match(builder, /nsis/);
  assert.match(builder, /dmg/);
  assert.match(builder, /maintainer: ["']?Giovanni Lion <giovanni\.lion@gmail\.com>["']?/);
  assert.match(desktopWorkflow, /Install Electron binary[\s\S]*?node node_modules\/electron\/install\.js/);
  assert.match(desktopWorkflow, /electron_config_cache:/);
});

test('checks release tags against the package version', () => {
  const script = path.join(root, 'scripts/check-release-version.js');
  const valid = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, RELEASE_TAG: `v${pkg.version}` }, encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  const invalid = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, RELEASE_TAG: 'v9.9.9' }, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /does not match package version/);
});

test('accepts prerelease tags based on the committed package version', () => {
  const script = path.join(root, 'scripts/check-release-version.js');
  const valid = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, RELEASE_TAG: `v${pkg.version}-rc.1` },
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);

  const invalid = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, RELEASE_TAG: 'v9.9.9-rc.1' },
    encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /does not match package version/);
});
