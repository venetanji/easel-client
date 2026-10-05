const test = require('node:test');
const assert = require('node:assert/strict');
const { createVideoTimelineView, frameToPixels, pixelToFrame, getPreviewLayers, confirmTimelineTrackDeletion } = require('../src/video-timeline-view');

function element(tagName = 'div') {
  let text = '';
  const listeners = new Map();
  const node = {
    tagName: tagName.toUpperCase(), children: [], attributes: {}, dataset: {}, style: {}, value: '', hidden: false, disabled: false,
    currentTime: 0, duration: 8, readyState: 4, paused: true, volume: 1,
    get textContent() { return text + this.children.map((child) => child.textContent || '').join(''); },
    set textContent(value) { text = String(value); this.children = []; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; },
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } },
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; text = ''; this.append(...children); },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; },
    addEventListener(name, fn) { const all = listeners.get(name) || []; all.push(fn); listeners.set(name, all); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter((entry) => entry !== fn)); },
    async dispatchEvent(event) { event.target ||= this; event.currentTarget = this; event.preventDefault ||= () => {}; event.stopPropagation ||= () => {}; for (const fn of [...(listeners.get(event.type) || [])]) await fn(event); },
    contains(target) { return this === target || this.children.some(child => child.contains(target)); },
    showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 56 }; },
    focus() { if (this.disabled) return; this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; },
    setPointerCapture() {}, releasePointerCapture() {},
    load() {}, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
  };
  node.classList = { add(...names) { node.className = [...new Set([...(node.className || '').split(' '), ...names])].join(' '); }, remove(name) { node.className = (node.className || '').split(' ').filter((entry) => entry !== name).join(' '); }, toggle(name, active) { this[active ? 'add' : 'remove'](name); }, contains(name) { return (node.className || '').split(' ').includes(name); } };
  return node;
}
const clone = (value) => JSON.parse(JSON.stringify(value));
function timeline(id = 'timeline-a', revision = 1) {
  return { schemaVersion: 1, id, revision, frameRate: { numerator: 24, denominator: 1 }, width: 1920, height: 1080,
    tracks: [{ id: 'video-1', type: 'video', name: 'Video' }, { id: 'audio-1', type: 'audio', name: 'Audio' }, { id: 'overlay-1', type: 'overlay', name: 'Overlay' }],
    items: [{ id: 'clip-1', trackId: 'video-1', startFrame: 24, endFrame: 72, assetId: 'asset-video', sourceStartSeconds: 1, sourceEndSeconds: 3, sourceDurationSeconds: 8, name: 'Coast', gain: 0.5 }], transitions: [] };
}
function fixture({ initial = timeline(), assets = [{ id: 'asset-video', mimeType: 'video/mp4', name: 'Coast', duration: 8 }, { id: 'asset-image', mimeType: 'image/png', name: 'Title' }], overrides = {}, viewOptions = {} } = {}) {
  let stored = clone(initial);
  const calls = [], selections = [], statuses = [], urls = [], revoked = [];
  const frames = new Map(); let frameId = 0;
  const window = { URL: { createObjectURL() { const url = `blob:test-${urls.length}`; urls.push(url); return url; }, revokeObjectURL(url) { revoked.push(url); } }, Blob, atob, performance: { now: () => 0 }, requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); } };
  const document = { createElement(tag) { const node = element(tag); node.ownerDocument = document; return node; }, defaultView: window };
  const container = element();
  const client = {
    async readTimeline(projectId) { calls.push(['read', projectId]); return clone(stored); },
    async createTimeline(projectId) { calls.push(['create', projectId]); stored = timeline(); stored.items = []; return clone(stored); },
    async getTimelineHistory() { return { undoAvailable: true, redoAvailable: false }; },
    async getProjectAssets(projectId) { calls.push(['assets', projectId]); return { assets: clone(assets), nextOffset: null }; },
    async getProjectAsset(projectId, assetId) { calls.push(['asset', projectId, assetId]); return { data: 'YWJj', mimeType: assets.find((asset) => asset.id === assetId)?.mimeType || 'video/mp4' }; },
    async applyTimeline(projectId, input) {
      calls.push(['apply', projectId, clone(input)]);
      for (const operation of input.operations) {
        const item = stored.items.find((candidate) => candidate.id === operation.itemId);
        if (operation.type === 'insert') stored.items.push(clone(operation.item));
        if (operation.type === 'add-track') stored.tracks.push(clone(operation.track));
        if (operation.type === 'reorder-track') { const [track] = stored.tracks.splice(stored.tracks.findIndex(track => track.id === operation.trackId), 1); stored.tracks.splice(operation.index, 0, track); }
        if (operation.type === 'remove') stored.items = stored.items.filter((candidate) => candidate.id !== operation.itemId);
        if (operation.type === 'move') { item.endFrame += operation.startFrame - item.startFrame; item.startFrame = operation.startFrame; if (operation.trackId) item.trackId = operation.trackId; }
        if (operation.type === 'trim') Object.assign(item, Object.fromEntries(['startFrame', 'endFrame', 'sourceStartSeconds', 'sourceEndSeconds'].filter((key) => operation[key] !== undefined).map((key) => [key, operation[key]])));
        if (operation.type === 'set-audio-level') Object.assign(item, Object.fromEntries(['gain', 'fadeInFrames', 'fadeOutFrames'].filter((key) => operation[key] !== undefined).map((key) => [key, operation[key]])));
      }
      stored.revision += 1; return clone(stored);
    },
    async undoTimeline(projectId, input) { calls.push(['undo', projectId, input]); stored.revision += 1; return clone(stored); },
    async redoTimeline(projectId, input) { calls.push(['redo', projectId, input]); stored.revision += 1; return clone(stored); },
    ...overrides,
  };
  const view = createVideoTimelineView({ document, container, client, onSelection: (selection) => selections.push(selection), onStatus: (status) => statuses.push(status), ...viewOptions });
  const all = (predicate, node = container) => [node, ...node.children.flatMap((child) => all(predicate, child))].filter(predicate);
  const role = (name) => all((node) => node.dataset.role === name)[0];
  const item = (id) => all((node) => node.dataset.itemId === id)[0];
  const click = (node) => node.dispatchEvent({ type: 'click' });
  const change = (node, value) => { node.value = String(value); return node.dispatchEvent({ type: 'change' }); };
  return { view, container, document, window, role, item, all, click, change, client, calls, selections, statuses, urls, revoked, frames, setStored(value) { stored = clone(value); } };
}
const settle = () => new Promise(setImmediate);

test('converts rational-rate frame positions and previews half-open media spans', () => {
  const rate = { numerator: 30000, denominator: 1001 };
  assert.equal(frameToPixels(30000, rate, 72), 72072);
  assert.equal(pixelToFrame(72072, rate, 72), 30000);
  const doc = timeline(); doc.items[0].fadeInFrames = 24;
  assert.deepEqual(getPreviewLayers(doc, 23), []);
  assert.equal(getPreviewLayers(doc, 36)[0].sourceTime, 1.5);
  assert.equal(getPreviewLayers(doc, 36)[0].gain, 0.25);
  assert.deepEqual(getPreviewLayers(doc, 72), []);
});

test('opens a missing timeline with accessible track controls without inventing selection', async () => {
  const f = fixture({ initial: null }); await f.view.open('project-a');
  assert.ok(f.calls.some(([method]) => method === 'create'));
  assert.equal(f.view.getSelection(), null);
  assert.equal(f.role('play').textContent, 'Play');
  assert.equal(f.role('seek').getAttribute('aria-label'), 'Preview frame');
  assert.equal(f.all((node) => node.dataset.trackId && node.dataset.role === 'track-select').length, 3);
  assert.match(f.container.textContent, /Add clip/);
  assert.equal(f.role('redo').disabled, true);
});

test('clip selection preserves exact half-open coordinates and returns detached context', async () => {
  const f = fixture(); await f.view.open('project-a');
  assert.equal(f.item('clip-1').style.left, '72px');
  assert.equal(f.item('clip-1').style.width, '144px');
  await f.click(f.item('clip-1'));
  assert.deepEqual(f.view.getSelection(), { projectId: 'project-a', timelineId: 'timeline-a', timelineRevision: 1, trackIds: ['video-1'], itemIds: ['clip-1'], startFrame: 24, endFrame: 72 });
  const copy = f.view.getSelection(); copy.itemIds.push('bad');
  assert.deepEqual(f.view.getSelection().itemIds, ['clip-1']);
  assert.equal(f.item('clip-1').getAttribute('aria-pressed'), 'true');
});

test('explicit numeric range can select an empty gap on one track', async () => {
  const f = fixture(); await f.view.open('project-a');
  await f.change(f.role('range-start'), 0); await f.change(f.role('range-end'), 24); await f.change(f.role('range-track'), 'video-1');
  await f.click(f.role('select-range'));
  assert.deepEqual(f.view.getSelection().itemIds, []);
  assert.deepEqual(f.view.getSelection().trackIds, ['video-1']);
  assert.equal(f.view.getSelection().endFrame, 24);
  await f.change(f.role('range-end'), 0); await f.click(f.role('select-range'));
  assert.equal(f.view.getSelection().endFrame, 24, 'invalid edits must retain the last explicit valid selection');
  assert.match(f.role('status').textContent, /end.*after.*start/i);
});

test('refresh keeps user selection anchored to its original revision and marks it stale', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  f.setStored(timeline('timeline-a', 2)); await f.view.refresh();
  assert.equal(f.view.getSelection().timelineRevision, 1);
  assert.match(f.role('selection-summary').textContent, /changed|select again/i);
  f.view.clearSelection(); assert.equal(f.view.getSelection(), null);
});

test('a late project read cannot replace the newly opened project', async () => {
  let finish;
  const f = fixture({ overrides: { readTimeline(projectId) { return projectId === 'project-a' ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(timeline('timeline-b')); } } });
  const earlier = f.view.open('project-a'); await f.view.open('project-b'); finish(timeline('timeline-a')); await earlier;
  await f.click(f.item('clip-1'));
  assert.equal(f.view.getSelection().projectId, 'project-b'); assert.equal(f.view.getSelection().timelineId, 'timeline-b');
});

