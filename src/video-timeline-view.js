(function exposeTimelineView(root) {
  'use strict';
  const PIXELS_PER_SECOND = 72;
  const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
  const MAX_CACHE_BYTES = 128 * 1024 * 1024;
  const MAX_FRAME = 10_000_000;
  const MAX_DELETE_CLIPS = 100;
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

  function createVideoTimelineView({ document, container, client, onSelection = () => {}, onStatus = () => {}, onClose, isBusy = () => false, confirmDeleteTrack }) {
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
    let pickerSequence = 0, deleteConfirmation = null;
    let history = null, libraryAssets = [], exportController = null, preparing = false, exporting = false, playhead = 0, playing = false, animation = null, playOrigin = 0, startedAt = 0;
    let pixelsPerSecond = PIXELS_PER_SECOND, inspectedItemId = '', drag = null, dropTarget = null, suppressClick = false;
    let cachedBytes = 0, itemCounter = 0, mediaFetchTail = Promise.resolve();
    const cache = new Map(), pendingMedia = new Map(), mediaErrors = new Map(), mediaNodes = new Map(), probeCleanups = new Set();
    const ui = {}, editControls = [];
    const active = (token) => !closed && !destroyed && generation === token;
    const canEdit = () => !closed && !!timeline && !loading && !mutating && !preparing && !exporting && !deleteConfirmation && !explicitlyBusy && !isBusy();
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

    const shell = el('section', 'video-timeline'); shell.tabIndex = -1; shell.setAttribute('aria-label', 'Video timeline editor');
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
    const previewEmpty = el('p', 'timeline-preview-empty', 'Drag media from the Media drawer onto a track to start your edit.', 'preview-empty');
    const mediaSurface = el('div', 'timeline-preview-media', undefined, 'preview-media'); stage.append(mediaSurface, previewEmpty);
    const transport = el('div', 'timeline-transport');
    transport.append(button('Play', 'play', () => togglePlayback(), 'button primary small'), button('Previous frame', 'previous-frame', () => seek(playhead - 1), 'button quiet small'), button('Next frame', 'next-frame', () => seek(playhead + 1), 'button quiet small'));
    const seekInput = el('input', 'timeline-seek', undefined, 'seek'); seekInput.type = 'range'; seekInput.min = '0'; seekInput.step = '1'; seekInput.value = '0'; seekInput.setAttribute('aria-label', 'Preview frame');
    seekInput.addEventListener('input', () => seek(Number(seekInput.value))); seekInput.addEventListener('change', () => seek(Number(seekInput.value)));
    transport.append(seekInput, el('output', 'timeline-timecode', '', 'timecode'));
    const previewFooter = el('div', 'timeline-preview-footer');
    previewFooter.append(el('span', '', 'Live preview · browser timing'), el('span', '', '', 'preview-status'), button('Retry media', 'retry-preview', () => { mediaErrors.clear(); disposeMediaNodes(); renderPreview(); })); ui['retry-preview'].hidden = true;
    preview.append(previewViewport, transport, previewFooter);
    const contextBar = el('section', 'timeline-context'); contextBar.setAttribute('aria-label', 'Timeline editing controls');
    const add = el('details', 'timeline-add', undefined, 'add-picker'); add.open = false;
    add.append(el('summary', '', 'Add clip'));
    const addFields = el('div', 'timeline-add-fields');
    addFields.append(field('Media', 'add-asset', 'select'), field('Destination track', 'add-track', 'select'), field('Still image length (seconds)', 'image-duration', 'number', 5));
    ui['image-duration'].min = '0.1'; ui['image-duration'].step = '0.1';
    const addNote = el('p', 'timeline-help', 'Drag from the Media drawer, or choose a clip here.', 'add-note');
    add.append(addFields, button('Add clip', 'add-clip', addClip, 'button primary small'), addNote);
    add.addEventListener('toggle', async () => { if (add.open) await refreshPicker(); });
    ui['add-asset'].addEventListener('change', updateAssetChoices);
    const inspector = el('details', 'timeline-inspector', undefined, 'inspector'); inspector.open = false; inspector.hidden = true;
    workbench.append(preview);
    const exactRange = el('details', 'timeline-exact-range'); exactRange.open = false; exactRange.append(el('summary', '', 'Exact selection'));
    const rangeBar = el('section', 'timeline-rangebar'); rangeBar.setAttribute('aria-label', 'Exact frame range');
    rangeBar.append(field('Start frame', 'range-start', 'number', 0), field('End frame (exclusive)', 'range-end', 'number', 24), field('Selection track', 'range-track', 'select'), button('Select range', 'select-range', selectRange), button('Clear', 'clear-selection', clearSelection, 'button quiet small'));
    exactRange.append(rangeBar); contextBar.append(add, inspector, exactRange);
    const selectionSummary = el('p', 'timeline-selection-summary', 'Select a clip or frame range to attach it to your next message.', 'selection-summary'); selectionSummary.setAttribute('aria-live', 'polite');
    const timelineToolbar = el('div', 'timeline-track-toolbar'); timelineToolbar.append(selectionSummary, button('Delete clip', 'remove-clip', deleteSelectedClips, 'button outline small timeline-delete'), button('Add video track', 'add-video-track', addVideoTrack), button('Clear selection', 'clear-range', clearSelection, 'button quiet small'), field('Zoom', 'zoom', 'range', PIXELS_PER_SECOND));
    ui.zoom.min = '24'; ui.zoom.max = '160'; ui.zoom.step = '8'; ui.zoom.addEventListener('input', () => { pixelsPerSecond = Number(ui.zoom.value); renderTracks(); });
    const tracksViewport = el('div', 'timeline-tracks-viewport', undefined, 'tracks-viewport');
    const tracks = el('div', 'timeline-tracks', undefined, 'tracks'); tracksViewport.append(tracks);
    tracksViewport.addEventListener('dragleave', (event) => {
      if (tracksViewport.contains?.(event.relatedTarget)) return;
      const box = tracksViewport.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX >= box.left + box.width || event.clientY < box.top || event.clientY >= box.top + box.height) clearDropTarget();
    });
    const statusNode = el('p', 'timeline-status', '', 'status'); statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite');
    shell.append(header, workbench, contextBar, timelineToolbar, tracksViewport, statusNode); container.replaceChildren(shell); container.hidden = true;
    editControls.push(ui['add-video-track'], ui['add-asset'], ui['add-track'], ui['image-duration'], ui['add-clip']);
    shell.addEventListener('keydown', (event) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!event.defaultPrevented && !event.repeat && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && canEdit() && !drag && selectionOwnsFocus(event.target) && selectedClipCount() <= MAX_DELETE_CLIPS) { event.preventDefault(); deleteSelectedClips(); }
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); if (drag) cancelRangeDrag(); else clearSelection(); clearDropTarget(); return; }
      if (event.defaultPrevented || ['INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(event.target?.tagName) || event.target?.isContentEditable) return;
      if (event.target?.tagName === 'BUTTON' && !['clip-body', 'track-select', 'clip-trim-start', 'clip-trim-end', 'range-start-handle', 'range-end-handle'].includes(event.target.dataset?.role)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); mutate(event.shiftKey ? 'redoTimeline' : 'undoTimeline'); return; }
      if (event.key === ' ') { event.preventDefault(); togglePlayback(); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(playhead + (event.key === 'ArrowLeft' ? -1 : 1)); }
    });

    function updateControls() {
      const editable = canEdit();
      for (const control of editControls) control.disabled = !editable;
      ui['add-clip'].disabled = !editable || !pickerAssets().some((asset) => asset.id === ui['add-asset'].value);
      ui.undo.disabled = !editable || history?.undoAvailable === false;
      ui.redo.disabled = !editable || history?.redoAvailable === false;
      ui.refresh.disabled = loading || mutating || preparing || exporting || !!deleteConfirmation || closed;
      ui.export.disabled = !editable || !durationFrames(timeline) || !host.EaselVideoExport?.exportVideoTimeline || !client.saveTimelineExport;
      ui.export.title = host.EaselVideoExport?.exportVideoTimeline ? 'Render a video and save it to the Media library' : 'Video export runtime is unavailable in this project';
      ui['cancel-export'].hidden = !exporting;
      ui.play.disabled = !timeline || !durationFrames(timeline) || loading;
      ui.seek.disabled = !timeline || !durationFrames(timeline) || loading;
      ui['previous-frame'].disabled = !timeline || playhead <= 0;
      ui['next-frame'].disabled = !timeline || playhead >= durationFrames(timeline);
      ui['select-range'].disabled = !timeline || loading;
      ui['clear-selection'].disabled = !selection; ui['clear-range'].disabled = !selection;
      ui['save-clip'] && (ui['save-clip'].disabled = !editable);
      const count = selectedClipCount();
      ui['remove-clip'].textContent = count > 1 ? `Delete selected clips (${count})` : 'Delete clip';
      ui['remove-clip'].disabled = !editable || !selectionCurrent() || !count || count > MAX_DELETE_CLIPS;
      ui['remove-clip'].title = count > MAX_DELETE_CLIPS ? 'Select up to 100 clips, or use Delete track for a whole track.' : 'Delete selected clips from the timeline. Undo restores them; source files stay in Media.';
      walk(tracks, (node) => {
        if (node.dataset?.role === 'remove-track') node.disabled = !editable;
        if (node.dataset?.role === 'track-up' || node.dataset?.role === 'track-down') node.disabled = !editable || (node.dataset.role === 'track-up' ? timeline?.tracks.at(-1)?.id : timeline?.tracks[0]?.id) === node.dataset.trackId;
        if (['clip-trim-start', 'clip-trim-end'].includes(node.dataset?.role)) node.disabled = !editable;
        if (['range-start-handle', 'range-end-handle'].includes(node.dataset?.role)) node.disabled = !editable || !selectionCurrent(); });
      shell.setAttribute('aria-busy', String(loading || mutating || preparing || exporting || !!deleteConfirmation));
    }
    function pickerAssets() {
      const found = new Map(assets.map(asset => [asset.id, asset]));
      for (const asset of libraryAssets) if (!found.has(asset.id)) found.set(asset.id, asset);
      return [...found.values()];
    }
    function updateAssetChoices() {
      const asset = pickerAssets().find((entry) => entry.id === ui['add-asset'].value);
      const isImage = asset?.mimeType?.startsWith('image/');
      ui['image-duration'].parentNode.hidden = !isImage;
      trackOptions(ui['add-track'], false, (track) => isImage ? track.type === 'video' || track.type === 'overlay' : asset?.mimeType?.startsWith('audio/') ? track.type === 'audio' : asset?.mimeType?.startsWith('video/') && track.type === 'video');
      updateControls();
    }
    function renderAssets() {
      const previous = ui['add-asset'].value;
      const supported = pickerAssets().filter((asset) => MEDIA_TYPE.test(asset.mimeType || '') && asset.id);
      ui['add-asset'].replaceChildren(...supported.map((asset) => option(asset.name || asset.id, asset.id)));
      ui['add-asset'].value = supported.some((asset) => asset.id === previous) ? previous : supported[0]?.id || '';
      ui['add-note'].textContent = supported.length ? 'Append to the chosen track. Library media is attached automatically; source files stay unchanged.' : 'Import or generate media in the Media drawer, then Refresh. You can also drag media directly onto a track.';
      updateAssetChoices();
    }
    async function refreshPicker() {
      if (!client.listAssets || closed || destroyed) return;
      const token = generation, owner = projectId, request = ++pickerSequence;
      try {
        const result = await client.listAssets();
        if (!active(token) || owner !== projectId || request !== pickerSequence) return;
        libraryAssets = Array.isArray(result) ? result : result?.assets || []; renderAssets();
      } catch (error) { if (active(token) && request === pickerSequence) status(`Could not load library media. Use Refresh to retry. ${error.message}`, true); }
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
      const ruler = el('div', 'timeline-ruler', undefined, 'ruler'); ruler.tabIndex = 0; ruler.setAttribute('role', 'slider'); ruler.setAttribute('aria-label', 'Timeline playhead'); ruler.setAttribute('aria-valuenow', playhead); ruler.setAttribute('aria-valuetext', `Frame ${playhead}`); ruler.setAttribute('aria-valuemin', '0'); ruler.setAttribute('aria-valuemax', String(durationFrames(timeline)));
      ruler.addEventListener('pointerdown', (event) => beginSeekDrag(event, ruler)); bindRangeGesture(ruler); ruler.style.width = `${width}px`;
      const spacing = Math.max(1, Math.ceil(64 / pixelsPerSecond), Math.ceil(end / fps(timeline.frameRate) / 500));
      for (let seconds = 0; seconds < end / fps(timeline.frameRate); seconds += spacing) {
        const tick = el('span', 'timeline-ruler-tick', String(Math.round(seconds * fps(timeline.frameRate)))); tick.style.left = `${seconds * pixelsPerSecond}px`; ruler.append(tick);
      }
      const rulerMarker = el('div', 'timeline-playhead'); rulerMarker.dataset.role = 'playhead'; rulerMarker.style.left = `${frameToPixels(playhead, timeline.frameRate, pixelsPerSecond)}px`; ruler.append(rulerMarker);
      rulerRow.append(ruler); rows.push(rulerRow);
      for (const track of [...timeline.tracks].reverse()) {
        const row = el('div', `timeline-track-row timeline-track-${track.type}`);
        const trackHeader = el('div', 'timeline-track-label');
        const trackButton = button(track.name || track.type, '', () => { if (suppressClick) { suppressClick = false; return; } selectSpan([track.id], 0, Math.max(1, durationFrames(timeline))); }, 'timeline-track-name');
        trackButton.title = 'Drag the track header to change layer order. Highest track appears in front.';
        trackButton.addEventListener('pointerdown', (event) => beginTrackDrag(event, track, trackButton)); bindRangeGesture(trackButton);
        const trackActions = el('div', 'timeline-track-order');
        for (const [direction, label] of [[1, 'up'], [-1, 'down']]) {
          const control = button(label === 'up' ? 'Up' : 'Down', '', () => reorderTrack(track.id, direction), 'timeline-track-order-button');
          control.dataset.role = `track-${label}`; control.dataset.trackId = track.id; control.setAttribute('aria-label', `Move ${track.name || track.type} ${label}`);
          control.disabled = !canEdit() || (direction === 1 ? timeline.tracks.at(-1)?.id : timeline.tracks[0]?.id) === track.id; trackActions.append(control);
        }
        const clipCount = timeline.items.filter(item => item.trackId === track.id).length;
        const identity = { token: generation, timelineId: timeline.id, revision: timeline.revision };
        const removeTrack = button('Delete track', '', () => { if (shell.contains(removeTrack)) return deleteTrack(track.id, identity); }, 'timeline-track-order-button timeline-delete');
        removeTrack.dataset.role = 'remove-track'; removeTrack.dataset.trackId = track.id;
        removeTrack.setAttribute('aria-label', `Delete ${track.name || track.type} track, ${clipCount} clip${clipCount === 1 ? '' : 's'}`);
        removeTrack.disabled = !canEdit(); trackActions.append(removeTrack);
        trackHeader.append(trackButton, el('span', 'timeline-track-count', `${clipCount} clip${clipCount === 1 ? '' : 's'}`), trackActions);
        trackButton.dataset.role = 'track-select'; trackButton.dataset.trackId = track.id; trackButton.setAttribute('aria-label', `Select ${track.name || track.type} track`);
        const lane = el('div', 'timeline-track-lane'); lane.tabIndex = 0; lane.dataset.role = 'track-lane'; lane.dataset.trackId = track.id; lane.style.width = `${width}px`; lane.style.backgroundSize = `${pixelsPerSecond}px 100%`; lane.setAttribute('aria-label', `${track.name || track.type} clips`);
        lane.addEventListener('pointerdown', (event) => {
          if (event.altKey && insideSelection(event, lane, track.id)) beginRangeDrag(event, lane, track.id, 'move');
          else if (event.target === lane) beginRangeDrag(event, lane, track.id);
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
          const clip = button('', '', () => { if (suppressClick) { suppressClick = false; return; } selectClip(item.id); }, 'timeline-clip'); clip.dataset.itemId = item.id; clip.dataset.role = 'clip-body'; clip.draggable = false;
          clip.addEventListener('pointerdown', (event) => { if (event.altKey && insideSelection(event, lane, track.id)) beginRangeDrag(event, lane, track.id, 'move', clip); else beginClipDrag(event, lane, item, clip); });
          clip.addEventListener('keydown', (event) => adjustClipKey(event, item)); bindRangeGesture(clip);
          const clipWidth = frameToPixels(item.endFrame - item.startFrame, timeline.frameRate, pixelsPerSecond);
          clip.style.left = `${frameToPixels(item.startFrame, timeline.frameRate, pixelsPerSecond)}px`; clip.style.width = `${clipWidth}px`; clip.style.paddingInline = `${Math.min(24, Math.max(0, (clipWidth - 4) / 4))}px`; clip.style.borderWidth = `${Math.min(1, clipWidth / 4)}px`;
          const name = item.name || assets.find((asset) => asset.id === item.assetId)?.name || 'Untitled clip';
          clip.append(el('strong', '', name), el('span', '', `${item.startFrame}–${item.endFrame}`));
          clip.title = `${name} · frames ${item.startFrame} to ${item.endFrame} (exclusive)`; clip.setAttribute('aria-label', clip.title); clip.setAttribute('aria-pressed', String(selection?.itemIds.includes(item.id) || false));
          lane.append(clip);
          for (const edge of ['start', 'end']) {
            const handle = button('', '', () => {}, `timeline-clip-trim timeline-clip-trim-${edge}`); handle.dataset.role = `clip-trim-${edge}`; handle.dataset.clipId = item.id;
            handle.setAttribute('role', 'slider'); handle.setAttribute('aria-label', `Trim ${name} ${edge}`); handle.setAttribute('aria-valuenow', item[`${edge}Frame`]); handle.title = `Drag to trim clip ${edge}. Arrow keys: 1 frame; Shift + arrow: 10 frames.`;
            handle.style.left = `${frameToPixels(item[`${edge}Frame`], timeline.frameRate, pixelsPerSecond)}px`; handle.style.width = `${Math.min(24, clipWidth / 4)}px`;
            handle.addEventListener('pointerdown', (event) => { if (event.altKey && insideSelection(event, lane, track.id, true)) beginRangeDrag(event, lane, track.id, 'move', handle); else beginClipDrag(event, lane, item, handle, edge); }); handle.addEventListener('keydown', (event) => adjustClipKey(event, item, edge)); bindRangeGesture(handle); lane.append(handle);
          }
        }
        const marker = el('div', 'timeline-playhead'); marker.dataset.role = 'playhead'; marker.style.left = `${frameToPixels(playhead, timeline.frameRate, pixelsPerSecond)}px`; lane.append(marker);
        row.append(trackHeader, lane); rows.push(row);
      }
      tracks.replaceChildren(...rows); renderSelection();
    }
    function visibleEndFrame() {
      return Math.min(MAX_FRAME, Math.max(durationFrames(timeline) + Math.ceil(fps(timeline.frameRate)), Math.ceil(fps(timeline.frameRate) * 8), selection?.endFrame || 0));
    }
    function selectionCurrent() { return !!selection && selection.projectId === projectId && selection.timelineRevision === timeline?.revision && selection.timelineId === timeline?.id; }
    function frameAt(event, lane, end = visibleEndFrame()) {
      return clamp(pixelToFrame(event.clientX - lane.getBoundingClientRect().left, timeline.frameRate, pixelsPerSecond), 0, end);
    }
    function laneAt(event, fallback) {
      if (!Number.isFinite(event.clientY)) return fallback;
      if (fallback) { const box = fallback.getBoundingClientRect(); if (event.clientY >= box.top && event.clientY < box.top + box.height) return fallback; }
      const lanes = []; walk(tracks, node => { if (node.dataset?.role === 'track-lane') lanes.push(node); });
      return lanes.find(node => { const box = node.getBoundingClientRect(); return event.clientY >= box.top && event.clientY < box.top + box.height; }) || fallback;
    }
    function crossedTracks(first, last) {
      const ids = [...timeline.tracks].reverse().map(track => track.id);
      const a = ids.indexOf(first), b = ids.indexOf(last);
      return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    }
    function insideSelection(event, lane, trackId, includeEnd = false) {
      const frame = frameAt(event, lane);
      return selectionCurrent() && selection.trackIds.includes(trackId) && frame >= selection.startFrame && (includeEnd ? frame <= selection.endFrame : frame < selection.endFrame);
    }
    function beginSeekDrag(event, ruler) {
      if (!timeline || drag || loading || event.button !== undefined && event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); ruler.focus?.();
      drag = { kind: 'seek', target: ruler, lane: ruler, pointerId: event.pointerId, token: generation, revision: timeline.revision, end: durationFrames(timeline) };
      ruler.setPointerCapture?.(event.pointerId); seek(frameAt(event, ruler, drag.end));
    }
    function snapFrame(frame, item, edge, event) {
      if (event?.shiftKey) return frame;
      const span = item.endFrame - item.startFrame, targets = [0, playhead];
      for (const other of timeline.items) if (other.id !== item.id) targets.push(other.startFrame, other.endFrame);
      const tolerance = Math.max(1, pixelToFrame(6, timeline.frameRate, pixelsPerSecond));
      let best = frame, distance = tolerance + 1;
      for (const target of targets) for (const candidate of edge ? [target] : [target, target - span]) {
        const delta = Math.abs(candidate - frame);
        if (delta < distance && delta <= tolerance) { best = candidate; distance = delta; }
      }
      return best;
    }
    function clipEdit(item, frameDelta, trackId, edge, event) {
      const candidate = copy(item), sourceTrack = timeline.tracks.find(track => track.id === item.trackId);
      const asset = assets.find(entry => entry.id === item.assetId);
      const still = asset?.mimeType?.startsWith('image/') || sourceTrack.type === 'overlay';
      const secondsPerFrame = (item.sourceEndSeconds - item.sourceStartSeconds) / (item.endFrame - item.startFrame);
      const limit = Math.min(MAX_FRAME, Math.floor(86400 * fps(timeline.frameRate)));
      if (!edge) {
        candidate.startFrame = clamp(snapFrame(item.startFrame + frameDelta, item, null, event), 0, limit - (item.endFrame - item.startFrame));
        candidate.endFrame = candidate.startFrame + item.endFrame - item.startFrame; candidate.trackId = trackId;
      } else {
        const minimum = edge === 'start' ? Math.max(0, still ? 0 : item.startFrame - Math.floor(item.sourceStartSeconds / secondsPerFrame + 1e-6)) : item.startFrame + 1;
        const maximum = edge === 'start' ? item.endFrame - 1 : still ? limit : Math.min(limit, item.endFrame + Math.floor(((item.sourceDurationSeconds ?? asset?.duration ?? item.sourceEndSeconds) - item.sourceEndSeconds) / secondsPerFrame + 1e-6));
        const value = clamp(snapFrame(item[`${edge}Frame`] + frameDelta, item, edge, event), minimum, maximum);
        candidate[`${edge}Frame`] = value;
        if (still) { candidate.sourceStartSeconds = 0; candidate.sourceEndSeconds = (candidate.endFrame - candidate.startFrame) / fps(timeline.frameRate); }
        else {
          const key = edge === 'start' ? 'sourceStartSeconds' : 'sourceEndSeconds';
          candidate[key] = clamp(candidate[key] + (value - item[`${edge}Frame`]) * secondsPerFrame, 0, item.sourceDurationSeconds ?? asset?.duration ?? item.sourceEndSeconds);
        }
      }
      const target = timeline.tracks.find(track => track.id === candidate.trackId);
      if (!compatibleAsset(asset, target)) return { candidate, error: 'Choose a compatible track for this clip.' };
      if (timeline.items.some(other => other.id !== item.id && other.trackId === candidate.trackId && other.startFrame < candidate.endFrame && other.endFrame > candidate.startFrame)) return { candidate, error: 'That move overlaps another clip. Use an empty gap or another video track.' };
      const operation = edge ? {type: 'trim', itemId: item.id, startFrame: candidate.startFrame, endFrame: candidate.endFrame, sourceStartSeconds: candidate.sourceStartSeconds, sourceEndSeconds: candidate.sourceEndSeconds} : {type: 'move', itemId: item.id, trackId: candidate.trackId, startFrame: candidate.startFrame};
      const operations = [operation], span = candidate.endFrame - candidate.startFrame, fades = (item.fadeInFrames || 0) + (item.fadeOutFrames || 0);
      if (edge && fades > span) {
        const fadeInFrames = Math.floor((item.fadeInFrames || 0) * span / fades);
        operations.push({type: 'set-audio-level', itemId: item.id, fadeInFrames, fadeOutFrames: span - fadeInFrames});
      }
      if (['trackId', 'startFrame', 'endFrame', 'sourceStartSeconds', 'sourceEndSeconds'].every(key => candidate[key] === item[key])) return {candidate, operations: []};
      return {candidate, operations};
    }
    function beginClipDrag(event, lane, item, target, edge) {
      if (!canEdit() || drag || event.button !== undefined && event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); target.focus?.(); pause(); suppressClick = false;
      drag = {kind: 'clip', item: copy(item), lane, target, edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, token: generation, revision: timeline.revision, moved: false};
      target.setPointerCapture?.(event.pointerId);
    }
    function previewClipDrag(event) {
      if (Math.abs(event.clientX - drag.x) < 3 && (!Number.isFinite(event.clientY) || Math.abs(event.clientY - drag.y) < 3) && !drag.moved) return;
      drag.moved = true;
      const lane = drag.edge ? drag.lane : laneAt(event, drag.lane);
      const delta = Math.round((event.clientX - drag.x) / pixelsPerSecond * fps(timeline.frameRate));
      const edit = clipEdit(drag.item, delta, lane.dataset.trackId, drag.edge, event);
      drag.operations = edit.operations; drag.error = edit.error;
      if (!drag.ghost) { drag.ghost = el('div', 'timeline-clip-ghost'); drag.ghost.dataset.role = 'clip-ghost'; }
      // Reparent the visual only. The captured clip and durable timeline stay put until pointerup.
      if (drag.ghost.parentNode !== lane) { drag.ghost.remove(); lane.append(drag.ghost); }
      drag.ghost.style.left = `${frameToPixels(edit.candidate.startFrame, timeline.frameRate, pixelsPerSecond)}px`;
      drag.ghost.style.width = `${frameToPixels(edit.candidate.endFrame - edit.candidate.startFrame, timeline.frameRate, pixelsPerSecond)}px`;
      drag.ghost.dataset.invalid = String(!!edit.error); drag.ghost.textContent = `${edit.candidate.startFrame}–${edit.candidate.endFrame}`;
      status(edit.error || `${drag.edge ? 'Trim' : 'Move'} to frames ${edit.candidate.startFrame}–${edit.candidate.endFrame}. Shift bypasses snapping. Escape cancels.`, !!edit.error);
    }
    async function adjustClipKey(event, item, edge) {
      if (!canEdit() || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const result = clipEdit(item, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1), item.trackId, edge, {shiftKey:true});
      if (result.error) status(result.error, true); else await mutate('applyTimeline', result.operations);
    }
    async function addVideoTrack() {
      if (!canEdit()) return;
      if (timeline.tracks.length >= 128) { status('The timeline has reached its 128-track limit.', true); return; }
      let index = 1; while (timeline.tracks.some(track => track.id === `video-${index}`)) index++;
      await mutate('applyTimeline', [{type:'add-track', track:{id:`video-${index}`, type:'video', name:`Video ${index}`}}]);
    }
    function reorderTrack(trackId, direction) {
      const index = timeline?.tracks.findIndex(track => track.id === trackId) + direction;
      if (!canEdit() || index < 0 || index >= timeline.tracks.length) return;
      return mutate('applyTimeline', [{type:'reorder-track', trackId, index}]);
    }
    function beginTrackDrag(event, track, target) {
      if (!canEdit() || drag || event.button !== undefined && event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); target.focus?.(); suppressClick = false;
      drag = {kind:'track', trackId:track.id, target, pointerId:event.pointerId, y:event.clientY, token:generation, revision:timeline.revision, moved:false};
      target.setPointerCapture?.(event.pointerId);
    }
    function clearTrackFeedback() { walk(tracks, node => { if (node.dataset?.role === 'track-lane') delete node.dataset.reorderTarget; }); }
    function previewTrackDrag(event) {
      if (Math.abs(event.clientY - drag.y) < 4 && !drag.moved) return;
      drag.moved = true; clearTrackFeedback();
      const lane = laneAt(event, null); if (!lane) { drag.operations = null; return; }
      const index = timeline.tracks.findIndex(track => track.id === lane.dataset.trackId);
      drag.operations = lane.dataset.trackId === drag.trackId ? null : [{type:'reorder-track',trackId:drag.trackId,index}];
      lane.dataset.reorderTarget = 'true';
    }
    function beginRangeDrag(event, lane, trackId, edge, target = lane) {
      if (!canEdit() || drag || event.button !== undefined && event.button !== 0 || edge && !selectionCurrent()) return;
      event.preventDefault(); event.stopPropagation();
      target.focus?.();
      drag = { kind: 'range', trackId, lane, target, edge, pointerId: event.pointerId, frame: frameAt(event, lane), previous: copy(selection), fields: ['range-start', 'range-end', 'range-track'].map((role) => ui[role].value), token: generation, revision: timeline.revision, end: visibleEndFrame() };
      target.setPointerCapture?.(event.pointerId);
      if (!edge) previewRangeDrag(event);
    }
    function previewRangeDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!active(drag.token) || timeline?.revision !== drag.revision) { cancelRangeDrag(); return; }
      if (drag.kind === 'clip') { previewClipDrag(event); return; }
      if (drag.kind === 'track') { previewTrackDrag(event); return; }
      if (drag.kind === 'seek') { seek(frameAt(event, drag.lane, drag.end)); return; }
      const last = frameAt(event, drag.lane, drag.end);
      let start = drag.previous?.startFrame, end = drag.previous?.endFrame;
      if (drag.edge === 'move') { const delta = clamp(last - drag.frame, -start, drag.end - end); start += delta; end += delta; }
      else if (drag.edge === 'start') start = clamp(start + last - drag.frame, 0, end - 1);
      else if (drag.edge === 'end') end = clamp(end + last - drag.frame, start + 1, drag.end);
      else { start = Math.min(drag.frame, last, drag.end - 1); end = Math.max(drag.frame, last, start + 1); }
      selectSpan(drag.edge ? drag.previous.trackIds : crossedTracks(drag.trackId, laneAt(event, drag.lane).dataset.trackId), start, end, undefined, false);
    }
    async function finishRangeDrag(event) {
      setTimeout(() => { suppressClick = false; }, 0);
      if (!drag || drag.pointerId !== event.pointerId) return;
      previewRangeDrag(event); if (!drag) return;
      const gesture = drag; drag = null; gesture.target.releasePointerCapture?.(gesture.pointerId);
      gesture.ghost?.remove(); clearTrackFeedback();
      if (gesture.kind === 'seek') return;
      if (gesture.kind === 'clip' || gesture.kind === 'track') {
        suppressClick = gesture.moved;
        if (gesture.moved && gesture.operations?.length && !gesture.error) { await mutate('applyTimeline', gesture.operations); }
        else if (gesture.error) status(gesture.error, true);
        return;
      }
      if (gesture.edge === 'move') suppressClick = true;
      inspectedItemId = selection?.itemIds.length === 1 ? selection.itemIds[0] : ''; renderInspector(); onSelection(copy(selection));
    }
    function cancelRangeDrag() {
      if (!drag) return;
      const gesture = drag; drag = null; gesture.ghost?.remove(); clearTrackFeedback();
      if (gesture.kind !== 'range') { suppressClick = !!gesture.moved; gesture.target.releasePointerCapture?.(gesture.pointerId); return; }
      if (gesture.edge === 'move') suppressClick = true;
      selection = gesture.previous;
      gesture.target.releasePointerCapture?.(gesture.pointerId);
      ['range-start', 'range-end', 'range-track'].forEach((role, index) => { ui[role].value = gesture.fields[index]; }); renderSelection();
    }
    function bindRangeGesture(target) {
      target.addEventListener('pointermove', previewRangeDrag);
      target.addEventListener('pointerup', finishRangeDrag);
      target.addEventListener('pointercancel', (event) => { if (drag?.pointerId === event.pointerId) cancelRangeDrag(); });
      target.addEventListener('lostpointercapture', (event) => { if (drag?.target === target && drag.pointerId === event.pointerId) cancelRangeDrag(); });
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
        if (!Array.from(event.dataTransfer?.types || []).includes(MEDIA_DRAG_TYPE)) throw new Error('Drag media from the Media drawer. Import files in that drawer first.');
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
      ui['selection-summary'].textContent = selection ? stale ? `Timeline changed after selection (revision ${selection.timelineRevision}). Select again before sending.` : `Selected frames [${selection.startFrame}, ${selection.endFrame}) · ${selection.trackIds.length} track${selection.trackIds.length === 1 ? '' : 's'} · ${selection.endFrame - selection.startFrame} frames · drag handles to adjust · next message` : 'Drag clips to move · edges to trim · empty space to select · Alt/Option + drag moves the range · drag headers to stack';
      if (selection && !stale && selection.itemIds.length) ui['selection-summary'].textContent += ` · ${selection.itemIds.length} clip${selection.itemIds.length === 1 ? '' : 's'}`;
      if (selection && !stale && selection.itemIds.length > MAX_DELETE_CLIPS) ui['selection-summary'].textContent += ' · Select up to 100 clips to delete together, or use Delete track.';
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
      delete ui['save-clip'];
      inspector.hidden = !item;
      if (!item) { inspector.open = false; inspector.replaceChildren(); return; }
      const title = el('summary', '', `Clip details · ${item.name || assets.find((asset) => asset.id === item.assetId)?.name || 'Selected clip'}`);
      const grid = el('div', 'timeline-inspector-grid');
      grid.append(field('Clip track', 'clip-track', 'select'), field('Start frame', 'clip-start', 'number', item.startFrame), field('End frame (exclusive)', 'clip-end', 'number', item.endFrame), field('Source in (seconds)', 'source-start', 'number', item.sourceStartSeconds), field('Source out (seconds)', 'source-end', 'number', item.sourceEndSeconds));
      trackOptions(ui['clip-track']); ui['clip-track'].value = item.trackId; ui['source-start'].step = '0.001'; ui['source-end'].step = '0.001';
      const isStill = assets.find((asset) => asset.id === item.assetId)?.mimeType?.startsWith('image/') || timeline.tracks.find((track) => track.id === item.trackId)?.type === 'overlay';
      if (!isStill) {
        grid.append(field('Audio gain (0–1)', 'clip-gain', 'number', item.gain ?? 1), field('Fade in (frames)', 'fade-in', 'number', item.fadeInFrames || 0), field('Fade out (frames)', 'fade-out', 'number', item.fadeOutFrames || 0)); ui['clip-gain'].step = '0.05'; ui['clip-gain'].max = '1';
      }
      const buttons = el('div', 'timeline-actions'); buttons.append(button('Save clip', 'save-clip', () => saveClip(item.id, isStill), 'button primary small'));
      inspector.replaceChildren(title, el('p', 'timeline-help', 'Drag the clip to move it. Drag its side grips to trim.'), grid, buttons, el('p', 'timeline-help', 'Source timestamps are independent of project frames. Live preview maps the source span to the clip length.'));
      updateControls();
    }
    function selectedClipCount() { return selection?.itemIds.length || 0; }
    const modalOpen = () => !!document.querySelector?.('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
    function selectionOwnsFocus(target) {
      if (!selectionCurrent() || !selectedClipCount() || target !== document.activeElement || !shell.contains(target)) return false;
      if (modalOpen()) return false;
      for (let node = target; node; node = node.parentNode) {
        if (['INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY', 'DIALOG'].includes(node.tagName) || node.isContentEditable || ['true', '', 'plaintext-only'].includes(node.getAttribute?.('contenteditable')) || ['textbox', 'dialog', 'alertdialog'].includes(node.getAttribute?.('role'))) return false;
      }
      const role = target.dataset?.role;
      if (role === 'remove-clip') return true;
      if (['clip-body', 'clip-trim-start', 'clip-trim-end'].includes(role)) return selection.itemIds.includes(target.dataset.itemId || target.dataset.clipId);
      return ['track-select', 'track-lane', 'range-start-handle', 'range-end-handle'].includes(role) && selection.trackIds.includes(target.dataset.trackId);
    }
    async function deleteSelectedClips() {
      if (!canEdit() || !selectionCurrent() || !selectedClipCount()) return;
      const count = selectedClipCount();
      if (count > MAX_DELETE_CLIPS) { status('Select up to 100 clips to delete together, or use Delete track. No clips were deleted.', true); return; }
      await mutate('applyTimeline', selection.itemIds.map(itemId => ({ type: 'remove', itemId })), {
        clearSelection: true, message: `Deleted ${count} clip${count === 1 ? '' : 's'}. Undo restores them. Source files stay in Media.`,
      });
    }
    async function deleteTrack(trackId, identity) {
      if (!canEdit() || !active(identity.token) || timeline.id !== identity.timelineId || timeline.revision !== identity.revision) return;
      const track = timeline.tracks.find(entry => entry.id === trackId); if (!track) return;
      const count = timeline.items.filter(item => item.trackId === trackId).length;
      if (count) {
        if (typeof confirmDeleteTrack !== 'function') { status('Track deletion confirmation is unavailable. No clips were deleted.', true); return; }
        const Controller = host.AbortController || root.AbortController;
        const controller = new Controller(); deleteConfirmation = controller; pause(); cancelRangeDrag(); updateControls();
        let confirmed = false;
        try { confirmed = await confirmDeleteTrack({ trackId, trackName: track.name, clipCount: count, signal: controller.signal }) === true; }
        catch (error) { if (active(identity.token)) status(`Could not confirm track deletion. ${error.message || 'Try again.'}`, true); }
        finally { if (deleteConfirmation === controller) { deleteConfirmation = null; updateControls(); } }
        if (!confirmed || controller.signal.aborted || !canEdit() || !active(identity.token)) return;
        if (timeline.id !== identity.timelineId || timeline.revision !== identity.revision) { status('The timeline changed. Review the track and delete again.', true); return; }
      }
      await mutate('applyTimeline', [{ type: 'remove-track', trackId, ...(count ? { removeItems: true } : {}) }], {
        clearSelection: true, message: `Deleted ${track.name} track${count ? ` and ${count} clip${count === 1 ? '' : 's'}` : ''}. Undo restores it. Source files stay in Media.`,
      });
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
    async function mutate(method, operations, options = {}) {
      if (!canEdit() || operations && !operations.length) return;
      cancelRangeDrag(); clearDropTarget();
      const token = generation, owner = projectId, revision = timeline.revision;
      const focused = document.activeElement; let nextFocus;
      const restoreDeletionFocus = options.clearSelection && selectionOwnsFocus(focused);
      mutating = true; readSequence += 1; pause(); updateControls();
      try {
        const result = await client[method](owner, { expectedRevision: revision, ...(operations ? { operations } : {}) });
        if (!active(token)) return;
        const restoreFocus = !modalOpen() && (document.activeElement === focused || document.activeElement === document.body) && (restoreDeletionFocus || ['clip-body', 'clip-trim-start', 'clip-trim-end', 'track-select', 'track-up', 'track-down', 'remove-track'].includes(focused?.dataset?.role));
        timeline = result; playhead = Math.min(playhead, durationFrames(timeline)); if (options.clearSelection) clearSelection(); render();
        if (restoreFocus) {
          let replacement; walk(tracks, node => { if (node.dataset?.role === focused.dataset.role && ['itemId', 'clipId', 'trackId'].every(key => node.dataset[key] === focused.dataset[key])) replacement = node; });
          nextFocus = restoreDeletionFocus ? ui.ruler : replacement || ui.ruler;
        }
        status(options.message || (method === 'undoTimeline' ? 'Edit undone.' : method === 'redoTimeline' ? 'Edit restored.' : 'Timeline saved. Source media is unchanged.')); await readHistory(token);
      } catch (error) { if (active(token)) status(`${error.message || 'Could not save the timeline.'}${/revision|conflict/i.test(error.message || '') ? ' Refresh, then select again.' : ''}`, true); }
      finally { if (active(token)) { mutating = false; updateControls(); if (nextFocus && !modalOpen() && (!document.activeElement || document.activeElement === focused || document.activeElement === document.body)) nextFocus.focus?.(); } }
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
      previewEmpty.textContent = failures.length ? 'Preview unavailable for this source.' : waiting ? 'Loading project media…' : layers.length ? 'Audio preview' : timeline.items.length ? 'No visual clip at this frame.' : 'Drag media from the Media drawer onto a track to start your edit.';
      ui['preview-status'].textContent = failures[0] || ''; ui['retry-preview'].hidden = !failures.length;
      if (ui.ruler) { ui.ruler.setAttribute('aria-valuenow', playhead); ui.ruler.setAttribute('aria-valuetext', `Frame ${playhead}`); }
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
      cancelRangeDrag(); clearDropTarget(); generation += 1; deleteConfirmation?.abort(); deleteConfirmation = null; exportController?.abort(); exportController = null; exporting = false; preparing = false; disposePreview(); closed = false; projectId = nextProjectId; timeline = null; assets = []; libraryAssets = []; add.open = false; inspector.open = false; exactRange.open = false; history = null; inspectedItemId = ''; playhead = 0; mutating = false;
      if (selection) { selection = null; onSelection(null); }
      container.hidden = false; tracks.replaceChildren(); ui.inspector.replaceChildren(); ui['add-asset'].replaceChildren(); status('Opening timeline…'); render();
      await load(generation, true);
    }
    async function refresh() { if (closed || destroyed || mutating || preparing || exporting) return; cancelRangeDrag(); pause(); await load(generation, true); if (add.open) await refreshPicker(); }
    function close() { cancelRangeDrag(); clearDropTarget(); generation += 1; deleteConfirmation?.abort(); deleteConfirmation = null; exportController?.abort(); exportController = null; exporting = false; preparing = false; closed = true; loading = false; mutating = false; disposePreview(); projectId = ''; timeline = null; assets = []; history = null; clearSelection(); container.hidden = true; }
    function destroy() { if (destroyed) return; close(); destroyed = true; container.replaceChildren(); }
    function setBusy(value) { explicitlyBusy = !!value; if (value) { cancelRangeDrag(); clearDropTarget(); } updateControls(); renderSelection(); }
    return { open, refresh, getSelection: () => copy(selection), clearSelection, close, destroy, setBusy };
  }

  function confirmTimelineTrackDeletion({ document, container, trackName, clipCount, signal }) {
    if (signal?.aborted) return Promise.resolve(false);
    const dialog = document.createElement('dialog'); dialog.className = 'timeline-delete-dialog';
    dialog.setAttribute('aria-label', `Delete ${trackName} track?`);
    const title = document.createElement('h2'); title.textContent = `Delete ${trackName} track?`;
    const detail = document.createElement('p'); detail.textContent = `This deletes the track and ${clipCount} clip${clipCount === 1 ? '' : 's'}. Undo restores them. Source files stay in Media.`;
    const actions = document.createElement('div'); actions.className = 'timeline-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button outline small'; cancel.textContent = 'Cancel';
    const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'button outline small timeline-delete'; approve.textContent = `Delete track and ${clipCount} clip${clipCount === 1 ? '' : 's'}`;
    actions.append(cancel, approve); dialog.append(title, detail, actions);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); if (dialog.open) dialog.close(); dialog.remove(); resolve(value); };
      const abort = () => finish(false);
      cancel.addEventListener('click', abort); approve.addEventListener('click', () => finish(true));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('close', abort); signal?.addEventListener('abort', abort, { once: true });
      try { container.append(dialog); dialog.showModal(); cancel.focus(); }
      catch { finish(false); }
    });
  }
  const api = { createVideoTimelineView, confirmTimelineTrackDeletion, frameToPixels, pixelToFrame, getPreviewLayers };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.createVideoTimelineView = createVideoTimelineView; root.confirmTimelineTrackDeletion = confirmTimelineTrackDeletion; }
}(typeof window !== 'undefined' ? window : globalThis));
