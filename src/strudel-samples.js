function createStrudelSamples(native, bank, getAssets) {
  const entries = new Map();
  const reserved = new Set([...bank.samples.map(sample => sample.name),
    'sin', 'sine', 'tri', 'triangle', 'sqr', 'square', 'saw', 'sawtooth', 'sbd',
    'white', 'pink', 'brown', 'pulse', 'supersaw', 'sawtri', 'user', '__proto__', 'constructor', 'prototype']);
  let preparation;
  const describe = entry => entry && Object.freeze({ assetId: entry.assetId, digest: entry.digest, durationSeconds: entry.durationSeconds });
  const checkBuffer = buffer => {
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 10 || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new Error('Samples must be mono or stereo audio up to 10 seconds. Use a short Suno one-shot or loop.');
  };
  function prepare() {
    if (!preparation) preparation = (async () => {
      for (const sample of bank.samples) {
        const url = `data:audio/wav;base64,${sample.data}`;
        const buffer = await native.loadBuffer(url, native.getAudioContext(), sample.name);
        checkBuffer(buffer);
        if (Math.abs(buffer.duration - sample.durationSeconds) > 1 / buffer.sampleRate + 1 / 48000) throw new Error(`Bundled sample ${sample.name} has inconsistent duration.`);
        await native.samples({ [sample.name]: [url] });
        entries.set(sample.name, Object.freeze({ ...sample, url, assetId: null }));
      }
    })().catch(error => { preparation = undefined; throw error; });
    return preparation;
  }
  async function add(name, assetId) {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(name)) throw new Error('Use a sample name in single quotes, with up to 48 lowercase letters, numbers or underscores.');
    if (reserved.has(name) || (!entries.has(name) && native.soundMap?.get()[name])) throw new Error('That sound name is reserved. Choose a name such as suno_snare.');
    if (typeof assetId !== 'string' || !/^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(assetId)) throw new Error('Use an attached Media asset ID in single quotes.');
    const assets = getAssets();
    if (!assets) throw new Error('Attach audio to this project in Media before adding a sample.');
    await assets.ready;
    const url = assets.getUrl(assetId);
    if (!/^data:audio\/(?:wav|x-wav|mpeg|mp3|mp4|x-m4a);base64,/.test(url) || url.length > Math.ceil(4 * 1048576 / 3) * 4 + 64) throw new Error('Use a WAV, MP3 or M4A sample up to 4 MiB.');
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), character => character.charCodeAt(0));
    if (!bytes.length || bytes.length > 4 * 1048576) throw new Error('Use a WAV, MP3 or M4A sample up to 4 MiB.');
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    if (entries.get(name)?.digest === digest && entries.get(name)?.assetId === assetId) return describe(entries.get(name));
    const buffer = await native.loadBuffer(url, native.getAudioContext(), name);
    checkBuffer(buffer);
    // A device-rate decode rounds frame counts. Keep portable export metadata
    // at 48 kHz, without replacing or resampling the live audio context.
    let durationSeconds = buffer.duration;
    if (buffer.sampleRate !== 48000) {
      const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes.buffer.slice(0));
      checkBuffer(decoded);
      durationSeconds = decoded.duration;
    }
    // Register only after decoding succeeds, leaving the previous sound playable.
    await native.samples({ [name]: [url] });
    entries.set(name, Object.freeze({ name, label: name, assetId, digest, durationSeconds, url }));
    return describe(entries.get(name));
  }
  return Object.freeze({ supportedFormats: Object.freeze(['wav', 'mp3', 'm4a']), prepare, add, get: name => describe(entries.get(name)),
    list: () => Array.from(entries, ([name, entry]) => ({ name, label: entry.label, ...describe(entry) })) });
}
module.exports = { createStrudelSamples };
