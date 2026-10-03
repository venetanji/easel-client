// Offline native regression: real application, drawer source, editable template,
// revision-safe host bridge, pointer/keyboard selection and persistent history.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(require('electron'), ['--no-sandbox', '--ozone-platform=x11', __filename], { env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, webContents, dialog } = require('electron');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-editor-smoke-'));
const artifacts = process.env.EASEL_UI_ARTIFACT_DIR || directory;
fs.mkdirSync(artifacts, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', path.join(directory, 'user-data'));
app.getAppPath = () => root;
const runtimeErrors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => runtimeErrors.push(details.reason));
});
require(path.join(root, 'src/main.js'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, message) {
  for (let attempt = 0; attempt < 150; attempt++) { const result = await read(); if (result) return result; await delay(40); }
  throw new Error(message);
}
const timeout = setTimeout(() => { console.error('Native editor smoke timed out.'); app.exit(2); }, 40000);
(async () => {
  await app.whenReady();
  const window = await until(async () => {
    const candidate = BrowserWindow.getAllWindows().find((entry) => /src\/index.html/.test(entry.webContents.getURL()));
    return candidate && await candidate.webContents.executeJavaScript('Boolean(window.easelClient)').catch(() => false) ? candidate : null;
  }, 'Main window did not initialize.');
  window.setSize(1440, 1000);
  const run = (source) => window.webContents.executeJavaScript(source);
  await run('document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close())');
  const project = await run('window.easelClient.openVideoEditor({title:"Offline editor interaction smoke",kits:["canvas-2d"]})');
  const canvas = await until(async () => {
    const candidate = webContents.getAllWebContents().find((entry) => entry.getURL().startsWith('easel-canvas://document/'));
    return candidate && await candidate.executeJavaScript('Boolean(window.EaselVideoEditor && document.querySelector("[data-role=track-lane]"))').catch(() => false) ? candidate : null;
  }, 'Editable timeline template did not initialize.');
  const edit = (source) => canvas.executeJavaScript(source);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(root, 'test/fixtures/video-export/overlay.png')] });
  const imported = await run(`window.easelClient.importMedia({projectId:${JSON.stringify(project.id)}})`);
  const assetId = imported.assets[0].assetId;
  await edit('window.EaselVideoEditor.refresh()');
  await run('document.getElementById("nav-media").click()');
  await until(() => run(`Boolean(document.querySelector('#media-list [data-asset-id="${assetId}"]')?.draggable)`), 'Imported media did not become draggable.');
  // Capture exactly what the real drawer source writes, then deliver it across
  // the separate sandboxed canvas webContents using a native DataTransfer.
  const transfer = await run(`(() => { const card = document.querySelector('#media-list [data-asset-id="${assetId}"]'); const data = new DataTransfer(); const event = new DragEvent('dragstart', {bubbles:true,cancelable:true,dataTransfer:data}); card.dispatchEvent(event); const result = {types:Array.from(data.types),payload:data.getData('application/x-easel-media-asset'),canceled:event.defaultPrevented}; card.dispatchEvent(new DragEvent('dragend',{bubbles:true})); return result; })()`);
  assert.equal(transfer.canceled, false);
  assert.deepEqual(transfer.types, ['application/x-easel-media-asset']);
  assert.deepEqual(JSON.parse(transfer.payload), { assetId });
  await edit(`(() => { document.querySelector('[data-role="image-duration"]').value='2'; const lane = document.querySelector('[data-role="track-lane"][data-track-id="video-1"]'); const box=lane.getBoundingClientRect(); const data=new DataTransfer(); data.setData('application/x-easel-media-asset', ${JSON.stringify(transfer.payload)}); for(const type of ['dragover','drop']) lane.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data,clientX:box.left+72,clientY:box.top+28})); })()`);
  const timeline = await until(async () => { const value = await edit('window.EaselHost.timeline({action:"read"})'); return value.items.length === 1 ? value : null; }, 'Drawer drop did not save a clip.');
  assert.equal(timeline.items[0].startFrame, 24); assert.equal(timeline.items[0].endFrame, 72);
  await edit('document.querySelector(".timeline-clip").click()');
  const handle = await edit(`(() => { const node=document.querySelector('[data-role="range-end-handle"][data-track-id="video-1"]'); const box=node.getBoundingClientRect(); return {x:Math.round(box.x+box.width/2-3),y:Math.round(box.y+box.height/2),visible:!node.hidden,disabled:node.disabled}; })()`);
  assert.equal(handle.visible, true); assert.equal(handle.disabled, false);
  canvas.sendInputEvent({type:'mouseMove',x:handle.x,y:handle.y});
  canvas.sendInputEvent({type:'mouseDown',x:handle.x,y:handle.y,button:'left',clickCount:1});
  canvas.sendInputEvent({type:'mouseMove',x:handle.x+36,y:handle.y,movementX:36});
  canvas.sendInputEvent({type:'mouseUp',x:handle.x+36,y:handle.y,button:'left',clickCount:1});
  await until(() => edit('window.EaselVideoEditor.getSelection()?.endFrame===84'), 'Native pointer did not adjust the range.');
  await edit('document.querySelector("[data-role=range-end-handle][data-track-id=video-1]").focus()');
  canvas.sendInputEvent({type:'keyDown',keyCode:'Right',modifiers:['shift']});
  canvas.sendInputEvent({type:'keyUp',keyCode:'Right',modifiers:['shift']});
  await until(() => edit('window.EaselVideoEditor.getSelection()?.endFrame===94'), 'Native keyboard did not adjust by ten frames.');
  const afterSelection = await edit('window.EaselHost.timeline({action:"read"})');
  assert.equal(afterSelection.revision, timeline.revision, 'Range adjustment must not edit the media.');
  assert.equal(afterSelection.items[0].endFrame, 72);
  const bounds = await edit(`(() => { const node=document.querySelector('[data-role="range-end-handle"][data-track-id="video-1"]'); const b=node.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2-3),y:Math.round(b.y+b.height/2)}; })()`);
  canvas.sendInputEvent({type:'mouseDown',x:bounds.x,y:bounds.y,button:'left',clickCount:1});
  canvas.sendInputEvent({type:'mouseMove',x:bounds.x+24,y:bounds.y,movementX:24});
  canvas.sendInputEvent({type:'keyDown',keyCode:'Escape'}); canvas.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  canvas.sendInputEvent({type:'mouseUp',x:bounds.x+24,y:bounds.y,button:'left',clickCount:1});
  await until(() => edit('window.EaselVideoEditor.getSelection()?.endFrame===94'), 'Escape did not restore the range.');
  await edit('document.querySelector("[data-role=undo]").click()');
  await until(async () => (await edit('window.EaselHost.timeline({action:"read"})')).items.length === 0, 'Undo did not remove the dropped clip.');
  await until(() => edit('!document.querySelector("[data-role=redo]").disabled'), 'Redo did not become ready.');
  await edit('document.querySelector("[data-role=redo]").click()');
  const restored = await until(async () => { const value=await edit('window.EaselHost.timeline({action:"read"})'); return value.items.length === 1 ? value : null; }, 'Redo did not restore the clip.');
  assert.equal(restored.items[0].assetId, assetId); assert.ok(restored.revision > timeline.revision);
  await edit('document.querySelector(".timeline-clip").click()');
  const errors = await edit('window.EaselCanvas?.inspect().errors || []');
  assert.deepEqual(errors, []); assert.deepEqual(runtimeErrors, []);
  fs.writeFileSync(path.join(artifacts, 'editor.png'), (await canvas.capturePage()).toPNG());
  fs.writeFileSync(path.join(artifacts, 'app.png'), (await window.capturePage()).toPNG());
  const result = { nativePointer: true, keyboardPrecision: true, escapeCancellation: true, managedDrawerPayload: true, sandboxedDrop: true, undoRedo: true, sourceUnchanged: true, revision: restored.revision, runtimeErrors, artifacts };
  fs.writeFileSync(path.join(artifacts, 'interactions.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); clearTimeout(timeout); app.exit(0);
})().catch((error) => { console.error(error); clearTimeout(timeout); app.exit(1); });