test('closing during a pending open prevents resurrection and disposes preview URLs', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.change(f.role('seek'), 36); await settle();
  assert.ok(f.urls.length); f.view.close();
  assert.equal(f.container.hidden, true); assert.deepEqual(f.revoked, f.urls);
  let finish; f.client.readTimeline = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.view.open('project-b'); f.view.close(); finish(timeline('timeline-b')); await pending;
  assert.equal(f.container.hidden, true); assert.equal(f.view.getSelection(), null);
});

test('adding project media commits a bounded source span at the chosen track end', async () => {
  const f = fixture(); await f.view.open('project-a');
  await f.change(f.role('add-asset'), 'asset-video'); await f.change(f.role('add-track'), 'video-1'); await f.click(f.role('add-clip'));
  const [, projectId, request] = f.calls.find(([method]) => method === 'apply');
  assert.equal(projectId, 'project-a'); assert.equal(request.expectedRevision, 1);
  const added = request.operations[0].item;
  assert.equal(added.startFrame, 72); assert.equal(added.endFrame, 264);
  assert.equal(added.sourceStartSeconds, 0); assert.equal(added.sourceEndSeconds, 8);
  assert.equal(f.view.getSelection(), null, 'adding media must not silently select a new target');
});

test('busy state blocks mutations even if a disabled control receives an event', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1')); f.view.setBusy(true);
  assert.equal(f.role('remove-clip').disabled, true); await f.click(f.role('remove-clip'));
  assert.equal(f.calls.some(([method]) => method === 'apply'), false);
  f.view.setBusy(false); await f.click(f.role('remove-clip'));
  assert.equal(f.calls.find(([method]) => method === 'apply')[2].operations[0].type, 'remove');
});

test('clip inspector saves trim, placement and audio in one revision-checked edit', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  await f.change(f.role('clip-start'), 48); await f.change(f.role('clip-end'), 72);
  await f.change(f.role('source-start'), 1); await f.change(f.role('source-end'), 2); await f.change(f.role('clip-gain'), 0.25);
  await f.click(f.role('save-clip'));
  const request = f.calls.find(([method]) => method === 'apply')[2];
  assert.equal(request.expectedRevision, 1);
  assert.ok(request.operations.some((op) => op.type === 'trim' && op.startFrame === 48 && op.sourceEndSeconds === 2));
  assert.ok(request.operations.some((op) => op.type === 'set-audio-level' && op.gain === 0.25));
});

test('late mutation responses do not switch back to an old project', async () => {
  let finish;
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  f.client.applyTimeline = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.click(f.role('remove-clip')); await f.view.open('project-b'); finish(timeline('old-project-result', 2)); await pending;
  await f.click(f.item('clip-1')); assert.equal(f.view.getSelection().projectId, 'project-b'); assert.equal(f.view.getSelection().timelineId, 'timeline-a');
});

test('preview seeks source timestamps and preserves per-clip audio gain', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.change(f.role('seek'), 36); await settle();
  const video = f.all((node) => node.tagName === 'VIDEO')[0];
  assert.ok(video); assert.equal(video.currentTime, 1.5); assert.equal(video.volume, 0.5); assert.equal(video.muted, false);
  await f.change(f.role('seek'), 72); assert.equal(f.all((node) => node.tagName === 'VIDEO').length, 0);
});

test('pending media is discarded after a project switch', async () => {
  let finish;
  const f = fixture({ overrides: { getProjectAsset() { return new Promise((resolve) => { finish = resolve; }); } } });
  await f.view.open('project-a'); await f.change(f.role('seek'), 36); await settle(); await f.view.open('project-b');
  finish({ data: 'YWJj', mimeType: 'video/mp4' }); await settle();
  assert.deepEqual(f.urls, []); assert.equal(f.all((node) => node.tagName === 'VIDEO').length, 0);
});

test('media read failures remain recoverable without corrupting the timeline', async () => {
  const f = fixture({ overrides: { async getProjectAsset() { throw new Error('Source is missing'); } } });
  await f.view.open('project-a'); await f.change(f.role('seek'), 36); await settle();
  assert.match(f.role('preview-status').textContent, /Source is missing/);
  assert.equal(f.role('retry-preview').hidden, false);
  f.client.getProjectAsset = async () => ({ data: 'YWJj', mimeType: 'video/mp4' }); await f.click(f.role('retry-preview')); await settle();
  assert.equal(f.all((node) => node.tagName === 'VIDEO').length, 1);
});

test('exports a frozen revision once, reports progress, and saves managed media', async () => {
  const f = fixture(); let exportInput;
  f.window.EaselVideoExport = { async exportVideoTimeline(input) { exportInput = input; input.onProgress({ phase: 'recording', progress: 0.5 }); assert.equal(f.role('add-clip').disabled, true); return { data: 'YWJj', mimeType: 'video/webm', name: 'Timeline.webm', width: 1920, height: 1080, duration: 3, codec: 'vp9', includesAudio: true }; } };
  f.client.saveTimelineExport = async (projectId, input) => { f.calls.push(['save-export', projectId, input]); return { assetId: 'exported-video', name: input.media.name }; };
  await f.view.open('project-a'); await f.click(f.role('export'));
  assert.equal(exportInput.timeline.revision, 1); assert.equal(typeof exportInput.getAsset, 'function');
  assert.equal(f.calls.filter(([method]) => method === 'save-export').length, 1);
  assert.equal(f.calls.find(([method]) => method === 'save-export')[2].expectedRevision, 1);
  assert.match(f.role('status').textContent, /saved.*Media|Media.*saved/i);
});

test('canceling export aborts processing and never saves a partial asset', async () => {
  const f = fixture(); let aborted = false;
  f.window.EaselVideoExport = { exportVideoTimeline({ signal }) { return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; const error = new Error('Canceled'); error.name = 'AbortError'; reject(error); })); } };
  f.client.saveTimelineExport = async () => { throw new Error('Partial export should never be saved'); };
  await f.view.open('project-a'); const pending = f.click(f.role('export')); await f.click(f.role('cancel-export')); await pending;
  assert.equal(aborted, true); assert.match(f.role('status').textContent, /canceled/i); assert.equal(f.role('export').disabled, false);
});

test('library media is attached explicitly before inserting and previewing it', async () => {
  const f = fixture();
  f.client.listAssets = async () => [{ id: 'library-video', name: 'Generated scene', mimeType: 'video/mp4', duration: 2 }];
  f.client.attachProjectAsset = async (projectId, assetId) => { f.calls.push(['attach', projectId, assetId]); };
  await f.view.open('project-a'); f.role('add-picker').open = true; await f.role('add-picker').dispatchEvent({ type: 'toggle' }); await f.change(f.role('add-asset'), 'library-video'); await f.click(f.role('add-clip'));
  const attachIndex = f.calls.findIndex(([method]) => method === 'attach'), applyIndex = f.calls.findIndex(([method]) => method === 'apply');
  assert.ok(attachIndex >= 0 && attachIndex < applyIndex);
  assert.equal(f.calls[applyIndex][2].operations[0].item.assetId, 'library-video');
});

test('media insertion is a compact disclosure outside a full-width preview', async () => {
  const f = fixture(); await f.view.open('project-a');
  const picker = f.role('add-picker');
  assert.ok(picker, 'Keyboard insertion remains available');
  assert.equal(picker.tagName, 'DETAILS'); assert.equal(picker.open, false);
  assert.equal(f.all(node => node.className === 'timeline-sidebar').length, 0);
  for (const role of ['media-source', 'media-filter', 'media-search', 'import-media']) assert.equal(f.role(role), undefined);
  const workbench = f.all(node => node.className === 'timeline-workbench')[0];
  assert.equal(workbench.children.length, 1);
  assert.equal(f.role('inspector').hidden, true);
  assert.equal(f.calls.some(([method]) => method === 'asset'), false);
});

test('keyboard picker merges project and library sources without duplicate IDs', async () => {
  const f = fixture(); f.client.listAssets = async () => [
    { id: 'asset-video', mimeType: 'video/mp4', name: 'Coast' },
    { id: 'new-image', mimeType: 'image/png', name: 'Generated still' },
  ];
  await f.view.open('project-a'); f.role('add-picker').open = true;
  await f.role('add-picker').dispatchEvent({ type: 'toggle' });
  assert.deepEqual(f.role('add-asset').children.map(node => node.value), ['asset-video', 'asset-image', 'new-image']);
  await f.change(f.role('add-asset'), 'asset-image'); await f.change(f.role('image-duration'), 2);
  await f.click(f.role('add-clip'));
  const item = f.calls.find(([method]) => method === 'apply')[2].operations[0].item;
  assert.equal(item.endFrame - item.startFrame, 48);
});

test('project media pagination reaches later files without repeating pages', async () => {
  const f = fixture({ overrides: { async getProjectAssets(_projectId, options = {}) { return options.offset ? { assets: [{ id: 'later', name: 'Later image', mimeType: 'image/png' }], nextOffset: null } : { assets: [{ id: 'first', name: 'First image', mimeType: 'image/png' }], nextOffset: 200 }; } } });
  await f.view.open('project-a'); assert.equal(f.role('add-asset').children.length, 2);
});

test('reverse track-range gestures preserve the exact right boundary', async () => {
  const f = fixture(); await f.view.open('project-a');
  const lane = f.all((node) => node.dataset.role === 'track-lane' && node.dataset.trackId === 'video-1')[0];
  await lane.dispatchEvent({ type: 'pointerdown', clientX: 72, pointerId: 1 }); await lane.dispatchEvent({ type: 'pointerup', clientX: 0, pointerId: 1 });
  assert.equal(f.view.getSelection().startFrame, 0); assert.equal(f.view.getSelection().endFrame, 24);
});

test('missing-duration inserts are serialized while native metadata is read', async () => {
  let finish; const f = fixture({ assets: [{ id: 'asset-video', name: 'Unknown length', mimeType: 'video/mp4' }], overrides: { getProjectAsset() { return new Promise((resolve) => { finish = resolve; }); } } });
  await f.view.open('project-a'); const first = f.click(f.role('add-clip')); const second = f.click(f.role('add-clip')); await settle();
  finish({ data: 'YWJj', mimeType: 'video/mp4' }); await Promise.all([first, second]);
  assert.equal(f.calls.filter(([method]) => method === 'apply').length, 1);
});

