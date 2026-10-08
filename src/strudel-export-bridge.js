const { revision } = require("./canvas-source");
function currentStrudelScope({ view, getView, projectStore, instances }) {
  const current = getView?.() || view, contract = current.getContract();
  if (contract.loading || contract.previewHidden || contract.sourcePendingReload || contract.loadedSourceValid === false) throw new Error("Reload and open the saved sound sketch before export.");
  const projectId = current.getCurrentCanvasId(), documentPath = current.getCurrentDocumentPath();
  if (!projectId || !documentPath || !projectStore.listDocuments(projectId).documents.some((entry) => entry.path === documentPath)) throw new Error("Open an existing saved Strudel sound document.");
  const instance = instances.resolveDocument(projectId, documentPath);
  if (instance?.templateId !== "strudel-sound") throw new Error("This document is not bound to a Strudel sound instance.");
  const project = projectStore.getProject(projectId);
  const sourceRevision = revision(projectStore.getDocumentSource(projectId, documentPath).html);
  const kits = project.manifest.kits.map(({ name, digest }) => ({ name, digest: digest || null }));
  // The authored source digest alone omits kit bytes and script execution order.
  const boundRevision = revision(JSON.stringify({ sourceRevision, kits }));
  projectStore.getProjectKitSource(projectId, "strudel");
  return { projectId, documentPath, instanceId: instance.instanceId, runtimeGeneration: contract.runtimeGeneration, sourceRevision: boundRevision };
}
function assertStrudelScope(scope, options) {
  const current = currentStrudelScope(options);
  if (["projectId", "documentPath", "instanceId", "runtimeGeneration", "sourceRevision"].some((key) => current[key] !== scope[key])) throw new Error("The Strudel source, instance or runtime changed. Reload the original sketch and export again.");
}
function createStrudelExportBridge({ controller, exportReady = false, isBusy = () => false, ...options }) {
  const record = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unsupported fields.`);
  };
  async function handle(request) {
    record(request, ["action", "input"], "Strudel export bridge request");
    const input = request.input ?? {};
    if (!["context", "export", "cancel"].includes(request.action)) throw new Error("Unsupported Strudel export bridge action.");
    record(input, request.action === "context" ? [] : request.action === "cancel" ? ["exportId"] : ["exportId", "expectedSourceRevision", "snapshot"], "Strudel export input");
    const scope = currentStrudelScope(options);
    if (request.action === "context") return { sourceRevision: scope.sourceRevision, exportReady: exportReady === true, ...!exportReady ? { reason: "WAV export is awaiting its end-to-end runtime compatibility gate." } : {} };
    if (request.action === "cancel") return controller.cancel(scope, input.exportId);
    if (exportReady !== true) throw new Error("WAV export is awaiting its end-to-end runtime compatibility gate.");
    if (isBusy()) throw new Error("Wait for the current agent operation before exporting sound.");
    return controller.start(scope, input);
  }
  return { handle };
}
module.exports = { currentStrudelScope, assertStrudelScope, createStrudelExportBridge };
