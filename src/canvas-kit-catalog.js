const KIT_CATALOG = Object.freeze([
  { id: 'canvas-2d', name: 'Canvas 2D', description: 'Native drawing, animation and image composition.', builtin: true },
  { id: 'html-deck', name: 'HTML deck', description: 'Interactive pages and presentations with HTML and CSS.', builtin: true },
  { id: 'three', name: 'Three.js', description: 'WebGL scenes, lighting and 3D objects.' },
  { id: 'p5', name: 'p5.js', description: 'Creative coding, drawing and interactive sketches.' },
  { id: 'strudel', name: 'Strudel', description: 'Native-synth patterns. Experimental offline compatibility; no samples or REPL.' },
  { id: 'tone', name: 'Tone.js', description: 'Synthesizers, effects and audio sequencing.' },
  { id: 'matter', name: 'Matter.js', description: '2D physics and body simulation.' },
  { id: 'phaser', name: 'Phaser', description: '2D games, sprites and scenes.' },
]);

function availableCanvasKits(bundles = {}) {
  return KIT_CATALOG.map((kit) => ({ ...kit, installed: kit.builtin === true || typeof bundles[kit.id] === 'string' && bundles[kit.id].length > 0 }));
}

function assertInstalledKits(kits, bundles) {
  const installed = new Set(availableCanvasKits(bundles).filter((kit) => kit.installed).map((kit) => kit.id));
  for (const kit of kits) if (!installed.has(kit)) throw new Error(`The ${kit} kit is not installed. Check Kits in Settings.`);
  return kits;
}

module.exports = { availableCanvasKits, assertInstalledKits };
