function imageDimensions(bytes, mimeType) {
  let width;
  let height;
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mimeType === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const format = bytes.toString('ascii', 12, 16);
    if (format === 'VP8X') {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (format === 'VP8L' && bytes[20] === 47) {
      width = 1 + ((bytes[21] | bytes[22] << 8) & 0x3fff);
      height = 1 + ((bytes[22] >> 6 | bytes[23] << 2 | bytes[24] << 10) & 0x3fff);
    } else if (format === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    }
  } else if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 8 < bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1];
      if (marker === 255) { offset += 1; continue; }
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (length >= 7 && [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  }
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : {};
}

module.exports = { imageDimensions };
