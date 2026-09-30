function createCanvasMediaPermissions({ session, webContents, getCanvasId, getGeneration, isReady = () => true, requestPermission }) {
  const grants = new Map();
  let permissionEpoch = 0;
  const requestedTypes = (details = {}) => {
    const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
    return Array.isArray(types) ? [...new Set(types.filter((type) => ['audio', 'video'].includes(type)))] : [];
  };
  session.setPermissionCheckHandler((sender, permission, _origin, details) => {
    if (sender !== webContents || permission !== 'media' || !getCanvasId() || !isReady()) return false;
    const types = requestedTypes(details);
    return types.length > 0 && types.every((type) => grants.get(getCanvasId())?.has(type));
  });
  session.setPermissionRequestHandler(async (sender, permission, callback, details) => {
    const canvasId = getCanvasId();
    const generation = getGeneration();
    const epoch = permissionEpoch;
    const types = requestedTypes(details);
    if (sender !== webContents || permission !== 'media' || !canvasId || !types.length || !isReady()) { callback(false); return; }
    if (types.every((type) => grants.get(canvasId)?.has(type))) { callback(true); return; }
    try {
      const allowed = typeof requestPermission === 'function' && await requestPermission({ canvasId, types });
      if (!allowed || epoch !== permissionEpoch || getCanvasId() !== canvasId || getGeneration() !== generation || webContents.isDestroyed()) { callback(false); return; }
      const granted = grants.get(canvasId) || new Set();
      types.forEach((type) => granted.add(type));
      grants.set(canvasId, granted);
      callback(true);
    } catch { callback(false); }
  });
  return {
    inspect: () => ({ camera: Boolean(grants.get(getCanvasId())?.has('video')), microphone: Boolean(grants.get(getCanvasId())?.has('audio')), scope: 'this canvas for the current app session' }),
    grant: (types) => {
      const canvasId = getCanvasId();
      if (!canvasId || !isReady() || !Array.isArray(types) || !types.length || types.some((type) => !['audio', 'video'].includes(type))) throw new Error('Open a canvas before allowing a camera or microphone.');
      const granted = grants.get(canvasId) || new Set();
      types.forEach((type) => granted.add(type));
      grants.set(canvasId, granted);
    },
    invalidatePending: () => { permissionEpoch += 1; },
    revoke: () => { permissionEpoch += 1; return grants.delete(getCanvasId()); },
  };
}

module.exports = { createCanvasMediaPermissions };