test('template mode does not expose a close action that would strand the editor', async () => {
  const f = fixture(); await f.view.open('project-a'); assert.equal(f.role('close').hidden, true);
});

test('audio gain greater than unity is rejected before mutation', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1')); await f.change(f.role('clip-gain'), 1.5); await f.click(f.role('save-clip'));
  assert.equal(f.calls.some(([method]) => method === 'apply'), false); assert.match(f.role('status').textContent, /0 to 1/);
});

test('closing cancels an in-flight export without saving its result', async () => {
  const f = fixture(); let signal, finish;
  f.window.EaselVideoExport = { exportVideoTimeline(input) { signal = input.signal; return new Promise((resolve) => { finish = resolve; }); } };
  f.client.saveTimelineExport = async () => { f.calls.push(['save-export']); };
  await f.view.open('project-a'); const pending = f.click(f.role('export')); f.view.close(); finish({ data: 'YWJj', mimeType: 'video/webm' }); await pending;
  assert.equal(signal.aborted, true); assert.equal(f.calls.some(([method]) => method === 'save-export'), false);
});

test('refresh picks up media imported through the existing app drawer', async () => {
  const f = fixture(); await f.view.open('project-a');
  f.client.getProjectAssets = async () => ({ assets: [{ id: 'new-asset', name: 'New recording', mimeType: 'video/webm', duration: 1 }], nextOffset: null });
  await f.click(f.role('refresh'));
  assert.equal(f.role('add-asset').children[0].value, 'new-asset');
});

test('visual overlay videos stay silent and expose no audio edits', async () => {
  const initial = timeline(); initial.items[0].trackId = 'overlay-1'; delete initial.items[0].gain;
  const f = fixture({ initial }); await f.view.open('project-a'); await f.click(f.item('clip-1')); await settle();
  assert.equal(f.role('clip-gain'), undefined);
  assert.equal(f.all((node) => node.tagName === 'VIDEO')[0].volume, 0);
  await f.click(f.role('save-clip')); assert.equal(f.calls.find(([method]) => method === 'apply')[2].operations.some((op) => op.type === 'set-audio-level'), false);
});

test('opening clears the external loading status when timeline is ready', async () => {
  const f = fixture(); await f.view.open('project-a'); assert.equal(f.statuses.at(-1), '');
});

test('selecting a clip reveals contextual timing and audio without moving the picker', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  assert.equal(f.role('inspector').hidden, false);
  assert.equal(f.role('inspector').tagName, 'DETAILS');
  assert.equal(f.role('inspector').parentNode.children[0], f.role('add-picker'));
});

test('long filenames remain unchanged in media but clip names fit the timeline contract', async () => {
  const name = 'a'.repeat(156) + '.mp4'; const f = fixture({ assets: [{ id: 'asset-video', name, mimeType: 'video/mp4', duration: 2 }] });
  await f.view.open('project-a'); await f.click(f.role('add-clip'));
  assert.equal(f.calls.find(([method]) => method === 'apply')[2].operations[0].item.name.length, 120);
  assert.equal(f.role('add-asset').children[0].textContent, name);
});

test('filename truncation does not split a Unicode surrogate pair', async () => {
  const f = fixture({ assets: [{ id: 'asset-video', name: 'a'.repeat(119) + '😀.mp4', mimeType: 'video/mp4', duration: 2 }] });
  await f.view.open('project-a'); await f.click(f.role('add-clip'));
  assert.equal(f.calls.find(([method]) => method === 'apply')[2].operations[0].item.name, 'a'.repeat(119));
});

test('long timelines bound ruler label nodes while keeping exact clip positions', async () => {
  const initial = timeline(); initial.items[0].endFrame = 24 * 3600;
  const f = fixture({ initial }); await f.view.open('project-a');
  assert.ok(f.all((node) => node.className === 'timeline-ruler-tick').length <= 501);
  assert.equal(f.item('clip-1').style.left, '72px');
});

test('preview serializes source-byte reads to bound transient memory', async () => {
  const initial = timeline(); initial.items.push({ ...initial.items[0], id: 'music', trackId: 'audio-1', assetId: 'asset-music' });
  const pending = []; let reading = 0, highWater = 0;
  const f = fixture({ initial, overrides: { getProjectAsset() { reading++; highWater = Math.max(highWater, reading); return new Promise((resolve) => pending.push(() => { reading--; resolve({ data: 'YWJj', mimeType: 'audio/wav' }); })); } } });
  await f.view.open('project-a'); await f.change(f.role('seek'), 36); await settle();
  const firstWave = highWater; pending.shift()(); await settle(); while(pending.length) { pending.shift()(); await settle(); }
  assert.equal(firstWave, 1); assert.equal(highWater, 1); f.view.destroy();
});

test('add-media destinations match video, audio and image track compatibility', async () => {
  const assets = [
    { id: 'asset-video', name: 'Video', mimeType: 'video/mp4', duration: 2 },
    { id: 'asset-audio', name: 'Audio', mimeType: 'audio/wav', duration: 2 },
    { id: 'asset-image', name: 'Image', mimeType: 'image/png' },
  ];
  const f = fixture({ assets }); await f.view.open('project-a');
  const destinations = () => f.role('add-track').children.map((entry) => entry.value);
  await f.change(f.role('add-asset'), 'asset-video'); assert.deepEqual(destinations(), ['video-1']);
  await f.change(f.role('add-asset'), 'asset-audio'); assert.deepEqual(destinations(), ['audio-1']);
  await f.change(f.role('add-asset'), 'asset-image'); assert.deepEqual(destinations(), ['video-1', 'overlay-1']);
});

