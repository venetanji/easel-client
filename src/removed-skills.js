// Names only: keep saved copies disabled without shipping the removed recipes.
const EaselRemovedSkills = (() => {
  const names = new Set([
    'canopy-part-title', 'code-slice-hero', 'cuboid-carousel', 'embedded-captions',
    'faceless-explainer', 'figma', 'frost-sequence-camera-orbit', 'general-video',
    'glass-shard-title', 'media-use', 'motion-graphics', 'music-to-video', 'orbit-card',
    'pr-to-video', 'product-launch-video', 'remotion-to-hyperframes', 'slideshow',
    'talking-head-recut', 'wireframe-portal-title',
  ]);
  function isRemoved(name) {
    const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
    return normalized === 'hyperframes' || normalized.startsWith('hyperframes-') || names.has(normalized);
  }
  return Object.freeze({
    isRemoved,
    reason: 'This HyperFrames recipe was removed from Easel. Its saved text is retained, but the required runtime and assets are unavailable.',
  });
})();

if (typeof module !== 'undefined') module.exports = EaselRemovedSkills;
