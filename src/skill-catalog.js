const fs = require('node:fs');
const path = require('node:path');

const MAX_SKILL_FILE_BYTES = 128_000;
const MAX_SKILL_INSTRUCTIONS_LENGTH = 32_000;
const HARNESS_SKILLS = Object.freeze({
  'easel-media': [],
  'easel-canvas': [],
  'easel-audio': ['tone'],
  'easel-p5': ['p5'],
  'easel-three': ['three'],
});
const HYPERFRAMES_SKILLS = new Set([
  'canopy-part-title', 'code-slice-hero', 'cuboid-carousel', 'embedded-captions',
  'faceless-explainer', 'figma', 'frost-sequence-camera-orbit', 'general-video',
  'glass-shard-title', 'media-use', 'motion-graphics', 'music-to-video', 'orbit-card',
  'pr-to-video', 'product-launch-video', 'remotion-to-hyperframes', 'slideshow',
  'talking-head-recut', 'wireframe-portal-title',
]);

function skillCompatibility(folder, availableKits) {
  if (Object.hasOwn(HARNESS_SKILLS, folder)) {
    const requiredKits = HARNESS_SKILLS[folder];
    const missing = availableKits && requiredKits.filter((id) => !availableKits.some((kit) => kit.id === id && kit.installed));
    if (missing?.length) return { compatibility: 'unsupported', requiredKits, reason: `Requires an installed ${missing.join(', ')} kit.` };
    return { compatibility: 'supported', requiredKits, reason: requiredKits.length ? `Enable ${requiredKits.join(', ')} in the project's Files drawer.` : 'Uses the tools and offline runtime available in Easel.' };
  }
  if (folder === 'hyperframes' || folder.startsWith('hyperframes-') || HYPERFRAMES_SKILLS.has(folder)) return {
    compatibility: 'unsupported', requiredKits: [],
    reason: 'Requires HyperFrames, shell commands or external assets that the in-app agent cannot access.',
  };
  return { compatibility: 'unreviewed', requiredKits: [], reason: 'Not reviewed for the Easel harness. Its dependencies may be unavailable.' };
}

function readInstalledSkills(skillsPath, { availableKits } = {}) {
  if (!fs.existsSync(skillsPath)) return [];
  return fs.readdirSync(skillsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{1,80}$/.test(entry.name))
    .flatMap((entry) => {
      const filename = path.join(skillsPath, entry.name, 'SKILL.md');
      if (!fs.existsSync(filename)) return [];
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return [];
      const source = fs.readFileSync(filename, 'utf8').trim();
      const frontMatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
      const name = frontMatter?.[1].match(/^name\s*:\s*(["']?)(.*?)\1\s*$/im)?.[2]?.trim() || entry.name;
      const description = frontMatter?.[1].match(/^description\s*:\s*(["']?)(.*?)\1\s*$/im)?.[2]?.trim() || '';
      const fullInstructions = (frontMatter ? source.slice(frontMatter[0].length) : source).trim();
      if (!fullInstructions) return [];
      return [{
        id: `installed-${entry.name}`,
        name: name.slice(0, 80),
        description: description.slice(0, 1000),
        instructions: fullInstructions.slice(0, MAX_SKILL_INSTRUCTIONS_LENGTH),
        truncated: fullInstructions.length > MAX_SKILL_INSTRUCTIONS_LENGTH,
        ...skillCompatibility(entry.name, availableKits),
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assertHarnessSkills(skills, catalog) {
  const unavailable = new Map(catalog.filter((skill) => skill.compatibility !== 'supported').map((skill) => [skill.name.toLowerCase(), skill]));
  for (const skill of skills) {
    const installed = unavailable.get(skill.name.toLowerCase());
    if (installed) throw new Error(`The ${installed.name} skill is unavailable in Easel: ${installed.reason}`);
  }
  return skills;
}

module.exports = { readInstalledSkills, skillCompatibility, assertHarnessSkills };
