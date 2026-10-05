// Validate and print the one official-package helper path for the approved CI
// prerequisite. This script never changes permissions or launches Electron.
const fs = require('node:fs');
const path = require('node:path');

function assertDisposableGithubLinux(env = process.env, platform = process.platform) {
  if (platform !== 'linux' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'Linux' || env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Electron helper setup is limited to a disposable GitHub-hosted Linux runner.');
  }
  // Match the installed @electron/get mirrorVar aliases, plus Electron's
  // installer switches. Reject them before download and again before privilege.
  const overrides = new Set(['ELECTRON_OVERRIDE_DIST_PATH',
    'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums',
    'ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH', 'npm_config_platform', 'npm_config_arch']);
  for (const option of ['mirror', 'nightlyMirror', 'customDir', 'customFilename', 'customVersion']) {
    const snake = option.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    for (const name of [`npm_config_electron_${option.toLowerCase()}`, `NPM_CONFIG_ELECTRON_${snake.toUpperCase()}`,
      `npm_config_electron_${snake}`, `npm_package_config_electron_${option}`,
      `npm_package_config_electron_${snake}`, `ELECTRON_${snake.toUpperCase()}`]) overrides.add(name);
  }
  for (const name of overrides) {
    if (env[name]) throw new Error(`Electron distribution override ${name} is not permitted for this CI setup.`);
  }
}

function resolveSandboxHelper(packageRoot) {
  const root = fs.realpathSync(packageRoot);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'electron') throw new Error('Expected the installed official electron package.');
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist) || !fs.lstatSync(dist).isDirectory()) {
    throw new Error('Electron dist must be a materialized regular directory, not a symlink.');
  }
  for (const name of ['electron', 'chrome-sandbox']) {
    const filename = path.join(dist, name);
    if (!fs.existsSync(filename)) throw new Error(`Electron is not materialized: missing ${name}. Run the official install.js first.`);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Electron ${name} must be a regular file, not a symlink.`);
    if (stat.nlink !== 1) throw new Error(`Electron ${name} must have a single hardlink.`);
    if (fs.realpathSync(filename) !== filename) throw new Error(`Electron ${name} must stay inside the installed dist directory.`);
  }
  return path.join(dist, 'chrome-sandbox');
}

if (require.main === module) {
  try {
    assertDisposableGithubLinux();
    // package.json resolution does not invoke electron/index.js or its lazy
    // installer. Path mode runs after materialization; preflight stays inert.
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--preflight') {
      // Environment-only mode: no package resolution or binary inspection.
    } else if (args.length === 0) {
      const packageRoot = path.dirname(require.resolve('electron/package.json'));
      process.stdout.write(`${resolveSandboxHelper(packageRoot)}\n`);
    } else {
      throw new Error('Unsupported CI sandbox helper arguments.');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertDisposableGithubLinux, resolveSandboxHelper };
