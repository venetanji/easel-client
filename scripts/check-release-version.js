const packageJson = require('../package.json');

const releaseTag = process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${packageJson.version}`) {
  console.error(`RELEASE_TAG ${releaseTag} does not match package version v${packageJson.version}.`);
  process.exitCode = 1;
}
