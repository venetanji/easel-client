const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCanvasStore } = require('../../src/canvas-store');
const { createVideoTimelineStore } = require('../../src/video-timeline-store');
const { createTemplateInstanceStore } = require('../../src/template-instance-store');
const { createVideoTimelineController } = require('../../src/video-timeline-controller');
const { createCanvasHistory } = require('../../src/canvas-history');
const { createDeletionService } = require('../../src/deletion-service');

function templateFixture(t, { historyOptions, confirm = () => true, instanceFileSystem } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'easel-template-lifecycle-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const timelines = createVideoTimelineStore({ userDataPath });
  const canvases = createCanvasStore({ userDataPath, listTimelines: (id) => timelines.list(id), listInstances: (id) => instances.list(id) });
  const instances = createTemplateInstanceStore({ userDataPath, timelineStore: timelines, projectStore: canvases, fileSystem: instanceFileSystem });
  const projectId = canvases.save({ title: 'Two video sketches', html: '<h1>Home</h1>', assets: [{ name: 'still', data: 'YWJj', mimeType: 'image/png' }] }).id;
  const assetId = canvases.getProject(projectId).manifest.assets[0].id;
  const records = ['a', 'b'].map((key, index) => ({ projectId, instanceId: String(index + 1).repeat(32), timelineId: key.repeat(32), documentPath: `${key}.html`, templateId: 'video-editor', templateVersion: 1 }));
  for (const record of records) {
    canvases.createDocument(projectId, { path: record.documentPath, html: '<main>Video</main><script>window.EaselVideoEditor = {};</script>' });
    timelines.create(projectId, record.timelineId, {}); instances.create(record);
  }
  let active = { ...records[0], runtimeGeneration: 1 };
  const controller = createVideoTimelineController({ store: timelines, projectStore: canvases, instances, getActiveProjectId: () => projectId, getActiveScope: () => active });
  const hostController = {
    getCurrentCanvasId: () => projectId,
    getCurrentDocumentPath: () => active.documentPath,
    getContract: () => ({ previewHidden: false, runtimeGeneration: active.runtimeGeneration }),
    markSourcePendingReload: () => {},
    openSaved: async (_id, documentPath) => { active = { ...instances.resolveDocument(projectId, documentPath), projectId, documentPath, runtimeGeneration: active.runtimeGeneration + 1 }; return { id: projectId, documentPath }; },
    inspectTimeline: (args) => controller.inspect(args),
    assertTimelineSelectionOrigin: (selection) => controller.assertSelectionOrigin(selection),
    applyTimelineEdit: ({ projectId, timelineId, instanceId, ...input }) => controller.apply(projectId, controller.resolveTarget(projectId, timelineId, instanceId), input),
  };
  const history = createCanvasHistory(historyOptions); let savedRecovery;
  const deletion = createDeletionService({ canvasStore: canvases, instances, confirm,
    canRecordUndo: (...args) => history.canRecord(...args),
    recordUndo: (id, html, recovery) => { savedRecovery = recovery; return history.record(id, html, recovery); },
  });
  const selection = { projectId, instanceId: records[0].instanceId, documentPath: records[0].documentPath, timelineId: records[0].timelineId, runtimeGeneration: 1, timelineRevision: 0, trackIds: ['video-1'], itemIds: [], startFrame: 0, endFrame: 12 };
  const clip = { id: 'clip', trackId: 'video-1', assetId, startFrame: 0, endFrame: 24, sourceStartSeconds: 0, sourceEndSeconds: 1 };
  const bytes = (record) => fs.readFileSync(path.join(userDataPath, 'video-timelines', projectId, `${record.timelineId}.json`), 'utf8');
  return { userDataPath, projectId, canvases, timelines, instances, controller, hostController, history, deletion, records, selection, clip, bytes, savedRecovery: () => savedRecovery,
    setActive: (scope) => { active = { ...active, ...scope }; },
  };
}
module.exports = { templateFixture };
