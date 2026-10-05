const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID = /^[a-f0-9]{32}$/;
const TIMELINE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BYTES = 1024 * 1024;
const writing = new Set();
function fail(message, code = 'INSTANCE_INVALID') { throw Object.assign(new Error(message), { code }); }
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is invalid.`); return value; }
function documentPath(value) {
  if (typeof value !== 'string' || value.length > 240 || /[\\\u0000-\u001f\u007f?#:]/.test(value) || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..') || !/\.html?$/i.test(value)) fail('Instance document path is invalid.');
  return value;
}
function validateRecord(record, projectId, legacy = false) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some((key) => !['projectId', 'instanceId', 'documentPath', 'templateId', 'templateVersion', 'timelineId'].includes(key))) fail('Instance contains unsupported fields.');
  id(record.projectId, 'Project ID'); id(record.instanceId, 'Instance ID'); documentPath(record.documentPath);
  if (record.projectId !== projectId || !['video-editor', 'strudel-sound'].includes(record.templateId) || !Number.isSafeInteger(record.templateVersion) || record.templateVersion < 1) fail('Instance template or project is invalid.');
  if (record.templateId === 'video-editor') {
    if (typeof record.timelineId !== 'string' || !(legacy ? TIMELINE_ID : ID).test(record.timelineId)) fail('Instance timeline ID is invalid.');
  } else if (Object.hasOwn(record, 'timelineId')) fail('This template has no timeline.');
  return structuredClone(record);
}

function createTemplateInstanceStore({ userDataPath, fileSystem = fs, timelineStore, projectStore, idFactory = () => crypto.randomUUID().replaceAll('-', '') }) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new Error('Instance storage requires a user data path.');
  const directory = path.join(userDataPath, 'template-instances');
  const filename = (projectId) => path.join(directory, `${id(projectId, 'Project ID')}.json`);
  function read(projectId) {
    let raw;
    try {
      const target = filename(projectId);
      if (fileSystem.statSync(target).size > MAX_BYTES) fail('Instance registry exceeds its limit.', 'INSTANCE_CORRUPT');
      raw = fileSystem.readFileSync(target, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, projectId, instances: [] }; throw error; }
    try {
      const value = JSON.parse(raw);
      if (!value || Object.keys(value).sort().join() !== 'instances,projectId,schemaVersion' || value.schemaVersion !== 1 || value.projectId !== projectId || !Array.isArray(value.instances) || value.instances.length > 100) throw new Error('Registry schema is invalid.');
      const instances = value.instances.map((record) => validateRecord(record, projectId, true));
      for (const key of ['instanceId', 'documentPath', 'timelineId']) {
        const values = instances.map((entry) => entry[key]).filter(Boolean);
        if (new Set(values).size !== values.length) throw new Error('Registry bindings are not unique.');
      }
      return { schemaVersion: 1, projectId, instances };
    } catch (cause) { throw Object.assign(new Error(`Saved template instances are corrupt or unsupported: ${cause.message}`), { code: 'INSTANCE_CORRUPT', cause }); }
  }
  function write(projectId, value) {
    const target = filename(projectId), temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > MAX_BYTES || value.instances.length > 100) fail('Instance registry exceeds its limit.');
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fileSystem.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const descriptor = fileSystem.openSync(temporary, 'r');
      try { fileSystem.fsyncSync(descriptor); } finally { fileSystem.closeSync(descriptor); }
      fileSystem.renameSync(temporary, target);
    } catch (error) { try { fileSystem.rmSync(temporary, { force: true }); } catch {} throw error; }
  }
  function exclusive(projectId, callback) {
    const target = filename(projectId);
    if (writing.has(target)) fail('Template instances are already being updated.', 'INSTANCE_BUSY');
    writing.add(target); try { return callback(); } finally { writing.delete(target); }
  }
  function append(record, legacy = false) {
    const checked = validateRecord(record, record?.projectId, legacy), saved = read(checked.projectId);
    if (saved.instances.some((entry) => entry.instanceId === checked.instanceId || entry.documentPath === checked.documentPath || checked.timelineId && entry.timelineId === checked.timelineId)) fail('This document, instance or timeline is already bound.', 'INSTANCE_EXISTS');
    write(checked.projectId, { ...saved, instances: [...saved.instances, checked] });
    return checked;
  }
  function list(projectId) { return read(projectId).instances; }
  function resolveDocument(projectId, input) { documentPath(input); return list(projectId).find((entry) => entry.documentPath === input) ?? null; }
  function create(record) { return exclusive(record?.projectId, () => append(record)); }
  function capture(projectId, instanceId) {
    id(instanceId, 'Instance ID');
    const instance = list(projectId).find((entry) => entry.instanceId === instanceId);
    if (!instance) fail('The template instance no longer exists.', 'INSTANCE_NOT_FOUND');
    const timeline = instance.timelineId ? timelineStore.snapshot(projectId, instance.timelineId) : null;
    if (instance.timelineId && !timeline) fail('The template timeline is missing; cannot retain its Undo recovery state.');
    return { instance, timeline };
  }
  function restore(projectId, snapshots) {
    return exclusive(projectId, () => {
      if (!Array.isArray(snapshots) || snapshots.length > 100) fail('Template recovery snapshots are invalid.');
      const saved = read(projectId), next = [...saved.instances], restored = [];
      const checked = snapshots.map((snapshot) => {
        if (!snapshot || Object.keys(snapshot).sort().join() !== 'instance,timeline') fail('Template recovery snapshot is invalid.');
        const instance = validateRecord(snapshot.instance, projectId, true);
        if (Boolean(instance.timelineId) !== Boolean(snapshot.timeline)) fail('Template recovery timeline is missing or unexpected.');
        const existing = next.find((entry) => entry.instanceId === instance.instanceId || entry.documentPath === instance.documentPath || instance.timelineId && entry.timelineId === instance.timelineId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(instance)) fail('Recovered template conflicts with an existing binding.', 'INSTANCE_EXISTS');
        if (!existing) next.push(instance);
        return { instance, timeline: snapshot.timeline };
      });
      try {
        for (const { instance, timeline } of checked) {
          if (timeline && timelineStore.restoreSnapshot(projectId, instance.timelineId, timeline)) restored.push(instance.timelineId);
        }
        write(projectId, { ...saved, instances: next });
      } catch (cause) {
        const errors = [cause];
        for (const timelineId of restored.reverse()) { try { timelineStore.remove(projectId, timelineId); } catch (error) { errors.push(error); } }
        if (errors.length > 1) throw new AggregateError(errors, 'Template recovery failed; retain the Undo history and retry.');
        throw cause;
      }
      return checked.map(({ instance }) => instance);
    });
  }
  function remove(projectId, instanceId) {
    id(instanceId, 'Instance ID');
    return exclusive(projectId, () => {
      const saved = read(projectId), record = saved.instances.find((entry) => entry.instanceId === instanceId);
      if (!record) return false;
      // Commit the registry first; a failed timeline transaction restores the binding.
      write(projectId, { ...saved, instances: saved.instances.filter((entry) => entry !== record) });
      try { if (record.timelineId) timelineStore?.remove(projectId, record.timelineId); }
      catch (cause) { write(projectId, saved); throw cause; }
      return true;
    });
  }
  function removeProject(projectId) {
    return exclusive(projectId, () => {
      const saved = read(projectId);
      write(projectId, { ...saved, instances: [] });
      try { timelineStore?.removeAll(projectId); }
      catch (cause) { write(projectId, saved); throw cause; }
      return saved.instances.length;
    });
  }
  function legacyCandidates(projectId) {
    const saved = read(projectId);
    return projectStore.listDocuments(projectId).documents.filter((document) => {
      if (saved.instances.some((entry) => entry.documentPath === document.path)) return false;
      if (document.path === 'video-editor/index.html' || document.templateId === 'video-editor') return true;
      // Inspect only the selected source graph, never host-injected project data.
      const source = projectStore.getDocumentSource?.(projectId, document.path)?.html || projectStore.getProject(projectId).files?.[document.path] || '';
      return /EaselHost(?:\?\.)?\.?(?:timeline)|EaselVideoEditor|id=["']video-editor["']/.test(source);
    });
  }
  function migrateLegacy(projectId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'documentPath')) fail('Legacy migration choice is invalid.');
    if (options.documentPath !== undefined) documentPath(options.documentPath);
    return exclusive(projectId, () => {
      const saved = read(projectId), legacy = timelineStore.readLegacy(projectId);
      if (!legacy) {
        if (options.documentPath !== undefined) fail('There is no legacy timeline for this choice.');
        return { status: 'none' };
      }
      const instance = saved.instances.find((entry) => entry.timelineId === legacy.document.id);
      if (instance) {
        if (options.documentPath !== undefined && options.documentPath !== instance.documentPath) fail('This legacy timeline is already bound to a different document.');
        return { status: 'already-migrated', instance };
      }
      let candidates = legacyCandidates(projectId);
      if (options.documentPath !== undefined) {
        candidates = candidates.filter((entry) => entry.path === options.documentPath);
        if (!candidates.length) fail('Choose one of the recognized legacy video candidates.');
      }
      if (candidates.length > 1) fail('Multiple legacy video documents share one timeline. Choose which document owns it before migrating.', 'TIMELINE_AMBIGUOUS');
      if (!candidates.length) return { status: 'document-missing' };
      timelineStore.migrateLegacy(projectId);
      const migrated = append({ projectId, instanceId: idFactory(), documentPath: candidates[0].path, templateId: 'video-editor', templateVersion: 1, timelineId: legacy.document.id }, true);
      return { status: 'migrated', instance: migrated };
    });
  }
  return { list, resolveDocument, create, capture, restore, remove, removeProject, migrateLegacy, legacyCandidates };
}
module.exports = { createTemplateInstanceStore };
