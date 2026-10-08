const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_KIT_SOURCE_ARCHIVE_BYTES = 64 * 1_048_576;
const MAX_KIT_SOURCE_UNCOMPRESSED_BYTES = 64 * 1_048_576;
const MAX_KIT_SOURCE_ENTRIES = 8192;
const MAX_KIT_SOURCE_MANIFEST_BYTES = 1_048_576;
const HASH = /^[a-f0-9]{64}$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Validate the bounded, descriptor-free archive format emitted by our builder.
// Nothing is extracted to disk, imported or executed. The opaque bytes are the
// distribution artifact; the manifest only binds them to an exact runtime pin.
function validateKitSourceArchive(data, runtimeSha256) {
  const invalid = (reason) => { throw new Error(`Strudel corresponding source archive is invalid: ${reason}.`); };
  if (!HASH.test(runtimeSha256 || '')) invalid('runtime pin');
  if (!Buffer.isBuffer(data) || data.length < 22 || data.length > MAX_KIT_SOURCE_ARCHIVE_BYTES) invalid('64 MiB archive limit');
  const end = data.length - 22;
  if (data.readUInt32LE(end) !== 0x06054b50 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 20)) invalid('ZIP end record');
  const count = data.readUInt16LE(end + 10), directoryOffset = data.readUInt32LE(end + 16), directoryBytes = data.readUInt32LE(end + 12);
  if (!count || count > MAX_KIT_SOURCE_ENTRIES || data.readUInt16LE(end + 8) !== count) invalid('8192-entry limit or split ZIP');
  if (directoryOffset + directoryBytes !== end) invalid('ZIP directory boundary');
  const entries = [], names = new Set();
  let offset = 0, uncompressedBytes = 0, manifest;
  while (offset < directoryOffset) {
    if (offset + 30 > directoryOffset || data.readUInt32LE(offset) !== 0x04034b50 || entries.length >= count) invalid('ZIP local record');
    const flags = data.readUInt16LE(offset + 6), method = data.readUInt16LE(offset + 8), checksum = data.readUInt32LE(offset + 14);
    const compressedBytes = data.readUInt32LE(offset + 18), bytes = data.readUInt32LE(offset + 22);
    const nameBytes = data.readUInt16LE(offset + 26), extraBytes = data.readUInt16LE(offset + 28);
    const start = offset + 30 + nameBytes, finish = start + compressedBytes;
    if (flags !== 0x0800 || ![0, 8].includes(method) || extraBytes || !nameBytes || nameBytes > 4096 || finish > directoryOffset) invalid('unsupported or truncated ZIP entry');
    const rawName = data.subarray(offset + 30, start), name = rawName.toString('utf8');
    if (!Buffer.from(name).equals(rawName) || !name.startsWith('strudel-source/') || name.includes('\\') || /[\u0000-\u001f\u007f:]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..') || names.has(name.toLowerCase())) invalid('unsafe or duplicate entry path');
    names.add(name.toLowerCase());
    uncompressedBytes += bytes;
    if (uncompressedBytes > MAX_KIT_SOURCE_UNCOMPRESSED_BYTES) invalid('64 MiB expanded limit');
    if (name === 'strudel-source/manifest.json' && bytes > MAX_KIT_SOURCE_MANIFEST_BYTES) invalid('1 MiB manifest limit');
    let content;
    try { content = method === 8 ? zlib.inflateRawSync(data.subarray(start, finish), { maxOutputLength: Math.max(1, bytes) }) : data.subarray(start, finish); }
    catch { invalid('corrupted compressed entry'); }
    if (content.length !== bytes || crc32(content) !== checksum) invalid('corrupted entry size or checksum');
    if (name === 'strudel-source/manifest.json') {
      try { manifest = JSON.parse(content.toString('utf8')); } catch { invalid('manifest JSON'); }
    }
    entries.push({ offset, name, flags, method, checksum, compressedBytes, bytes });
    offset = finish;
  }
  if (entries.length !== count) invalid('entry count');
  for (const entry of entries) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) invalid('ZIP directory record');
    const nameBytes = data.readUInt16LE(offset + 28), extraBytes = data.readUInt16LE(offset + 30), commentBytes = data.readUInt16LE(offset + 32);
    const next = offset + 46 + nameBytes;
    if (next > end || extraBytes || commentBytes || data.readUInt16LE(offset + 34) || data.readUInt32LE(offset + 38)) invalid('unsupported ZIP directory metadata');
    if (data.subarray(offset + 46, next).toString('utf8') !== entry.name || data.readUInt16LE(offset + 8) !== entry.flags || data.readUInt16LE(offset + 10) !== entry.method || data.readUInt32LE(offset + 16) !== entry.checksum || data.readUInt32LE(offset + 20) !== entry.compressedBytes || data.readUInt32LE(offset + 24) !== entry.bytes || data.readUInt32LE(offset + 42) !== entry.offset) invalid('conflicting ZIP directory');
    offset = next;
  }
  if (offset !== end || manifest?.schemaVersion !== 1 || manifest?.kitId !== 'strudel' || typeof manifest.version !== 'string' || !HASH.test(manifest.runtimeSha256 || '')) invalid('source manifest');
  if (manifest.runtimeSha256 !== runtimeSha256) throw new Error('Strudel corresponding source does not match the pinned runtime. The installed archive cannot replace its original source.');
  return { runtimeSha256, archiveSha256: sha256(data), bytes: data.length, uncompressedBytes, entries: count, version: manifest.version };
}

