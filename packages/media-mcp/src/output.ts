import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AUDIO_EXTENSIONS } from './audio.js';

export interface SavedMedia { path: string; mimeType: string; bytes: number; sha256: string }
const extensions: Record<string, string> = { ...AUDIO_EXTENSIONS, 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
}

export async function prepareOutputDirectory(directory: string, roots = process.env.EASEL_MEDIA_OUTPUT_ROOTS): Promise<string> {
  if (!isAbsolute(directory) || !roots) throw new Error('Filesystem output requires an absolute directory under configured EASEL_MEDIA_OUTPUT_ROOTS.');
  let configured: unknown;
  try { configured = JSON.parse(roots); } catch { throw new Error('Invalid output root configuration.'); }
  if (!Array.isArray(configured) || !configured.length || configured.some(root => typeof root !== 'string' || !isAbsolute(root) || resolve(root) === sep)) throw new Error('Invalid output root configuration.');
  const allowed = (await Promise.all(configured.map(root => realpath(root).catch(() => undefined)))).filter((root): root is string => root !== undefined);
  const requested = resolve(directory);
  let ancestor = requested;
  let physical: string | undefined;
  while (!physical) {
    try { physical = await realpath(ancestor); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (!allowed.some(root => within(resolve(physical!, relative(ancestor, requested)), root))) throw new Error('Output directory is outside the configured workspace roots.');
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const destination = await realpath(requested);
  if (!allowed.some(root => within(destination, root))) throw new Error('Output directory resolves outside the configured workspace roots.');
  return destination;
}

export async function saveMedia(directory: string, media: Array<{ data: string; mimeType: string }>, roots = process.env.EASEL_MEDIA_OUTPUT_ROOTS): Promise<SavedMedia[]> {
  const destination = await prepareOutputDirectory(directory, roots);
  const saved: SavedMedia[] = [];
  try {
    for (const item of media) {
      const extension = extensions[item.mimeType];
      if (!extension) throw new Error('Unsupported output media type.');
      const bytes = Buffer.from(item.data, 'base64');
      if (!bytes.length || bytes.length > 32 * 1_048_576) throw new Error('Output media must contain 1 byte to 32 MiB.');
      const temporary = await mkdtemp(join(destination, '.easel-'));
      const path = join(destination, 'easel-' + randomUUID() + '.' + extension);
      try {
        const stage = join(temporary, 'media');
        await writeFile(stage, bytes, { mode: 0o600, flag: 'wx' });
        await link(stage, path);
        saved.push({ path, mimeType: item.mimeType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    return saved;
  } catch (error) {
    await Promise.all(saved.map(item => rm(item.path, { force: true })));
    throw error;
  }
}
