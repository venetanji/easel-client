const packageJson = require('../package.json');

const releaseTag = process.env.RELEASE_TAG;
const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const versionTagPattern = new RegExp(`^v${escapedVersion}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
if (releaseTag && !versionTagPattern.test(releaseTag)) {
  console.error(`RELEASE_TAG ${releaseTag} does not match package version v${packageJson.version}.`);
  process.exitCode = 1;
}