// Optional native geometry regression. Run with EASEL_UI_TEST_DISPLAY pointing at
// an available X display; the normal node suite does not launch a desktop.
test('browser preview frame preserves output geometry at desktop and narrow sizes', { skip: !process.env.EASEL_UI_TEST_DISPLAY }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-timeline-geometry-'));
  const artifacts = process.env.EASEL_UI_ARTIFACT_DIR || directory;
  fs.mkdirSync(artifacts, { recursive: true });
  const fixtureDocument = timeline(); fixtureDocument.items[0].startFrame = 0; fixtureDocument.items[0].endFrame = 72;
  function initializeFixture(initial) {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 32;
    const context = canvas.getContext('2d'); context.fillStyle = '#efbf35'; context.fillRect(0, 0, 96, 32);
    const data = canvas.toDataURL('image/png').split(',')[1];
    const client = {
      readTimeline: async () => initial,
      getProjectAssets: async () => ({ assets: [{ id: 'asset-video', name: 'Wide yellow image', mimeType: 'image/png' }], nextOffset: null }),
      getProjectAsset: async () => ({ data, mimeType: 'image/png' }),
    };
    window.editor = createVideoTimelineView({ document, container: document.getElementById('editor'), client });
    window.editor.open('project-a').then(() => { document.querySelector('[data-item-id="clip-1"]').click(); });
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{font-family:"Segoe UI",sans-serif;--paper:#fbfaf6;--paper-deep:#f3f2eb;--line:#d4d9d0;--muted:#58675f;--ink:#202d27;--green:#174d3a;--coral:#b84e38}*{box-sizing:border-box}html,body,#editor{width:100%;height:100%;margin:0}button,input,select{font:inherit}button{padding:5px 9px;border:1px solid #d4d9d0;border-radius:6px;background:#fbfaf6}button:disabled{opacity:.55}
    ${fs.readFileSync(path.join(__dirname, '../src/video-timeline.css'), 'utf8')}</style></head><body><main id="editor"></main><script>${fs.readFileSync(path.join(__dirname, '../src/video-timeline-view.js'), 'utf8')}\n(${initializeFixture.toString()})(${JSON.stringify(fixtureDocument)});</script></body></html>`;
  fs.writeFileSync(path.join(directory, 'index.html'), html);
  fs.writeFileSync(path.join(directory, 'native.cjs'), `
    const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.disableHardwareAcceleration();
    app.whenReady().then(async()=>{const window=new BrowserWindow({width:1100,height:820,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});const run=s=>window.webContents.executeJavaScript(s);await window.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});
    await run(\`new Promise((resolve,reject)=>{let n=0;const id=setInterval(()=>{if(document.querySelector('.timeline-preview-layer')?.complete){clearInterval(id);resolve()}else if(n++>100){clearInterval(id);reject(new Error('Fixture did not load'))}},20)})\`);
    const measure=async()=>run(\`(()=>{const stage=document.querySelector('[data-role="preview-stage"]').getBoundingClientRect();const preview=document.querySelector('.timeline-preview').getBoundingClientRect();const tracks=document.querySelector('[data-role="tracks-viewport"]').getBoundingClientRect();const image=document.querySelector('.timeline-preview-layer');return {frame:{width:stage.width,height:stage.height,left:stage.left,top:stage.top,right:stage.right,bottom:stage.bottom},preview:{left:preview.left,top:preview.top,right:preview.right,bottom:preview.bottom},tracksBottom:tracks.bottom,viewportHeight:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,imageFit:getComputedStyle(image).objectFit,imageWidth:image.naturalWidth,imageHeight:image.naturalHeight}})()\`);
    const desktop=await measure();fs.writeFileSync(${JSON.stringify(path.join(artifacts, 'desktop.png'))},(await window.webContents.capturePage()).toPNG());
    window.setSize(600,850);await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const narrow=await measure();fs.writeFileSync(${JSON.stringify(path.join(artifacts, 'narrow.png'))},(await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(${JSON.stringify(path.join(directory, 'result.json'))},JSON.stringify({desktop,narrow}));window.destroy();app.quit();}).catch(error=>{console.error(error);app.exit(1)});
  `);
  try {
    await promisify(execFile)(require('electron'), ['--no-sandbox', '--ozone-platform=x11', path.join(directory, 'native.cjs')], { timeout: 25000, env: { ...process.env, DISPLAY: process.env.EASEL_UI_TEST_DISPLAY, HOME: directory, XDG_CONFIG_HOME: directory } });
    const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
    fs.writeFileSync(path.join(artifacts, 'geometry.json'), JSON.stringify(result, null, 2));
    for (const [size, geometry] of Object.entries(result)) {
      assert.ok(Math.abs(geometry.frame.width / geometry.frame.height - fixtureDocument.width / fixtureDocument.height) < 0.005, `${size}: preview frame ${geometry.frame.width}×${geometry.frame.height} must preserve ${fixtureDocument.width}:${fixtureDocument.height}`);
      assert.ok(geometry.frame.left >= geometry.preview.left && geometry.frame.right <= geometry.preview.right && geometry.frame.top >= geometry.preview.top && geometry.frame.bottom <= geometry.preview.bottom, `${size}: output frame must fit inside preview`);
      assert.ok(geometry.tracksBottom <= geometry.viewportHeight + 1, `${size}: all timeline tracks remain visible`);
      assert.equal(geometry.overflow, false); assert.equal(geometry.imageFit, 'contain');
      assert.equal(geometry.imageWidth, 96); assert.equal(geometry.imageHeight, 32);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function laneFor(f, trackId = 'video-1') { return f.all((node) => node.dataset.role === 'track-lane' && node.dataset.trackId === trackId)[0]; }
function handleFor(f, edge = 'end', trackId = 'video-1') { return f.all((node) => node.dataset.role === `range-${edge}-handle` && node.dataset.trackId === trackId)[0]; }
function mediaTransfer(assetId, extra = {}) { return { types: ['application/x-easel-media-asset'], dropEffect: 'none', getData: () => JSON.stringify({ assetId, ...extra }) }; }

test('selection exposes visible named boundary handles with frame precision keyboard adjustment', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  const start = handleFor(f, 'start'), end = handleFor(f);
  assert.ok(start && end, 'selection needs two visible adjustable handles');
  assert.equal(start.hidden, false); assert.match(start.getAttribute('aria-label'), /selection start/i);
  assert.equal(start.getAttribute('aria-valuenow'), '24');
  await end.dispatchEvent({ type: 'keydown', key: 'ArrowRight' }); assert.equal(f.view.getSelection().endFrame, 73);
  await start.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', shiftKey: true }); assert.equal(f.view.getSelection().startFrame, 14);
  await start.dispatchEvent({ type: 'keydown', key: 'Home' }); assert.equal(f.view.getSelection().startFrame, 0);
  assert.equal(f.calls.some(([method]) => method === 'apply'), false, 'selection must never trim media');
});

test('range drags preview continuously, commit once, and cancel without changing attached context', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  const end = handleFor(f); assert.ok(end, 'drag handle exists'); const before = f.selections.length;
  await end.dispatchEvent({ type: 'pointerdown', clientX: 216, pointerId: 7 });
  await end.dispatchEvent({ type: 'pointermove', clientX: 288, pointerId: 7 });
  assert.equal(f.role('range-end').value, '96'); assert.equal(f.selections.length, before);
  await end.dispatchEvent({ type: 'pointercancel', pointerId: 7 });
  assert.equal(f.view.getSelection().endFrame, 72); assert.equal(f.selections.length, before);
  await end.dispatchEvent({ type: 'pointerdown', clientX: 216, pointerId: 8 });
  await end.dispatchEvent({ type: 'pointerup', clientX: 270, pointerId: 8 });
  assert.equal(f.view.getSelection().endFrame, 90); assert.equal(f.selections.length, before + 1);
});

test('empty-lane selection is visible during a gesture and stays within its lane', async () => {
  const f = fixture(); await f.view.open('project-a'); const lane = laneFor(f);
  await lane.dispatchEvent({ type: 'pointerdown', clientX: 72, pointerId: 2 });
  await lane.dispatchEvent({ type: 'pointermove', clientX: 144, pointerId: 2 });
  assert.equal(lane.children.find(node=>node.dataset.role==='range-highlight').hidden, false); assert.equal(f.role('range-end').value, '48');
  await lane.dispatchEvent({ type: 'pointerup', clientX: 1e12, pointerId: 2 });
  assert.equal(f.view.getSelection().endFrame, 192);
});

test('stale ranges cannot be adjusted into a fresh revision by keyboard or pointer', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  f.setStored(timeline('timeline-a', 2)); await f.view.refresh(); const handle = handleFor(f); assert.ok(handle);
  assert.equal(handle.disabled, true); await handle.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
  assert.equal(f.view.getSelection().timelineRevision, 1); assert.equal(f.view.getSelection().endFrame, 72);
});

test('media drops insert a managed source at the pointed frame with expected revision', async () => {
  const id = 'a'.repeat(32); const f = fixture({ assets: [{ id, mimeType: 'image/png', name: 'Card' }] }); await f.view.open('project-a');
  const lane = laneFor(f, 'overlay-1'), dataTransfer = mediaTransfer(id);
  await lane.dispatchEvent({ type: 'dragover', clientX: 108, dataTransfer });
  assert.equal(dataTransfer.dropEffect, 'copy'); assert.equal(lane.dataset.dropState, 'ready');
  await lane.dispatchEvent({ type: 'drop', clientX: 108, dataTransfer });
  const request = f.calls.find(([method]) => method === 'apply')?.[2]; assert.ok(request, 'drop inserts a clip');
  assert.equal(request.expectedRevision, 1); assert.equal(request.operations[0].item.startFrame, 36); assert.equal(request.operations[0].item.assetId, id);
});

test('drop rejects external files, path-bearing payloads and incompatible media without attachment', async () => {
  const id = 'a'.repeat(32); const f = fixture({ assets: [{ id, mimeType: 'video/mp4', name: 'Video', duration: 2 }] }); await f.view.open('project-a');
  const lane = laneFor(f, 'audio-1');
  await lane.dispatchEvent({ type: 'drop', clientX: 0, dataTransfer: mediaTransfer(id) });
  assert.match(f.role('status').textContent, /compatible|video track/i);
  await lane.dispatchEvent({ type: 'drop', clientX: 0, dataTransfer: mediaTransfer(id, { path: '/private/source.mp4' }) });
  assert.match(f.role('status').textContent, /managed|payload/i);
  await lane.dispatchEvent({ type: 'drop', clientX: 0, dataTransfer: { types: ['Files'], getData: () => '' } });
  assert.equal(f.calls.some(([method]) => ['apply', 'attach'].includes(method)), false);
});

test('library drop attaches only after compatibility checks and refuses stale async results', async () => {
  const id = 'b'.repeat(64); let finish;
  const f = fixture({ overrides: { listAssets: () => new Promise((resolve) => { finish = resolve; }), attachProjectAsset: async (...args) => f.calls.push(['attach', ...args]) } });
  await f.view.open('project-a'); const lane = laneFor(f, 'overlay-1');
  const drop = lane.dispatchEvent({ type: 'drop', clientX: 0, dataTransfer: mediaTransfer(id) }); await settle();
  await f.view.open('project-b'); finish([{ id, mimeType: 'image/png', name: 'Library' }]); await drop;
  assert.equal(f.calls.some(([method]) => ['apply', 'attach'].includes(method)), false);
});

test('media drop rejects non-string asset IDs and overlapping placement', async () => {
  const id = 'a'.repeat(32); const f = fixture({ assets: [{ id, mimeType: 'video/mp4', duration: 2 }] }); await f.view.open('project-a'); const lane = laneFor(f);
  await lane.dispatchEvent({ type: 'drop', clientX: 72, dataTransfer: mediaTransfer([id]) });
  assert.match(f.role('status').textContent, /payload/);
  await lane.dispatchEvent({ type: 'drop', clientX: 72, dataTransfer: mediaTransfer(id) });
  assert.match(f.role('status').textContent, /overlaps/);
  assert.equal(f.calls.some(([method]) => method === 'apply'), false);
});

test('drag escape restores the original range and project navigation cancels the gesture', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1')); const end = handleFor(f); const before = f.selections.length;
  await end.dispatchEvent({ type: 'pointerdown', clientX: 216, pointerId: 1 }); await end.dispatchEvent({ type: 'pointermove', clientX: 300, pointerId: 1 });
  await f.container.children[0].dispatchEvent({ type: 'keydown', key: 'Escape', target: end });
  assert.equal(f.view.getSelection().endFrame, 72); assert.equal(f.selections.length, before);
  await end.dispatchEvent({ type: 'pointerdown', clientX: 216, pointerId: 1 }); await f.view.open('project-b');
  await end.dispatchEvent({ type: 'pointerup', clientX: 300, pointerId: 1 }); assert.equal(f.view.getSelection(), null);
});

test('library media drop attaches then inserts once and repeated drops stay serialized', async () => {
  const id = 'b'.repeat(64); let finish; let attached = false;
  const f = fixture({ overrides: {
    listAssets: () => new Promise((resolve) => { finish = resolve; }),
    attachProjectAsset: async (_projectId, assetId) => { f.calls.push(['attach', assetId]); attached = true; },
    getProjectAssets: async () => ({ assets: attached ? [{ id, mimeType: 'image/png', name: 'Library image' }] : [], nextOffset: null }),
  } });
  await f.view.open('project-a'); const lane = laneFor(f, 'overlay-1');
  const first = lane.dispatchEvent({ type: 'drop', clientX: 36, dataTransfer: mediaTransfer(id) }); await settle();
  await lane.dispatchEvent({ type: 'drop', clientX: 36, dataTransfer: mediaTransfer(id) }); finish([{ id, mimeType: 'image/png', name: 'Library image' }]); await first;
  assert.equal(f.calls.filter(([method]) => method === 'attach').length, 1);
  const apply = f.calls.filter(([method]) => method === 'apply'); assert.equal(apply.length, 1); assert.equal(apply[0][2].operations[0].item.startFrame, 12);
});

test('a revised timeline rejects an old drop target instead of silently using the new revision', async () => {
  const id = 'a'.repeat(32); const f = fixture({ assets: [{ id, mimeType: 'image/png' }] }); await f.view.open('project-a'); const oldLane = laneFor(f, 'overlay-1');
  await oldLane.dispatchEvent({ type: 'dragover', clientX: 0, dataTransfer: mediaTransfer(id) }); f.setStored(timeline('timeline-a', 2)); await f.view.refresh();
  await oldLane.dispatchEvent({ type: 'dragleave', relatedTarget: null });
  await laneFor(f, 'overlay-1').dispatchEvent({ type: 'dragover', clientX: 0, dataTransfer: mediaTransfer(id) });
  await laneFor(f, 'overlay-1').dispatchEvent({ type: 'drop', clientX: 0, dataTransfer: mediaTransfer(id) });
  assert.match(f.role('status').textContent, /changed during the drag/); assert.equal(f.calls.some(([method]) => method === 'apply'), false);
});

test('range handles preserve the grab offset without jumping on a wide hit target', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1')); const end = handleFor(f);
  await end.dispatchEvent({ type: 'pointerdown', clientX: 210, pointerId: 1 });
  await end.dispatchEvent({ type: 'pointerup', clientX: 213, pointerId: 1 });
  assert.equal(f.view.getSelection().endFrame, 73, 'a three-pixel move adds one frame regardless of where the handle was grabbed');
});

