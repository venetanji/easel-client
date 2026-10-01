const fs = require('node:fs');

function assertStorageSpace(directory, byteLengths, fileSystem = fs) {
  const sizes = Array.isArray(byteLengths) ? byteLengths : [byteLengths];
  if (sizes.some((bytes) => !Number.isSafeInteger(bytes) || bytes < 0)) throw new Error('Storage write size is invalid.');
  if (typeof fileSystem.statfsSync !== 'function') return;
  let stats;
  try { stats = fileSystem.statfsSync(directory, { bigint: true }); }
  catch (error) {
    if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) return;
    throw error;
  }
  const blockSize = BigInt(stats.bsize);
  if (blockSize <= 0n) return;
  const available = BigInt(stats.bavail) * blockSize;
  // Atomic replacements need space for the new file while the old file still exists.
  const required = sizes.reduce((total, bytes) => total + (BigInt(bytes) + blockSize - 1n) / blockSize * blockSize, 0n);
  if (required <= available) return;
  const mib = (bytes) => (Number(bytes) / 1_048_576).toFixed(2);
  throw Object.assign(new Error(`Not enough disk space to save: requires ${mib(required)} MiB; ${mib(available)} MiB available. Free some space and retry.`), {
    code: 'INSUFFICIENT_DISK_SPACE', requiredBytes: Number(required), availableBytes: Number(available),
  });
}

function storageWriteError(error) {
  if (!['ENOSPC', 'EDQUOT'].includes(error.code)) return error;
  return Object.assign(new Error('Storage is full or its quota was reached. Free some space and retry saving.', { cause: error }), { code: 'INSUFFICIENT_DISK_SPACE' });
}

module.exports = { assertStorageSpace, storageWriteError };
