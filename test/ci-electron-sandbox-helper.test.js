const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const yaml = require('js-yaml');
const vm = require('node:vm');
const helperFile = path.resolve(__dirname, '../scripts/ci-electron-sandbox-helper.cjs');

function helper() {
  assert.ok(fs.existsSync(helperFile), 'CI sandbox helper path validation is required');
  return require(helperFile);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-sandbox-path-test-'));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'electron', version: '44.4.5' }));
  fs.writeFileSync(path.join(root, 'dist/electron'), 'not executed');
  fs.writeFileSync(path.join(root, 'dist/chrome-sandbox'), 'not executed');
  return root;
}

test('workflow_configures_only_the_materialized_official_helper_before_probe', () => {
  const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/test.yml'), 'utf8'));
  const steps = workflow.jobs.test.steps;
  const index = steps.findIndex((step) => step.name === 'Configure Electron sandbox helper on disposable CI');
  assert.ok(index >= 0, 'a narrowly scoped sandbox helper prerequisite is required');
  assert.equal(steps[index].if, "runner.os == 'Linux' && runner.environment == 'github-hosted'");
  assert.deepEqual(steps[index].run.trim().split('\n'), [
    'set -euo pipefail',
    'node scripts/ci-electron-sandbox-helper.cjs --preflight',
    'node node_modules/electron/install.js',
    'helper="$(node scripts/ci-electron-sandbox-helper.cjs)"',
    'sudo chown root:root -- "$helper"',
    'sudo chmod 4755 -- "$helper"',
    'test "$(stat -c \'%u:%g:%a\' -- "$helper")" = "0:0:4755"',
  ]);
  assert.equal(steps[index + 1].name, 'Verify constrained offline Strudel runtime');
  assert.equal(steps[index + 1].run, 'xvfb-run -a node scripts/probe-strudel-runtime.cjs');
  assert.doesNotMatch(steps[index].run, /--no-sandbox|sysctl|apparmor|chown\s+-R|chmod\s+-R|find\s/);
});

test('helper_is_limited_to_disposable_github_hosted_linux_context', () => {
  const { assertDisposableGithubLinux } = helper();
  const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted' };
  assert.doesNotThrow(() => assertDisposableGithubLinux(env, 'linux'));
  for (const [changed, platform] of [
    [{ ...env, GITHUB_ACTIONS: undefined }, 'linux'],
    [{ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux'],
    [{ ...env, RUNNER_OS: 'macOS' }, 'darwin'],
    ...['ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_MIRROR', 'ELECTRON_CUSTOM_DIR', 'ELECTRON_CUSTOM_FILENAME'].map((name) => [{ ...env, [name]: '/somewhere' }, 'linux']),
  ]) assert.throws(() => assertDisposableGithubLinux(changed, platform), /disposable|override/i);
});

test('helper_resolves_only_regular_installed_electron_dist_files', () => {
  const { resolveSandboxHelper } = helper();
  const root = fixture();
  try {
    const sandbox = path.join(root, 'dist/chrome-sandbox');
    const before = fs.statSync(sandbox);
    assert.equal(resolveSandboxHelper(root), sandbox);
    const after = fs.statSync(sandbox);
    assert.deepEqual([after.mode, after.uid, after.gid], [before.mode, before.uid, before.gid]);
    fs.unlinkSync(path.join(root, 'dist/electron'));
    assert.throws(() => resolveSandboxHelper(root), /materialized|missing/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('helper_rejects_symlinks_and_shared_hardlinks_without_mutating_any_file', () => {
  const { resolveSandboxHelper } = helper();
  const root = fixture();
  try {
    const sandbox = path.join(root, 'dist/chrome-sandbox');
    const outside = path.join(root, 'other-file');
    fs.writeFileSync(outside, 'leave unchanged');
    const originalMode = fs.statSync(outside).mode;
    fs.unlinkSync(sandbox);
    fs.symlinkSync(outside, sandbox);
    assert.throws(() => resolveSandboxHelper(root), /regular|symlink/i);
    fs.unlinkSync(sandbox);
    fs.linkSync(outside, sandbox);
    assert.throws(() => resolveSandboxHelper(root), /hardlink|single/i);
    assert.equal(fs.statSync(outside).mode, originalMode);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'leave unchanged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('helper_rejects_a_replaced_package_or_symlinked_dist_directory', () => {
  const { resolveSandboxHelper } = helper();
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'not-electron' }));
    assert.throws(() => resolveSandboxHelper(root), /official electron package/);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'electron' }));
    fs.renameSync(path.join(root, 'dist'), path.join(root, 'other-dist'));
    fs.symlinkSync(path.join(root, 'other-dist'), path.join(root, 'dist'), 'dir');
    assert.throws(() => resolveSandboxHelper(root), /regular directory/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('preflight_rejects_every_upstream_mirror_alias_and_remote_checksum_switch', () => {
  const { assertDisposableGithubLinux } = helper();
  const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted' };
  const getterRoot = path.dirname(require.resolve('@electron/get'));
  const upstream = fs.readFileSync(path.join(getterRoot, 'artifact-utils.js'), 'utf8');
  const options = [...upstream.matchAll(/mirrorVar\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(options, ['mirror', 'nightlyMirror', 'customDir', 'customFilename', 'customVersion']);
  const aliases = new Set();
  for (const option of options) {
    const snake = option.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    for (const name of [`npm_config_electron_${option.toLowerCase()}`, `NPM_CONFIG_ELECTRON_${snake.toUpperCase()}`,
      `npm_config_electron_${snake}`, `npm_package_config_electron_${option}`,
      `npm_package_config_electron_${snake}`, `ELECTRON_${snake.toUpperCase()}`]) aliases.add(name);
  }
  assert.equal(aliases.size, 28);
  for (const name of [...aliases, 'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums',
    'ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH', 'npm_config_platform', 'npm_config_arch']) {
    assert.throws(() => assertDisposableGithubLinux({ ...env, [name]: '1' }, 'linux'), /override/i, name);
  }
  assert.throws(() => assertDisposableGithubLinux({ ...env,
    npm_config_electron_mirror: 'https://example.invalid/', npm_config_electron_use_remote_checksums: '1' }, 'linux'), /override/i);
});

test('preflight_mode_validates_environment_without_resolving_or_installing_electron', () => {
  const source = fs.readFileSync(helperFile, 'utf8');
  const module = { exports: {} };
  const output = { stdout: '', stderr: '' };
  const inertRequire = (name) => {
    assert.ok(['node:fs', 'node:path'].includes(name), `unexpected module side effect: ${name}`);
    return require(name);
  };
  inertRequire.main = module;
  inertRequire.resolve = () => { throw new Error('preflight must not resolve or materialize Electron'); };
  const process = { argv: ['node', helperFile, '--preflight'], platform: 'linux',
    env: { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ENVIRONMENT: 'github-hosted' },
    stdout: { write(value) { output.stdout += value; } }, stderr: { write(value) { output.stderr += value; } } };
  vm.runInNewContext(source, { require: inertRequire, module, process });
  assert.equal(process.exitCode, undefined, output.stderr);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, '');
  process.env.npm_config_electron_mirror = 'https://example.invalid/';
  vm.runInNewContext(source, { require: inertRequire, module, process });
  assert.equal(process.exitCode, 1);
  assert.match(output.stderr, /override/);
});
