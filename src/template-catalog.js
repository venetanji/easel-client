// Locally packaged teaching sketches. Readiness describes the intended template;
// availability describes whether this build can actually create it.
const ENTRIES = [
  {
    id: 'video-editor', version: 1, status: 'ready', title: 'Video editor',
    purpose: 'Arrange your footage and sound into an editable video sketch.',
    requiredKits: ['canvas-2d'], actions: ['create-project', 'add-to-current-project'],
    outputs: ['Editable HTML and independent timeline', 'WebM video saved to Media'],
    limitations: ['WebM export is limited to 60 seconds and 32 MiB.', 'Transitions and speed changes are not supported.'],
    questions: ['What do you want the viewer to feel?', 'Do you already have footage, or should we plan the shots?'],
    availability: { available: true },
  },
  {
    id: 'strudel-sound', version: 1, status: 'ready', title: 'Strudel sound',
    purpose: 'Write and audition live Strudel patterns in an offline scratchpad.',
    requiredKits: ['strudel'], actions: ['create-project', 'add-to-current-project'],
    outputs: ['Editable HTML with synths, local drums and attached samples', 'Bounded stereo WAV loop saved to Media'],
    limitations: ['Creation requires the installed Strudel kit. Existing projects retain their pinned kit; create a new Strudel project for the latest local sample bank.', 'Remote samples/network are blocked. Attached WAV/MP3/M4A samples must be mono/stereo, at most 10 seconds and 4 MiB; WAV export accepts at most 16 sample names and 8 MiB of sample bytes.', 'WAV export: 1–16 cycles, at most 30 seconds including a 0.5-second release tail.', 'Stereo 48 kHz PCM16 WAV below 6 MiB; effects and sample pitch/speed/slicing cannot export.'],
    questions: ['Do you want to begin with a rhythm or a melody?', 'Should it feel calm, playful or tense?'],
    availability: { available: false, reason: 'Creation requires the installed Strudel kit.' },
  },
  ...[
    ['presentations', 'Presentations', 'Build an editable visual story for a presentation.'],
    ['games', 'Games', 'Explore rules, characters and playful interaction.'],
    ['image-editor', 'Image editor', 'Explore composition, crops and image layers.'],
    ['svg-editor', 'SVG editor', 'Draw and adapt editable vector artwork.'],
    ['voxel-soundscape', 'Voxel soundscape', 'Explore a three-dimensional scene with sound.'],
  ].map(([id, title, purpose]) => ({
    id, version: 1, status: 'planned', title, purpose, requiredKits: [], actions: [], outputs: [],
    limitations: ['Planned; no working template is included in this release.'], questions: [],
    availability: { available: false, reason: 'This template is planned.' },
  })),
];
function listTemplates(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'includePlanned') || options.includePlanned !== undefined && typeof options.includePlanned !== 'boolean') throw new Error('Template list options are invalid.');
  return structuredClone(ENTRIES.filter((entry) => options.includePlanned !== false || entry.status !== 'planned'));
}
module.exports = { listTemplates };
