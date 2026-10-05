const crypto = require('node:crypto');
const { listTemplates: catalog } = require('./template-catalog');
const { availableCanvasKits, assertInstalledKits } = require('./canvas-kit-catalog');
const { validateTemplateCreate, validateTemplateOpen, validateOpaqueId, validateCanvasTitle, validateCanvasKits, validateDocumentPath } = require('./ipc-contract');
const { createVideoTimelineTemplate } = require('./video-timeline-template');
const { createStrudelTemplate } = require('./strudel-template');

function createTemplateService({ projectStore, instanceStore, timelineStore, kitBundles = {}, history,
  getCurrentProjectId = () => '', saveBeforeSwitch = async () => {}, openDocument = async () => ({}),
  isBusy = () => false, videoFactory = createVideoTimelineTemplate, strudelFactory = createStrudelTemplate, strudelReady = false,
  idFactory = () => crypto.randomUUID().replaceAll('-', ''),
}) {
  let pending = false;
  function listTemplates(options) {
    const installed = new Set(availableCanvasKits(kitBundles).filter((kit) => kit.installed).map((kit) => kit.id));
    return catalog(options).map((entry) => {
      if (entry.status !== 'ready') return entry;
      const missing = entry.requiredKits.filter((kit) => !installed.has(kit));
      entry.availability = missing.length ? { available: false, reason: `The ${missing.join(', ')} kit is not installed. Check Kits in Settings.`, missingKits: missing }
        : entry.id === 'strudel-sound' && !(strudelReady === true && typeof strudelFactory === 'function') ? entry.availability : { available: true };
      return entry;
    });
  }
  function assertIdle(context) {
    if (isBusy(context)) throw new Error('Wait for the current operation before creating or opening a template.');
  }
  async function exclusive(context, action) {
    if (pending) throw new Error('A template operation is already in progress.');
    assertIdle(context); pending = true;
    try { return await action(); } finally { pending = false; }
  }
  function currentTarget(input) {
    if (input.target === 'new-project') return undefined;
    const current = getCurrentProjectId();
    if (!current) throw new Error('Open a current project before adding a template.');
    validateOpaqueId(current, 'Project ID');
    if (input.projectId !== undefined && input.projectId !== current) throw new Error('The requested project is not the active current project.');
    return current;
  }
  function template(input) {
    const entry = listTemplates().find((item) => item.id === input.templateId);
    if (!entry) throw new Error('This template is not in the local catalog.');
    if (entry.status !== 'ready') throw new Error('This template is planned and cannot be created.');
    if (!entry.availability.available) throw new Error(entry.availability.reason);
    return entry;
  }
  function newId(label) { return validateOpaqueId(idFactory(), label); }
  function createSource(input, projectId, extraKits = []) {
    const entry = template(input);
    const kits = [...new Set([...extraKits, ...entry.requiredKits])];
    assertInstalledKits(kits, kitBundles);
    if (projectId && (!history?.canRecordBoundary || !history?.recordBoundary || !history.canRecordBoundary(projectId))) throw new Error('The template Undo boundary cannot fit the history budget or its history service is unavailable. No sketch was created and earlier history is unchanged.');
    const instanceId = newId('Instance ID');
    const timelineId = entry.id === 'video-editor' ? newId('Timeline ID') : undefined;
    const documentPath = `sketches/${instanceId}/index.html`;
    const source = entry.id === 'video-editor' ? videoFactory() : strudelFactory({ instanceId });
    // The atomic store extracts inline HTML/CSS/JS into editable instance files.
    // Adapt the factory's single-entry contract without silently dropping files
    // or expanding the trusted creation transaction/renderer IPC surface.
    let html = source;
    if (typeof source !== 'string') {
      if (!source || source.entry !== 'index.html' || !source.files ||
        Object.keys(source.files).length !== 1 || typeof source.files['index.html'] !== 'string') {
        throw new Error('Template factory must return a single index.html HTML entry.');
      }
      html = source.files[source.entry];
    }
    let binding, saved, createdTimeline = false, createdBinding = false;
    try {
      saved = projectStore.createTemplateDocument({ projectId, path: documentPath, title: input.title || entry.title, html, kits }, ({ projectId: id }) => {
        binding = { projectId: id, instanceId, documentPath, templateId: entry.id, templateVersion: entry.version, ...(timelineId ? { timelineId } : {}) };
        // These stores refuse collisions; never remove pre-existing records on failure.
        if (timelineId) { timelineStore.create(id, timelineId, {}); createdTimeline = true; }
        instanceStore.create(binding); createdBinding = true;
      });
    } catch (cause) {
      const errors = [cause];
      if (createdBinding) {
        try { instanceStore.remove(binding.projectId, instanceId); createdTimeline = false; } catch (error) { errors.push(error); }
      }
      // If registry removal failed, keep its matching timeline recoverable.
      if (createdTimeline && !createdBinding) try { timelineStore.remove(binding.projectId, timelineId); } catch (error) { errors.push(error); }
      if (errors.length > 1) throw new AggregateError(errors, `Template creation failed: ${cause.message}. Recovery cleanup also failed; no existing project source was replaced.`);
      throw cause;
    }
    // Synchronous history bookkeeping follows the successful canonical commit,
    // before opening a preview. Failed creation never changes the Undo stack.
    if (projectId) history.recordBoundary(projectId);
    return { ...saved, ...binding };
  }
  function undoState(projectId) { return history?.getUndoState?.(projectId) || { undoAvailable: false, undoHistoryEntries: 0 }; }
  async function present(binding, created = false) {
    try {
      const opened = await openDocument(binding.projectId, binding.documentPath);
      return { ...opened, ...binding, ...(binding.timelineId ? { document: timelineStore.read(binding.projectId, binding.timelineId) } : {}), opened: true, ...undoState(binding.projectId) };
    } catch (error) {
      // Source and instance are already durable. Preserve their identity so callers
      // can retry Open, rather than repeat Create and accidentally duplicate work.
      if (!created) throw error;
      return { ...binding, opened: false, openError: error.message, ...undoState(binding.projectId) };
    }
  }
  async function createTemplateInstance(input, context) {
    const checked = validateTemplateCreate(input);
    template(checked);
    const projectId = currentTarget(checked);
    return exclusive(context, async () => {
      await saveBeforeSwitch(); assertIdle(context);
      if (currentTarget(checked) !== projectId) throw new Error('The current project changed while saving. Try adding the template again.');
      return present(createSource(checked, projectId), true);
    });
  }
  function resolveInstance(input) {
    const binding = instanceStore.list(input.projectId).find((entry) => entry.instanceId === input.instanceId);
    if (!binding || !projectStore.listDocuments(input.projectId).documents.some((entry) => entry.path === binding.documentPath)) throw new Error('The template instance or its document no longer exists.');
    return binding;
  }
  async function openTemplateInstance(input, context) {
    const checked = validateTemplateOpen(input); resolveInstance(checked);
    return exclusive(context, async () => {
      await saveBeforeSwitch(); assertIdle(context);
      return present(resolveInstance(checked));
    });
  }
  async function openVideoEditor(input = {}, context) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['projectId', 'instanceId', 'timelineId', 'title', 'kits', 'legacyDocumentPath'].includes(key))) throw new Error('Video project options are invalid.');
    const projectId = input.projectId === undefined ? undefined : validateOpaqueId(input.projectId, 'Project ID');
    if (input.instanceId !== undefined) validateOpaqueId(input.instanceId, 'Instance ID');
    if (input.timelineId !== undefined && (typeof input.timelineId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.timelineId))) throw new Error('Timeline ID is invalid.');
    if (input.legacyDocumentPath !== undefined) validateDocumentPath(input.legacyDocumentPath);
    if (input.legacyDocumentPath !== undefined && (input.instanceId !== undefined || input.timelineId !== undefined)) throw new Error('Choose either a legacy document or a registered instance.');
    if (!projectId && [input.instanceId, input.timelineId, input.legacyDocumentPath].some((value) => value !== undefined)) throw new Error('A project is required to choose an existing video sketch.');
    const title = input.title === undefined ? 'Video project' : validateCanvasTitle(input.title);
    const kits = input.kits === undefined ? ['canvas-2d'] : validateCanvasKits(input.kits);
    return exclusive(context, async () => {
      await saveBeforeSwitch(); assertIdle(context);
      if (projectId) {
        projectStore.listDocuments(projectId);
        if (!input.instanceId && !input.timelineId) {
          try { instanceStore.migrateLegacy(projectId, input.legacyDocumentPath === undefined ? {} : { documentPath: input.legacyDocumentPath }); }
          catch (error) {
            if (error.code !== 'TIMELINE_AMBIGUOUS') throw error;
            return { status: 'choice-required', kind: 'legacy', projectId,
              message: 'These legacy documents share one timeline. Choose its owner; the other source files will remain unchanged.',
              choices: instanceStore.legacyCandidates(projectId).map((entry) => ({ documentPath: entry.path, title: entry.title || entry.path })) };
          }
        }
        const instances = instanceStore.list(projectId).filter((entry) => entry.templateId === 'video-editor');
        let binding;
        if (input.instanceId || input.timelineId) {
          binding = instances.find((entry) => (!input.instanceId || input.instanceId === entry.instanceId) && (!input.timelineId || input.timelineId === entry.timelineId));
          if (!binding) throw new Error('The requested video instance no longer exists or its identity does not match.');
        } else if (instances.length > 1) return { status: 'choice-required', kind: 'instances', projectId,
          message: 'Choose which video sketch to open.', choices: instances.map((entry) => ({ ...entry, title: projectStore.listDocuments(projectId).documents.find((document) => document.path === entry.documentPath)?.title || entry.documentPath })) };
        else binding = instances[0];
        if (binding) return present(resolveInstance(binding));
      }
      return present(createSource({ templateId: 'video-editor', title: projectId ? 'Video editor' : title }, projectId, projectId ? [] : kits), true);
    });
  }
  return { listTemplates, createTemplateInstance, openTemplateInstance, openVideoEditor };
}
module.exports = { createTemplateService };