test('an unchanged refresh re-enables current selection handles and busy state disables them', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1')); await f.view.refresh();
  assert.equal(handleFor(f).disabled, false, 'loading must release the handle when the revision stayed current');
  f.view.setBusy(true); assert.equal(handleFor(f).disabled, true);
  f.view.setBusy(false); assert.equal(handleFor(f).disabled, false);
});

test('canceling a cross-track gesture restores the exact range controls for the next selection', async () => {
  const f = fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1')); const lane = laneFor(f, 'audio-1');
  await lane.dispatchEvent({ type: 'pointerdown', clientX: 0, pointerId: 9 });
  await lane.dispatchEvent({ type: 'pointermove', clientX: 72, pointerId: 9 });
  await lane.dispatchEvent({ type: 'pointercancel', pointerId: 9 });
  assert.equal(f.role('range-track').value, 'video-1');
  await f.click(f.role('select-range')); assert.deepEqual(f.view.getSelection().trackIds, ['video-1']);
  f.view.clearSelection(); await f.change(f.role('range-start'), 5); await f.change(f.role('range-end'), 15); await f.change(f.role('range-track'), 'overlay-1');
  await lane.dispatchEvent({ type: 'pointerdown', clientX: 0, pointerId: 10 }); await lane.dispatchEvent({ type: 'pointercancel', pointerId: 10 });
  assert.equal(f.view.getSelection(), null); assert.equal(f.role('range-start').value, '5'); assert.equal(f.role('range-end').value, '15'); assert.equal(f.role('range-track').value, 'overlay-1');
});

test('leaving the timeline clears drag feedback and lets a new drag use the refreshed revision', async () => {
  const id = 'a'.repeat(32); const f = fixture({ assets: [{ id, mimeType: 'image/png' }] }); await f.view.open('project-a'); const lane = laneFor(f, 'overlay-1');
  await lane.dispatchEvent({ type: 'dragover', clientX: 0, dataTransfer: mediaTransfer(id) });
  await f.role('tracks-viewport').dispatchEvent({ type: 'dragleave', clientX: -1, clientY: 10 });
  assert.equal(lane.dataset.dropState, '');
  f.setStored(timeline('timeline-a', 2)); await f.view.refresh(); const freshLane = laneFor(f, 'overlay-1');
  await freshLane.dispatchEvent({ type: 'dragover', clientX: 0, dataTransfer: mediaTransfer(id) });
  await freshLane.dispatchEvent({ type: 'drop', clientX: 0, dataTransfer: mediaTransfer(id) });
  assert.equal(f.calls.find(([method]) => method === 'apply')[2].expectedRevision, 2);
});

function laneGeometry(f) {
  const lanes = f.all(node => node.dataset.role === 'track-lane');
  lanes.forEach((lane, index) => { lane.getBoundingClientRect = () => ({left: 0, top: index * 72, width: 960, height: 72}); });
  return lanes;
}
async function pointer(node, type, x, y, extra = {}) { await node.dispatchEvent({type, pointerId: 7, button: 0, clientX: x, clientY: y, ...extra}); }

test('clip body drag moves its time once with source span unchanged', async () => {
  const f = fixture(); await f.view.open('project-a');
  const clip = f.item('clip-1');
  await pointer(clip, 'pointerdown', 100); await pointer(clip, 'pointermove', 136); await pointer(clip, 'pointerup', 136);
  const mutations = f.calls.filter(([method]) => method === 'apply');
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0][2], {expectedRevision:1, operations:[{type:'move', itemId:'clip-1', trackId:'video-1', startFrame:36}]});
  assert.equal(f.item('clip-1').style.left, '108px');
});

test('clip moves across compatible tracks but rejects audio destinations and overlaps', async () => {
  const doc = timeline(); doc.tracks.push({id:'video-2',type:'video',name:'Video 2'});
  const f = fixture({initial:doc}); await f.view.open('project-a');
  let lanes = laneGeometry(f), clip = f.item('clip-1');
  let destination = lanes.find(node => node.dataset.trackId === 'video-2').getBoundingClientRect();
  await pointer(clip,'pointerdown',100,230); await pointer(clip,'pointermove',136,destination.top+30); await pointer(clip,'pointerup',136,destination.top+30);
  assert.equal(f.calls.find(([method]) => method === 'apply')?.[2].operations[0].trackId,'video-2');
  lanes = laneGeometry(f); clip = f.item('clip-1'); destination = lanes.find(node=>node.dataset.trackId==='audio-1').getBoundingClientRect();
  await pointer(clip,'pointerdown',130,30); await pointer(clip,'pointermove',150,destination.top+30); await pointer(clip,'pointerup',150,destination.top+30);
  assert.equal(f.calls.filter(([method])=>method==='apply').length,1);
  assert.match(f.role('status').textContent,/compatible/i);
});

test('clip trim changes source in proportion to its frame edge, with source bounds', async () => {
  const f = fixture(); await f.view.open('project-a');
  const handle = f.all(node=>node.dataset.role==='clip-trim-start')[0]; assert.ok(handle,'A clip has its own trim grip');
  await pointer(handle,'pointerdown',72); await pointer(handle,'pointermove',108); await pointer(handle,'pointerup',108);
  assert.deepEqual(f.calls.find(([method])=>method==='apply')[2].operations[0], {type:'trim',itemId:'clip-1',startFrame:36,endFrame:72,sourceStartSeconds:1.5,sourceEndSeconds:3});
});

test('Escape and stale refresh cancel pending clip moves without writes', async () => {
  const f = fixture(); await f.view.open('project-a'); let clip = f.item('clip-1');
  await pointer(clip,'pointerdown',100); await pointer(clip,'pointermove',136);
  await f.container.children[0].dispatchEvent({type:'keydown',key:'Escape',target:clip});
  await pointer(clip,'pointerup',136); assert.equal(f.calls.some(([method])=>method==='apply'),false);
  clip = f.item('clip-1'); await pointer(clip,'pointerdown',100); await pointer(clip,'pointermove',136);
  f.setStored(timeline('timeline-a',2)); await f.view.refresh(); await pointer(clip,'pointerup',136);
  assert.equal(f.calls.some(([method])=>method==='apply'),false);
});

test('ruler seeks and Space starts playback at the chosen frame', async () => {
  const f = fixture(); await f.view.open('project-a'); const ruler = f.role('ruler'); assert.ok(ruler,'A focusable timeline ruler is present');
  await pointer(ruler,'pointerdown',150); await pointer(ruler,'pointerup',150);
  assert.equal(f.role('seek').value,'50'); assert.equal(ruler.focused,true);
  await f.container.children[0].dispatchEvent({type:'keydown',key:' ',target:ruler});
  assert.equal(f.role('play').textContent,'Pause'); assert.equal(f.role('seek').value,'50');
  await f.container.children[0].dispatchEvent({type:'keydown',key:' ',target:ruler}); assert.equal(f.role('play').textContent,'Play');
});

test('range drag spans the crossed tracks and exact inputs are secondary', async () => {
  const f = fixture(); await f.view.open('project-a'); const lanes=laneGeometry(f); const first=lanes[0],last=lanes[2];
  await pointer(first,'pointerdown',0,30); await pointer(first,'pointermove',60,174); await pointer(first,'pointerup',60,174);
  assert.deepEqual(f.view.getSelection().trackIds,lanes.map(node=>node.dataset.trackId));
  assert.equal(f.view.getSelection().startFrame,0); assert.equal(f.view.getSelection().endFrame,20);
  assert.equal(f.role('range-start').parentNode.parentNode.parentNode.tagName,'DETAILS');
  assert.equal(f.role('range-start').parentNode.parentNode.parentNode.open,false);
});

test('adding and reordering tracks makes the first visible row the top preview layer', async () => {
  const f=fixture(); await f.view.open('project-a'); const add=f.role('add-video-track'); assert.ok(add,'Video tracks can be added');
  await f.click(add);
  const request=f.calls.find(([method])=>method==='apply')[2]; assert.equal(request.operations[0].type,'add-track'); assert.equal(request.operations[0].track.type,'video');
  const trackId=request.operations[0].track.id;
  assert.equal(f.all(node=>node.dataset.role==='track-lane')[0].dataset.trackId,trackId);
  const down=f.all(node=>node.dataset.role==='track-down'&&node.dataset.trackId===trackId)[0]; assert.ok(down); await f.click(down);
  assert.deepEqual(f.calls.filter(([method])=>method==='apply')[1][2].operations,[{type:'reorder-track',trackId,index:2}]);
});

test('Alt drag shifts the selected range over clips without editing clips', async () => {
  const f=fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  const clip=f.item('clip-1'); await pointer(clip,'pointerdown',120,undefined,{altKey:true}); await pointer(clip,'pointermove',156,undefined,{altKey:true}); await pointer(clip,'pointerup',156,undefined,{altKey:true});
  assert.equal(f.view.getSelection().startFrame,36); assert.equal(f.view.getSelection().endFrame,84);
  assert.equal(f.calls.some(([method])=>method==='apply'),false);
});

test('clip snapping finds adjacent edges and Shift bypasses it', async () => {
  const doc=timeline(); doc.items.push({...doc.items[0],id:'clip-2',startFrame:120,endFrame:144});
  const f=fixture({initial:doc}); await f.view.open('project-a');
  let clip=f.item('clip-1'); await pointer(clip,'pointerdown',100); await pointer(clip,'pointermove',241); await pointer(clip,'pointerup',241);
  assert.equal(f.calls.find(([method])=>method==='apply')[2].operations[0].startFrame,72,'snap moving end to frame 120');
  clip=f.item('clip-1'); await pointer(clip,'pointerdown',240); await pointer(clip,'pointermove',237,undefined,{shiftKey:true}); await pointer(clip,'pointerup',237,undefined,{shiftKey:true});
  assert.equal(f.calls.filter(([method])=>method==='apply')[1][2].operations[0].startFrame,71);
});

