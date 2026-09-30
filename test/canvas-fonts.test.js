const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitizeGoogleFontsCss, sanitizeGoogleFontsHtml } = require('../src/canvas-fonts');
const { assembleProject, projectSnapshot } = require('../src/canvas-project');
const { buildCanvasDocument, buildCanvasSnapshotDocument } = require('../src/canvas-policy');
const { createCanvasStore } = require('../src/canvas-store');

function project(files) {
  return { version: 1, manifest: { entry: 'index.html', kits: [], assets: [] }, files };
}

test('removes only recognized Google Fonts stylesheet and preconnect elements', () => {
  const removed = [
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono&amp;display=swap">',
    '<LINK HREF=//fonts.googleapis.com/css?family=Playfair+Display REL="alternate stylesheet">',
    '<link href="https://fonts.googleapis.com" rel="preconnect">',
    '<link rel="preconnect" href="https://fonts.gstatic.com/" crossorigin>',
  ].join('\n');
  const retained = [
    '<link rel="stylesheet" href="styles.css">',
    '<link rel="stylesheet" href="https://example.com/styles.css">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/not-fonts">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com.example.com/css2">',
    '<link rel="stylesheet" href="https://user@fonts.googleapis.com/css2">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com:8443/css2">',
    '<link rel="icon" href="https://fonts.googleapis.com/css2">',
    '<link rel="preconnect" href="https://fonts.gstatic.com/some-path">',
    '<style>body { font-family: "DM Mono", monospace; }</style>',
  ].join('\n');
  const html = `<html><head>${removed}\n${retained}</head><body></body></html>`;
  assert.equal(sanitizeGoogleFontsHtml(html), `<html><head>${'\n'.repeat(removed.split('\n').length)}${retained}</head><body></body></html>`);
});

test('preserves comments, scripts, raw text, templates and text formatting exactly', () => {
  const link = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono">';
  const importRule = '@import "https://fonts.googleapis.com/css2?family=DM+Mono";';
  const protectedHtml = [
    `<!-- ${link} -->`,
    `<script>const markup = '${link}'; const css = '${importRule}';</script>`,
    `<textarea>${link}<style>${importRule}</style></textarea>`,
    `<title>${link}</title>`,
    `<template>${link}<style>${importRule}</style></template>`,
    `<pre>&lt;link rel="stylesheet" href="https://fonts.googleapis.com/css2"&gt;</pre>`,
    '<p>https://fonts.googleapis.com/css2 is an example.</p>',
  ].join('\r\n');
  assert.equal(sanitizeGoogleFontsHtml(protectedHtml), protectedHtml);
  const plaintext = `<plaintext>${link}<style>${importRule}</style>`;
  assert.equal(sanitizeGoogleFontsHtml(plaintext), plaintext);
  const unclosedScript = `<script>const example = '${link}';`;
  assert.equal(sanitizeGoogleFontsHtml(unclosedScript), unclosedScript);
});

test('removes Google CSS imports while retaining family choices, comments and local imports', () => {
  const imports = [
    '@import "https://fonts.googleapis.com/css2?family=DM+Mono";',
    "@import url('https://fonts.googleapis.com/css?family=Playfair+Display') screen;",
    '@IMPORT url(//fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,400;1,400&display=swap) layer(fonts);',
    '@import /* font stylesheet */ url("https://fonts.googleapis.com/css2?family=DM+Mono") supports(display: grid);',
  ];
  const retained = [
    '@import "./palette.css";',
    '@import url("https://example.com/styles.css");',
    '@import "https://fonts.googleapis.com/not-fonts";',
    '/* @import "https://fonts.googleapis.com/css2?family=Ignored"; */',
    '.example::before { content: \'@import "https://fonts.googleapis.com/css2?family=Literal";\'; }',
    '@font-face { font-family: "DM Mono"; src: local("DM Mono"); }',
    'body { font-family: "DM Mono", "Playfair Display", serif; }',
  ].join('\n');
  assert.equal(sanitizeGoogleFontsCss(`${imports.join('\n')}\n${retained}`), `${'\n'.repeat(imports.length)}${retained}`);
  assert.equal(sanitizeGoogleFontsCss('@import "https://fonts.googleapis.com/css2?family=DM+Mono"'), '');
});

test('does not mistake CSS strings or nested declarations for top-level font imports', () => {
  const css = [
    '@import-other "https://fonts.googleapis.com/css2";',
    '@media screen { @import "https://fonts.googleapis.com/css2"; }',
    '.example { content: "\\\" @import url(https://fonts.googleapis.com/css2);"; }',
    '/* @import "https://fonts.googleapis.com/css2"; */',
  ].join('\n');
  assert.equal(sanitizeGoogleFontsCss(css), css);
});

