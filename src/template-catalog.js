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
    purpose: 'Explore editable synthesized rhythms and melodies with Strudel.',
    requiredKits: ['strudel'], actions: ['create-project', 'add-to-current-project'],
    outputs: ['Editable HTML and pattern source', 'Bounded WAV loop saved to Media after the audio compatibility gate passes'],
    limitations: ['Unavailable until the local kit, real sketch and audio runtime pass compatibility checks.', 'Synth-only patterns; no remote samples, microphone or full REPL.', 'Planned export bounds: 1–16 cycles, 30 seconds and 6 MiB.'],
    questions: ['Do you want to begin with a rhythm or a melody?', 'Should it feel calm, playful or tense?'],
    availability: { available: false, reason: 'The Strudel sketch and audio runtime compatibility gate have not passed.' },
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
