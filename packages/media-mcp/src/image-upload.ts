export const MAX_IMAGE_INPUTS = 16;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const LEGACY_IMAGE_BYTES = 4 * 1024 * 1024;

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageUpload {
  data: string;
  mimeType: ImageMimeType;
  name?: string;
}

export interface DecodedImage {
  bytes: Buffer;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  name: string;
}

export function decodeBase64(data: unknown, maxBytes: number, label: string): Buffer {
  if (typeof data !== 'string' || !data.length) throw new Error(`${label} must contain base64 image bytes.`);
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw new Error(`${label} exceeds the image size limit.`);
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error(`${label} must contain valid base64 image bytes, without a data URL prefix.`);
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.toString('base64') !== data) throw new Error(`${label} contains invalid base64 image bytes.`);
  if (bytes.length > maxBytes) throw new Error(`${label} exceeds the image size limit.`);
  return bytes;
}

export function imageMimeType(bytes: Buffer): ImageMimeType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

// Read format headers to check shapes without decoding the complete image.
function imageDimensions(bytes: Buffer, mimeType: ImageMimeType): { width: number; height: number } | undefined {
  if (mimeType === 'image/png') {
    if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') {
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) return;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return;
      if (frames.has(marker)) {
        if (length < 8) return;
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
    return;
  }
  if (bytes.length < 25 || bytes.readUInt32LE(4) + 8 > bytes.length) return;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (bytes.length < 30) return;
  if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return;
}

export function decodeImageUpload(input: ImageUpload, label: string, maxBytes = MAX_IMAGE_BYTES): DecodedImage {
  if (!input || !['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType)) {
    throw new Error(`${label} must be a PNG, JPEG, or WebP image.`);
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(input.name))) {
    throw new Error(`${label} name must contain only letters, numbers, dots, underscores, or hyphens.`);
  }
  const bytes = decodeBase64(input.data, maxBytes, label);
  const detected = imageMimeType(bytes);
  if (detected !== input.mimeType) throw new Error(`${label} bytes do not match its declared MIME type.`);
  const dimensions = imageDimensions(bytes, detected);
  if (!dimensions?.width || !dimensions.height) throw new Error(`${label} has an invalid image header or dimensions.`);
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[detected];
  const stem = input.name?.replace(/\.[^.]+$/, '') || 'image';
  return { bytes, mimeType: detected, ...dimensions, name: `${stem}.${extension}` };
}

export function requireLegacyImage(image: DecodedImage, label: string): void {
  if (image.mimeType !== 'image/png' || image.width !== image.height || image.bytes.length >= LEGACY_IMAGE_BYTES) {
    throw new Error(`${label} for dall-e-2 must be a square PNG smaller than 4 MiB.`);
  }
}

export function appendImage(form: FormData, field: string, image: DecodedImage): void {
  form.append(field, new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.name);
}
