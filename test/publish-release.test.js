const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/publish-release.sh');

function runPublisher({ existingRelease = false, files = [], tag = 'v0.0.1-rc.1' } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-release-'));
  const assetDir = path.join(temp, 'assets');
  const binDir = path.join(temp, 'bin');
  const logPath = path.join(temp, 'gh-calls.jsonl');
  fs.mkdirSync(assetDir);
  fs.mkdirSync(binDir);
  for (const file of files) fs.writeFileSync(path.join(assetDir, file), 'asset');
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'release' && args[1] === 'view') process.exit(process.env.GH_RELEASE_EXISTS === 'true' ? 0 : 1);
`);
  fs.chmodSync(path.join(binDir, 'gh'), 0o755);

  const result = spawnSync('bash', [script], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ASSET_DIR: assetDir,
      GH_LOG: logPath,
      GH_RELEASE_EXISTS: String(existingRelease),
      GITHUB_REPOSITORY: 'venetanji/easel-client',
      RELEASE_TAG: tag,
    },
    encoding: 'utf8',
  });
  const calls = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { result, calls, temp };
}

test('publishes individual desktop files as prerelease assets, not the MCP tarball', (t) => {
  const files = [
    'Easel Studio-0.0.1-rc.1-win-x64.exe',
    'Easel Studio-0.0.1-rc.1-win-x64.zip',
    'Easel Studio-0.0.1-rc.1-mac-arm64.dmg',
    'Easel Studio-0.0.1-rc.1-mac-arm64.zip',
    'Easel Studio-0.0.1-rc.1-linux-x64.AppImage',
    'Easel Studio-0.0.1-rc.1-linux-x64.deb',
    'easel-media-mcp-linux.tar.gz',
  ];
  const { result, calls, temp } = runPublisher({ files });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls[0].slice(0, 3), ['release', 'view', 'v0.0.1-rc.1']);
  const create = calls.find((args) => args[1] === 'create');
  assert.ok(create);
  assert.equal(create.includes('--prerelease'), true);
  assert.equal(create.some((arg) => arg.endsWith('.exe')), true);
  assert.equal(create.some((arg) => arg.endsWith('.dmg')), true);
  assert.equal(create.some((arg) => arg.endsWith('.zip')), true);
  assert.equal(create.some((arg) => arg.endsWith('.AppImage')), true);
  assert.equal(create.some((arg) => arg.endsWith('.deb')), true);
  assert.equal(create.some((arg) => arg.endsWith('.tar.gz')), false);
});

test('uploads assets with clobber when the tagged release already exists', (t) => {
  const { result, calls, temp } = runPublisher({
    existingRelease: true,
    files: ['Easel Studio-0.0.1-rc.1-win-x64.exe'],
  });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.some((args) => args[1] === 'upload' && args.includes('--clobber')));
  assert.ok(calls.some((args) => args[1] === 'edit' && args.includes('--prerelease')));
  assert.equal(calls.some((args) => args[1] === 'create'), false);
});

test('publishes a normal release without marking it prerelease', (t) => {
  const { result, calls, temp } = runPublisher({
    tag: 'v0.0.1',
    files: ['Easel Studio-0.0.1-win-x64.exe'],
  });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.equal(result.status, 0, result.stderr);
  const create = calls.find((args) => args[1] === 'create');
  assert.ok(create);
  assert.equal(create.includes('--prerelease'), false);
});

test('refuses to publish when there are no desktop package files', (t) => {
  const { result, calls, temp } = runPublisher({ files: ['easel-media-mcp-linux.tar.gz'] });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no desktop package assets/i);
  assert.deepEqual(calls, []);
});
