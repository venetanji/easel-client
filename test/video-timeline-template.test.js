const test = require('node:test');
const assert = require('node:assert/strict');
const { createVideoTimelineTemplate } = require('../src/video-timeline-template');
const { projectFromDocument } = require('../src/canvas-project');
test('video editor is an ordinary offline editable HTML project with extracted source files', () => {
  const sources = [];
  const html = createVideoTimelineTemplate({ readSource: (name) => { sources.push(name); return name.endsWith('.css') ? '.timeline-editor{color:#202d27}' : 'window.templateModuleLoaded = true;'; } });
  assert.match(html, /Video editor/);
  assert.match(html, /EaselHost.timeline/);
  assert.equal(html.includes('https://'), false);
  assert.ok(sources.includes('video-timeline-view.js'));
  assert.ok(sources.includes('video-timeline-export.js'));
  const project = projectFromDocument(html, { documentPath: 'video-editor/index.html', scriptPath: 'video-editor/app.js', stylePath: 'video-editor/styles.css', extractKits: () => [], extractAssets: (html) => html });
  assert.ok(project.files['video-editor/app.js']);
  assert.ok(project.files['video-editor/styles.css']);
  assert.match(project.files['video-editor/app.js'], /saveTimelineExport/);
});
