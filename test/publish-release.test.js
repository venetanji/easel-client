const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/publish-release.sh');

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitPaths = spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout || '';
  const installRoots = [
    ...gitPaths.trim().split(/\r?\n/).filter(Boolean).map((git) => path.resolve(path.dirname(git), '..')),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'),
  ].filter(Boolean);
  for (const installRoot of installRoots) {
    for (const relative of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = path.join(installRoot, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Git Bash is required to run the release publisher tests on Windows.');
}

function bashPath(value) {
  if (process.platform !== 'win32') return value;
  return path.resolve(value).replace(/\\/g, '/').replace(/^([A-Za-z]):(?=\/)/, (_, drive) => `/${drive.toLowerCase()}`);
}

function removePublisherTemp(temp) {
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^easel-release-[A-Za-z0-9]+$/);
  fs.rmSync(resolved, { recursive: true, force: true });
}

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

  // Windows checkouts may use CRLF even though the committed shell script uses LF.
  const testScript = path.join(temp, 'publish-release.sh');
  fs.writeFileSync(testScript, fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n'));
  const env = { ...process.env };
  const inheritedPath = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const originalPath = inheritedPath ? env[inheritedPath] : '';
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  const nodeDir = path.dirname(process.execPath);
  Object.assign(env, {
    PATH: [binDir, nodeDir, originalPath].join(path.delimiter),
    ASSET_DIR: bashPath(assetDir),
    GH_LOG: logPath,
    GH_RELEASE_EXISTS: String(existingRelease),
    GITHUB_REPOSITORY: 'venetanji/easel-client',
    RELEASE_TAG: tag,
    PUBLISH_TEST_BIN: bashPath(binDir),
    PUBLISH_TEST_NODE_DIR: bashPath(nodeDir),
    PUBLISH_TEST_SCRIPT: bashPath(testScript),
  });

  // Fail before running the publisher if gh would resolve outside the test sandbox.
  const wrapper = `export PATH="$PUBLISH_TEST_BIN:$PUBLISH_TEST_NODE_DIR:$PATH"
if [[ "$(command -v gh)" != "$PUBLISH_TEST_BIN/gh" ]]; then
  printf '%s\\n' 'Release test refused to use a non-test gh executable.' >&2
  exit 1
fi
exec "$BASH" "$PUBLISH_TEST_SCRIPT"
`;
  const result = spawnSync(findBash(), ['--noprofile', '--norc', '-c', wrapper], {
    cwd: root,
    env,
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
  t.after(() => removePublisherTemp(temp));

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
  t.after(() => removePublisherTemp(temp));

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
  t.after(() => removePublisherTemp(temp));

  assert.equal(result.status, 0, result.stderr);
  const create = calls.find((args) => args[1] === 'create');
  assert.ok(create);
  assert.equal(create.includes('--prerelease'), false);
});

test('refuses to publish when there are no desktop package files', (t) => {
  const { result, calls, temp } = runPublisher({ files: ['easel-media-mcp-linux.tar.gz'] });
  t.after(() => removePublisherTemp(temp));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no desktop package assets/i);
  assert.deepEqual(calls, []);
});
