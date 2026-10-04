const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readInstalledSkills } = require('../src/skill-catalog');
const { MEDIA_REFERENCE_TOOLS } = require('../src/media-reference-tools');
const { TIMELINE_TOOLS } = require('../src/video-timeline-tools');

const skillDirectory = path.join(__dirname, '..', '.agents', 'skills', 'easel-media');
const referencesDirectory = path.join(skillDirectory, 'references');
const catalogBytes = fs.readFileSync(path.join(referencesDirectory, 'lora-catalog.json'));
const catalog = JSON.parse(catalogBytes);

test('the bundled LoRA snapshot preserves all pinned server entries', () => {
  assert.equal(catalog.length, 38);
  assert.equal(new Set(catalog.map((entry) => entry.id)).size, catalog.length);
  assert.equal(crypto.createHash('sha256').update(catalogBytes).digest('hex'),
    '3faba4af15374f19d833556527ba77efb6fc22d18318cf43fdec1608f92af556');
  for (const entry of catalog) {
    assert.match(entry.id, /^[a-z0-9.-]+$/);
    assert.ok(['ltx-2', 'ltx-2.3', 'ltx-2.5'].includes(entry.family));
    assert.match(entry.revision, /^[a-f0-9]{40}$/);
    assert.equal(typeof entry.supported, 'boolean');
    assert.ok(Array.isArray(entry.requires));
    assert.ok(entry.validation);
    assert.ok(entry.files.length > 0);
    for (const file of entry.files) {
      assert.match(file.filename, /^[a-zA-Z0-9._-]+\.safetensors$/);
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
    }
  }
});

test('snapshot support is limited to seven cameras and three validated server recipes', () => {
  assert.deepEqual(catalog.filter((entry) => entry.supported).map((entry) => entry.id).sort(), [
    'camera-dolly-in', 'camera-dolly-left', 'camera-dolly-out', 'camera-dolly-right',
    'camera-jib-down', 'camera-jib-up', 'camera-static', 'cinemagraph', 'ingredients', 'slow-motion',
  ]);
  for (const entry of catalog.filter((item) => !item.supported)) {
    assert.equal(entry.validation, 'not_tested');
  }
});

test('the readable inventory documents every registered ID exactly once', () => {
  const inventory = fs.readFileSync(path.join(referencesDirectory, 'loras.md'), 'utf8');
  const documentedIds = [...inventory.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
  assert.deepEqual(documentedIds.sort(), catalog.map((entry) => entry.id).sort());
});

test('skill reference links remain local and resolve inside the bundled skill', () => {
  const filenames = [path.join(skillDirectory, 'SKILL.md'),
    ...fs.readdirSync(referencesDirectory).filter((name) => name.endsWith('.md'))
      .map((name) => path.join(referencesDirectory, name))];
  let referenceCount = 0;
  for (const filename of filenames) {
    const contents = fs.readFileSync(filename, 'utf8');
    for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
      const destination = path.resolve(path.dirname(filename), match[1]);
      assert.ok(destination.startsWith(skillDirectory + path.sep), match[1]);
      assert.ok(fs.statSync(destination).isFile(), match[1]);
      referenceCount += 1;
    }
  }
  assert.ok(referenceCount >= 6);
});

test('the skill distinguishes target models, typed generation controls and current fan-out limits', () => {
  const skill = fs.readFileSync(path.join(skillDirectory, 'SKILL.md'), 'utf8');
  assert.match(skill, /name: easel-media/);
  assert.match(skill, /`qwen-image-2\.1`/);
  assert.match(skill, /`ltx-2\.5`/);
  assert.match(skill, /Current client limit: at most four nonempty segments/);
  for (const name of ['discover_video_capabilities({model})', 'list_video_loras({model})', 'cameraLora', 'cameraLoraStrength', 'loras: [{id,strength?}]', 'motionSpeed', 'loraReferenceAssetId', 'loraReferenceStrength', 'guidingFrames: [{assetId,frameIndex,strength?}]', 'guidingFrames: [{image:{data,mimeType,name?},frameIndex,strength?}]']) {
    assert.ok(skill.includes(name), name);
  }
  assert.match(skill, /exact decimal string/);
  assert.match(skill, /18446744073709551614/);
  assert.match(skill, /32 MiB/);
  assert.match(skill, /1–8 stills/);
  assert.match(skill, /seconds \* 24/);
  assert.match(skill, /step \*\*one\*\*/);
  assert.match(skill, /graph_contract_tested/);
  assert.match(skill, /not live-GPU\/visually verified/);
  assert.match(skill, /soft conditioning/);
  assert.match(skill, /LTX-2\.5 runtime remains unavailable/);
  assert.match(skill.replace(/\s+/g, ' '), /decoded still images.*32 million pixels.*declared MIME/);
  assert.doesNotMatch(skill, /no current MCP adapter-discovery tool|server-side recipes, not current MCP arguments/);
  assert.match(skill, /not a video timeline/);
  assert.match(skill, /no idempotency recovery contract/);
});

