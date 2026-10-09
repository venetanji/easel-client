const EXTENSIONS = Object.freeze({ 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' });

function isGenericGeneratedName(name) {
  return /^Generated (?:video|audio)\.(?:mp4|webm|wav|mp3|m4a)$/i.test(name || '');
}

function generatedMediaName(prompt, mimeType, index = 0) {
  const extension = EXTENSIONS[mimeType];
  if (!extension) return undefined;
  let stem = String(prompt || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '');
  stem = stem.replace(/\.(?:mp4|webm|wav|mp3|m4a)$/i, '').trim();
  if (stem.length > 120) stem = stem.slice(0, 120).replace(/\s+\S*$/, '').trim() || stem.slice(0, 120);
  stem ||= mimeType.startsWith('video/') ? 'Generated video' : 'Generated audio';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `${stem} media`;
  return `${stem}${index ? ` ${index + 1}` : ''}.${extension}`;
}

module.exports = { generatedMediaName, isGenericGeneratedName };
