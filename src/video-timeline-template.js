const fs = require('node:fs');
const path = require('node:path');

function bootVideoEditor() {
  const container = document.getElementById('video-editor');
  const status = document.getElementById('editor-status');
  const projectId = document.querySelector('meta[name="easel-canvas-id"]')?.content;
  function report(message, error = false) { status.textContent = message || ''; status.setAttribute('role', error ? 'alert' : 'status'); }
  if (!window.EaselHost?.timeline || !projectId) { report('Open this editable project in Easel Studio to load its timeline and managed media. The project ZIP preserves every sketch in .easel/timelines/.', true); return; }
  const call = (action, input) => window.EaselHost.timeline({ action, ...(input !== undefined ? { input } : {}) });
  const client = {
    readTimeline: () => call('read'), createTimeline: (_id, input = {}) => call('create', input),
    applyTimeline: (_id, input) => call('apply', input), undoTimeline: (_id, input) => call('undo', input), redoTimeline: (_id, input) => call('redo', input),
    getTimelineHistory: () => call('history'), getProjectAssets: (_id, input = {}) => call('assets', input), getProjectAsset: (_id, assetId) => call('asset', { assetId }),
    importMedia: () => call('import'),
    listAssets: () => call('library'), attachProjectAsset: (_id, assetId) => call('attach', { assetId }),
    saveTimelineExport: (_id, input) => call('save-export', { ...input, exportId: input.exportId || crypto.randomUUID() }),
  };
  const editor = createVideoTimelineView({ document, container, client, confirmDeleteTrack: (input) => confirmTimelineTrackDeletion({ document, container, ...input }), onSelection: (selection) => { call('select', selection).catch((error) => report(error.message, true)); }, onStatus: () => report('') });
  let opened = false, binding = null;
  const open = async () => { if (opened) return; opened = true; try { await editor.open(projectId); } catch (error) { opened = false; report(error.message, true); } };
  const unsubscribe = window.EaselHost.onTimelineChanged?.((event) => {
    if (event.projectId !== projectId) return;
    if (event.ready) {
      if (event.error) { report(event.error, true); return; }
      binding = event; open();
    }
    else if (!binding || event.timelineId !== binding.timelineId || event.instanceId !== binding.instanceId) return;
    else if (event.selectionConsumed) editor.clearSelection();
    else if (opened) editor.refresh().catch((error) => report(error.message, true));
  });
  window.EaselVideoEditor = editor;
  window.EaselCanvas?.registerApp({ id: 'video-editor', dispose: () => { unsubscribe?.(); editor.destroy(); delete window.EaselVideoEditor; } });
  // During document installation, the host sends ready after validating the loaded origin.

}
function createVideoTimelineTemplate({ readSource = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8') } = {}) {
  const css = readSource('video-timeline.css');
  const scripts = ['../canvas-kits/mediabunny.js', 'video-timeline-view.js', 'video-timeline-export.js'].map((name) => `(function(){\n${readSource(name)}\n${name.endsWith('mediabunny.js') ? 'window.EaselMediabunny = EaselMediabunny;' : ''}\n})();`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Video editor</title><style>
:root{color-scheme:light;font-family:"Segoe UI","Helvetica Neue",sans-serif;color:#202d27;background:#fbfaf6;--paper:#fbfaf6;--paper-deep:#f3f2eb;--line:#d4d9d0;--muted:#58675f;--ink:#202d27;--green:#174d3a;--green-deep:#12392d;--green-wash:#e7eee7;--coral:#b84e38;--gold:#ad7930}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;height:100%}body{display:flex;flex-direction:column}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.55}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--green);outline-offset:3px}button,input,select{border:1px solid var(--line);border-radius:6px;padding:7px 10px;background:var(--paper);color:var(--ink)}.button{font-weight:600}.button.accent,.button.primary{background:var(--green);color:white}.button.small{padding:5px 9px;font-size:12px}#video-editor{flex:1;min-height:0}#editor-status{margin:0;padding:6px 14px;font-size:12px;color:var(--muted)}#editor-status:empty{display:none}#editor-status[role=alert]{color:var(--coral)}
${css}</style></head><body><main id="video-editor" aria-label="Video timeline editor"></main><p id="editor-status" role="status" aria-live="polite"></p><script>${scripts.replace(/<\/script/gi, '<\\/script')}\n(${bootVideoEditor.toString()})();</script></body></html>`;
}
module.exports = { createVideoTimelineTemplate };
