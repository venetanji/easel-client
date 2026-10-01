const zlib = require('node:zlib');

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

function zipDate(timestamp) {
  const date = new Date(timestamp);
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return { date: (year - 1980) << 9 | date.getMonth() + 1 << 5 | date.getDate(), time: date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >> 1 };
}

function createProjectZip({ maxUncompressedBytes = 256 * 1_048_576, timestamp = Date.now() } = {}) {
  const chunks = [];
  const directory = [];
  const names = new Set();
  let offset = 0;
  let uncompressedBytes = 0;
  const date = zipDate(timestamp);

  function add(name, value) {
    if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => !part || part === '..' || part === '.') || /[\u0000-\u001f\u007f:]/.test(name)) throw new Error('ZIP entry path is invalid.');
    const normalized = name.toLowerCase();
    if (names.has(normalized)) throw new Error(`Project export paths conflict on Windows: ${name}. Rename one of these files before exporting.`);
    if (directory.length >= 65_535) throw new Error('Project export has too many entries.');
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 65_535) throw new Error('Project export filename is too long.');
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (uncompressedBytes + bytes.length > maxUncompressedBytes) throw new Error(`Project export exceeds its ${maxUncompressedBytes}-byte uncompressed limit.`);
    let compressed = zlib.deflateRawSync(bytes, { level: 6 });
    const method = compressed.length < bytes.length ? 8 : 0;
    if (!method) compressed = bytes;
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(date.time, 10);
    header.writeUInt16LE(date.date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(date.time, 12);
    central.writeUInt16LE(date.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    chunks.push(header, nameBytes, compressed);
    directory.push(central, nameBytes);
    names.add(normalized);
    offset += header.length + nameBytes.length + compressed.length;
    uncompressedBytes += bytes.length;
  }

  function finish() {
    const directoryBytes = directory.reduce((total, chunk) => total + chunk.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.size, 8);
    end.writeUInt16LE(names.size, 10);
    end.writeUInt32LE(directoryBytes, 12);
    end.writeUInt32LE(offset, 16);
    return { data: Buffer.concat([...chunks, ...directory, end]), files: names.size, uncompressedBytes };
  }

  return { add, finish, get uncompressedBytes() { return uncompressedBytes; } };
}

module.exports = { createProjectZip };
