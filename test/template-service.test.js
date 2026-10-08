const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCanvasStore } = require('../src/canvas-store');
const { createVideoTimelineStore } = require('../src/video-timeline-store');
const { createTemplateInstanceStore } = require('../src/template-instance-store');
const { createVideoTimelineTemplate } = require('../src/video-timeline-template');
const { createCanvasHistory, restoreCanvasHistory } = require('../src/canvas-history');
const { createSourceArchiveFixture } = require('./helpers/canvas-kit-source');
const SMALL_SOURCE = '<main>Sound</main><style>main{color:red}</style><script>const pattern = "c3";</script>';
function fixture(t, options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-template-service-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const timelines = createVideoTimelineStore({ userDataPath, fileSystem: options.timelineFs || fs });
  let instances;
  const kitBundles = options.kitBundles || {};
  const canvases = createCanvasStore({ userDataPath, kitBundles, fileSystem: options.sourceFs || fs,
    readKitSourceArchive: (name) => name === 'strudel' && kitBundles.strudel ? createSourceArchiveFixture(kitBundles.strudel) : null,
    listTimelines: (id) => timelines.list(id), listInstances: (id) => instances?.list(id) || [] });
  instances = createTemplateInstanceStore({ userDataPath, timelineStore: timelines, projectStore: canvases, fileSystem: options.registryFs || fs });
  let active = options.noProject ? '' : canvases.createProject({ title: 'Student work', kits: options.kits || ['canvas-2d'] }).id;
  let busy = false;
  const calls = [];
  const history = options.history || createCanvasHistory(options.historyOptions);
  assert.ok(fs.existsSync(path.join(__dirname, '../src/template-service.js')), 'The shared template service must exist');
  const { createTemplateService } = require('../src/template-service');
  const service = createTemplateService({ projectStore: canvases, instanceStore: instances, timelineStore: timelines, kitBundles, history,
    getCurrentProjectId: () => active, isBusy: () => busy,
    // Exercise the real template source; the prebuilt Mediabunny artifact is absent
    // in this offline worktree and no renderer/audio is executed by store tests.
    videoFactory: () => createVideoTimelineTemplate({ readSource: (name) => name.endsWith('mediabunny.js') ? 'const EaselMediabunny = {};' : fs.readFileSync(path.join(__dirname, '../src', name), 'utf8') }),
    saveBeforeSwitch: async () => { calls.push('save'); await options.saveBeforeSwitch?.(); },
    openDocument: async (projectId, documentPath) => { calls.push({ projectId, documentPath }); if (options.openError) throw new Error('Preview unavailable'); active = projectId; return canvases.getDocument(projectId, documentPath); },
    ...(options.strudel ? { strudelFactory: options.strudelFactory || (() => SMALL_SOURCE), strudelReady: true } : {}),
    ...options.serviceOptions,
  });
  return { service, canvases, instances, timelines, history, userDataPath, calls, projectId: active,
    setActive: (value) => { active = value; }, setBusy: (value) => { busy = value; },
    source: (id = active) => fs.readFileSync(path.join(userDataPath, 'canvases', `${id}.project.json`), 'utf8'),
    create: (input = {}) => service.createTemplateInstance({ templateId: 'video-editor', target: 'current-project', ...input }),
  };
}
test('planned_cannot_instantiate', async (t) => {
  const f = fixture(t); const before = f.source();
  for (const entry of f.service.listTemplates().filter((entry) => entry.status === 'planned')) {
    await assert.rejects(f.create({ templateId: entry.id }), /planned/i);
  }
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), []); assert.deepEqual(f.calls, []);
});
test('add_requires_project', async (t) => {
  const f = fixture(t, { noProject: true });
  await assert.rejects(f.create(), /current project|open a project/i);
  assert.deepEqual(f.canvases.list(), []);
});
test('unique_paths_preserve_existing', async (t) => {
  const f = fixture(t); const before = JSON.parse(f.source());
  const first = await f.create(); const second = await f.create();
  assert.notEqual(first.instanceId, second.instanceId); assert.notEqual(first.documentPath, second.documentPath);
  assert.notEqual(first.timelineId, second.timelineId);
  assert.equal(first.documentPath, `sketches/${first.instanceId}/index.html`);
  assert.equal(first.projectId, f.projectId); assert.equal(second.projectId, f.projectId);
  const after = JSON.parse(f.source());
  for (const [name, content] of Object.entries(before.files)) assert.equal(after.files[name], content);
  assert.deepEqual(after.manifest, before.manifest);
  assert.equal(f.instances.list(f.projectId).length, 2); assert.equal(f.timelines.list(f.projectId).length, 2);
  assert.equal(f.calls[0], 'save');
  const opened = await f.service.openTemplateInstance({ projectId: f.projectId, instanceId: first.instanceId });
  for (const key of ['projectId', 'instanceId', 'documentPath', 'timelineId']) assert.equal(opened[key], first[key]);
});
test('new_project_has_only_its_template_source_and_default_entry', async (t) => {
  const f = fixture(t); const before = f.source(f.projectId);
  const created = await f.create({ target: 'new-project', title: 'My film' });
  assert.notEqual(created.projectId, f.projectId); assert.equal(f.source(f.projectId), before);
  const next = JSON.parse(f.source(created.projectId));
  assert.equal(next.title, 'My film'); assert.equal(next.manifest.entry, created.documentPath);
  assert.ok(Object.keys(next.files).every((name) => name.startsWith(`sketches/${created.instanceId}/`)));
});
test('missing_kit_rolls_back', async (t) => {
  const f = fixture(t, { strudel: true }); const before = f.source();
  await assert.rejects(f.create({ templateId: 'strudel-sound' }), /strudel.*(not installed|unavailable)/i);
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), []); assert.deepEqual(f.timelines.list(f.projectId), []);
  await assert.rejects(f.create({ templateId: 'strudel-sound', target: 'new-project' }), /strudel.*(not installed|unavailable)/i);
  assert.equal(f.canvases.list().length, 1);
});
test('kit_budget_preserves_existing_project', async (t) => {
  const f = fixture(t, { strudel: true, kits: ['canvas-2d', 'tone'], kitBundles: { tone: '/*' + 't'.repeat(5 * 1048576) + '*/', strudel: '/*' + 's'.repeat(4 * 1048576) + '*/' } });
  const before = f.source(), cached = fs.readdirSync(path.join(f.userDataPath, 'canvases/.dependencies'));
  await assert.rejects(f.create({ templateId: 'strudel-sound' }), /kit.*(bytes|limit|budget)/i);
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), []);
  assert.deepEqual(fs.readdirSync(path.join(f.userDataPath, 'canvases/.dependencies')), cached);
});
test('known_installed_kit_merges_atomically_and_existing_kit_digest_is_preserved', async (t) => {
  const f = fixture(t, { strudel: true, kits: ['canvas-2d', 'tone'], kitBundles: { tone: 'window.Tone = {};', strudel: 'window.Strudel = {};' } });
  const before = JSON.parse(f.source());
  const created = await f.create({ templateId: 'strudel-sound' });
  const after = JSON.parse(f.source());
  assert.deepEqual(after.manifest.kits.slice(0, 2), before.manifest.kits);
  assert.equal(after.manifest.kits[2].name, 'strudel');
  assert.equal(created.timelineId, undefined); assert.deepEqual(f.timelines.list(f.projectId), []);
  assert.match(f.canvases.getDocument(f.projectId, created.documentPath).html, /window.Strudel/);
  const manifest = zipEntry(f.canvases.exportProject(f.projectId).data, 'manifest.json');
  assert.deepEqual(JSON.parse(manifest).instances, f.instances.list(f.projectId));
  assert.deepEqual(JSON.parse(manifest).templates.map(({ id, version }) => ({ id, version })), [{ id: 'strudel-sound', version: 1 }]);
  assert.equal(JSON.parse(manifest).templateInstanceSchemaVersion, 1);
});
function zipEntry(buffer, name) {
  const zlib = require('node:zlib'); let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18);
    const length = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const found = buffer.subarray(offset + 30, offset + 30 + length).toString();
    const start = offset + 30 + length + extra, data = buffer.subarray(start, start + size);
    if (found === name) return (method === 8 ? zlib.inflateRawSync(data) : data).toString();
    offset = start + size;
  }
  throw new Error(`Missing ZIP entry ${name}`);
}
test('strudel_default_gate_never_instantiates_placeholder_source', async (t) => {
  const f = fixture(t, { kitBundles: { strudel: 'window.Strudel = {};' } }); const before = f.source();
  assert.equal(f.service.listTemplates().find((entry) => entry.id === 'strudel-sound').availability.available, false);
  await assert.rejects(f.create({ templateId: 'strudel-sound' }), /installed.*kit|runtime|compatibility|unavailable/i);
  assert.equal(f.source(), before); assert.deepEqual(f.calls, []);
});
test('extracted_dependencies_count_toward_100_file_limit', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 95; i++) f.canvases.writeFile(f.projectId, { path: `notes/${i}.txt`, content: 'x' });
  assert.equal(f.canvases.getProject(f.projectId).files.length, 98);
  const before = f.source();
  await assert.rejects(f.create(), /100 source files/);
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), []); assert.deepEqual(f.timelines.list(f.projectId), []);
});
test('one_MiB_source_limit_is_preflighted_without_partial_creation', async (t) => {
  const f = fixture(t, { strudel: true, kitBundles: { strudel: 'window.Strudel = {};' }, strudelFactory: () => `<main>${'x'.repeat(1048576)}</main>` });
  const before = f.source();
  await assert.rejects(f.create({ templateId: 'strudel-sound' }), /1 MiB/);
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), []);
});
test('four_MiB_project_limit_is_preflighted_without_partial_creation', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.canvases.writeFile(f.projectId, { path: `notes/${i}.txt`, content: 'x'.repeat(1048576) });
  f.canvases.writeFile(f.projectId, { path: 'notes/3.txt', content: 'x'.repeat(1048576 - 12000) });
  const before = f.source();
  await assert.rejects(f.create(), /4 MiB/);
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), []);
});
for (const failure of ['registry', 'timeline', 'source']) test(`${failure}_write_failure_leaves_existing_source_media_kits_and_host_state_untouched`, async (t) => {
  let fail = false; const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => {
    if (fail && (failure !== 'source' || to.endsWith('.project.json'))) throw new Error(`${failure} disk failure`);
    return fs.renameSync(from, to);
  };
  const f = fixture(t, { [`${failure}Fs`]: fileSystem });
  const existing = await f.create();
  f.canvases.createDocument(f.projectId, { path: 'photo.html', html: '<img src="{{asset:photo}}">', assets: [{ name: 'photo', mimeType: 'image/png', data: 'YWJj' }] });
  f.timelines.apply(f.projectId, existing.timelineId, { expectedRevision: 0, operations: [{ type: 'add-track', track: { id: 'music', type: 'audio', name: 'Music' } }] });
  const before = f.source(); const bindings = f.instances.list(f.projectId); const timeline = f.timelines.snapshot(f.projectId, existing.timelineId);
  fail = true;
  await assert.rejects(f.create(), new RegExp(`${failure} disk failure`));
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), bindings);
  assert.deepEqual(f.timelines.list(f.projectId).map((item) => item.id), [existing.timelineId]);
  assert.deepEqual(f.timelines.snapshot(f.projectId, existing.timelineId), timeline);
});
test('failed_new_project_does_not_leave_empty_project', async (t) => {
  const fileSystem = Object.create(fs); fileSystem.renameSync = () => { throw new Error('Registry unavailable'); };
  const f = fixture(t, { noProject: true, registryFs: fileSystem });
  await assert.rejects(f.create({ target: 'new-project' }), /Registry unavailable/);
  assert.deepEqual(f.canvases.list(), []);
  const timelineRoot = path.join(f.userDataPath, 'video-timelines');
  if (fs.existsSync(timelineRoot)) for (const dir of fs.readdirSync(timelineRoot)) assert.deepEqual(fs.readdirSync(path.join(timelineRoot, dir)), []);
});
test('preview_failure_returns_created_identity_for_reopen_without_duplicate_creation', async (t) => {
  const f = fixture(t, { openError: true });
  const created = await f.create();
  assert.equal(created.opened, false); assert.match(created.openError, /Preview unavailable/);
  assert.equal(f.instances.list(f.projectId)[0].instanceId, created.instanceId);
  assert.ok(JSON.parse(f.source()).files[created.documentPath]);
});
test('host_rejects_forged_targets_and_busy_operations', async (t) => {
  const f = fixture(t); const other = f.canvases.createProject().id; const before = f.source();
  await assert.rejects(f.create({ projectId: other }), /current project|active project/i);
  await assert.rejects(f.create({ target: 'new-project', projectId: f.projectId }), /project/i);
  await assert.rejects(f.create({ path: '../index.html' }), /invalid|unsupported/i);
  await assert.rejects(f.create({ instanceId: 'b'.repeat(32) }), /invalid|unsupported/i);
  f.setBusy(true); await assert.rejects(f.create(), /operation|busy/i);
  assert.equal(f.source(), before); assert.deepEqual(f.calls, []);
});
test('host_rechecks_active_target_and_busy_state_after_save', async (t) => {
  let f;
  f = fixture(t, { saveBeforeSwitch: () => f.setActive('f'.repeat(32)) });
  const before = f.source(f.projectId);
  await assert.rejects(f.create(), /changed|current project|active project/i);
  assert.equal(f.source(f.projectId), before);
  f.setActive(f.projectId);
  f = fixture(t, { saveBeforeSwitch: () => f.setBusy(true) });
  await assert.rejects(f.create(), /operation|busy/i);
  assert.deepEqual(f.instances.list(f.projectId), []);
});
test('video_launcher_reopens_sole_instance_and_returns_real_choices_for_many', async (t) => {
  const f = fixture(t); const first = await f.create();
  const opened = await f.service.openVideoEditor({ projectId: f.projectId });
  assert.equal(opened.instanceId, first.instanceId); assert.equal(f.instances.list(f.projectId).length, 1);
  const second = await f.create();
  const choice = await f.service.openVideoEditor({ projectId: f.projectId });
  assert.equal(choice.status, 'choice-required'); assert.equal(choice.kind, 'instances');
  assert.deepEqual(choice.choices.map((entry) => entry.instanceId), [first.instanceId, second.instanceId]);
  assert.equal((await f.service.openVideoEditor({ projectId: f.projectId, instanceId: second.instanceId })).instanceId, second.instanceId);
});
test('legacy_choice_binds_only_selected_real_candidate_without_source_changes', async (t) => {
  const f = fixture(t);
  for (const name of ['copy-a/index.html', 'copy-b/index.html']) f.canvases.createDocument(f.projectId, { path: name, html: '<main id="video-editor"></main><script>window.EaselHost.timeline.read();</script>' });
  f.canvases.createDocument(f.projectId, { path: 'unrelated.html', html: '<main>Other</main>' });
  f.timelines.create(f.projectId);
  const before = f.source(), legacy = f.timelines.readLegacy(f.projectId);
  const choice = await f.service.openVideoEditor({ projectId: f.projectId });
  assert.equal(choice.status, 'choice-required'); assert.equal(choice.kind, 'legacy');
  assert.deepEqual(choice.choices.map((entry) => entry.documentPath), ['copy-a/index.html', 'copy-b/index.html']);
  await assert.rejects(f.service.openVideoEditor({ projectId: f.projectId, legacyDocumentPath: 'unrelated.html' }), /candidate|choice/i);
  assert.deepEqual(f.instances.list(f.projectId), []);
  const opened = await f.service.openVideoEditor({ projectId: f.projectId, legacyDocumentPath: 'copy-b/index.html' });
  assert.equal(opened.documentPath, 'copy-b/index.html'); assert.equal(f.source(), before);
  assert.deepEqual(f.timelines.readLegacy(f.projectId), legacy);
  assert.equal(f.instances.list(f.projectId).length, 1);
});


