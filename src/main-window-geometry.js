function getMainWindowGeometry(workArea) {
  // Leave room for compositor gaps and decorations on scaled desktops.
  const margin = 24;
  const width = Math.min(1200, Math.max(1, workArea.width - margin * 2));
  const height = Math.min(900, Math.max(1, workArea.height - margin * 2));
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(960, width),
    minHeight: Math.min(720, height),
  };
}

module.exports = { getMainWindowGeometry };
