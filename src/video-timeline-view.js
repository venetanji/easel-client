(function exposeTimelineView(root) {
  'use strict';
  const PIXELS_PER_SECOND = 72;
  const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
  const MAX_CACHE_BYTES = 128 * 1024 * 1024;
  const MAX_FRAME = 10_000_000;
  const MEDIA_DRAG_TYPE = 'application/x-easel-media-asset';
  const MEDIA_TYPE = /^(?:video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|image\/(?:png|jpeg|webp|gif|avif|bmp))$/i;
  const copy = (value) => value == null ? null : JSON.parse(JSON.stringify(value));
  const fps = (rate) => rate.numerator / rate.denominator;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const durationFrames = (timeline) => timeline ? Math.max(0, ...timeline.items.map((item) => item.endFrame)) : 0;

  function frameToPixels(frame, frameRate, pixelsPerSecond = PIXELS_PER_SECOND) { return frame / fps(frameRate) * pixelsPerSecond; }
  function pixelToFrame(pixel, frameRate, pixelsPerSecond = PIXELS_PER_SECOND) { return Math.max(0, Math.round(pixel / pixelsPerSecond * fps(frameRate))); }
  function getPreviewLayers(timeline, frame) {
    if (!timeline) return [];
    return timeline.tracks.flatMap((track) => timeline.items.filter((item) => item.trackId === track.id && frame >= item.startFrame && frame < item.endFrame).map((item) => {
      const offset = frame - item.startFrame;
      const length = item.endFrame - item.startFrame;
      const fadeIn = item.fadeInFrames ? Math.min(1, offset / item.fadeInFrames) : 1;
      const fadeOut = item.fadeOutFrames ? Math.min(1, (item.endFrame - frame) / item.fadeOutFrames) : 1;
      return { item, track, type: track.type, sourceTime: item.sourceStartSeconds + offset / length * (item.sourceEndSeconds - item.sourceStartSeconds), playbackRate: (item.sourceEndSeconds - item.sourceStartSeconds) / (length / fps(timeline.frameRate)), gain: track.type === 'overlay' ? 0 : (item.gain ?? 1) * Math.min(fadeIn, fadeOut) };
    }));
  }

  function createVideoTimelineView({ document, container, client, onSelection = () => {}, onStatus = () => {}, onClose, isBusy = () => false }) {
    if (!document || !container || !client) throw new Error('Timeline document, container and client are required.');
    const host = document.defaultView || root;
    const urlApi = host.URL || root.URL;
    const BlobType = host.Blob || root.Blob;
    const decodeBase64 = host.atob || root.atob;
    const raf = host.requestAnimationFrame?.bind(host) || ((fn) => setTimeout(() => fn(Date.now()), 16));
    const cancelRaf = host.cancelAnimationFrame?.bind(host) || clearTimeout;
    const now = () => host.performance?.now?.() ?? Date.now();
    let projectId = '', timeline = null, selection = null, assets = [], generation = 0, readSequence = 0;
    let closed = true, destroyed = false, loading = false, mutating = false, explicitlyBusy = false;
    let history = null, libraryAssets = [], exportController = null, preparing = false, exporting = false, playhead = 0, playing = false, animation = null, playOrigin = 0, startedAt = 0;
    let pixelsPerSecond = PIXELS_PER_SECOND, inspectedItemId = '', drag = null, dropTarget = null;
    let cachedBytes = 0, itemCounter = 0, mediaFetchTail = Promise.resolve();
    const cache = new Map(), pendingMedia = new Map(), mediaErrors = new Map(), mediaNodes = new Map(), probeCleanups = new Set();
    const ui = {}, editControls = [];
    const active = (token) => !closed && !destroyed && generation === token;
    const canEdit = () => !closed && !!timeline && !loading && !mutating && !preparing && !exporting && !explicitlyBusy && !isBusy();
    const el = (tag, className, text, role) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      if (role) { node.dataset.role = role; ui[role] = node; }
      return node;
    };
    const button = (text, role, action, className = 'button outline small') => {
      const node = el('button', className, text, role); node.type = 'button';
      node.addEventListener('click', action); return node;
    };
    const field = (text, role, type = 'number', value = '') => {
      const label = el('label', 'timeline-field'); const caption = el('span', '', text);
      const input = el(type === 'select' ? 'select' : 'input', '', undefined, role);
      if (type !== 'select') input.type = type;
      input.value = String(value); input.setAttribute('aria-label', text);
      if (type === 'number') { input.min = '0'; input.step = '1'; }
      label.append(caption, input); return label;
    };
    const option = (label, value) => { const node = el('option', '', label); node.value = value; return node; };
    const trackOptions = (node, includeAll = false, allowed = () => true) => {
      const previous = node.value;
      node.replaceChildren(...(includeAll ? [option('All tracks', '')] : []), ...(timeline?.tracks || []).filter(allowed).map((track) => option(track.name || track.type, track.id)));
      const valid = timeline?.tracks.some((track) => allowed(track) && track.id === previous);
      node.value = valid || includeAll && previous === '' ? previous : (timeline?.tracks.find(allowed)?.id || '');
    };
    const status = (message, error = false) => {
      ui.status.textContent = message || ''; ui.status.dataset.state = error ? 'error' : 'ready';
      onStatus(message || '', error);
    };
    const numeric = (role, { integer = true, min = 0, max = MAX_FRAME } = {}) => {
      const raw = ui[role].value.trim(); const value = Number(raw);
      if (!raw || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) throw new Error(`${ui[role].getAttribute('aria-label')} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
      return value;
    };
    const range = (startRole, endRole) => {
      const startFrame = numeric(startRole), endFrame = numeric(endRole);
      if (endFrame <= startFrame) throw new Error('The end frame must be after the start frame. End frames are exclusive.');
      return { startFrame, endFrame };
    };

    const shell = el('section', 'video-timeline'); shell.setAttribute('aria-label', 'Video timeline editor');
    const header = el('header', 'timeline-header');
    const heading = el('div', 'timeline-heading'); heading.append(el('h2', '', 'Timeline'), el('span', 'timeline-meta', '', 'meta'));
    const actions = el('div', 'timeline-actions');
    actions.append(button('Undo', 'undo', () => mutate('undoTimeline')), button('Redo', 'redo', () => mutate('redoTimeline')), button('Refresh', 'refresh', () => refresh()), button('Export video', 'export', exportTimeline, 'button primary small'), button('Cancel export', 'cancel-export', () => exportController?.abort()), button('Back to canvas', 'close', () => { close(); onClose?.(); }, 'button quiet small'));
    ui['cancel-export'].hidden = true; ui.close.hidden = typeof onClose !== 'function'; header.append(heading, actions);
    const workbench = el('div', 'timeline-workbench');
    const preview = el('section', 'timeline-preview'); preview.setAttribute('aria-label', 'Live video preview');
    const previewViewport = el('div', 'timeline-preview-viewport');
    const stage = el('div', 'timeline-preview-stage', undefined, 'preview-stage');
    previewViewport.append(stage);
    const previewEmpty = el('p', 'timeline-preview-empty', 'Add project media to start your edit.', 'preview-empty');
    const mediaSurface = el('div', 'timeline-preview-media', undefined, 'preview-media'); stage.append(mediaSurface, previewEmpty);
    const transport = el('div', 'timeline-transport');
    transport.append(button('Play', 'play', () => togglePlayback(), 'button primary small'), button('Previous frame', 'previous-frame', () => seek(playhead - 1), 'button quiet small'), button('Next frame', 'next-frame', () => seek(playhead + 1), 'button quiet small'));
    const seekInput = el('input', 'timeline-seek', undefined, 'seek'); seekInput.type = 'range'; seekInput.min = '0'; seekInput.step = '1'; seekInput.value = '0'; seekInput.setAttribute('aria-label', 'Preview frame');
    seekInput.addEventListener('input', () => seek(Number(seekInput.value))); seekInput.addEventListener('change', () => seek(Number(seekInput.value)));
    transport.append(seekInput, el('output', 'timeline-timecode', '', 'timecode'));
    const previewFooter = el('div', 'timeline-preview-footer');
    previewFooter.append(el('span', '', 'Live preview · browser timing'), el('span', '', '', 'preview-status'), button('Retry media', 'retry-preview', () => { mediaErrors.clear(); disposeMediaNodes(); renderPreview(); })); ui['retry-preview'].hidden = true;
    preview.append(previewViewport, transport, previewFooter);
    const sidebar = el('aside', 'timeline-sidebar');
    const add = el('section', 'timeline-add'); add.append(el('h3', '', 'Add media'), button('Import media', 'import-media', importMedia));
    add.append(field('Media source', 'media-source', 'select'), field('Media type', 'media-filter', 'select'), field('Search media', 'media-search', 'search'), field('Media', 'add-asset', 'select'), field('Destination track', 'add-track', 'select'), field('Still image length (seconds)', 'image-duration', 'number', 5));
    ui['image-duration'].min = '0.1'; ui['image-duration'].step = '0.1';
    const addNote = el('p', 'timeline-help', 'Clips append to the selected track. Source files stay unchanged.', 'add-note');
    add.append(button('Add clip', 'add-clip', addClip, 'button primary small'), addNote);
    ui['media-source'].append(option('This project', 'project'), option('Media library', 'library')); ui['media-source'].value = 'project';
    ui['media-filter'].append(option('All media', ''), option('Video', 'video'), option('Audio', 'audio'), option('Images', 'image')); ui['media-filter'].value = '';
    ui['media-source'].addEventListener('change', async () => {
      const token = generation;
      if (ui['media-source'].value === 'library' && client.listAssets) {
        try { const result = await client.listAssets(); if (!active(token)) return; libraryAssets = Array.isArray(result) ? result : result?.assets || []; renderAssets(); }
        catch (error) { if (active(token)) status(`Could not load the Media library. ${error.message}`, true); }
      } else renderAssets();
    });
    ui['media-filter'].addEventListener('change', renderAssets); ui['media-search'].addEventListener('input', renderAssets); ui['media-search'].addEventListener('change', renderAssets);
    ui['add-asset'].addEventListener('change', updateAssetChoices);
    const inspector = el('section', 'timeline-inspector', undefined, 'inspector'); sidebar.append(add, inspector);
    workbench.append(preview, sidebar);
    const rangeBar = el('section', 'timeline-rangebar'); rangeBar.setAttribute('aria-label', 'Exact frame range');
    rangeBar.append(field('Start frame', 'range-start', 'number', 0), field('End frame (exclusive)', 'range-end', 'number', 24), field('Selection track', 'range-track', 'select'), button('Select range', 'select-range', selectRange), button('Clear', 'clear-selection', clearSelection, 'button quiet small'));
    const selectionSummary = el('p', 'timeline-selection-summary', 'Select a clip or frame range to attach it to your next message.', 'selection-summary'); selectionSummary.setAttribute('aria-live', 'polite');
    const timelineToolbar = el('div', 'timeline-track-toolbar'); timelineToolbar.append(selectionSummary, field('Zoom', 'zoom', 'range', PIXELS_PER_SECOND));
    ui.zoom.min = '24'; ui.zoom.max = '160'; ui.zoom.step = '8'; ui.zoom.addEventListener('input', () => { pixelsPerSecond = Number(ui.zoom.value); renderTracks(); });
    const tracksViewport = el('div', 'timeline-tracks-viewport', undefined, 'tracks-viewport');
    const tracks = el('div', 'timeline-tracks', undefined, 'tracks'); tracksViewport.append(tracks);
    tracksViewport.addEventListener('dragleave', (event) => {
      if (tracksViewport.contains?.(event.relatedTarget)) return;
      const box = tracksViewport.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX >= box.left + box.width || event.clientY < box.top || event.clientY >= box.top + box.height) clearDropTarget();
    });
    const statusNode = el('p', 'timeline-status', '', 'status'); statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite');
    shell.append(header, workbench, rangeBar, timelineToolbar, tracksViewport, statusNode); container.replaceChildren(shell); container.hidden = true;
    editControls.push(ui['import-media'], ui['media-source'], ui['media-filter'], ui['media-search'], ui['add-asset'], ui['add-track'], ui['image-duration'], ui['add-clip']);
    shell.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (drag) cancelRangeDrag(); else clearSelection(); clearDropTarget(); return; }
      if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target?.tagName)) return;
      if (event.key === ' ') { event.preventDefault(); togglePlayback(); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(playhead + (event.key === 'ArrowLeft' ? -1 : 1)); }
    });

    function updateControls() {
      const editable = canEdit();
      for (const control of editControls) control.disabled = !editable;
      ui['add-clip'].disabled = !editable || !pickerAssets().some((asset) => asset.id === ui['add-asset'].value);
      ui.undo.disabled = !editable || history?.undoAvailable === false;
      ui.redo.disabled = !editable || history?.redoAvailable === false;
      ui.refresh.disabled = loading || mutating || preparing || exporting || closed;
      ui.export.disabled = !editable || !durationFrames(timeline) || !host.EaselVideoExport?.exportVideoTimeline || !client.saveTimelineExport;
      ui.export.title = host.EaselVideoExport?.exportVideoTimeline ? 'Render a video and save it to the Media library' : 'Video export runtime is unavailable in this project';
      ui['cancel-export'].hidden = !exporting;
      ui.play.disabled = !timeline || !durationFrames(timeline) || loading;
      ui.seek.disabled = !timeline || !durationFrames(timeline) || loading;
      ui['previous-frame'].disabled = !timeline || playhead <= 0;
      ui['next-frame'].disabled = !timeline || playhead >= durationFrames(timeline);
      ui['select-range'].disabled = !timeline || loading;
      ui['clear-selection'].disabled = !selection;
      ui['save-clip'] && (ui['save-clip'].disabled = !editable);
      ui['remove-clip'] && (ui['remove-clip'].disabled = !editable);
      walk(tracks, (node) => { if (['range-start-handle', 'range-end-handle'].includes(node.dataset?.role)) node.disabled = !editable || !selectionCurrent(); });
      shell.setAttribute('aria-busy', String(loading || mutating || preparing || exporting));
    }
    function pickerAssets() { return ui['media-source'].value === 'library' ? libraryAssets : assets; }
    function updateAssetChoices() {
      const asset = pickerAssets().find((entry) => entry.id === ui['add-asset'].value);
      const isImage = asset?.mimeType?.startsWith('image/');
      ui['image-duration'].parentNode.hidden = !isImage;
      trackOptions(ui['add-track'], false, (track) => isImage ? track.type === 'video' || track.type === 'overlay' : asset?.mimeType?.startsWith('audio/') ? track.type === 'audio' : asset?.mimeType?.startsWith('video/') && track.type === 'video');
      updateControls();
    }
    function renderAssets() {
      const previous = ui['add-asset'].value;
      const query = ui['media-search'].value.trim().toLocaleLowerCase();
      const supported = pickerAssets().filter((asset) => MEDIA_TYPE.test(asset.mimeType || '') && asset.id && (!ui['media-filter'].value || asset.mimeType.startsWith(`${ui['media-filter'].value}/`)) && (!query || String(asset.name || asset.id).toLocaleLowerCase().includes(query)));
      ui['media-source'].parentNode.hidden = !client.listAssets; ui['import-media'].hidden = !client.importMedia;
      ui['add-asset'].replaceChildren(...supported.map((asset) => option(asset.name || asset.id, asset.id)));
      ui['add-asset'].value = supported.some((asset) => asset.id === previous) ? previous : supported[0]?.id || '';
      ui['add-note'].textContent = supported.length ? ui['media-source'].value === 'library' ? 'Add clip attaches this library source to your project and appends it to the track.' : 'Clips append to the selected track. Source files stay unchanged.' : query || ui['media-filter'].value ? 'No matching media. Try another name or media type.' : 'No media yet. Import or generate media in the Media library, then Refresh.';
      updateAssetChoices();
    }
    function render() {
      if (!timeline) { ui.meta.textContent = loading ? 'Opening…' : ''; updateControls(); return; }
      ui.meta.textContent = `${timeline.width} × ${timeline.height} · ${Number(fps(timeline.frameRate).toFixed(3))} fps · revision ${timeline.revision}`;
      stage.style.aspectRatio = `${timeline.width} / ${timeline.height}`;
      stage.style.maxWidth = `calc(100cqh * ${timeline.width / timeline.height})`;
      trackOptions(ui['range-track'], true); renderAssets(); renderTracks(); renderInspector(); renderSelection(); renderPreview(); updateControls();
    }
    function renderTracks() {
      if (!timeline) { tracks.replaceChildren(); return; }
      const end = visibleEndFrame();
      const width = frameToPixels(end, timeline.frameRate, pixelsPerSecond);
      const rows = [];
      const rulerRow = el('div', 'timeline-ruler-row'); rulerRow.append(el('span', 'timeline-track-label', 'Frames'));
      const ruler = el('div', 'timeline-ruler'); ruler.style.width = `${width}px`;
      const spacing = Math.max(1, Math.ceil(64 / pixelsPerSecond), Math.ceil(end / fps(timeline.frameRate) / 500));
      for (let seconds = 0; seconds < end / fps(timeline.frameRate); seconds += spacing) {
        const tick = el('span', 'timeline-ruler-tick', String(Math.round(seconds * fps(timeline.frameRate)))); tick.style.left = `${seconds * pixelsPerSecond}px`; ruler.append(tick);
      }
      rulerRow.append(ruler); rows.push(rulerRow);
      for (const track of timeline.tracks) {
        const row = el('div', `timeline-track-row timeline-track-${track.type}`);
        const trackButton = button(track.name || track.type, '', () => selectSpan([track.id], 0, Math.max(1, durationFrames(timeline))), 'timeline-track-label');
        trackButton.dataset.role = 'track-select'; trackButton.dataset.trackId = track.id; trackButton.setAttribute('aria-label', `Select ${track.name || track.type} track`);
        const lane = el('div', 'timeline-track-lane'); lane.dataset.role = 'track-lane'; lane.dataset.trackId = track.id; lane.style.width = `${width}px`; lane.style.backgroundSize = `${pixelsPerSecond}px 100%`; lane.setAttribute('aria-label', `${track.name || track.type} clips`);
        lane.addEventListener('pointerdown', (event) => {
          if (event.target === lane) beginRangeDrag(event, lane, track.id);
        });
        bindRangeGesture(lane);
        lane.addEventListener('dragover', (event) => previewMediaDrop(event, lane, track));
        lane.addEventListener('dragleave', (event) => { if (!lane.contains?.(event.relatedTarget)) clearDropTarget(true); });
        lane.addEventListener('drop', (event) => dropMedia(event, lane, track));
        const selectedRange = el('div', 'timeline-selected-range'); selectedRange.dataset.role = 'range-highlight'; selectedRange.dataset.trackId = track.id; selectedRange.hidden = true; lane.append(selectedRange);
        for (const edge of ['start', 'end']) {
          const handle = button('', '', () => {}, `timeline-range-handle timeline-range-handle-${edge}`);
          handle.dataset.role = `range-${edge}-handle`; handle.dataset.trackId = track.id;
          handle.setAttribute('role', 'slider'); handle.setAttribute('aria-label', `Selection ${edge} frame on ${track.name || track.type}`);
          handle.setAttribute('aria-orientation', 'horizontal'); handle.title = 'Drag to adjust selection. Arrow keys: 1 frame; Shift + arrow: 10 frames. Escape: cancel.';
          handle.hidden = true;
          handle.addEventListener('pointerdown', (event) => beginRangeDrag(event, lane, track.id, edge, handle));
          handle.addEventListener('keydown', (event) => adjustRangeKey(event, edge));
          bindRangeGesture(handle); lane.append(handle);
        }
        const dropMarker = el('div', 'timeline-drop-marker'); dropMarker.dataset.role = 'drop-marker'; dropMarker.hidden = true; lane.append(dropMarker);
        for (const item of timeline.items.filter((entry) => entry.trackId === track.id)) {
          const clip = button('', '', () => selectClip(item.id), 'timeline-clip'); clip.dataset.itemId = item.id;
          clip.style.left = `${frameToPixels(item.startFrame, timeline.frameRate, pixelsPerSecond)}px`; clip.style.width = `${frameToPixels(item.endFrame - item.startFrame, timeline.frameRate, pixelsPerSecond)}px`;
          const name = item.name || assets.find((asset) => asset.id === item.assetId)?.name || 'Untitled clip';
          clip.append(el('strong', '', name), el('span', '', `${item.startFrame}–${item.endFrame}`));
          clip.title = `${name} · frames ${item.startFrame} to ${item.endFrame} (exclusive)`; clip.setAttribute('aria-label', clip.title); clip.setAttribute('aria-pressed', String(selection?.itemIds.includes(item.id) || false));
          lane.append(clip);
        }
        const marker = el('div', 'timeline-playhead'); marker.dataset.role = 'playhead'; marker.style.left = `${frameToPixels(playhead, timeline.frameRate, pixelsPerSecond)}px`; lane.append(marker);
        row.append(trackButton, lane); rows.push(row);
      }
      tracks.replaceChildren(...rows); renderSelection();
    }
    function visibleEndFrame() {
      return Math.min(MAX_FRAME, Math.max(durationFrames(timeline) + Math.ceil(fps(timeline.frameRate)), Math.ceil(fps(timeline.frameRate) * 8), selection?.endFrame || 0));
    }
    function selectionCurrent() { return !!selection && selection.timelineRevision === timeline?.revision && selection.timelineId === timeline?.id; }
    function frameAt(event, lane, end = visibleEndFrame()) {
      return clamp(pixelToFrame(event.clientX - lane.getBoundingClientRect().left, timeline.frameRate, pixelsPerSecond), 0, end);
    }
    function beginRangeDrag(event, lane, trackId, edge, target = lane) {
      if (!canEdit() || drag || event.button !== undefined && event.button !== 0 || edge && !selectionCurrent()) return;
      event.preventDefault(); event.stopPropagation();
      drag = { trackId, lane, target, edge, pointerId: event.pointerId, frame: frameAt(event, lane), previous: copy(selection), fields: ['range-start', 'range-end', 'range-track'].map((role) => ui[role].value), token: generation, revision: timeline.revision, end: visibleEndFrame() };
      target.setPointerCapture?.(event.pointerId);
      if (!edge) previewRangeDrag(event);
    }
    function previewRangeDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!active(drag.token) || timeline?.revision !== drag.revision) { cancelRangeDrag(); return; }
      const last = frameAt(event, drag.lane, drag.end);
      let start = drag.previous?.startFrame, end = drag.previous?.endFrame;
      if (drag.edge === 'start') start = clamp(start + last - drag.frame, 0, end - 1);
      else if (drag.edge === 'end') end = clamp(end + last - drag.frame, start + 1, drag.end);
      else { start = Math.min(drag.frame, last, drag.end - 1); end = Math.max(drag.frame, last, start + 1); }
      selectSpan(drag.edge ? drag.previous.trackIds : [drag.trackId], start, end, undefined, false);
    }
    function finishRangeDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      previewRangeDrag(event); if (!drag) return;
      const gesture = drag; drag = null; gesture.target.releasePointerCapture?.(gesture.pointerId);
      inspectedItemId = selection?.itemIds.length === 1 ? selection.itemIds[0] : ''; renderInspector(); onSelection(copy(selection));
    }
    function cancelRangeDrag() {
      if (!drag) return;
      const gesture = drag; drag = null; selection = gesture.previous;
      gesture.target.releasePointerCapture?.(gesture.pointerId);
      ['range-start', 'range-end', 'range-track'].forEach((role, index) => { ui[role].value = gesture.fields[index]; }); renderSelection();
    }
    function bindRangeGesture(target) {
      target.addEventListener('pointermove', previewRangeDrag);
      target.addEventListener('pointerup', finishRangeDrag);
      target.addEventListener('pointercancel', (event) => { if (drag?.pointerId === event.pointerId) cancelRangeDrag(); });
      target.addEventListener('lostpointercapture', cancelRangeDrag);
    }
    function adjustRangeKey(event, edge) {
      if (!canEdit() || !selectionCurrent() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const min = edge === 'start' ? 0 : selection.startFrame + 1;
      const max = edge === 'start' ? selection.endFrame - 1 : visibleEndFrame();
      const next = event.key === 'Home' ? min : event.key === 'End' ? max : clamp(selection[`${edge}Frame`] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1), min, max);
      selectSpan(selection.trackIds, edge === 'start' ? next : selection.startFrame, edge === 'end' ? next : selection.endFrame);
    }
    function clearDropTarget(preserveContext = false) {
      if (!dropTarget) return;
      dropTarget.lane.dataset.dropState = ''; const marker = [...dropTarget.lane.children].find((node) => node.dataset.role === 'drop-marker'); if (marker) marker.hidden = true;
      if (!preserveContext) dropTarget = null;
    }
    function previewMediaDrop(event, lane, track) {
      if (!canEdit() || !Array.from(event.dataTransfer?.types || []).includes(MEDIA_DRAG_TYPE)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
      if (dropTarget?.lane !== lane) {
        const previous = dropTarget; clearDropTarget();
        dropTarget = { lane, token: previous?.token ?? generation, revision: previous?.revision ?? timeline.revision };
      }
      const frame = frameAt(event, lane); lane.dataset.dropState = 'ready';
      const marker = [...lane.children].find((node) => node.dataset.role === 'drop-marker');
      if (marker) { marker.hidden = false; marker.style.left = `${frameToPixels(frame, timeline.frameRate, pixelsPerSecond)}px`; marker.textContent = `${track.name || track.type} · frame ${frame}`; }
    }
    function compatibleAsset(asset, track) {
      return MEDIA_TYPE.test(asset?.mimeType || '') && (asset.mimeType.startsWith('image/') ? ['video', 'overlay'].includes(track?.type) : asset.mimeType.startsWith('audio/') ? track?.type === 'audio' : track?.type === 'video');
    }
    async function dropMedia(event, lane, track) {
      event.preventDefault(); event.stopPropagation();
      const target = dropTarget; clearDropTarget();
      if (!canEdit()) return;
      const token = generation, revision = timeline.revision, owner = projectId;
      try {
        if (target && (target.token !== token || target.revision !== revision)) throw new Error('The timeline changed during the drag. Drag the media again.');
        if (!Array.from(event.dataTransfer?.types || []).includes(MEDIA_DRAG_TYPE)) throw new Error('Drag media from the Media drawer. Use Import media for files.');
        const raw = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
        if (typeof raw !== 'string' || raw.length > 160) throw new Error('Invalid managed media payload. Drag the media again.');
        let payload; try { payload = JSON.parse(raw); } catch { throw new Error('Invalid managed media payload. Drag the media again.'); }
        if (!payload || Object.keys(payload).length !== 1 || typeof payload.assetId !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(payload.assetId || '')) throw new Error('Invalid managed media payload. Drag the media again.');
        const startFrame = frameAt(event, lane);
        preparing = true; updateControls();
        let asset = assets.find((entry) => entry.id === payload.assetId);
        if (!asset && client.listAssets) {
          const result = await client.listAssets();
          if (!active(token) || timeline?.revision !== revision) return;
          libraryAssets = Array.isArray(result) ? result : result?.assets || [];
          asset = libraryAssets.find((entry) => entry.id === payload.assetId);
        }
        if (!asset) throw new Error('This media is no longer available. Refresh the Media drawer and try again.');
        if (!compatibleAsset(asset, track)) throw new Error(`This media is not compatible with the ${track.name || track.type} track. Use a ${asset.mimeType?.startsWith('audio/') ? 'audio' : 'video'} track.`);
        preparing = false;
        await addClip({ asset, trackId: track.id, startFrame, token, revision, owner });
      } catch (error) { if (active(token)) status(error.message || 'Could not drop this media.', true); }
      finally { if (active(token)) { preparing = false; updateControls(); } }
    }
    function walk(node, fn) { fn(node); for (const child of node.children || []) walk(child, fn); }
    function renderSelection() {
      const stale = !!selection && (selection.timelineRevision !== timeline?.revision || selection.timelineId !== timeline?.id);
      if (selection) { ui['range-start'].value = String(selection.startFrame); ui['range-end'].value = String(selection.endFrame); ui['range-track'].value = selection.trackIds.length === 1 ? selection.trackIds[0] : ''; }
      ui['selection-summary'].textContent = selection ? stale ? `Timeline changed after selection (revision ${selection.timelineRevision}). Select again before sending.` : `Selected frames [${selection.startFrame}, ${selection.endFrame}) · ${selection.trackIds.length} track${selection.trackIds.length === 1 ? '' : 's'} · ${selection.endFrame - selection.startFrame} frames · drag handles to adjust · next message` : 'Click a clip or drag a range. Drop media from the Media drawer onto a track.';
      ui['selection-summary'].dataset.stale = String(stale);
      walk(tracks, (node) => {
        if (node.dataset?.itemId) node.setAttribute('aria-pressed', String(selection?.itemIds.includes(node.dataset.itemId) || false));
        if (['range-start-handle', 'range-end-handle'].includes(node.dataset?.role)) {
          const edge = node.dataset.role === 'range-start-handle' ? 'start' : 'end';
          node.hidden = !selection || !selection.trackIds.includes(node.dataset.trackId);
          if (selection) {
            node.style.left = `${frameToPixels(selection[`${edge}Frame`], timeline.frameRate, pixelsPerSecond)}px`;
            node.setAttribute('aria-valuenow', selection[`${edge}Frame`]); node.setAttribute('aria-valuetext', `Frame ${selection[`${edge}Frame`]}${edge === 'end' ? ', exclusive' : ''}`);
            node.setAttribute('aria-valuemin', edge === 'start' ? 0 : selection.startFrame + 1); node.setAttribute('aria-valuemax', edge === 'start' ? selection.endFrame - 1 : visibleEndFrame());
          }
        }
        if (node.dataset?.role === 'range-highlight') {
          node.dataset.stale = String(stale);
          node.hidden = !selection || !selection.trackIds.includes(node.dataset.trackId);
          if (selection) { node.style.left = `${frameToPixels(selection.startFrame, timeline.frameRate, pixelsPerSecond)}px`; node.style.width = `${frameToPixels(selection.endFrame - selection.startFrame, timeline.frameRate, pixelsPerSecond)}px`; }
        }
      });
      updateControls();
    }
    function selectSpan(trackIds, startFrame, endFrame, itemIds, commit = true) {
      if (!timeline || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < 0 || endFrame <= startFrame || endFrame > MAX_FRAME) return;
      const chosenItems = itemIds || timeline.items.filter((item) => trackIds.includes(item.trackId) && item.startFrame < endFrame && item.endFrame > startFrame).map((item) => item.id);
      selection = { projectId, timelineId: timeline.id, timelineRevision: timeline.revision, trackIds: [...trackIds], itemIds: [...chosenItems], startFrame, endFrame };
      ui['range-start'].value = String(startFrame); ui['range-end'].value = String(endFrame); ui['range-track'].value = trackIds.length === 1 ? trackIds[0] : '';
      if (commit) inspectedItemId = chosenItems.length === 1 ? chosenItems[0] : '';
      renderSelection(); if (commit) { renderInspector(); onSelection(copy(selection)); }
    }
    function selectClip(itemId) {
      const item = timeline?.items.find((entry) => entry.id === itemId); if (!item) return;
      selectSpan([item.trackId], item.startFrame, item.endFrame, [item.id]); seek(item.startFrame);
    }
    function selectRange() {
      if (!timeline) return;
      try { const { startFrame, endFrame } = range('range-start', 'range-end'); const trackIds = ui['range-track'].value ? [ui['range-track'].value] : timeline.tracks.map((track) => track.id); selectSpan(trackIds, startFrame, endFrame); status('Range selected. Describe the edit in chat.'); }
      catch (error) { status(error.message, true); }
    }
    function clearSelection() {
      cancelRangeDrag(); const hadSelection = !!selection; selection = null; inspectedItemId = ''; renderSelection(); renderInspector(); if (hadSelection) onSelection(null);
    }
    function renderInspector() {
      const inspector = ui.inspector; const item = timeline?.items.find((entry) => entry.id === inspectedItemId);
      delete ui['save-clip']; delete ui['remove-clip'];
      if (!item) { sidebar.replaceChildren(add, inspector); inspector.replaceChildren(el('h3', '', 'Clip details'), el('p', 'timeline-help', 'Select one clip to trim, move or adjust its audio.')); return; }
      sidebar.replaceChildren(inspector, add);
      const title = el('h3', '', item.name || assets.find((asset) => asset.id === item.assetId)?.name || 'Clip details');
      const grid = el('div', 'timeline-inspector-grid');
      grid.append(field('Clip track', 'clip-track', 'select'), field('Start frame', 'clip-start', 'number', item.startFrame), field('End frame (exclusive)', 'clip-end', 'number', item.endFrame), field('Source in (seconds)', 'source-start', 'number', item.sourceStartSeconds), field('Source out (seconds)', 'source-end', 'number', item.sourceEndSeconds));
      trackOptions(ui['clip-track']); ui['clip-track'].value = item.trackId; ui['source-start'].step = '0.001'; ui['source-end'].step = '0.001';
      const isStill = assets.find((asset) => asset.id === item.assetId)?.mimeType?.startsWith('image/') || timeline.tracks.find((track) => track.id === item.trackId)?.type === 'overlay';
      if (!isStill) {
        grid.append(field('Audio gain (0–1)', 'clip-gain', 'number', item.gain ?? 1), field('Fade in (frames)', 'fade-in', 'number', item.fadeInFrames || 0), field('Fade out (frames)', 'fade-out', 'number', item.fadeOutFrames || 0)); ui['clip-gain'].step = '0.05'; ui['clip-gain'].max = '1';
      }
      const buttons = el('div', 'timeline-actions'); buttons.append(button('Save clip', 'save-clip', () => saveClip(item.id, isStill), 'button primary small'), button('Remove', 'remove-clip', () => mutate('applyTimeline', [{ type: 'remove', itemId: item.id }]), 'button quiet small'));
      inspector.replaceChildren(title, grid, buttons, el('p', 'timeline-help', 'Source timestamps are independent of project frames. Live preview maps the source span to the clip length.'));
      updateControls();
    }
    async function saveClip(itemId, isStill) {
      if (!canEdit()) return;
      try {
        const { startFrame, endFrame } = range('clip-start', 'clip-end');
        const sourceStartSeconds = numeric('source-start', { integer: false, max: 86400 }); const sourceEndSeconds = numeric('source-end', { integer: false, max: 86400 });
        if (sourceEndSeconds <= sourceStartSeconds) throw new Error('Source out must be after source in.');
        const item = timeline.items.find((entry) => entry.id === itemId); if (!item) return;
        const operations = [];
        if (ui['clip-track'].value !== item.trackId) operations.push({ type: 'move', itemId, trackId: ui['clip-track'].value, startFrame });
        operations.push({ type: 'trim', itemId, startFrame, endFrame, sourceStartSeconds, sourceEndSeconds });
        if (!isStill) operations.push({ type: 'set-audio-level', itemId, gain: numeric('clip-gain', { integer: false, max: 1 }), fadeInFrames: numeric('fade-in'), fadeOutFrames: numeric('fade-out') });
        await mutate('applyTimeline', operations);
      } catch (error) { status(error.message, true); }
    }
    async function readHistory(token) {
      if (!client.getTimelineHistory) return;
      try { const value = await client.getTimelineHistory(projectId); if (active(token)) { history = value; updateControls(); } } catch { if (active(token)) history = null; }
    }
    async function mutate(method, operations) {
      if (!canEdit()) return;
      cancelRangeDrag(); clearDropTarget();
      const token = generation, owner = projectId, revision = timeline.revision;
      mutating = true; readSequence += 1; pause(); updateControls();
      try {
        const result = await client[method](owner, { expectedRevision: revision, ...(operations ? { operations } : {}) });
        if (!active(token)) return;
        timeline = result; playhead = Math.min(playhead, durationFrames(timeline)); render(); status(method === 'undoTimeline' ? 'Edit undone.' : method === 'redoTimeline' ? 'Edit restored.' : 'Timeline saved. Source media is unchanged.'); await readHistory(token);
      } catch (error) { if (active(token)) status(`${error.message || 'Could not save the timeline.'}${/revision|conflict/i.test(error.message || '') ? ' Refresh, then select again.' : ''}`, true); }
      finally { if (active(token)) { mutating = false; updateControls(); } }
    }
    async function addClip(drop) {
      if (!canEdit()) return;
      const asset = drop?.asset || pickerAssets().find((entry) => entry.id === ui['add-asset'].value); const trackId = drop?.trackId || ui['add-track'].value;
      if (!asset || !timeline.tracks.some((track) => track.id === trackId)) return;
      const token = generation, originalRevision = timeline.revision;
      if (drop?.asset && (drop.token !== token || drop.revision !== originalRevision || drop.owner !== projectId)) return;
      preparing = true; updateControls();
      try {
        if (!compatibleAsset(asset, timeline.tracks.find((track) => track.id === trackId))) throw new Error('Choose a compatible destination track.');
        if (!assets.some((entry) => entry.id === asset.id)) {
          if (!client.attachProjectAsset) throw new Error('Attach this media to the project first.');
          await client.attachProjectAsset(projectId, asset.id);
          if (!active(token)) return;
          assets = await readAssets(projectId, token);
          if (!active(token) || timeline?.revision !== originalRevision) return;
          if (!assets.some((entry) => entry.id === asset.id)) assets.push(asset);
        }
        const isStill = asset.mimeType.startsWith('image/');
        let sourceDurationSeconds = isStill ? numeric('image-duration', { integer: false, min: 0.1, max: 3600 }) : asset.duration;
        if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
          status('Reading source duration…'); ui['add-clip'].disabled = true;
          sourceDurationSeconds = await measureDuration(asset, token);
        }
        if (!active(token) || timeline.revision !== originalRevision) return;
        preparing = false; if (!canEdit()) return;
        const count = Math.floor(sourceDurationSeconds * fps(timeline.frameRate));
        if (count < 1) throw new Error('This source is shorter than one project frame.');
        const startFrame = drop?.asset ? drop.startFrame : Math.max(0, ...timeline.items.filter((item) => item.trackId === trackId).map((item) => item.endFrame));
        if (startFrame + count > MAX_FRAME) throw new Error('This clip extends beyond the timeline frame limit. Drop it earlier.');
        if (timeline.items.some((item) => item.trackId === trackId && item.startFrame < startFrame + count && item.endFrame > startFrame)) throw new Error('That space overlaps another clip. Drop into an empty gap or after the last clip.');
        const id = `clip-${host.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${++itemCounter}`}`;
        await mutate('applyTimeline', [{ type: 'insert', item: { id, trackId, startFrame, endFrame: startFrame + count, assetId: asset.id, name: String(asset.name || 'Untitled clip').slice(0, 120).replace(/[\uD800-\uDBFF]$/, ''), sourceStartSeconds: 0, sourceEndSeconds: count / fps(timeline.frameRate), ...(!isStill ? { sourceDurationSeconds } : {}) } }]);
      } catch (error) { if (active(token)) status(error.message || 'Could not add this media.', true); }
      finally { if (active(token)) { preparing = false; updateControls(); } }
    }

    async function importMedia() {
      if (!canEdit() || !client.importMedia) return;
      const token = generation, owner = projectId; preparing = true; updateControls();
      try {
        const result = await client.importMedia(owner);
        if (!active(token)) return;
        assets = await readAssets(owner, token);
        if (!active(token)) return;
        ui['media-source'].value = 'project'; renderAssets();
        if (!result?.canceled) status('Media imported. Choose a track and add a clip.');
      } catch (error) { if (active(token)) status(`Could not import media. ${error.message}`, true); }
      finally { if (active(token)) { preparing = false; updateControls(); } }
    }
    async function readAssets(owner, token) {
      const found = new Map(); let offset = 0, pages = 0;
      while (found.size < 2000 && pages++ < 10) {
        const result = await client.getProjectAssets(owner, { offset, limit: 200 });
        if (!active(token)) return [];
        const page = Array.isArray(result) ? result : result?.assets || [];
        for (const asset of page) if (asset.id && found.size < 2000) found.set(asset.id, asset);
        const next = result?.nextOffset;
        if (!Number.isSafeInteger(next) || next <= offset) break;
        offset = next;
      }
      return [...found.values()];
    }
    async function exportTimeline() {
      if (!canEdit() || !host.EaselVideoExport?.exportVideoTimeline || !client.saveTimelineExport || !durationFrames(timeline)) return;
      const token = generation, owner = projectId, snapshot = copy(timeline);
      const Controller = host.AbortController || root.AbortController;
      const controller = new Controller(); exportController = controller; exporting = true; ui['cancel-export'].disabled = false; pause(); updateControls();
      status('Preparing video export…');
      try {
        const media = await host.EaselVideoExport.exportVideoTimeline({
          timeline: snapshot, getAsset: (assetId) => client.getProjectAsset(owner, assetId), signal: controller.signal, name: 'Timeline.webm',
          onProgress: ({ phase, progress }) => { if (active(token)) status(`${phase === 'preparing' ? 'Preparing' : phase === 'finalizing' ? 'Finishing' : 'Rendering'} video · ${Math.round(clamp(progress || 0, 0, 1) * 100)}%`); },
        });
        if (!active(token) || controller.signal.aborted) return;
        ui['cancel-export'].disabled = true; status('Saving video to Media…');
        const saved = await client.saveTimelineExport(owner, { expectedRevision: snapshot.revision, media });
        if (!active(token)) return;
        status(saved?.warning || `Saved ${saved?.name || media.name || 'video'} to Media. Open the Media library to play or download it.`);
        try { assets = await readAssets(owner, token); if (active(token)) renderAssets(); } catch { /* Saving succeeded; refreshing media must not retry or relabel the save. */ }
      } catch (error) { if (active(token)) status(error.name === 'AbortError' || controller.signal.aborted ? 'Video export canceled.' : `Export failed: ${error.message || 'Please retry with supported media.'}`, error.name !== 'AbortError' && !controller.signal.aborted); }
      finally { if (active(token)) { exporting = false; exportController = null; updateControls(); } }
    }

    async function loadMedia(assetId, token) {
      if (cache.has(assetId)) { const result = cache.get(assetId); result.usedAt = Date.now(); return result; }
      if (pendingMedia.has(assetId)) return pendingMedia.get(assetId);
      const owner = projectId;
      const promise = (async () => {
        const metadata = assets.find((asset) => asset.id === assetId);
        if (metadata?.bytes > MAX_MEDIA_BYTES) throw new Error('This source exceeds the 64 MiB live-preview limit. Use a smaller proxy.');
        const request = mediaFetchTail.then(() => active(token) ? client.getProjectAsset(owner, assetId) : null);
        mediaFetchTail = request.catch(() => {});
        const media = await request;
        if (!active(token)) return null;
        if (!MEDIA_TYPE.test(media.mimeType || '')) throw new Error('This media type cannot be previewed. Use MP4/WebM, supported audio, or a raster image.');
        if (typeof media.data !== 'string' || !media.data.length || media.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new Error('This source is empty or exceeds the 64 MiB live-preview limit. Use a smaller proxy.');
        const binary = decodeBase64(media.data); const bytes = binary.length;
        if (bytes > MAX_MEDIA_BYTES) throw new Error('This source exceeds the 64 MiB live-preview limit. Use a smaller proxy.');
        const activeAssets = new Set(getPreviewLayers(timeline, playhead).map((layer) => layer.item.assetId));
        for (const [key, entry] of [...cache].sort((a, b) => a[1].usedAt - b[1].usedAt)) {
          if (cachedBytes + bytes <= MAX_CACHE_BYTES) break;
          if (!activeAssets.has(key)) { urlApi.revokeObjectURL(entry.url); cachedBytes -= entry.bytes; cache.delete(key); }
        }
        if (cachedBytes + bytes > MAX_CACHE_BYTES) throw new Error('Active media exceeds the 128 MiB preview budget. Use smaller proxies or fewer overlapping sources.');
        const buffer = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const entry = { url: urlApi.createObjectURL(new BlobType([buffer], { type: media.mimeType })), mimeType: media.mimeType, bytes, usedAt: Date.now() };
        cache.set(assetId, entry); cachedBytes += bytes; return entry;
      })();
      pendingMedia.set(assetId, promise);
      try { return await promise; } finally { if (pendingMedia.get(assetId) === promise) pendingMedia.delete(assetId); }
    }
    async function measureDuration(asset, token) {
      const entry = await loadMedia(asset.id, token); if (!entry || !active(token)) throw new Error('Project changed while reading media.');
      const media = document.createElement(asset.mimeType.startsWith('audio/') ? 'audio' : 'video'); media.preload = 'metadata'; media.muted = true;
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); media.removeEventListener('loadedmetadata', done); media.removeEventListener('error', failed); media.removeAttribute('src'); media.load?.(); probeCleanups.delete(cancel); };
        const done = () => { const value = media.duration; cleanup(); Number.isFinite(value) && value > 0 && value <= 86400 ? resolve(value) : reject(new Error('Source duration is unavailable. Re-import a finite, playable media file.')); };
        const failed = () => { cleanup(); reject(new Error('Cannot read this source. Re-import it in a browser-supported format.')); };
        const cancel = () => { cleanup(); reject(new Error('Project closed.')); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Reading media timed out. Try a smaller, browser-supported file.')); }, 15000);
        probeCleanups.add(cancel); media.addEventListener('loadedmetadata', done); media.addEventListener('error', failed); media.src = entry.url; media.load?.(); if (media.readyState >= 1) done();
      });
    }
    function disposeNode(record) {
      record.node.pause?.(); record.node.removeAttribute('src'); record.node.load?.(); record.node.remove();
    }
    function disposeMediaNodes() { for (const record of mediaNodes.values()) disposeNode(record); mediaNodes.clear(); }
    function disposePreview() {
      pause(); for (const cleanup of [...probeCleanups]) cleanup(); disposeMediaNodes();
      for (const entry of cache.values()) urlApi.revokeObjectURL(entry.url); cache.clear(); pendingMedia.clear(); mediaErrors.clear(); cachedBytes = 0; mediaFetchTail = Promise.resolve();
    }
    function syncMedia(record, layer) {
      const node = record.node;
      if (record.kind === 'img') return;
      try {
        if (!playing || Math.abs(node.currentTime - layer.sourceTime) > 0.18) node.currentTime = layer.sourceTime;
        node.playbackRate = layer.playbackRate; node.muted = false; node.volume = clamp(layer.gain, 0, 1);
        if (playing && node.paused && !record.starting) {
          record.starting = true; const token = generation;
          Promise.resolve(node.play()).catch((error) => { if (active(token) && mediaNodes.get(layer.item.id) === record) { pause(); mediaErrors.set(layer.item.assetId, `Playback was blocked: ${error.message || 'press Play to retry'}`); renderPreview(); } }).finally(() => { record.starting = false; });
        } else if (!playing) node.pause?.();
      } catch (error) { mediaErrors.set(layer.item.assetId, `Cannot play this source range: ${error.message || 'unsupported timing'}. Adjust source in/out or re-import the media.`); }
    }
    function renderPreview() {
      if (!timeline || closed) return;
      const token = generation, layers = getPreviewLayers(timeline, playhead), ids = new Set(layers.map((layer) => layer.item.id));
      for (const [id, record] of mediaNodes) if (!ids.has(id)) { disposeNode(record); mediaNodes.delete(id); }
      let waiting = false;
      for (const [index, layer] of layers.entries()) {
        const assetId = layer.item.assetId;
        if (mediaErrors.has(assetId)) continue;
        let record = mediaNodes.get(layer.item.id);
        if (!record) {
          const entry = cache.get(assetId);
          if (!entry) {
            waiting = true;
            if (!pendingMedia.has(assetId)) loadMedia(assetId, token).then(() => { if (active(token)) renderPreview(); }).catch((error) => { if (active(token)) { mediaErrors.set(assetId, error.message || 'Source unavailable.'); renderPreview(); } });
            continue;
          }
          const kind = entry.mimeType.startsWith('image/') ? 'img' : entry.mimeType.startsWith('audio/') ? 'audio' : 'video';
          const node = el(kind, `timeline-preview-layer timeline-preview-${layer.type}`); node.alt = layer.item.name || 'Timeline image'; node.preload = 'auto'; node.playsInline = true; node.controls = false; node.draggable = false;
          node.addEventListener('error', () => { if (active(token) && mediaNodes.get(layer.item.id)?.node === node) { mediaErrors.set(assetId, 'Source cannot be decoded. Re-import a browser-supported file, then retry.'); renderPreview(); } });
          node.addEventListener('loadedmetadata', () => { const currentLayer = getPreviewLayers(timeline, playhead).find((entry) => entry.item.id === layer.item.id); if (active(token) && currentLayer && mediaNodes.get(layer.item.id)?.node === node) syncMedia(mediaNodes.get(layer.item.id), currentLayer); });
          record = { node, kind }; mediaNodes.set(layer.item.id, record); node.src = entry.url; mediaSurface.append(node);
        }
        record.node.style.zIndex = String(index); syncMedia(record, layer);
      }
      const failures = layers.map((layer) => mediaErrors.get(layer.item.assetId)).filter(Boolean);
      previewEmpty.hidden = layers.some((layer) => layer.type !== 'audio') && !waiting && !failures.length;
      previewEmpty.textContent = failures.length ? 'Preview unavailable for this source.' : waiting ? 'Loading project media…' : layers.length ? 'Audio preview' : timeline.items.length ? 'No visual clip at this frame.' : 'Add project media to start your edit.';
      ui['preview-status'].textContent = failures[0] || ''; ui['retry-preview'].hidden = !failures.length;
      ui.seek.max = String(Math.max(1, durationFrames(timeline))); ui.seek.value = String(playhead);
      ui.timecode.textContent = `${playhead} / ${durationFrames(timeline)} f`; ui.timecode.setAttribute('aria-label', `Frame ${playhead} of ${durationFrames(timeline)}`);
      walk(tracks, (node) => { if (node.dataset?.role === 'playhead') node.style.left = `${frameToPixels(playhead, timeline.frameRate, pixelsPerSecond)}px`; });
      updateControls();
    }
    function pause() {
      playing = false; if (animation !== null) cancelRaf(animation); animation = null;
      for (const record of mediaNodes.values()) record.node.pause?.(); if (ui.play) ui.play.textContent = 'Play';
    }
    function seek(frame) { if (!timeline || !Number.isFinite(frame)) return; pause(); playhead = clamp(Math.round(frame), 0, durationFrames(timeline)); renderPreview(); }
    function togglePlayback() {
      if (playing) { pause(); return; }
      if (!timeline || !durationFrames(timeline) || closed) return;
      if (playhead >= durationFrames(timeline)) playhead = 0;
      playing = true; playOrigin = playhead; startedAt = now(); ui.play.textContent = 'Pause'; renderPreview();
      const token = generation;
      const tick = (timestamp) => {
        if (!active(token) || !playing) return;
        playhead = Math.min(durationFrames(timeline), playOrigin + Math.floor((timestamp - startedAt) / 1000 * fps(timeline.frameRate)));
        if (playhead >= durationFrames(timeline)) pause(); renderPreview();
        if (playing) animation = raf(tick);
      };
      animation = raf(tick);
    }
    async function load(token, createMissing) {
      const request = ++readSequence, owner = projectId; loading = true; updateControls();
      try {
        let next = await client.readTimeline(owner); if (!active(token) || request !== readSequence) return;
        if (!next && createMissing) next = await client.createTimeline(owner, {});
        if (!active(token) || request !== readSequence) return;
        if (!next) throw new Error('This project has no timeline. Close and reopen Timeline to create one.');
        const result = await readAssets(owner, token); if (!active(token) || request !== readSequence) return;
        assets = result; timeline = next; playhead = Math.min(playhead, durationFrames(timeline));
        render(); status(''); await readHistory(token);
      } catch (error) { if (active(token) && request === readSequence) status(`${error.message || 'Could not open the timeline.'} Use Refresh to try again.`, true); }
      finally { if (active(token) && request === readSequence) { loading = false; updateControls(); } }
    }
    async function open(nextProjectId) {
      if (destroyed) throw new Error('Timeline view has been destroyed.');
      if (typeof nextProjectId !== 'string' || !nextProjectId) throw new Error('Open a project before using Timeline.');
      cancelRangeDrag(); clearDropTarget(); generation += 1; exportController?.abort(); exportController = null; exporting = false; preparing = false; disposePreview(); closed = false; projectId = nextProjectId; timeline = null; assets = []; libraryAssets = []; ui['media-source'].value = 'project'; ui['media-search'].value = ''; ui['media-filter'].value = ''; history = null; inspectedItemId = ''; playhead = 0; mutating = false;
      if (selection) { selection = null; onSelection(null); }
      container.hidden = false; tracks.replaceChildren(); ui.inspector.replaceChildren(); ui['add-asset'].replaceChildren(); status('Opening timeline…'); render();
      await load(generation, true);
    }
    async function refresh() { if (closed || destroyed || mutating || preparing || exporting) return; cancelRangeDrag(); pause(); await load(generation, true); }
    function close() { cancelRangeDrag(); clearDropTarget(); generation += 1; exportController?.abort(); exportController = null; exporting = false; preparing = false; closed = true; loading = false; mutating = false; disposePreview(); projectId = ''; timeline = null; assets = []; history = null; clearSelection(); container.hidden = true; }
    function destroy() { if (destroyed) return; close(); destroyed = true; container.replaceChildren(); }
    function setBusy(value) { explicitlyBusy = !!value; if (value) { cancelRangeDrag(); clearDropTarget(); } updateControls(); renderSelection(); }
    return { open, refresh, getSelection: () => copy(selection), clearSelection, close, destroy, setBusy };
  }
  const api = { createVideoTimelineView, frameToPixels, pixelToFrame, getPreviewLayers };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.createVideoTimelineView = createVideoTimelineView;
}(typeof window !== 'undefined' ? window : globalThis));
