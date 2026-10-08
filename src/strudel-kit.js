// Keep the upstream API intact. The dedicated Strudel scratchpad opts into the
// pinned REPL; canvas CSP still blocks network and grants this only per document.
const STRUDEL_OFFLINE_MARKER = '/* easel-strudel-offline-audio-v1 */';
const STRUDEL_OFFLINE_SETUP = `${STRUDEL_OFFLINE_MARKER}
;(() => {
  const strudel = window.strudel;
  // This promise waits for a real gesture. Never await it during page startup.
  // Only the Strudel scratchpad opts into dynamic evaluation and its local worklets.
  const scratchpad = document.documentElement?.dataset?.easelStrudelRepl === 'v1';
  strudel.initAudioOnFirstClick({ disableWorklets: !scratchpad });
})();
`;

function prepareStrudelBundle(source) {
  return source.includes(STRUDEL_OFFLINE_MARKER) ? source : `${source}\n${STRUDEL_OFFLINE_SETUP}`;
}

function getStrudelCapabilities() {
  return {
    nativeSynths: ['sine', 'triangle', 'square', 'sawtooth'],
    // Native playback and bounded production WAV/Media export passed CI on 5 October 2026.
    // Production gate: b3cb58a, Test run 37306231481.
    audioExport: true,
    externalSamples: false,
    repl: true,
  };
}

module.exports = { prepareStrudelBundle, getStrudelCapabilities };