test('preflight_commit_guard_preserves_a_newer_existing_project_edit', (t) => {
  const f = fixture(t); const instanceId = 'e'.repeat(32);
  const before = JSON.parse(f.source());
  let expected;
  assert.throws(() => f.canvases.createTemplateDocument({ projectId: f.projectId, path: `sketches/${instanceId}/index.html`, title: 'Sketch', html: SMALL_SOURCE, kits: ['canvas-2d'] }, () => {
    f.canvases.writeFile(f.projectId, { path: 'latest.txt', content: 'Newer user work' });
    expected = f.source();
  }), /project changed/i);
  assert.equal(f.source(), expected);
  const after = JSON.parse(f.source());
  assert.equal(after.files['latest.txt'], 'Newer user work');
  for (const [name, content] of Object.entries(before.files)) assert.equal(after.files[name], content);
  assert.ok(!after.files[`sketches/${instanceId}/index.html`]);
});
test('saved_kit_bytes_are_not_upgraded_when_another_template_is_added', async (t) => {
  const kitBundles = { tone: 'window.Tone = {version:1};', strudel: 'window.Strudel = {};' };
  const f = fixture(t, { kitBundles, kits: ['canvas-2d', 'tone'], strudel: true });
  const originalTone = JSON.parse(f.source()).manifest.kits.find((kit) => kit.name === 'tone');
  kitBundles.tone = 'window.Tone = {version:2};';
  const created = await f.create({ templateId: 'strudel-sound' });
  assert.deepEqual(JSON.parse(f.source()).manifest.kits.find((kit) => kit.name === 'tone'), originalTone);
  assert.match(f.canvases.getDocument(f.projectId, created.documentPath).html, /window.Tone = \{version:1\}/);
});
test('service_rejects_an_overlapping_create_before_save_finishes', async (t) => {
  let release;
  const f = fixture(t, { saveBeforeSwitch: () => new Promise((resolve) => { release = resolve; }) });
  const first = f.create();
  await assert.rejects(f.create(), /already in progress/);
  release(); await first;
  assert.equal(f.instances.list(f.projectId).length, 1);
});
test('opening_deleted_or_cross_project_instance_does_not_switch_or_recreate_it', async (t) => {
  const f = fixture(t); const created = await f.create();
  const other = f.canvases.createProject().id;
  const count = f.calls.length;
  await assert.rejects(f.service.openTemplateInstance({ projectId: other, instanceId: created.instanceId }), /no longer exists/);
  assert.equal(f.calls.length, count);
  f.canvases.deleteFile(f.projectId, { path: created.documentPath });
  await assert.rejects(f.service.openTemplateInstance({ projectId: f.projectId, instanceId: created.instanceId }), /no longer exists/);
  assert.equal(f.calls.length, count);
});
test('launcher_creates_atomically_when_no_video_exists_and_add_always_creates_another', async (t) => {
  const f = fixture(t);
  const first = await f.service.openVideoEditor({ projectId: f.projectId });
  const second = await f.create();
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(f.instances.list(f.projectId).length, 2);
});