function readBoundedFile(filename, maxBytes, fileSystem = fs) {
  const stat = fileSystem.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) throw new Error('Strudel corresponding source file is invalid or oversized.');
  const data = fileSystem.readFileSync(filename);
  if (!Buffer.isBuffer(data) || data.length !== stat.size) throw new Error('Strudel corresponding source file changed or is corrupted.');
  return data;
}

function createInstalledKitSourceReader(directory, { fileSystem = fs } = {}) {
  return (name) => {
    if (name !== 'strudel') throw new Error('Only the Strudel corresponding source archive is supported.');
    return readBoundedFile(path.join(directory, 'strudel-source.zip'), MAX_KIT_SOURCE_ARCHIVE_BYTES, fileSystem);
  };
}

function createCanvasKitSourceCache({ dependenciesPath, readInstalledArchive = () => null, writeAtomic, fileSystem = fs }) {
  function readRetained(runtimeSha256) {
    const bindingPath = path.join(dependenciesPath, `${runtimeSha256}.source.json`);
    if (!fileSystem.existsSync(bindingPath)) return null;
    let binding;
    try { binding = JSON.parse(readBoundedFile(bindingPath, 4096, fileSystem).toString('utf8')); }
    catch (cause) { throw new Error('Strudel corresponding source binding is corrupted.', { cause }); }
    if (binding?.schemaVersion !== 1 || binding.kitId !== 'strudel' || binding.runtimeSha256 !== runtimeSha256 || !HASH.test(binding.archiveSha256 || '') || !Number.isSafeInteger(binding.bytes) || binding.bytes < 1 || binding.bytes > MAX_KIT_SOURCE_ARCHIVE_BYTES) throw new Error('Strudel corresponding source binding is conflicting or corrupted.');
    let data;
    try { data = readBoundedFile(path.join(dependenciesPath, `${binding.archiveSha256}.source.zip`), MAX_KIT_SOURCE_ARCHIVE_BYTES, fileSystem); }
    catch (cause) { throw new Error('Strudel corresponding source retained archive is missing or corrupted.', { cause }); }
    if (data.length !== binding.bytes || sha256(data) !== binding.archiveSha256) throw new Error('Strudel corresponding source retained archive is corrupted. No installed replacement was used.');
    return { ...validateKitSourceArchive(data, runtimeSha256), data };
  }

  function retain(name, runtimeSha256) {
    if (name !== 'strudel' || !HASH.test(runtimeSha256 || '')) throw new Error('Strudel corresponding source requires a valid pinned runtime.');
    const existing = readRetained(runtimeSha256);
    if (existing) return existing;
    let data;
    try { data = readInstalledArchive(name); }
    catch (cause) { throw new Error('Strudel corresponding source installed archive is unavailable. Restore the original matching archive before exporting.', { cause }); }
    if (!data) throw new Error('Strudel corresponding source archive is missing. Restore the original matching archive before exporting. Preview and editing remain available.');
    const metadata = validateKitSourceArchive(data, runtimeSha256);
    const archivePath = path.join(dependenciesPath, `${metadata.archiveSha256}.source.zip`);
    if (fileSystem.existsSync(archivePath)) {
      const saved = readBoundedFile(archivePath, MAX_KIT_SOURCE_ARCHIVE_BYTES, fileSystem);
      if (!saved.equals(data)) throw new Error('Strudel corresponding source content-addressed archive is corrupted.');
    } else writeAtomic(archivePath, data);
    // The tiny binding is the commit point. An interrupted write leaves only an
    // unreferenced content-addressed archive, which a later matching retry reuses.
    writeAtomic(path.join(dependenciesPath, `${runtimeSha256}.source.json`), JSON.stringify({ schemaVersion: 1, kitId: name, runtimeSha256, archiveSha256: metadata.archiveSha256, bytes: metadata.bytes }));
    return { ...metadata, data };
  }

  function tryRetain(name, runtimeSha256) {
    if (name !== 'strudel') return;
    // Source distribution failures must not prevent local preview/editing. A
    // distribution request calls retain directly and reports the exact failure.
    try { retain(name, runtimeSha256); } catch { /* Keep the runtime pin intact. */ }
  }
  return { retain, tryRetain };
}

module.exports = { MAX_KIT_SOURCE_ARCHIVE_BYTES, MAX_KIT_SOURCE_UNCOMPRESSED_BYTES, MAX_KIT_SOURCE_ENTRIES, createInstalledKitSourceReader, createCanvasKitSourceCache, validateKitSourceArchive };
