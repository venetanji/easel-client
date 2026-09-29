const fs = require('node:fs');
const path = require('node:path');

const BUNDLED_CANVAS_KITS = Object.freeze(['three', 'phaser', 'matter', 'tone']);
const MAX_CANVAS_KIT_BYTES = 8 * 1024 * 1024;

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

module.exports = { BUNDLED_CANVAS_KITS, MAX_CANVAS_KIT_BYTES, loadCanvasKitBundles };
