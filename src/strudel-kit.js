// Keep the upstream API intact. Easel supports only native synth patterns;
// sample fetching, the REPL and worklet-dependent features remain unsupported.
const STRUDEL_OFFLINE_MARKER = '/* easel-strudel-offline-audio-v1 */';
const STRUDEL_OFFLINE_SETUP = `${STRUDEL_OFFLINE_MARKER}
;(() => {
  const strudel = window.strudel;
  // This promise waits for a real gesture. Never await it during page startup.
  // Calling first makes initStrudel reuse worklet-disabled initialization.
  strudel.initAudioOnFirstClick({ disableWorklets: true });
})();
`;

function prepareStrudelBundle(source) {
  return source.includes(STRUDEL_OFFLINE_MARKER) ? source : `${source}\n${STRUDEL_OFFLINE_SETUP}`;
}

function getStrudelCapabilities() {
  return {
    nativeSynths: ['sine', 'triangle', 'square', 'sawtooth'],
    // Promote only after the bounded isolated-renderer runtime gate passes.
    audioExport: false,
    externalSamples: false,
    repl: false,
  };
}

module.exports = { prepareStrudelBundle, getStrudelCapabilities };
