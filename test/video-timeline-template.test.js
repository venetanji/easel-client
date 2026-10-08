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

test('timeline CSS gives preview full width and wraps compact editing disclosures', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/video-timeline.css'), 'utf8');
  assert.match(css, /\.timeline-workbench\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.doesNotMatch(css, /\.timeline-sidebar/);
  assert.match(css, /\.timeline-context\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.timeline-context summary:focus-visible/);
});

test('new video starters inject the bounded text-only track deletion dialog', () => {
  const html = createVideoTimelineTemplate({ readSource: () => '' });
  assert.match(html, /confirmDeleteTrack: \(input\) => confirmTimelineTrackDeletion\(\{ document, container, \.\.\.input \}\)/);
  assert.doesNotMatch(html, /window\.confirm\(/);
});