test('in-app skill injection includes every adapter and the essential creative guidance', () => {
  const skill = readInstalledSkills(path.dirname(skillDirectory))
    .find((entry) => entry.name === 'easel-media');
  assert.ok(skill);
  assert.equal(skill.truncated, false);
  assert.equal(skill.compatibility, 'supported');
  const documentedIds = [...skill.instructions.matchAll(/^\| `([^`]+)` \|/gm)]
    .map((match) => match[1]);
  assert.deepEqual(documentedIds.sort(), catalog.map((entry) => entry.id).sort());
  const normalizedInstructions = skill.instructions.replace(/\s+/g, ' ');
  for (const practice of ['pose-neutral', 'master audio', 'motionSpeed', 'guide-token', '8n+1']) {
    assert.ok(normalizedInstructions.includes(practice), practice);
  }
  for (const toolName of ['list_media_jobs', 'list_media_assets', 'inspect_media_asset']) {
    assert.ok(MEDIA_REFERENCE_TOOLS.some((tool) => tool.function.name === toolName));
    assert.ok(skill.instructions.includes('`' + toolName + '`'));
  }
});


function injectedMediaInstructions() {
  return readInstalledSkills(path.dirname(skillDirectory))
    .find((entry) => entry.name === 'easel-media').instructions.replace(/\s+/g, ' ');
}

test('injected media skill explains managed timeline assembly without source retiming', () => {
  const instructions = injectedMediaInstructions();
  for (const { function: tool } of TIMELINE_TOOLS) {
    assert.ok(instructions.includes('`' + tool.name + '`'), tool.name);
  }
  assert.match(instructions, /`inspect_timeline`.*`list_media_assets`.*`attach_canvas_assets`.*`apply_timeline_edit`/);
  assert.match(instructions, /`expectedRevision`/);
  assert.match(instructions, /stale.*fresh selection/);
  assert.match(instructions, /integer half-open.*\[startFrame,endFrame\)/);
  assert.match(instructions, /sourceStartSeconds.*sourceEndSeconds.*seconds/);
  assert.match(instructions, /frameRate.numerator \/ frameRate.denominator/);
  assert.match(instructions, /sourceEndSeconds - sourceStartSeconds = \(endFrame - startFrame\) \/ fps/);
  assert.match(instructions, /\[0,48\).*\[48,96\)/);
  assert.match(instructions, /no same-track overlaps/);
  assert.match(instructions, /Export video.*no agent export tool/);
});

test('injected stitching recipes separate local cuts from unsupported temporal generation', () => {
  const instructions = injectedMediaInstructions();
  assert.match(instructions, /Hard-cut assembly/);
  assert.match(instructions, /Generative stitching/);
  assert.match(instructions, /H3.*temporal video\/audio guides.*client.*cannot submit/);
  assert.match(instructions, /LTX.*still-image.*temporal.*not exposed/);
  assert.match(instructions, /retained.*boundary frames/);
  assert.match(instructions, /duplicate.*boundary frame/);
  assert.match(instructions, /identity.*motion.*lighting/);
  assert.match(instructions, /gain.*fadeInFrames.*fadeOutFrames/);
  assert.match(instructions, /never claim.*heard.*metadata/);
  assert.match(instructions, /ComfyUI restart.*downloaded managed assets/);
  assert.match(instructions, /never.*resubmit.*billed/);
  assert.doesNotMatch(instructions, /prepare_timeline_guides/);
});