test('source_commit_failure_removes_only_new_kit_cache_and_instance', async (t) => {
  let fail = false; const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => { if (fail && to.endsWith('.project.json')) throw new Error('Source commit failed'); return fs.renameSync(from, to); };
  const f = fixture(t, { sourceFs: fileSystem, strudel: true, kits: ['canvas-2d', 'tone'], kitBundles: { tone: 'window.Tone = {};', strudel: 'window.Strudel = {};' } });
  const before = f.source(), directory = path.join(f.userDataPath, 'canvases/.dependencies');
  const caches = fs.readdirSync(directory).map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')]);
  fail = true;
  await assert.rejects(f.create({ templateId: 'strudel-sound' }), /Source commit failed/);
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), []);
  assert.deepEqual(fs.readdirSync(directory).map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')]), caches);
});
test('binding_side_effect_cannot_overwrite_newer_source_and_cleanup_preserves_other_instances', async (t) => {
  let f, intervene = false, expected;
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => {
    if (intervene) {
      intervene = false;
      f.canvases.writeFile(f.projectId, { path: 'latest.txt', content: 'Keep this newer work' }); expected = f.source();
    }
    return fs.renameSync(from, to);
  };
  f = fixture(t, { registryFs: fileSystem }); const existing = await f.create();
  intervene = true;
  await assert.rejects(f.create(), /project changed/i);
  assert.equal(f.source(), expected);
  assert.deepEqual(f.instances.list(f.projectId).map((entry) => entry.instanceId), [existing.instanceId]);
  assert.deepEqual(f.timelines.list(f.projectId).map((entry) => entry.id), [existing.timelineId]);
});

