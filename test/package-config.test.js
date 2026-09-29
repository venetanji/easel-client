const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const desktopWorkflow = fs.readFileSync(path.join(root, '.github/workflows/desktop.yml'), 'utf8');

test('declares v0.0.1 cross-platform package scripts and MCP runtime files', () => {
  assert.equal(pkg.version, '0.0.1');
  assert.equal(pkg.dependencies['@easel/media-mcp'], '0.0.1');
  for (const script of ['build', 'dist:dir', 'dist:win', 'dist:mac', 'dist:linux', 'build:media-mcp']) {
    assert.equal(typeof pkg.scripts[script], 'string', `${script} is configured`);
  }
  assert.match(builder, /packages\/media-mcp\/dist/);
  assert.match(builder, /asarUnpack:/);
  assert.match(builder, /AppImage/);
  assert.match(builder, /nsis/);
  assert.match(builder, /dmg/);
  assert.match(builder, /maintainer: ["']?Giovanni Lion <giovanni\.lion@gmail\.com>["']?/);
  assert.match(desktopWorkflow, /Install Electron binary[\s\S]*?node node_modules\/electron\/install\.js/);
  assert.match(desktopWorkflow, /electron_config_cache:/);
});

test('checks release tags against the package version', () => {
  const script = path.join(root, 'scripts/check-release-version.js');
  const valid = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, RELEASE_TAG: 'v0.0.1' }, encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  const invalid = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, RELEASE_TAG: 'v9.9.9' }, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /does not match package version/);
});
