const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session, protocol, nativeImage } = require('electron');
const { createVideoMetadataService } = require('../../src/video-metadata');
const { createManagedVideoSourceResolver } = require('../../src/video-frame-reference');
const { createCanvasMediaStore } = require('../../src/canvas-media-store');
const { createAssetStore } = require('../../src/asset-store');
const { createCanvasStore } = require('../../src/canvas-store');

async function syntheticClip() {
  const bunny = globalThis.EaselMediabunny;
  const canvas = document.createElement('canvas');
  canvas.width = 96; canvas.height = 64;
  const context = canvas.getContext('2d');
  const target = new bunny.BufferTarget();
  const output = new bunny.Output({ format: new bunny.WebMOutputFormat(), target });
  const video = new bunny.CanvasSource(canvas, { codec: 'vp8', bitrate: 100_000 });
  const audio = new bunny.AudioBufferSource({ codec: 'opus', bitrate: 64_000 });
  output.addVideoTrack(video, { frameRate: 24 });
  output.addAudioTrack(audio);
  await output.start();
  // Encode a silent audio tail beyond the video; never connect a playback node.
  await audio.add(new AudioBuffer({ length: 72_000, sampleRate: 48_000, numberOfChannels: 1 }));
  audio.close();
  for (let frame = 0; frame < 24; frame++) {
    context.fillStyle = frame === 23 ? '#0000ff' : '#ff0000';
    context.fillRect(0, 0, 96, 64);
    await video.add(frame / 24, 1 / 24);
  }
  video.close();
  await output.finalize();
  return btoa(String.fromCharCode(...new Uint8Array(target.buffer)));
}

async function run() {
  const root = process.env.EASEL_FRAME_SMOKE_DIRECTORY;
  app.setPath('userData', path.join(root, 'profile'));
  app.setPath('cache', path.join(root, 'cache'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  protocol.registerSchemesAsPrivileged([{ scheme: 'easel-canvas', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  await app.whenReady();
  const fixtureWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  fixtureWindow.webContents.setAudioMuted(true);
  let service;
  try {
    const fixturePage = path.join(root, 'fixture.html');
    fs.writeFileSync(fixturePage, '<!doctype html><title>Synthetic frame fixture</title>');
    await fixtureWindow.loadFile(fixturePage);
    await fixtureWindow.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../../canvas-kits/mediabunny.js'), 'utf8') + '\n;globalThis.EaselMediabunny = EaselMediabunny; void 0;');
    const data = await fixtureWindow.webContents.executeJavaScript(`(${syntheticClip.toString()})()`);
    const mediaStore = createCanvasMediaStore({ userDataPath: app.getPath('userData') });
    const imageStore = createAssetStore({ userDataPath: app.getPath('userData') });
    const projects = createCanvasStore({ userDataPath: app.getPath('userData') });
    const project = projects.save({ title: 'Synthetic digest video', html: `<video src="data:video/webm;base64,${data}"></video>` });
    const digestAsset = projects.listAssets(project.id).assets[0];
    const readMediaReference = ({ assetId, projectId }) => projects.getAsset(projectId, assetId);
    service = createVideoMetadataService({ BrowserWindow,
      sessionFactory: async partition => ({ partition, session: session.fromPartition(partition, { cache: false }) }), mediaStore, imageStore,
      readVideoSource: createManagedVideoSourceResolver({ mediaStore, readMediaReference }) });
    const sourceAssetId = await mediaStore.save({ data, mimeType: 'video/webm', name: 'Synthetic source.webm' });
    const last = await service.extractFrame({ assetId: sourceAssetId, position: 'last' });
    const timed = await service.extractFrame({ assetId: sourceAssetId, timestampSeconds: 0.25 });
    const almostEnd = await service.extractFrame({ assetId: sourceAssetId, timestampSeconds: 0.999 });
    assert.equal(last.timestampSeconds, 0.958, 'The final native WebM frame uses millisecond timestamp precision.');
    assert.ok(Math.abs(timed.timestampSeconds - 0.25) < 1e-6);
    assert.equal(last.data, almostEnd.data);
    assert.notEqual(last.data, timed.data);
    assert.equal((await imageStore.get(last.assetId)).data, last.data);
    const lastImage = nativeImage.createFromBuffer(Buffer.from(last.data, 'base64'));
    assert.deepEqual(lastImage.getSize(), { width: 96, height: 64 });
    const lastPixels = lastImage.toBitmap();
    assert.ok(lastPixels[0] > 180 && lastPixels[2] < 60, 'Last video frame must be blue, not a red midpoint or an empty frame.');
    await assert.rejects(service.extractFrame({ assetId: sourceAssetId, timestampSeconds: 1.25 }), /before the video track ends/);
    const digestStill = await service.extractFrame({ assetId: digestAsset.id, projectId: project.id });
    assert.equal(digestStill.data, last.data);
    const mp4Data = fs.readFileSync(path.join(__dirname, '../fixtures/video-export/red.mp4')).toString('base64');
    const mp4Id = await mediaStore.save({ data: mp4Data, mimeType: 'video/mp4', name: 'Synthetic MP4.mp4' });
    const mp4Still = await service.extractFrame({ assetId: mp4Id });
    assert.equal(nativeImage.createFromBuffer(Buffer.from(mp4Still.data, 'base64')).isEmpty(), false);
    await service.close();
    console.log(JSON.stringify({ lastTimestamp: last.timestampSeconds, selectedTimestamp: timed.timestampSeconds,
      jpegBytes: last.bytes, savedImageId: last.assetId, digestSource: true, mp4Source: true, audioTailIgnored: true, silent: true }));
    app.exit(0);
  } finally {
    if (!fixtureWindow.isDestroyed()) fixtureWindow.destroy();
    await service?.close();
  }
}
run().catch(error => { console.error(error.stack || error); app.exit(1); });
