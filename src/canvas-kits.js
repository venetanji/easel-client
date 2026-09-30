const fs = require('node:fs');
const path = require('node:path');

const BUNDLED_CANVAS_KITS = Object.freeze(['three', 'phaser', 'matter', 'tone', 'p5']);
const MAX_CANVAS_KIT_BYTES = 8 * 1024 * 1024;
const TONE_OFFLINE_CLOCK_MARKER = '/* easel-tone-offline-clock-v1 */';
const TONE_OFFLINE_SETUP = `${TONE_OFFLINE_CLOCK_MARKER}
;(() => {
  const tone = window.Tone;
  if (!tone?.Context || !tone.getContext) return;
  const originalDefaults = tone.Context.getDefaults;
  tone.Context.getDefaults = function () {
    return { ...originalDefaults.call(this), clockSource: 'timeout' };
  };
  const context = tone.getContext();
  if (!context.isOffline && context.clockSource !== 'timeout') context.clockSource = 'timeout';
})();
`;

function prepareToneBundle(source) {
  return source.includes(TONE_OFFLINE_CLOCK_MARKER) ? source : `${source}\n${TONE_OFFLINE_SETUP}`;
}

function loadCanvasKitBundles(directory) {
  const bundles = {};
  for (const kit of BUNDLED_CANVAS_KITS) {
    const filename = path.join(directory, `${kit}.js`);
    if (!fs.existsSync(filename)) continue;
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > MAX_CANVAS_KIT_BYTES) {
      throw new Error(`The bundled ${kit} canvas kit is invalid.`);
    }
    bundles[kit] = fs.readFileSync(filename, 'utf8');
  }
  return bundles;
}

function repairLegacyToneBundle(html) {
  return html.replace(/(<script\b[^>]*\bdata-easel-canvas-kit=["']tone["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_match, opening, source, closing) => {
      // Early builds wrapped Tone's existing license comment in another comment.
      const repaired = source.replace(/\n\/\*\n(\/\*\*[\s\S]*?\*\/)\n\*\/\s*$/, '\n$1\n');
      return `${opening}${prepareToneBundle(repaired)}${closing}`;
    });
}

module.exports = { BUNDLED_CANVAS_KITS, MAX_CANVAS_KIT_BYTES, TONE_OFFLINE_SETUP, loadCanvasKitBundles, prepareToneBundle, repairLegacyToneBundle };