test('overlap rejection and trim source bounds protect saved media', async () => {
  const doc=timeline(); doc.items.push({...doc.items[0],id:'clip-2',startFrame:80,endFrame:104});
  const f=fixture({initial:doc}); await f.view.open('project-a');
  const clip=f.item('clip-1'); await pointer(clip,'pointerdown',100); await pointer(clip,'pointermove',142); await pointer(clip,'pointerup',142);
  assert.equal(f.calls.some(([method])=>method==='apply'),false); assert.match(f.role('status').textContent,/overlap/i);
  const trim=f.all(node=>node.dataset.role==='clip-trim-start'&&node.dataset.clipId==='clip-1')[0];
  await pointer(trim,'pointerdown',72); await pointer(trim,'pointermove',-300); await pointer(trim,'pointerup',-300);
  const op=f.calls.find(([method])=>method==='apply')[2].operations[0]; assert.equal(op.startFrame,0); assert.equal(op.sourceStartSeconds,0);
});

test('dragging a track header reorders its whole layer and Escape cancels reorder', async () => {
  const f=fixture(); await f.view.open('project-a'); laneGeometry(f);
  let header=f.all(node=>node.dataset.role==='track-select'&&node.dataset.trackId==='video-1')[0];
  await pointer(header,'pointerdown',20,174); await pointer(header,'pointermove',20,30); await pointer(header,'pointerup',20,30);
  assert.deepEqual(f.calls.find(([method])=>method==='apply')[2].operations,[{type:'reorder-track',trackId:'video-1',index:2}]);
  laneGeometry(f); header=f.all(node=>node.dataset.role==='track-select'&&node.dataset.trackId==='video-1')[0];
  await pointer(header,'pointerdown',20,30); await pointer(header,'pointermove',20,174); await f.container.children[0].dispatchEvent({type:'keydown',key:'Escape'}); await pointer(header,'pointerup',20,174);
  assert.equal(f.calls.filter(([method])=>method==='apply').length,1);
});

test('keyboard clip movement and trimming commit single-frame edits', async () => {
  const f=fixture(); await f.view.open('project-a');
  await f.item('clip-1').dispatchEvent({type:'keydown',key:'ArrowRight'});
  assert.equal(f.calls.find(([method])=>method==='apply')[2].operations[0].startFrame,25);
  await f.all(node=>node.dataset.role==='clip-trim-end')[0].dispatchEvent({type:'keydown',key:'ArrowLeft',shiftKey:true});
  const op=f.calls.filter(([method])=>method==='apply')[1][2].operations[0]; assert.equal(op.endFrame,63); assert.equal(op.sourceEndSeconds,3-10/24);
});

test('a canceled moved clip does not turn the trailing pointer click into a new selection', async () => {
  const f=fixture(); await f.view.open('project-a'); const clip=f.item('clip-1');
  await pointer(clip,'pointerdown',100); await pointer(clip,'pointermove',136); await f.container.children[0].dispatchEvent({type:'keydown',key:'Escape'}); await pointer(clip,'pointerup',136); await f.click(clip);
  assert.equal(f.view.getSelection(),null); assert.equal(f.calls.some(([method])=>method==='apply'),false);
});

test('no-op clip keyboard edits at source bounds do not create undo entries', async () => {
  const doc=timeline(); doc.items[0].startFrame=0; doc.items[0].endFrame=48;
  const f=fixture({initial:doc}); await f.view.open('project-a'); await f.item('clip-1').dispatchEvent({type:'keydown',key:'ArrowLeft'});
  assert.equal(f.calls.some(([method])=>method==='apply'),false);
});


test('keyboard focus survives clip mutations for repeated frame nudges', async () => {
  const f=fixture(); await f.view.open('project-a'); f.item('clip-1').focus();
  await f.document.activeElement.dispatchEvent({type:'keydown',key:'ArrowRight'});
  assert.ok(f.document.activeElement===f.item('clip-1'), 'Focus must target the replacement clip node');
  await f.document.activeElement.dispatchEvent({type:'keydown',key:'ArrowRight'});
  assert.equal(f.calls.filter(([method])=>method==='apply')[1][2].operations[0].startFrame,26);
});


test('trim handle regains focus after it becomes editable for repeated keyboard trims', async () => {
  const f=fixture(); await f.view.open('project-a'); f.all(node=>node.dataset.role==='clip-trim-end')[0].focus();
  await f.document.activeElement.dispatchEvent({type:'keydown',key:'ArrowLeft'});
  assert.ok(f.document.activeElement===f.all(node=>node.dataset.role==='clip-trim-end')[0]);
  assert.equal(f.document.activeElement.disabled,false);
});

test('zoom preserves the ruler playhead and accessible current frame', async () => {
  const f=fixture(); await f.view.open('project-a'); await f.change(f.role('seek'),36);
  f.role('zoom').value='144'; await f.role('zoom').dispatchEvent({type:'input'});
  assert.equal(f.role('ruler').getAttribute('aria-valuenow'),'36');
  assert.equal(f.role('ruler').children.find(node=>node.dataset.role==='playhead').style.left,'216px');
});

test('native blur caused by temporarily disabling a trim grip still restores keyboard focus', async () => {
  let finish;
  const f=fixture({overrides:{applyTimeline(){ return new Promise(resolve=>{finish=resolve;}); }}});
  await f.view.open('project-a'); const handle=f.all(node=>node.dataset.role==='clip-trim-end')[0]; handle.focus();
  const pending=handle.dispatchEvent({type:'keydown',key:'ArrowLeft'});
  f.document.body=element('body'); f.document.activeElement=f.document.body;
  finish(timeline('timeline-a',2)); await pending;
  assert.ok(f.document.activeElement===f.all(node=>node.dataset.role==='clip-trim-end')[0]);
});

test('source-bound trims remain valid despite floating point frame arithmetic', async () => {
  const {applyTimelineOperations}=require('../src/video-timeline');
  const doc=timeline(); Object.assign(doc.items[0], {assetId:'a'.repeat(64), startFrame:24,endFrame:36,sourceStartSeconds:13/24,sourceEndSeconds:25/24});
  let committed;
  const f=fixture({initial:doc,assets:[{id:'a'.repeat(64),mimeType:'video/mp4',duration:8}],overrides:{async applyTimeline(_project,request){committed=applyTimelineOperations(doc,request.operations).document; return committed;}}});
  await f.view.open('project-a'); const handle=f.all(node=>node.dataset.role==='clip-trim-start')[0];
  await pointer(handle,'pointerdown',72); await pointer(handle,'pointermove',-100); await pointer(handle,'pointerup',-100);
  assert.ok(committed,'The source-bound trim must commit through real model validation');
  assert.equal(committed.items[0].sourceStartSeconds,0); assert.equal(committed.items[0].startFrame,11);
});

test('Escape during Alt range drag over a clip preserves the prior custom range after click', async () => {
  const f=fixture(); await f.view.open('project-a'); await f.change(f.role('range-start'),30); await f.change(f.role('range-end'),60); await f.change(f.role('range-track'),'video-1'); await f.click(f.role('select-range'));
  const clip=f.item('clip-1'); await pointer(clip,'pointerdown',120,undefined,{altKey:true}); await pointer(clip,'pointermove',156,undefined,{altKey:true});
  await f.container.children[0].dispatchEvent({type:'keydown',key:'Escape'}); await pointer(clip,'pointerup',156); await f.click(clip);
  assert.equal(f.view.getSelection().startFrame,30); assert.equal(f.view.getSelection().endFrame,60);
});

test('Alt dragging a trim grip moves only the selection', async () => {
  const f=fixture(); await f.view.open('project-a'); await f.click(f.item('clip-1'));
  const handle=f.all(node=>node.dataset.role==='clip-trim-start')[0];
  await pointer(handle,'pointerdown',74,undefined,{altKey:true}); await pointer(handle,'pointermove',110,undefined,{altKey:true}); await pointer(handle,'pointerup',110,undefined,{altKey:true});
  assert.equal(f.calls.some(([method])=>method==='apply'),false);
  assert.equal(f.view.getSelection().startFrame,36); assert.equal(f.view.getSelection().endFrame,84);
});

test('short clips keep a body hit target between proportionally sized trim grips', async () => {
  const doc=timeline(); doc.items[0].endFrame=30; doc.items[0].sourceEndSeconds=1.25;
  const f=fixture({initial:doc}); await f.view.open('project-a');
  const width=parseFloat(f.item('clip-1').style.width);
  assert.ok(parseFloat(f.item('clip-1').style.paddingInline) * 2 + 2 <= width, 'Padding must not expand the clip beyond its frame width');
  for (const handle of f.all(node=>['clip-trim-start','clip-trim-end'].includes(node.dataset.role))) assert.ok(parseFloat(handle.style.width)<=width/4);
});

test('late capture loss from a different control cannot cancel a new track drag', async () => {
  const f=fixture(); await f.view.open('project-a'); laneGeometry(f);
  const header=f.all(node=>node.dataset.role==='track-select'&&node.dataset.trackId==='video-1')[0];
  await pointer(header,'pointerdown',20,174);
  await f.role('ruler').dispatchEvent({type:'lostpointercapture',pointerId:7});
  await pointer(header,'pointermove',20,30); await pointer(header,'pointerup',20,30);
  assert.equal(f.calls.filter(([method])=>method==='apply').length,1);
});

test('Alt on the selected part of a trim grip uses pointer position rather than clip edge', async () => {
  const f=fixture(); await f.view.open('project-a'); await f.change(f.role('range-start'),26); await f.change(f.role('range-end'),60); await f.change(f.role('range-track'),'video-1'); await f.click(f.role('select-range'));
  const handle=f.all(node=>node.dataset.role==='clip-trim-start')[0]; await pointer(handle,'pointerdown',80,undefined,{altKey:true}); await pointer(handle,'pointermove',116,undefined,{altKey:true}); await pointer(handle,'pointerup',116,undefined,{altKey:true});
  assert.equal(f.calls.some(([method])=>method==='apply'),false); assert.equal(f.view.getSelection().startFrame,38);
});


