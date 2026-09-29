const fs = require('node:fs');
const path = require('node:path');

const MAX_SKILL_FILE_BYTES = 128_000;
const MAX_SKILL_INSTRUCTIONS_LENGTH = 32_000;

function readInstalledSkills(skillsPath) {
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
      const fullInstructions = (frontMatter ? source.slice(frontMatter[0].length) : source).trim();
      if (!fullInstructions) return [];
      return [{
        id: `installed-${entry.name}`,
        name: name.slice(0, 80),
        instructions: fullInstructions.slice(0, MAX_SKILL_INSTRUCTIONS_LENGTH),
        truncated: fullInstructions.length > MAX_SKILL_INSTRUCTIONS_LENGTH,
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

module.exports = { readInstalledSkills };
