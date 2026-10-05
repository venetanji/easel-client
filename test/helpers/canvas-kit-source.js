const crypto = require('node:crypto');
const { createProjectZip } = require('../../src/project-zip');

// Synthetic source distribution for host/store tests. This is deliberately not
// a substitute for the reviewed production corresponding-source archive.
function createSourceArchiveFixture(runtime, label = 'Original exact source') {
  const zip = createProjectZip({ timestamp: new Date(1980, 0, 1).getTime() });
  zip.add('strudel-source/manifest.json', JSON.stringify({ schemaVersion: 1, kitId: 'strudel', version: '1.3.0', runtimeSha256: crypto.createHash('sha256').update(runtime).digest('hex'), inputs: [] }));
  zip.add('strudel-source/README.txt', label);
  return zip.finish().data;
}

module.exports = { createSourceArchiveFixture };