test('post_commit_timestamp_failure_keeps_durable_source_binding_and_kit', async (t) => {
  let enabled = false, failStat = '';
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => { fs.renameSync(from, to); if (enabled && to.endsWith('.project.json')) failStat = to; };
  fileSystem.statSync = (file, ...args) => {
    if (file === failStat) { failStat = ''; throw new Error('Timestamp unavailable after committed rename'); }
    return fs.statSync(file, ...args);
  };
  const f = fixture(t, { sourceFs: fileSystem, strudel: true, kitBundles: { strudel: 'window.Strudel = {};' } });
  enabled = true;
  const created = await f.create({ templateId: 'strudel-sound' });
  assert.equal(created.opened, true);
  assert.equal(f.instances.list(f.projectId)[0].instanceId, created.instanceId);
  assert.match(f.canvases.getDocument(f.projectId, created.documentPath).html, /window.Strudel/);
});


function editSource(f, name, content) {
  const before = f.canvases.get(f.projectId).html;
  f.canvases.writeFile(f.projectId, { path: name, content });
  f.history.record(f.projectId, before);
}
function undoSource(f) {
  return restoreCanvasHistory({ history: f.history, canvasStore: f.canvases, instances: f.instances }, f.projectId);
}
for (const route of ['explicit-add', 'launcher-create']) test(`${route}_guards_prior_history_without_removing_created_source_or_timeline`, async (t) => {
  const f = fixture(t);
  editSource(f, 'notes.txt', 'Keep this previous source edit');
  const created = route === 'explicit-add' ? await f.create() : await f.service.openVideoEditor({ projectId: f.projectId });
  const source = f.source(), binding = f.instances.list(f.projectId), timeline = f.timelines.snapshot(f.projectId, created.timelineId);
  assert.throws(() => undoSource(f), /Undo stops.*template|creation boundary/i);
  assert.equal(f.source(), source); assert.deepEqual(f.instances.list(f.projectId), binding);
  assert.deepEqual(f.timelines.snapshot(f.projectId, created.timelineId), timeline);
  assert.equal(f.history.canUndo(f.projectId), false);
  assert.equal(f.history.getUndoState(f.projectId).undoHistoryEntries, 1);
  assert.match(f.history.getUndoState(f.projectId).undoBlockedReason, /earlier history.*kept|earlier.*retained/i);
  assert.equal((await f.service.openTemplateInstance({ projectId: f.projectId, instanceId: created.instanceId })).instanceId, created.instanceId);
  const exported = f.canvases.exportProject(f.projectId).manifest;
  assert.ok(exported.documents.some((entry) => entry.path === exported.instances[0].documentPath));
});
test('later_source_edits_undo_normally_until_boundary_without_changing_independent_timeline_history', async (t) => {
  const f = fixture(t);
  editSource(f, 'notes.txt', 'Before creation');
  const a = await f.create(); const b = await f.create();
  f.timelines.apply(f.projectId, a.timelineId, { expectedRevision: 0, operations: [{ type: 'add-track', track: { id: 'music', type: 'audio', name: 'Music' } }] });
  f.timelines.apply(f.projectId, b.timelineId, { expectedRevision: 0, operations: [{ type: 'add-track', track: { id: 'voice', type: 'audio', name: 'Voice' } }] });
  const timelines = [a, b].map((binding) => f.timelines.snapshot(f.projectId, binding.timelineId));
  const afterCreation = JSON.parse(f.source());
  editSource(f, 'notes.txt', 'After creation');
  editSource(f, 'another.txt', 'Later edit');
  assert.equal(f.history.canUndo(f.projectId), true);
  undoSource(f);
  assert.equal(JSON.parse(f.source()).files['another.txt'], undefined);
  assert.equal(JSON.parse(f.source()).files['notes.txt'], 'After creation');
  undoSource(f);
  assert.deepEqual(JSON.parse(f.source()), afterCreation);
  assert.throws(() => undoSource(f), /Undo stops.*template|creation boundary/i);
  assert.deepEqual([a, b].map((binding) => f.timelines.snapshot(f.projectId, binding.timelineId)), timelines);
  assert.equal(f.history.getUndoState(f.projectId).undoHistoryEntries, 1);
});
for (const route of ['explicit-add', 'launcher-create']) test(`${route}_failure_does_not_append_or_guard_existing_history`, async (t) => {
  let fail = false; const fileSystem = Object.create(fs);
  fileSystem.renameSync = (from, to) => { if (fail) throw new Error('Registry failure'); return fs.renameSync(from, to); };
  const f = fixture(t, { registryFs: fileSystem });
  editSource(f, 'notes.txt', 'Existing edit');
  fail = true;
  await assert.rejects(route === 'explicit-add' ? f.create() : f.service.openVideoEditor({ projectId: f.projectId }), /Registry failure/);
  assert.equal(f.history.canUndo(f.projectId), true);
  undoSource(f);
  assert.equal(JSON.parse(f.source()).files['notes.txt'], undefined);
  assert.equal(f.history.canUndo(f.projectId), false);
});
for (const route of ['explicit-add', 'launcher-create']) test(`${route}_preview_failure_keeps_successful_creation_boundary_and_prior_history`, async (t) => {
  const f = fixture(t, { openError: true });
  editSource(f, 'notes.txt', 'Existing edit');
  const created = route === 'explicit-add' ? await f.create() : await f.service.openVideoEditor({ projectId: f.projectId });
  assert.equal(created.opened, false);
  assert.equal(created.undoAvailable, false);
  assert.match(created.undoBlockedReason, /Undo stops.*template|creation boundary/i);
  assert.throws(() => undoSource(f), /Undo stops.*template|creation boundary/i);
  assert.ok(JSON.parse(f.source()).files[created.documentPath]);
  assert.equal(f.history.getUndoState(f.projectId).undoHistoryEntries, 1);
});
test('history_boundary_budget_failure_rejects_before_creation_without_discarding_prior_history', async (t) => {
  const f = fixture(t);
  const before = f.canvases.get(f.projectId).html;
  const history = createCanvasHistory({ maxBytes: Buffer.byteLength(before) });
  history.record(f.projectId, before);
  const { createTemplateService } = require('../src/template-service');
  const service = createTemplateService({ projectStore: f.canvases, instanceStore: f.instances, timelineStore: f.timelines, history,
    getCurrentProjectId: () => f.projectId, videoFactory: () => SMALL_SOURCE });
  const source = f.source();
  await assert.rejects(service.createTemplateInstance({ templateId: 'video-editor', target: 'current-project' }), /Undo.*budget|history.*budget/i);
  assert.equal(f.source(), source); assert.deepEqual(f.instances.list(f.projectId), []); assert.deepEqual(f.timelines.list(f.projectId), []);
  assert.equal(history.undo(f.projectId), before);
});
test('stale_source_snapshot_cannot_remove_a_registered_instance_even_without_creation_marker', async (t) => {
  const f = fixture(t), stale = f.canvases.get(f.projectId).html;
  const created = await f.create();
  // A legacy caller records an older snapshot after creation; this bypasses the
  // creation boundary but must still be rejected by the production restore guard.
  const staleHistory = createCanvasHistory(); staleHistory.record(f.projectId, stale);
  const before = f.source();
  assert.throws(() => restoreCanvasHistory({ history: staleHistory, canvasStore: f.canvases, instances: f.instances }, f.projectId), /bound template|template.*source|creation boundary/i);
  assert.equal(f.source(), before); assert.equal(staleHistory.canUndo(f.projectId), true);
  assert.equal(f.instances.list(f.projectId)[0].instanceId, created.instanceId);
});