test('sanitizes inline style imports using source offsets rather than HTML serialization', () => {
  const html = '<!DOCTYPE html>\r\n<html lang=en><head><style media="screen">\r\n@import url("https://fonts.googleapis.com/css2?family=DM+Mono");\r\nbody{font-family:"DM Mono",monospace}\r\n</style></head><body>Keep &amp; text</body></html>';
  const expected = html.replace('@import url("https://fonts.googleapis.com/css2?family=DM+Mono");', '');
  assert.equal(sanitizeGoogleFontsHtml(html), expected);
});

test('canvas creation and snapshots remove remote font declarations before offline validation', () => {
  const html = '<html><head><link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono"><style>@import "https://fonts.googleapis.com/css?family=Playfair+Display";body { font-family: "DM Mono", monospace; }</style></head><body>Offline</body></html>';
  for (const built of [buildCanvasDocument({ html }), buildCanvasSnapshotDocument(html)]) {
    assert.doesNotMatch(built, /fonts\.(?:googleapis|gstatic)\.com/);
    assert.match(built, /font-family: "DM Mono", monospace/);
    assert.match(built, /font-src data:/);
    assert.match(built, /connect-src data: blob:/);
  }
  for (const external of [
    '<link rel="stylesheet" href="https://example.com/styles.css">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/not-fonts">',
    '<img src="https://fonts.gstatic.com/image.png">',
  ]) {
    assert.throws(() => buildCanvasDocument({ html: external }), /external URLs/);
    assert.throws(() => buildCanvasSnapshotDocument(external), /external URLs/);
  }
});

test('canonical assembly strips HTML and local CSS font imports without modifying authored files', () => {
  const saved = project({
    'index.html': '<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono"><link rel="stylesheet" href="styles/main.css"><style>@import url(https://fonts.googleapis.com/css2?family=Playfair+Display);h1 { font-family: "Playfair Display", serif; }</style></head><body><h1>Local fonts</h1></body></html>',
    'styles/main.css': '@import "https://fonts.googleapis.com/css2?family=DM+Mono";\n@import "./palette.css";\nbody { font-family: "DM Mono", monospace; }',
    'styles/palette.css': '@import url(https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,400;1,400);\nbody { color: #223344; }',
  });
  const before = structuredClone(saved);
  const output = assembleProject(saved, { includeSnapshot: false });
  assert.doesNotMatch(output, /fonts\.googleapis\.com/);
  assert.match(output, /font-family: "Playfair Display", serif/);
  assert.match(output, /font-family: "DM Mono", monospace/);
  assert.match(output, /color: #223344/);
  assert.deepEqual(saved, before);
  assert.deepEqual(projectSnapshot(assembleProject(saved)), before);
});

test('canonical assembly still rejects arbitrary remote stylesheet and CSS imports', () => {
  for (const remote of ['https://example.com/style.css', 'https://fonts.googleapis.com/not-fonts', 'https://fonts.googleapis.com.example.com/css2']) {
    assert.throws(() => assembleProject(project({ 'index.html': `<link rel="stylesheet" href="${remote}">` })), /Only relative local project references/);
    assert.throws(() => assembleProject(project({ 'index.html': '<link rel="stylesheet" href="styles.css">', 'styles.css': `@import "${remote}";` })), /Only relative local project references/);
  }
});

test('opens existing canonical projects with Google Fonts references without rewriting the record', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-local-fonts-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const directory = path.join(userDataPath, 'canvases');
  fs.mkdirSync(directory);
  const id = 'd'.repeat(32);
  const record = JSON.stringify({ ...project({
    'index.html': '<html><head><link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono"><link rel="stylesheet" href="styles.css"></head><body>Installed font</body></html>',
    'styles.css': '@import "https://fonts.googleapis.com/css2?family=DM+Mono";body { font-family: "DM Mono", monospace; }',
  }), id, title: 'Installed fonts' });
  const filename = path.join(directory, `${id}.project.json`);
  fs.writeFileSync(filename, record);
  const store = createCanvasStore({ userDataPath });
  const loaded = store.get(id);
  assert.equal(loaded.title, 'Installed fonts');
  assert.match(loaded.html, /font-family: "DM Mono", monospace/);
  assert.doesNotMatch(loaded.html, /<link[^>]+fonts\.(?:googleapis|gstatic)\.com/);
  assert.equal(fs.readFileSync(filename, 'utf8'), record);
  assert.deepEqual(fs.readdirSync(directory), [`${id}.project.json`]);
});
