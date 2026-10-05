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
    // Native kit playback/offline synthesis passed CI on 5 October 2026.
    // WAV export remains unavailable until its separate end-to-end Media gate.
    audioExport: false,
    externalSamples: false,
    repl: false,
  };
}

module.exports = { prepareStrudelBundle, getStrudelCapabilities };