test('one-frame clips at minimum zoom keep their authored width rather than border width', async () => {
  const doc=timeline(); doc.items[0].endFrame=25; doc.items[0].sourceEndSeconds=1+1/24;
  const f=fixture({initial:doc}); await f.view.open('project-a'); f.role('zoom').value='24'; await f.role('zoom').dispatchEvent({type:'input'});
  const clip=f.item('clip-1'); assert.equal(clip.style.width,'1px');
  assert.ok(parseFloat(clip.style.borderWidth)*2+parseFloat(clip.style.paddingInline)*2<=1);
});

test('a delayed keyboard library list never leaks across project switches', async () => {
  const f = fixture(); let finish;
  f.client.listAssets = () => new Promise(resolve => { finish = resolve; });
  await f.view.open('project-a'); f.role('add-picker').open = true;
  const pending = f.role('add-picker').dispatchEvent({ type: 'toggle' });
  await f.view.open('project-b');
  finish([{ id: 'old-library', mimeType: 'video/mp4', name: 'Old project context' }]); await pending;
  assert.equal(f.role('add-picker').open, false);
  assert.equal(f.role('add-asset').children.some(option => option.value === 'old-library'), false);
});

test('a failed library list keeps project keyboard insertion and can retry', async () => {
  const f = fixture(); f.client.listAssets = async () => { throw new Error('Unavailable'); };
  await f.view.open('project-a'); f.role('add-picker').open = true;
  await f.role('add-picker').dispatchEvent({ type: 'toggle' });
  assert.equal(f.role('add-clip').disabled, false);
  assert.match(f.role('status').textContent, /Refresh to retry/);
  f.client.listAssets = async () => [{ id: 'retry-image', mimeType: 'image/png', name: 'Recovered' }];
  await f.click(f.role('refresh'));
  assert.ok(f.role('add-asset').children.some(option => option.value === 'retry-image'));
});

