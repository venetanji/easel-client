const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readInstalledSkills } = require('../src/skill-catalog');

test('native canvas skill teaches permission-bounded template dialogue without adding a seventh skill', () => {
  const catalog = readInstalledSkills(path.join(__dirname, '../.agents/skills'));
  assert.equal(catalog.length, 6);
  const instructions = catalog.find((skill) => skill.name === 'easel-canvas').instructions;
  for (const name of ['list_templates', 'create_template_instance', 'request_canvas_input', 'restorePreviousView', 'clear']) assert.ok(instructions.includes(name));
  assert.match(instructions, /specific.*(?:create|add).*target/i);
  assert.match(instructions, /rhythm.*melody/);
  assert.match(instructions, /calm.*energetic/);
  assert.match(instructions, /never.*resetState/i);
  assert.match(instructions, /model round trip.*reload/i);
  assert.match(instructions, /Escape.*Stop/);
  assert.match(instructions, /questions.*media.*permission/i);
  assert.ok(instructions.length < 32_000);
});
