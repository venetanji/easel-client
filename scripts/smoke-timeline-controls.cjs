// Offline direct-manipulation regression against the real app and persisted
// host bridge. Fixtures are synthetic; no models or user media are contacted.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=x11'] : []), __filename];
  const result = spawnSync(require('electron'), args, { env: process.env, stdio: 'inherit', timeout: 120000 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, webContents, dialog } = require('electron');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-direct-controls-'));
const artifacts = process.env.EASEL_UI_ARTIFACT_DIR || directory;
fs.mkdirSync(artifacts, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', path.join(directory, 'user-data'));
app.getAppPath = () => root;
const crashes = [];
app.on('web-contents-created', (_event, contents) => contents.on('render-process-gone', (_event, details) => crashes.push(details.reason)));
require(path.join(root, 'src/main.js'));
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let phase = 'startup', canvas, window;
async function until(read, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) { const value = await read(); if (value) return value; await delay(30); }
  throw new Error(`${phase}: ${message}`);
}
const timeout = setTimeout(() => { console.error(`Timeout during ${phase}`); app.exit(2); }, 115000);
(async () => {
  await app.whenReady();
  window = await until(async () => {
    const candidate = BrowserWindow.getAllWindows().find(entry => /src\/index.html/.test(entry.webContents.getURL()));
    return candidate && await candidate.webContents.executeJavaScript('Boolean(window.easelClient)').catch(() => false) ? candidate : null;
  }, 'main window did not initialize');
  window.setSize(1440, 1000);
  const run = source => window.webContents.executeJavaScript(source);
  await run('document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close())');
  const project = await run('window.easelClient.openVideoEditor({title:"Offline direct controls",kits:["canvas-2d"]})');
  canvas = await until(async () => {
    const candidate = webContents.getAllWebContents().find(entry => entry.getURL().startsWith('easel-canvas://document/'));
    return candidate && await candidate.executeJavaScript('Boolean(window.EaselVideoEditor && document.querySelector("[data-role=ruler]"))').catch(() => false) ? candidate : null;
  }, 'template did not initialize');
  const edit = source => canvas.executeJavaScript(source);
  const read = () => edit('window.EaselHost.timeline({action:"read"})');
  const paint = () => edit('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const ready = () => until(() => edit('!document.querySelector("[data-role=refresh]").disabled'), 'editor did not become ready');
  const apply = async operations => {
    const snapshot = await read();
    const result = await edit(`window.EaselHost.timeline({action:'apply',input:${JSON.stringify({ expectedRevision: snapshot.revision, operations })}})`);
    await edit('window.EaselVideoEditor.refresh()'); await ready(); await paint(); return result;
  };
  const role = (name, field, value) => `[data-role="${name}"]${field ? `[data-${field}="${value}"]` : ''}`;
  const point = async (selector, x = 0.5, y = 0.5) => edit(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node) throw new Error('Missing target: '+${JSON.stringify(selector)}); const b=node.getBoundingClientRect(); if(node.hidden || b.width<=0 || b.height<=0) throw new Error('Invisible target'); return {x:Math.round(b.x+b.width*${x}),y:Math.round(b.y+b.height*${y})}; })()`);
  const focus = async () => { window.show(); window.focus(); canvas.focus(); await until(() => edit('document.hasFocus()'), 'canvas did not receive native focus'); await paint(); };
  const key = async (keyCode, modifiers = []) => { canvas.sendInputEvent({type:'keyDown',keyCode,modifiers}); canvas.sendInputEvent({type:'keyUp',keyCode,modifiers}); await paint(); };
  await edit(`window.controlEvents=[]; for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture','pointercancel']) document.addEventListener(type,event=>window.controlEvents.push({type,role:event.target.dataset?.role,item:event.target.dataset?.itemId,pointerId:event.pointerId,buttons:event.buttons,captured:event.target.hasPointerCapture?.(event.pointerId),x:event.clientX,y:event.clientY}),true);`);
  async function drag(from, to, { modifiers = [], cancel = false } = {}) {
    await focus(); await edit('window.controlEvents=[]');
    canvas.sendInputEvent({type:'mouseMove',...from,modifiers});
    canvas.sendInputEvent({type:'mouseDown',...from,button:'left',clickCount:1,modifiers});
    await until(() => edit('window.controlEvents.some(event=>event.type==="pointerdown")'), 'native pointerdown missing');
    canvas.sendInputEvent({type:'mouseMove',...to,movementX:to.x-from.x,movementY:to.y-from.y,modifiers:[...modifiers,'leftButtonDown']});
    await paint();
    if (cancel) await key('Escape');
    canvas.sendInputEvent({type:'mouseUp',...to,button:'left',clickCount:1,modifiers});
    await ready(); await paint();
  }
  const click = async selector => { const p = await point(selector); await drag(p, p); };
  const changed = async revision => until(async () => { const value=await read(); return value.revision > revision ? value : null; }, 'edit did not persist');
  const fixtureDir = path.join(root, 'test/fixtures/video-export');
  const sourceHashes = Object.fromEntries(['red.mp4','blue.mp4'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(fixtureDir,name))).digest('hex')]));
  dialog.showOpenDialog = async () => ({ canceled:false, filePaths:['red.mp4','blue.mp4'].map(name=>path.join(fixtureDir,name)) });
  const imported = await run(`window.easelClient.importMedia({projectId:${JSON.stringify(project.id)}})`);
  assert.equal(imported.assets.length, 2);
  const red = imported.assets.find(asset=>asset.name==='red.mp4').assetId;
  const blue = imported.assets.find(asset=>asset.name==='blue.mp4').assetId;
  await edit('window.EaselVideoEditor.refresh()'); await ready();
  phase = 'add track';
  let snapshot = await read(); await click(role('add-video-track')); snapshot = await changed(snapshot.revision);
  const addedTrack = snapshot.tracks.find(track=>track.type==='video' && track.id!=='video-1').id;
  assert.equal(snapshot.tracks.length, 4);
  const item = (id,assetId,trackId,startFrame,endFrame,name) => ({id,assetId,trackId,startFrame,endFrame,name,sourceStartSeconds:0,sourceEndSeconds:(endFrame-startFrame)/24,sourceDurationSeconds:1,gain:0});
  snapshot = await apply([
    {type:'insert',item:item('red-back',red,'video-1',0,24,'Red background')},
    {type:'insert',item:item('blue-move',blue,'video-1',24,48,'Blue movable clip')},
  ]);
  phase = 'move clip across tracks';
  const body = await point(role('clip-body','item-id','blue-move'));
  const destination = await point(role('track-lane','track-id',addedTrack));
  await drag(body,{x:body.x+72,y:destination.y},{modifiers:['shift']});
  snapshot = await changed(snapshot.revision);
  assert.deepEqual([snapshot.items.find(i=>i.id==='blue-move').trackId,snapshot.items.find(i=>i.id==='blue-move').startFrame,snapshot.items.find(i=>i.id==='blue-move').endFrame],[addedTrack,48,72]);
  phase = 'trim end';
  let trim = await point(role('clip-trim-end','clip-id','blue-move'));
  await drag(trim,{x:trim.x-36,y:trim.y},{modifiers:['shift']}); snapshot=await changed(snapshot.revision);
  assert.equal(snapshot.items.find(i=>i.id==='blue-move').endFrame,60);
  assert.equal(snapshot.items.find(i=>i.id==='blue-move').sourceEndSeconds,0.5);
  phase = 'trim start';
  trim=await point(role('clip-trim-start','clip-id','blue-move'));
  await drag(trim,{x:trim.x+9,y:trim.y},{modifiers:['shift']}); snapshot=await changed(snapshot.revision);
  assert.equal(snapshot.items.find(i=>i.id==='blue-move').startFrame,51);
  assert.equal(snapshot.items.find(i=>i.id==='blue-move').sourceStartSeconds,0.125);
  phase = 'cancel clip move';
  const beforeCancel=JSON.stringify(snapshot);
  const moving=await point(role('clip-body','item-id','blue-move'));
  await drag(moving,{x:moving.x+36,y:moving.y},{cancel:true,modifiers:['shift']});
  assert.equal(JSON.stringify(await read()),beforeCancel);
  phase = 'undo and redo';
  await click(role('undo')); snapshot=await changed(snapshot.revision);
  assert.equal(snapshot.items.find(i=>i.id==='blue-move').startFrame,48);
  await until(()=>edit('!document.querySelector("[data-role=redo]").disabled'),'redo unavailable');
  await click(role('redo')); snapshot=await changed(snapshot.revision);
  assert.equal(snapshot.items.find(i=>i.id==='blue-move').startFrame,51);
  phase = 'short clip body target';
  trim=await point(role('clip-trim-end','clip-id','blue-move'));
  await drag(trim,{x:trim.x-9,y:trim.y},{modifiers:['shift']}); snapshot=await changed(snapshot.revision);
  assert.equal(snapshot.items.find(i=>i.id==='blue-move').endFrame-snapshot.items.find(i=>i.id==='blue-move').startFrame,6);
  const short=await point(role('clip-body','item-id','blue-move'));
  const shortHit=await edit(`(()=>{const node=document.elementFromPoint(${short.x},${short.y});const body=document.querySelector('[data-role="clip-body"][data-item-id="blue-move"]');const box=body.getBoundingClientRect();return {itemId:node?.closest('[data-role="clip-body"]')?.dataset.itemId,hitRole:node?.dataset.role,bodyWidth:box.width,styleWidth:body.style.width,padding:getComputedStyle(body).paddingInline}})()`);
  assert.equal(shortHit.itemId,'blue-move',`short clip center must remain draggable: ${JSON.stringify(shortHit)}`);
  await drag(short,{x:short.x+9,y:short.y},{modifiers:['shift']}); snapshot=await changed(snapshot.revision);
  assert.deepEqual([snapshot.items.find(i=>i.id==='blue-move').startFrame,snapshot.items.find(i=>i.id==='blue-move').endFrame],[54,60]);
  phase = 'ruler seek and Space';
  const rulerLeft=await point(role('ruler'),0,0.5);
  await drag({...rulerLeft,x:rulerLeft.x+18},{...rulerLeft,x:rulerLeft.x+18});
  assert.equal(await edit('Number(document.querySelector("[data-role=seek]").value)'),6);
  await key('Space'); await until(()=>edit('document.querySelector("[data-role=play]").textContent==="Pause"'),'Space did not start playback');
  await key('Space'); await until(()=>edit('document.querySelector("[data-role=play]").textContent==="Play"'),'Space did not pause playback');
  phase = 'cross-track selection';
  const high=await point(role('track-lane','track-id',addedTrack),0,0.5), low=await point(role('track-lane','track-id','video-1'),0,0.5);
  await drag({...high,x:high.x+270},{...low,x:low.x+342});
  let selection=await edit('window.EaselVideoEditor.getSelection()');
  assert.deepEqual([selection.startFrame,selection.endFrame,selection.trackIds.length],[90,114,4]);
  const selectionRevision=(await read()).revision;
  phase = 'Alt selection move';
  await drag({...high,x:high.x+306},{...high,x:high.x+324},{modifiers:['alt']});
  selection=await edit('window.EaselVideoEditor.getSelection()');
  assert.deepEqual([selection.startFrame,selection.endFrame,selection.trackIds.length],[96,120,4]);
  assert.equal((await read()).revision,selectionRevision,'selection must not write a timeline edit');
  phase = 'Escape selection rollback';
  await drag({...high,x:high.x+318},{...high,x:high.x+348},{modifiers:['alt'],cancel:true});
  assert.deepEqual(await edit('window.EaselVideoEditor.getSelection()'),selection);
  phase = 'stacking fixtures';
  snapshot=await apply([{type:'insert',item:item('blue-front',blue,addedTrack,0,24,'Blue foreground')}]);
  async function seekFrame(frame) {
    const p=await point(role('ruler'),0,0.5); await drag({...p,x:p.x+frame*3},{...p,x:p.x+frame*3});
    await until(()=>edit('Array.from(document.querySelectorAll("video.timeline-preview-layer")).length===2 && Array.from(document.querySelectorAll("video.timeline-preview-layer")).every(node=>node.readyState>=2 && !node.seeking)'),'preview layers did not decode'); await paint();
  }
  async function previewPixel() {
    const p=await point(role('preview-stage'));
    const dataUrl=(await canvas.capturePage({x:p.x,y:p.y,width:1,height:1})).toDataURL();
    return edit(`(async()=>{const image=new Image();image.src=${JSON.stringify(dataUrl)};await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.drawImage(image,0,0);return Array.from(context.getImageData(0,0,1,1).data)})()`);
  }
  const checkColor=(rgba,color,label)=>assert.ok(color==='blue' ? rgba[2]>170 && rgba[0]<90 : rgba[0]>170 && rgba[2]<90,`${label}: expected ${color}, received ${rgba}`);
  await seekFrame(6); const bluePixel=await previewPixel(); checkColor(bluePixel,'blue','highest row preview');
  phase = 'native track reorder';
  const header=await point(role('track-select','track-id',addedTrack)); const last=await point(role('track-lane','track-id','video-1'));
  await drag(header,{x:header.x,y:last.y}); snapshot=await changed(snapshot.revision);
  assert.equal(snapshot.tracks[0].id,addedTrack);
  const rowOrder=await edit('Array.from(document.querySelectorAll("[data-role=track-lane]")).map(node=>node.dataset.trackId)');
  assert.deepEqual(rowOrder,[...snapshot.tracks].reverse().map(track=>track.id));
  await seekFrame(6); const redPixel=await previewPixel(); checkColor(redPixel,'red','reordered preview');
  phase = 'export reordered composition';
  const ids=await run('window.easelClient.listAssets().then(assets=>assets.map(asset=>asset.id))');
  await click(role('export'));
  const output=await until(async()=>{const assets=await run('window.easelClient.listAssets()');return assets.find(asset=>asset.mimeType==='video/webm'&&!ids.includes(asset.id));},'export did not save',1800);
  const media=await run(`window.easelClient.getLibraryAsset(${JSON.stringify(output.id)})`);
  const decoded=await edit(`(async()=>{const bunny=window.EaselMediabunny;const input=new bunny.Input({source:new bunny.BufferSource(Uint8Array.from(atob(${JSON.stringify(media.data)}),c=>c.charCodeAt(0))),formats:[bunny.WEBM]});try{const track=await input.getPrimaryVideoTrack();const frame=await new bunny.CanvasSink(track).getCanvas(0.25);return Array.from(frame.canvas.getContext('2d').getImageData(Math.floor(frame.canvas.width/2),Math.floor(frame.canvas.height/2),1,1).data);}finally{input.dispose()}})()`);
  checkColor(decoded,'red','decoded export');
  phase = 'verify source and runtime';
  for(const [name,hash] of Object.entries(sourceHashes)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(fixtureDir,name))).digest('hex'),hash);
  assert.deepEqual(await edit('window.EaselCanvas?.inspect().errors || []'),[]); assert.deepEqual(crashes,[]);
  await edit('window.EaselVideoEditor.clearSelection(); document.querySelector("[data-role=clip-body][data-item-id=red-back]").click()'); await seekFrame(6);
  fs.writeFileSync(path.join(artifacts,'timeline-controls.png'),(await canvas.capturePage()).toPNG());
  const desktopGeometry=await edit('({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth})');
  window.setMinimumSize(640,780); window.setSize(680,960);
  await until(()=>edit('innerWidth<750'),'narrow canvas did not resize'); await paint();
  fs.writeFileSync(path.join(artifacts,'timeline-controls-narrow.png'),(await canvas.capturePage()).toPNG());
  const narrowGeometry=await edit('({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth})');
  assert.equal(desktopGeometry.overflow,false); assert.equal(narrowGeometry.overflow,false);
  fs.writeFileSync(path.join(artifacts,'reordered.webm'),Buffer.from(media.data,'base64'));
  const evidence={moveAcrossTracks:true,trimBothEdges:true,shortClipBody:true,escapeCancels:true,undoRedo:true,rulerSeek:true,spacePlayback:true,crossTrackSelection:true,altRangeShiftNoWrites:true,nativeTrackReorder:true,highestPreviewMatchesDecodedExport:true,previewBefore:bluePixel,previewAfter:redPixel,decoded,desktopGeometry,narrowGeometry,sourceHashes,revision:(await read()).revision,artifacts};
  fs.writeFileSync(path.join(artifacts,'timeline-controls.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));clearTimeout(timeout);app.exit(0);
})().catch(async error=>{console.error(error);if(canvas){try{console.error(await canvas.executeJavaScript('JSON.stringify({selection:window.EaselVideoEditor?.getSelection(),status:document.querySelector("[data-role=status]")?.textContent,events:window.controlEvents?.slice(-12),focused:document.hasFocus()})'));fs.writeFileSync(path.join(artifacts,'failure.png'),(await canvas.capturePage()).toPNG());}catch{}}clearTimeout(timeout);app.exit(1);});
