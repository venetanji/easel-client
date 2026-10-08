const { listTemplates } = require('./template-catalog');

const TEMPLATE_METHODS = Object.freeze({ list_templates: 'listTemplates', create_template_instance: 'createTemplateInstance' });
const MAX_CATALOG_BYTES = 12_000;
const TEMPLATE_TOOLS = Object.freeze([
  { type: 'function', function: {
    name: 'list_templates',
    description: 'Discover locally packaged creative templates, readiness, installed-kit availability, limitations and suggested questions. Planned entries cannot be opened or created. Discovery starts no generation, playback or creation.',
    parameters: { type: 'object', additionalProperties: false, properties: { includePlanned: { type: 'boolean' } } },
  } },
  { type: 'function', function: {
    name: 'create_template_instance',
    description: 'Create an independent editable template sketch only after a specific user request to create or add it and choose the target. Preserve existing project files. For current-project, projectId must match the active project. Planned/unavailable entries are rejected; opening starts no model call or playback. A failed preview still returns the saved identity; do not create again.',
    parameters: { type: 'object', additionalProperties: false, required: ['templateId', 'target'], properties: {
      templateId: { type: 'string', enum: listTemplates({ includePlanned: false }).map((entry) => entry.id) },
      target: { type: 'string', enum: ['new-project', 'current-project'] },
      projectId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
      title: { type: 'string', minLength: 1, maxLength: 120 },
    } },
  } },
]);

function templateCatalogResult(templates) {
  const result = { templates, limitBytes: MAX_CATALOG_BYTES };
  if (!Array.isArray(templates) || templates.length > 32 || Buffer.byteLength(JSON.stringify(result)) > MAX_CATALOG_BYTES) throw new Error('The local template catalog exceeds its discovery limit.');
  return result;
}

module.exports = { TEMPLATE_METHODS, TEMPLATE_TOOLS, templateCatalogResult };
