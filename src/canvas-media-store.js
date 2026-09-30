const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_MEDIA_BYTES = 32 * 1_048_576;
const MAX_VIDEO_FRAMES = 6;
const MAX_FRAME_BYTES = 2 * 1_048_576;
const MAX_POSTER_CHARACTERS = 65_536;
const FORMATS = Object.freeze({ 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'video/webm': 'webm', 'video/mp4': 'mp4' });
const ID_PATTERN = /^[a-f0-9]{32}$/;

function readBase64(value, limit, label) {
  if (typeof value !== 'string' || !value || value.length % 4 || value.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(label + ' is invalid or oversized.');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > limit) throw new Error(label + ' exceeds its size limit.');
  return bytes;
}

function validateMediaBytes(bytes, mimeType) {
  const wav = bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  const mp3 = bytes.length >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  const webm = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const mp4 = bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  if (!({ 'audio/wav': wav, 'audio/mpeg': mp3, 'video/webm': webm, 'video/mp4': mp4 })[mimeType]) throw new Error('Capture media does not match its declared file format.');
}

function jpegBytes(data, limit = MAX_FRAME_BYTES) {
  const bytes = readBase64(data, limit, 'Video frame');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error('Video samples must be complete JPEG images.');
  return bytes;
}

function createCanvasMediaStore({ userDataPath, fileSystem = fs, idFactory = () => crypto.randomUUID().replaceAll('-', '') }) {
  const directory = path.join(userDataPath, 'canvas-media');

  function checkId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Capture ID is invalid.');
    return id;
  }

  function capturePath(id) { return path.join(directory, checkId(id)); }

  function record(id) {
    const folder = capturePath(id);
    const metadataFile = path.join(folder, 'metadata.json');
    if (fileSystem.existsSync(metadataFile)) {
      if (fileSystem.statSync(metadataFile).size > 128_000) throw new Error('Saved capture metadata exceeds its limit.');
      const metadata = JSON.parse(fileSystem.readFileSync(metadataFile, 'utf8'));
      if (!metadata || metadata.id !== id || !Object.hasOwn(FORMATS, metadata.mimeType) || !Number.isInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > MAX_MEDIA_BYTES || !/^[a-f0-9]{64}$/.test(metadata.digest)) throw new Error('Saved capture metadata is invalid.');
      if (typeof metadata.name !== 'string' || !metadata.name || metadata.name.length > 160 || /[\u0000-\u001f\u007f]/.test(metadata.name) || !Number.isFinite(metadata.updatedAt) || metadata.updatedAt < 0) throw new Error('Saved capture identity metadata is invalid.');
      for (const key of ['width', 'height']) if (metadata[key] !== undefined && (!Number.isInteger(metadata[key]) || metadata[key] < 1 || metadata[key] > 16_384)) throw new Error('Saved capture dimensions are invalid.');
      if (metadata.duration !== undefined && (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || metadata.duration > 3_600)) throw new Error('Saved capture duration is invalid.');
      if (metadata.codec !== undefined && (typeof metadata.codec !== 'string' || metadata.codec.length > 160 || /[\u0000-\u001f\u007f]/.test(metadata.codec))) throw new Error('Saved capture codec is invalid.');
      if (typeof metadata.thumbnail !== 'string' || metadata.thumbnail.length > MAX_POSTER_CHARACTERS || (metadata.thumbnail && !metadata.thumbnail.startsWith('data:image/jpeg;base64,'))) throw new Error('Saved capture poster is invalid.');
      if (metadata.scope !== undefined && (!metadata.scope || typeof metadata.scope !== 'object' || Array.isArray(metadata.scope) || Buffer.byteLength(JSON.stringify(metadata.scope)) > 2_048)) throw new Error('Saved capture scope is invalid.');
      return { metadata, filename: path.join(folder, 'media.' + FORMATS[metadata.mimeType]), folder };
    }
    // Flat WAV/MP3 records from previous versions remain readable.
    for (const [mimeType, extension] of Object.entries(FORMATS)) {
      const filename = path.join(directory, id + '.' + extension);
      if (fileSystem.existsSync(filename)) {
        const stat = fileSystem.statSync(filename);
        if (stat.size < 1 || stat.size > MAX_MEDIA_BYTES) throw new Error('Saved capture exceeds its media limit.');
        return { filename, metadata: { id, mimeType, name: (mimeType.startsWith('video/') ? 'Canvas recording' : 'Audio capture') + '.' + extension, bytes: stat.size, updatedAt: stat.mtimeMs, thumbnail: '' } };
      }
    }
    throw new Error('Capture media was not found.');
  }

  function publicMetadata(metadata) {
    return Object.fromEntries(['id', 'name', 'mimeType', 'bytes', 'width', 'height', 'duration', 'codec', 'thumbnail', 'updatedAt', 'scope'].filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]));
  }

  async function save({ data, mimeType, name, width, height, duration, codec, thumbnail = '', frames = [], scope } = {}) {
    if (!Object.hasOwn(FORMATS, mimeType)) throw new Error('Capture media must be WAV, MP3, WebM, or MP4.');
    const bytes = readBase64(data, MAX_MEDIA_BYTES, 'Capture media');
    validateMediaBytes(bytes, mimeType);
    const video = mimeType.startsWith('video/');
    for (const [label, value] of [['width', width], ['height', height]]) if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 16_384)) throw new Error('Capture ' + label + ' is invalid.');
    if (duration !== undefined && (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 3_600)) throw new Error('Capture duration is invalid.');
    if (codec !== undefined && (typeof codec !== 'string' || codec.length > 160 || /[\u0000-\u001f\u007f]/.test(codec))) throw new Error('Capture codec is invalid.');
    if (!Array.isArray(frames) || frames.length > MAX_VIDEO_FRAMES || (!video && frames.length)) throw new Error('Save at most six samples for a captured video.');
    const samples = frames.map((frame, index) => {
      if (!frame || typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > (duration || 3_600)) throw new Error('Video sample timestamp is invalid.');
      return { timestamp: frame.timestamp, filename: 'frame-' + index + '.jpg', bytes: jpegBytes(frame.data) };
    });
    if (typeof thumbnail !== 'string' || thumbnail.length > MAX_POSTER_CHARACTERS || (thumbnail && !thumbnail.startsWith('data:image/jpeg;base64,'))) throw new Error('Capture poster must be a JPEG data URL no larger than 64 KiB.');
    if (thumbnail) jpegBytes(thumbnail.slice('data:image/jpeg;base64,'.length), 49_152);
    if (scope !== undefined && (!scope || typeof scope !== 'object' || Array.isArray(scope) || Buffer.byteLength(JSON.stringify(scope)) > 2_048)) throw new Error('Capture scope metadata is invalid.');
    const id = checkId(idFactory());
    const cleanName = (typeof name === 'string' ? name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) : '') || (video ? 'Canvas recording' : 'Audio capture') + '.' + FORMATS[mimeType];
    const metadata = { id, name: cleanName, mimeType, bytes: bytes.length, digest: crypto.createHash('sha256').update(bytes).digest('hex'), thumbnail, updatedAt: Date.now(), ...(width ? { width } : {}), ...(height ? { height } : {}), ...(duration ? { duration } : {}), ...(codec ? { codec } : {}), ...(scope ? { scope } : {}), frames: samples.map((sample) => ({ timestamp: sample.timestamp, filename: sample.filename, bytes: sample.bytes.length, digest: crypto.createHash('sha256').update(sample.bytes).digest('hex') })) };
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, id + '.' + crypto.randomUUID() + '.tmp');
    fileSystem.mkdirSync(temporary, { mode: 0o700 });
    try {
      fileSystem.writeFileSync(path.join(temporary, 'media.' + FORMATS[mimeType]), bytes, { flag: 'wx', mode: 0o600 });
      for (const sample of samples) fileSystem.writeFileSync(path.join(temporary, sample.filename), sample.bytes, { flag: 'wx', mode: 0o600 });
      fileSystem.writeFileSync(path.join(temporary, 'metadata.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      fileSystem.renameSync(temporary, capturePath(id));
    } catch (error) {
      const root = path.resolve(directory);
      const target = path.resolve(temporary);
      if (target.startsWith(root + path.sep) && path.dirname(target) === root) fileSystem.rmSync(target, { recursive: true, force: true });
      throw error;
    }
    return id;
  }

  async function getMetadata(id) { return publicMetadata(record(checkId(id)).metadata); }

  async function get(id) {
    const saved = record(checkId(id));
    if (fileSystem.statSync(saved.filename).size !== saved.metadata.bytes) throw new Error('Saved capture media size is inconsistent.');
    const bytes = fileSystem.readFileSync(saved.filename);
    if (!bytes.length || bytes.length !== saved.metadata.bytes || bytes.length > MAX_MEDIA_BYTES || (saved.metadata.digest && crypto.createHash('sha256').update(bytes).digest('hex') !== saved.metadata.digest)) throw new Error('Saved capture media is missing or corrupted.');
    validateMediaBytes(bytes, saved.metadata.mimeType);
    return { ...publicMetadata(saved.metadata), data: bytes.toString('base64') };
  }

  async function getFrames(id, { maxFrames = MAX_VIDEO_FRAMES } = {}) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_VIDEO_FRAMES) throw new Error('Read between one and six saved video samples.');
    const saved = record(checkId(id));
    if (!saved.metadata.mimeType.startsWith('video/')) throw new Error('Select a captured video asset.');
    if (!saved.folder || !Array.isArray(saved.metadata.frames) || !saved.metadata.frames.length || saved.metadata.frames.length > MAX_VIDEO_FRAMES) throw new Error('This video has no stored frame samples. Use record_canvas_video to create a sampled recording. Imported videos can be shared with chat for a temporary observation.');
    const count = Math.min(maxFrames, saved.metadata.frames.length);
    const indices = Array.from({ length: count }, (_, index) => count === 1 ? 0 : Math.round(index * (saved.metadata.frames.length - 1) / (count - 1)));
    const frames = indices.map((index) => {
      const frame = saved.metadata.frames[index];
      if (!frame || frame.filename !== 'frame-' + index + '.jpg' || !Number.isInteger(frame.bytes) || frame.bytes < 1 || frame.bytes > MAX_FRAME_BYTES || typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > (saved.metadata.duration || 3_600) || !/^[a-f0-9]{64}$/.test(frame.digest)) throw new Error('Saved video frame metadata is invalid.');
      const filename = path.join(saved.folder, frame.filename);
      if (fileSystem.statSync(filename).size !== frame.bytes) throw new Error('Saved video frame size is inconsistent.');
      const bytes = fileSystem.readFileSync(filename);
      if (bytes.length !== frame.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== frame.digest) throw new Error('Saved video frame is missing or corrupted.');
      return { timestamp: frame.timestamp, data: bytes.toString('base64') };
    });
    return { ...publicMetadata(saved.metadata), assetId: id, frames, totalFrames: saved.metadata.frames.length, includesAudio: false, sampled: true, limits: { maxFrames: MAX_VIDEO_FRAMES, maxFrameBytes: MAX_FRAME_BYTES }, contract: 'These are saved JPEG samples from the recorded canvas bitmap. Video timing between samples and audio are not represented.' };
  }

  async function list() {
    if (!fileSystem.existsSync(directory)) return [];
    const ids = new Set(fileSystem.readdirSync(directory).flatMap((filename) => ID_PATTERN.test(filename) ? [filename] : /^[a-f0-9]{32}\.(?:wav|mp3|webm|mp4)$/.test(filename) ? [filename.slice(0, 32)] : []));
    const result = [];
    for (const id of ids) {
      try { result.push(publicMetadata(record(id).metadata)); } catch { /* One damaged capture does not hide the rest of the library. */ }
    }
    return result.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
  }

  return { save, get, getMetadata, list, getFrames, getVideoFrames: getFrames };
}

module.exports = { MAX_FRAME_BYTES, MAX_MEDIA_BYTES, MAX_VIDEO_FRAMES, createCanvasMediaStore };