test('disclosure keyboard activation does not trigger playback or cancel native toggling', async () => {
  const f = fixture(); await f.view.open('project-a');
  const shell = f.all(node => node.className === 'video-timeline')[0];
  let prevented = false;
  await shell.dispatchEvent({ type: 'keydown', key: ' ', target: { tagName: 'SUMMARY' }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(f.role('play').textContent, 'Play');
});

test('latest keyboard library refresh wins without silently changing the chosen source', async () => {
  const f = fixture(); const pending = [];
  f.client.listAssets = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  await f.view.open('project-a'); f.role('add-picker').open = true;
  const first = f.role('add-picker').dispatchEvent({ type: 'toggle' });
  const second = f.role('add-picker').dispatchEvent({ type: 'toggle' });
  pending[1].resolve([{ id: 'new-image', mimeType: 'image/png', name: 'Latest' }]); await second;
  await f.change(f.role('add-asset'), 'new-image');
  pending[0].resolve([{ id: 'old-image', mimeType: 'image/png', name: 'Outdated' }]); await first;
  assert.equal(f.role('add-asset').value, 'new-image');
  assert.equal(f.role('add-asset').children.some(option => option.value === 'old-image'), false);
  const oldError = f.role('add-picker').dispatchEvent({ type: 'toggle' });
  const latest = f.role('add-picker').dispatchEvent({ type: 'toggle' });
  pending[3].resolve([{ id: 'new-image', mimeType: 'image/png', name: 'Latest' }]); await latest;
  pending[2].reject(new Error('Outdated error')); await oldError;
  assert.doesNotMatch(f.role('status').textContent, /Outdated error/);
});

const { templateFixture } = require('./helpers/template-lifecycle');
function deletionFixture(t, { count = 2, viewOptions = {} } = {}) {
  const real = templateFixture(t), record = real.records[0];
  const clips = Array.from({ length: count }, (_, i) => ({ ...real.clip, id: `clip-${i}`, startFrame: i * 24, endFrame: (i + 1) * 24 }));
  for (let i = 0; i < clips.length; i += 100) real.controller.apply(real.projectId, record.timelineId, { expectedRevision: i / 100, operations: clips.slice(i, i + 100).map(item => ({ type: 'insert', item })) });
  const calls = [];
  const f = fixture({ initial: real.controller.read(real.projectId, record.timelineId), assets: real.canvases.listAssets(real.projectId).assets, viewOptions,
    overrides: {
      readTimeline: async () => real.controller.read(real.projectId, record.timelineId),
      getTimelineHistory: async () => real.controller.history(real.projectId, record.timelineId),
      getProjectAsset: async (_id, assetId) => real.canvases.getAsset(real.projectId, assetId),
      applyTimeline: async (_id, input) => { calls.push(clone(input)); return real.controller.apply(real.projectId, record.timelineId, input); },
      undoTimeline: async (_id, input) => real.controller.undo(real.projectId, record.timelineId, input),
      redoTimeline: async (_id, input) => real.controller.redo(real.projectId, record.timelineId, input),
    } });
  return { ...f, real, edits: calls, read: () => real.controller.read(real.projectId, record.timelineId), trackDelete: id => f.all(node => node.dataset.role === 'remove-track' && node.dataset.trackId === id)[0] };
}
async function selectAllClips(f) {
  await f.change(f.role('range-start'), 0); await f.change(f.role('range-end'), f.read().items.length * 24);
  await f.change(f.role('range-track'), 'video-1'); await f.click(f.role('select-range'));
}
async function deleteKey(f, target, options = {}) {
  let prevented = false;
  await f.container.children[0].dispatchEvent({ type: 'keydown', key: 'Delete', target, preventDefault: () => { prevented = true; }, ...options });
  await settle(); return prevented;
}

test('visible clip deletion uses one real edit and Undo while source media and HTML stay unchanged', async t => {
  const f = deletionFixture(t); await f.view.open(f.real.projectId);
  const before = f.read(), source = f.real.canvases.getDocumentSource(f.real.projectId, 'a.html');
  const media = f.real.canvases.getAsset(f.real.projectId, f.real.clip.assetId), project = f.real.canvases.getProject(f.real.projectId);
  const otherTimeline = f.real.bytes(f.real.records[1]);
  assert.equal(f.role('remove-clip').disabled, true);
  await f.click(f.item('clip-0'));
  assert.equal(f.role('remove-clip').textContent, 'Delete clip');
  assert.notEqual(f.role('remove-clip').parentNode, f.role('inspector'));
  assert.equal(f.role('inspector').open, false);
  await selectAllClips(f);
  assert.match(f.role('remove-clip').textContent, /Delete selected clips.*2/);
  await f.click(f.role('remove-clip'));
  assert.equal(f.edits.length, 1); assert.equal(f.edits[0].operations.length, 2);
  assert.equal(f.read().items.length, 0); assert.equal(f.view.getSelection(), null);
  assert.match(f.role('status').textContent, /Deleted 2 clips.*Undo.*Media/i);
  await f.click(f.role('undo')); assert.deepEqual(f.read().items, before.items);
  assert.deepEqual(f.read().tracks, before.tracks);
  assert.deepEqual(f.real.canvases.getAsset(f.real.projectId, f.real.clip.assetId), media);
  assert.deepEqual(f.real.canvases.getProject(f.real.projectId), project);
  assert.deepEqual(f.real.canvases.getDocumentSource(f.real.projectId, 'a.html'), source);
  assert.equal(f.real.bytes(f.real.records[1]), otherTimeline);
  f.view.destroy();
});

test('track deletion displays clip count, cancels safely, then cascades above 99 clips in one real edit', async t => {
  let finish; const requests = [];
  const f = deletionFixture(t, { count: 101, viewOptions: { confirmDeleteTrack: input => { requests.push(input); return new Promise(resolve => { finish = resolve; }); } } });
  await f.view.open(f.real.projectId); const before = f.read();
  const control = f.trackDelete('video-1');
  assert.match(control.textContent, /Delete track/); assert.match(control.getAttribute('aria-label'), /Video.*101 clips/i);
  const pending = f.click(control); assert.equal(requests.length, 1); assert.equal(requests[0].clipCount, 101);
  assert.equal(f.role('add-video-track').disabled, true); assert.equal(control.disabled, true);
  await f.click(control); assert.equal(requests.length, 1);
  finish(false); await pending; assert.deepEqual(f.read(), before); assert.equal(f.edits.length, 0);
  const approved = f.click(control); finish(true); await approved;
  assert.deepEqual(f.edits[0].operations, [{ type: 'remove-track', trackId: 'video-1', removeItems: true }]);
  assert.equal(f.read().items.length, 0); assert.equal(f.read().tracks.length, 2);
  await f.click(f.role('undo')); assert.deepEqual(f.read().items, before.items); assert.deepEqual(f.read().tracks, before.tracks);
  f.view.destroy();
});

test('empty track deletes directly, and unavailable confirmation fails closed for populated tracks', async t => {
  const f = deletionFixture(t); await f.view.open(f.real.projectId);
  await f.click(f.trackDelete('audio-1'));
  assert.deepEqual(f.edits[0].operations, [{ type: 'remove-track', trackId: 'audio-1' }]);
  await f.click(f.trackDelete('video-1'));
  assert.equal(f.edits.length, 1); assert.match(f.role('status').textContent, /confirmation.*unavailable/i);
  f.view.destroy();
});

test('clip batch limits reject more than 100 clips without partial deletion and accept exactly 100', async t => {
  const f = deletionFixture(t, { count: 101 }); await f.view.open(f.real.projectId); await selectAllClips(f);
  assert.equal(f.role('remove-clip').disabled, true); assert.match(f.role('selection-summary').textContent, /101 clips.*100.*Delete track/i);
  await f.click(f.role('remove-clip')); assert.equal(f.edits.length, 0); assert.equal(f.read().items.length, 101);
  await f.change(f.role('range-end'), 2400); await f.click(f.role('select-range'));
  await f.click(f.role('remove-clip')); assert.equal(f.edits[0].operations.length, 100); assert.equal(f.read().items.length, 1);
  await f.click(f.role('undo')); assert.equal(f.read().items.length, 101);
  f.view.destroy();
});

test('Delete and Backspace act only on a current selection owning timeline focus', async t => {
  for (const key of ['Delete', 'Backspace']) {
    const f = deletionFixture(t); await f.view.open(f.real.projectId); await f.click(f.item('clip-0'));
    const clip = f.item('clip-0'); clip.focus();
    assert.equal(await deleteKey(f, clip, { key, repeat: true }), false);
    assert.equal(await deleteKey(f, clip, { key, ctrlKey: true }), false);
    f.role('clip-start').focus(); assert.equal(await deleteKey(f, f.role('clip-start'), { key }), false);
    const editable = f.document.createElement('div'); editable.setAttribute('contenteditable', 'true');
    const text = f.document.createElement('span'); editable.append(text); f.container.children[0].append(editable); text.focus();
    assert.equal(await deleteKey(f, text, { key }), false);
    f.role('play').focus(); assert.equal(await deleteKey(f, f.role('play'), { key }), false);
    f.item('clip-1').focus(); assert.equal(await deleteKey(f, f.item('clip-1'), { key }), false);
    clip.focus(); const modal = f.document.createElement('dialog'); modal.open = true; f.container.append(modal);
    f.document.querySelector = () => modal; assert.equal(await deleteKey(f, clip, { key }), false); f.document.querySelector = () => null; modal.remove();
    const unrelated = f.document.createElement('button'); unrelated.dataset = { ...clip.dataset }; unrelated.focus(); assert.equal(await deleteKey(f, unrelated, { key }), false);
    clip.focus(); f.view.setBusy(true); assert.equal(await deleteKey(f, clip, { key }), false); f.view.setBusy(false);
    assert.equal(f.edits.length, 0); assert.equal(await deleteKey(f, clip, { key }), true);
    assert.equal(f.edits.length, 1); assert.equal(f.read().items.length, 1); assert.equal(f.view.getSelection(), null);
    assert.equal(await deleteKey(f, clip, { key }), false);
    await f.click(f.role('undo')); assert.equal(f.read().items.length, 2); f.view.destroy();
  }
});

test('stale selections and old rendered track buttons cannot delete a refreshed or reopened timeline', async t => {
  const f = deletionFixture(t, { viewOptions: { confirmDeleteTrack: async () => true } });
  await f.view.open(f.real.projectId); await f.click(f.item('clip-0'));
  const clip = f.item('clip-0'), trackButton = f.trackDelete('video-1');
  f.real.controller.apply(f.real.projectId, f.real.records[0].timelineId, { expectedRevision: 1, operations: [{ type: 'move', itemId: 'clip-0', startFrame: 48 }] });
  await f.view.refresh(); assert.equal(f.role('remove-clip').disabled, true);
  await f.click(f.role('remove-clip')); clip.focus(); assert.equal(await deleteKey(f, clip), false);
  await f.click(trackButton); assert.equal(f.edits.length, 0);
  await f.view.open('another-project'); await f.click(trackButton); assert.equal(f.edits.length, 0); f.view.destroy();
});

test('pending track confirmation rechecks revisions, busy state and view lifetime before mutating', async t => {
  for (const interruption of ['refresh', 'busy', 'reopen', 'destroy']) {
    let finish, request;
    const f = deletionFixture(t, { viewOptions: { confirmDeleteTrack: input => { request = input; return new Promise(resolve => { finish = resolve; }); } } });
    await f.view.open(f.real.projectId); const pending = f.click(f.trackDelete('video-1'));
    if (interruption === 'refresh') {
      f.real.controller.apply(f.real.projectId, f.real.records[0].timelineId, { expectedRevision: 1, operations: [{ type: 'move', itemId: 'clip-0', startFrame: 48 }] });
      await f.view.refresh();
    } else if (interruption === 'busy') f.view.setBusy(true);
    else if (interruption === 'reopen') await f.view.open('another-project');
    else f.view.destroy();
    finish(true); await pending; assert.equal(f.edits.length, 0, interruption);
    if (['reopen', 'destroy'].includes(interruption)) assert.equal(request.signal.aborted, true);
    if (interruption !== 'destroy') f.view.destroy();
  }
});

test('deletion remains single-flight through an in-progress mutation', async t => {
  const f = deletionFixture(t); await f.view.open(f.real.projectId); await f.click(f.item('clip-0'));
  const apply = f.client.applyTimeline; let finish;
  f.client.applyTimeline = async (...args) => { await new Promise(resolve => { finish = resolve; }); return apply(...args); };
  const pending = f.click(f.role('remove-clip')); await f.click(f.role('remove-clip')); await f.click(f.trackDelete('audio-1'));
  assert.equal(f.edits.length, 0); finish(); await pending; assert.equal(f.edits.length, 1); f.view.destroy();
});

test('safe delete dialog uses text, defaults to Cancel and disposes on cancel, approval or abort', async () => {
  const f = fixture(); const signal = new AbortController();
  const confirm = () => confirmTimelineTrackDeletion({ document: f.document, container: f.container, trackName: '<img src=x onerror=alert(1)>', clipCount: 101, signal: signal.signal });
  const pending = confirm(); const dialog = f.all(node => node.tagName === 'DIALOG')[0];
  assert.ok(dialog.open); assert.match(dialog.textContent, /101 clips.*Undo.*Media/);
  assert.equal(f.all(node => node.tagName === 'IMG').length, 0);
  const cancel = f.all(node => node.textContent === 'Cancel')[0]; assert.equal(f.document.activeElement, cancel);
  await f.click(cancel); assert.equal(await pending, false); assert.equal(f.all(node => node.tagName === 'DIALOG').length, 0);
  const approved = confirm(); await f.click(f.all(node => node.tagName === 'BUTTON' && node.textContent === 'Delete track and 101 clips')[0]); assert.equal(await approved, true);
  const aborted = confirm(); signal.abort(); assert.equal(await aborted, false); assert.equal(f.all(node => node.tagName === 'DIALOG').length, 0);
  f.view.destroy();
});

test('confirmation errors and non-boolean approval cannot delete a populated track', async t => {
  for (const result of ['yes', 1, {}, new Error('Dialog unavailable')]) {
    const f = deletionFixture(t, { viewOptions: { confirmDeleteTrack: async () => { if (result instanceof Error) throw result; return result; } } });
    await f.view.open(f.real.projectId); const before = f.read(); await f.click(f.trackDelete('video-1'));
    assert.deepEqual(f.read(), before); assert.equal(f.edits.length, 0); assert.equal(f.trackDelete('video-1').disabled, false);
    if (result instanceof Error) assert.match(f.role('status').textContent, /Could not confirm.*Dialog unavailable/);
    f.view.destroy();
  }
});

test('native dialog Escape/close cancel and dialog failure leaves no detached prompt', async () => {
  const f = fixture();
  const confirm = () => confirmTimelineTrackDeletion({ document: f.document, container: f.container, trackName: 'Audio', clipCount: 1 });
  for (const type of ['cancel', 'close']) {
    const pending = confirm(); const dialog = f.all(node => node.tagName === 'DIALOG')[0];
    await dialog.dispatchEvent({ type }); assert.equal(await pending, false); assert.equal(f.all(node => node.tagName === 'DIALOG').length, 0);
  }
  const create = f.document.createElement;
  f.document.createElement = tag => { const node = create(tag); if (tag === 'dialog') node.showModal = () => { throw new Error('Unsupported dialog'); }; return node; };
  assert.equal(await confirm(), false); assert.equal(f.all(node => node.tagName === 'DIALOG').length, 0); f.view.destroy();
});

for (const origin of ['remove-clip', 'range-start-handle', 'range-end-handle', 'track-lane']) {
  test(`successful deletion from ${origin} restores timeline focus after native blur and supports keyboard Undo`, async t => {
    const f = deletionFixture(t); await f.view.open(f.real.projectId); await selectAllClips(f);
    const target = origin === 'remove-clip' ? f.role(origin) : f.all(node => node.dataset.role === origin && node.dataset.trackId === 'video-1')[0];
    target.focus(); const apply = f.client.applyTimeline; let finish;
    f.client.applyTimeline = async (...args) => { await new Promise(resolve => { finish = resolve; }); return apply(...args); };
    const pending = origin === 'remove-clip' ? f.click(target) : deleteKey(f, target);
    f.document.body = element('body'); f.document.activeElement = f.document.body; // Native disabled/removed-node blur.
    finish(); await pending; await settle();
    assert.equal(f.read().items.length, 0); assert.equal(f.view.getSelection(), null);
    assert.ok(f.document.activeElement === f.role('ruler'), 'Deletion must leave an enabled timeline focus target');
    await f.container.children[0].dispatchEvent({ type: 'keydown', target: f.document.activeElement, key: 'z', ctrlKey: true }); await settle();
    assert.equal(f.read().items.length, 2, 'Immediate keyboard Undo restores the deleted clips'); f.view.destroy();
  });
}

test('deletion focus recovery does not run on failure or steal focus during async changes', async t => {
  for (const interruption of ['failure', 'external-focus', 'modal', 'reopen', 'history-external-focus', 'history-modal']) {
    const f = deletionFixture(t); await f.view.open(f.real.projectId); await selectAllClips(f);
    const target = f.role('remove-clip'); target.focus(); const apply = f.client.applyTimeline; let finish;
    f.document.body = element('body');
    if (interruption.startsWith('history-')) {
      const history = f.client.getTimelineHistory;
      f.client.getTimelineHistory = async (...args) => { await new Promise(resolve => { finish = resolve; }); return history(...args); };
    } else f.client.applyTimeline = async (...args) => { await new Promise(resolve => { finish = resolve; }); if (interruption === 'failure') throw new Error('Save failed'); return apply(...args); };
    const pending = f.click(target); f.document.activeElement = f.document.body; await settle();
    let expectedFocus = f.document.body;
    if (interruption.endsWith('external-focus')) {
      expectedFocus = f.document.createElement('button'); expectedFocus.dataset.role = 'track-lane'; expectedFocus.focus();
    } else if (interruption.endsWith('modal')) {
      const dialog = f.document.createElement('dialog'); dialog.open = true; f.document.querySelector = () => dialog;
    } else if (interruption === 'reopen') {
      await f.view.open('another-project'); expectedFocus = f.role('play'); expectedFocus.focus();
    }
    finish(); await pending; await settle();
    assert.ok(f.document.activeElement === expectedFocus, interruption);
    if (interruption === 'failure') assert.equal(f.read().items.length, 2);
    f.view.destroy();
  }
});
