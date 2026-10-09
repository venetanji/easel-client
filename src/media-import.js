const fs = require('node:fs');
const path = require('node:path');

const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const MIME_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
});

class ImportError extends Error {}

function safeName(filename) {
  return (typeof filename === 'string' ? path.win32.basename(path.basename(filename)).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) : '') || 'Selected file';
}

function checkFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ImportError('Choose a regular file, not a folder or symbolic link.');
  if (!Number.isSafeInteger(stat.size) || stat.size < 1) throw new ImportError('Media file is empty or invalid.');
  if (stat.size > MAX_IMPORT_BYTES) throw new ImportError('Media file exceeds 32 MiB.');
}

function unchanged(before, after) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => before[key] === after[key]);
}

async function readSelectedFile(filename, fileSystem) {
  const before = await fileSystem.promises.lstat(filename);
  checkFile(before);
  const constants = fileSystem.constants || fs.constants;
  // NOFOLLOW closes the final-component symlink race where supported. NONBLOCK
  // prevents a replaced FIFO from hanging open; fstat still requires a regular file.
  const handle = await fileSystem.promises.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    checkFile(opened);
    if (!unchanged(before, opened)) throw new ImportError('Media file changed while importing. Select it again.');
    // Reserve only the checked size plus one byte, so a growing file cannot cause
    // an unbounded read or allocation. The extra byte detects growth before save.
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const selected = await fileSystem.promises.lstat(filename);
    if (offset !== opened.size || !unchanged(opened, after) || !unchanged(opened, selected) || selected.isSymbolicLink()) throw new ImportError('Media file changed while importing. Select it again.');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function validateImageHeader(bytes, mimeType) {
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR';
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const webp = bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
  if (!({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp })[mimeType]) throw new ImportError('Image does not match its file format.');
}

function safeError(error) {
  if (error instanceof ImportError) return error.message;
  if (error?.code === 'ENOENT') return 'Selected file was not found. Select it again.';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'Selected file could not be accessed.';
  if (error?.code === 'ELOOP') return 'Choose a regular file, not a symbolic link.';
  if (['ENOSPC', 'EDQUOT', 'INSUFFICIENT_DISK_SPACE'].includes(error?.code)) return 'Not enough storage space to import this file. Free some space and try again.';
  // Native filesystem, decoder, and store errors can contain private local paths.
  return 'Media file is invalid or could not be imported.';
}

/** Host-only: filenames must come from the native open-file dialog, never tool arguments. */
async function importMediaFiles({ filenames, imageStore, mediaStore, fileSystem = fs, validateImage, onSaved } = {}) {
  const assets = [];
  const errors = [];
  if (!Array.isArray(filenames)) return { assets, errors: [{ name: 'Selection', error: 'Choose media files using the import dialog.' }] };
  if (filenames.length > MAX_IMPORT_FILES) return { assets, errors: [{ name: 'Selection', error: 'Choose at most 20 media files at a time.' }] };
  for (const filename of filenames) {
    const name = safeName(filename);
    try {
      if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) throw new ImportError('Choose a local media file using the import dialog.');
      const mimeType = MIME_TYPES[path.extname(filename).toLowerCase()];
      if (!mimeType) throw new ImportError('Supported formats are PNG, JPEG, WebP, MP4, WebM, WAV, MP3, and M4A.');
      const bytes = await readSelectedFile(filename, fileSystem);
      const store = mimeType.startsWith('image/') ? imageStore : mediaStore;
      if (mimeType.startsWith('image/')) {
        validateImageHeader(bytes, mimeType);
        if (validateImage) await validateImage(bytes, mimeType);
      }
      const assetId = await store.save({ data: bytes.toString('base64'), mimeType, name });
      const asset = { assetId, name, mimeType, bytes: bytes.length };
      // Saving has succeeded: a preview/notification failure must not hide the
      // asset or suggest retrying an import that would create duplicate copies.
      assets.push(asset);
      if (typeof store.getMetadata === 'function') {
        try {
          const metadata = await store.getMetadata(assetId);
          for (const key of ['width', 'height', 'duration', 'codec', 'thumbnail', 'updatedAt']) {
            if (metadata[key] !== undefined) asset[key] = metadata[key];
          }
        } catch {
          errors.push({ name, error: 'Imported, but its library metadata could not be loaded.' });
        }
      }
      if (onSaved) {
        try { await onSaved({ ...asset }); }
        catch { errors.push({ name, error: 'Imported, but its library preview could not be updated.' }); }
      }
    } catch (error) {
      errors.push({ name, error: safeError(error) });
    }
  }
  return { assets, errors };
}

module.exports = { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, importMediaFiles };