test('creation_with_no_prior_history_does_not_invent_history_or_block_later_source_undo', async (t) => {
  const f = fixture(t), created = await f.create();
  assert.equal(created.undoAvailable, false); assert.equal(created.undoBlockedReason, undefined);
  assert.equal(f.history.getUndoState(f.projectId).undoHistoryEntries, 0);
  editSource(f, 'after.txt', 'After template creation');
  undoSource(f);
  assert.equal(f.history.getUndoState(f.projectId).undoHistoryEntries, 0);
  assert.equal(undoSource(f), null);
  assert.ok(JSON.parse(f.source()).files[created.documentPath]);
});
test('current_project_template_creation_requires_shared_history_protection', async (t) => {
  const f = fixture(t, { serviceOptions: { history: undefined } });
  const before = f.source();
  await assert.rejects(f.create(), /history service is unavailable/);
  assert.equal(f.source(), before); assert.deepEqual(f.instances.list(f.projectId), []);
});

test('strudel_factory_receives_host_identity_and_atomic_single_entry_is_extracted', async (t) => {
  const { createStrudelTemplate } = require('../src/strudel-template');
  let factoryId;
  const f = fixture(t, { strudel: true, kitBundles: { strudel: 'window.strudel = {};' }, strudelFactory: (options) => { factoryId = options?.instanceId; return createStrudelTemplate(options); } });
  const before = JSON.parse(f.source());
  const created = await f.create({ templateId: 'strudel-sound' });
  assert.equal(factoryId, created.instanceId);
  const after = JSON.parse(f.source());
  for (const [name, content] of Object.entries(before.files)) assert.equal(after.files[name], content);
  assert.match(after.files[`sketches/${created.instanceId}/app.js`], /function createPattern\(\)/);
  assert.match(after.files[created.documentPath], /Strudel sound/);
  assert.equal(f.instances.list(f.projectId).length, 1);
});

test('strudel_factory_rejects_multi_file_or_invalid_entry_before_writes', async (t) => {
  for (const result of [{ files: { 'index.html': '<main>Hi</main>', 'lost.js': 'bad' }, entry: 'index.html' }, { files: { '../index.html': 'bad' }, entry: '../index.html' }]) {
    const f = fixture(t, { strudel: true, kitBundles: { strudel: 'window.strudel = {};' }, strudelFactory: () => result });
    const before = f.source();
    await assert.rejects(f.create({ templateId: 'strudel-sound' }), /single.*HTML|entry/i);
    assert.equal(f.source(), before);
    assert.deepEqual(f.instances.list(f.projectId), []);
  }
});
