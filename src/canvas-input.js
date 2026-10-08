const ID_PATTERN = /^[a-f0-9]{32}$/;
const INPUT_ACTIONS = new Set(['clear', 'restorePreviousView', 'resetState']);
const { validateInteractionOrigin } = require('./interaction-origin');

function inputId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function validateCanvasInputRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Canvas input request is required.');
  if (Object.keys(input).some((key) => !['question', 'options', 'afterSubmit'].includes(key))) throw new Error('Canvas input request contains unsupported fields.');
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (!question || question.length > 1000) throw new Error('Canvas input question must contain 1 to 1000 characters.');
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 12) throw new Error('Canvas input needs 2 to 12 choices.');
  const values = new Set();
  const options = input.options.map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option) || Object.keys(option).some((key) => !['value', 'label'].includes(key))) throw new Error('Canvas input choice is invalid.');
    const value = typeof option.value === 'string' ? option.value.trim() : '';
    const label = typeof option.label === 'string' ? option.label.trim() : '';
    if (!value || value.length > 128 || !label || label.length > 240) throw new Error('Canvas choice needs a value (up to 128 characters) and label (up to 240).');
    if (values.has(value)) throw new Error('Canvas choice values must be unique.');
    values.add(value);
    return { value, label };
  });
  const afterSubmit = input.afterSubmit ?? 'restorePreviousView';
  if (!INPUT_ACTIONS.has(afterSubmit)) throw new Error('Canvas input completion action is invalid.');
  return { question, options, afterSubmit };
}

function validateCanvasInputSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['requestId', 'value', 'canvasId', 'documentPath', 'instanceId'].includes(key))) throw new Error('Canvas input submission is invalid.');
  const requestId = inputId(input.requestId, 'Input request ID');
  const canvasId = inputId(input.canvasId, 'Canvas ID');
  if (typeof input.value !== 'string' || !input.value || input.value.length > 128) throw new Error('Canvas input value is invalid.');
  const documentPath = input.documentPath === undefined ? undefined : require('./ipc-contract').validateDocumentPath(input.documentPath);
  const instanceId = input.instanceId === undefined ? undefined : inputId(input.instanceId, 'Instance ID');
  return { requestId, canvasId, value: input.value, ...(documentPath ? { documentPath } : {}), ...(instanceId ? { instanceId } : {}) };
}

// Scope comes from the host's current document and registry, never authored UI.
// Old requests without instance identity retain their existing document behavior.
function canvasInputMatchesScope(entry, scope) {
  return Boolean(scope && entry.canvasId === scope.canvasId
    && (!entry.documentPath || entry.documentPath === scope.documentPath)
    && (entry.instanceId === undefined || entry.instanceId === scope.instanceId));
}

function canvasInputSummary(entry) {
  const keys = ['id', 'kind', 'canvasId', 'documentPath', 'instanceId', 'chatId', 'question', 'options', 'afterSubmit', 'value', 'prompt', 'status', 'createdAt', 'answeredAt', 'completedAt', 'error', 'actionApplied', 'actionError'];
  const summary = Object.fromEntries(keys.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
  if (entry.origin !== undefined) summary.origin = validateInteractionOrigin(entry.origin);
  if (entry.attachments) summary.attachments = entry.attachments.map(({ assetId, type, name, mimeType }) => ({ assetId, type, name, mimeType }));
  return summary;
}

function formatCanvasInputMessage(entry) {
  if (entry.kind === 'media') {
    const prompt = entry.prompt || 'Review the media I shared from the canvas.';
    return `${prompt}\n\n${JSON.stringify({ type: 'canvas_media', requestId: entry.id, canvasId: entry.canvasId, documentPath: entry.documentPath || '', assets: entry.attachments.map(({ assetId, type, name, mimeType }) => ({ assetId, type, name, mimeType })) })}`;
  }
  const choice = entry.options.find((option) => option.value === entry.value);
  return `Canvas response: ${choice?.label || entry.value}\n\n${JSON.stringify({ type: 'canvas_input', requestId: entry.id, canvasId: entry.canvasId, documentPath: entry.documentPath || '', ...(entry.instanceId ? { instanceId: entry.instanceId } : {}), question: entry.question, value: entry.value, label: choice?.label || entry.value, completion: { action: entry.afterSubmit, applied: Boolean(entry.actionApplied), ...(entry.actionError ? { error: entry.actionError } : {}) } })}`;
}

module.exports = { canvasInputMatchesScope, canvasInputSummary, formatCanvasInputMessage, inputId, validateCanvasInputRequest, validateCanvasInputSubmission };
