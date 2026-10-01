import { chromium, type Browser } from 'playwright';

const MAX_HTML_BYTES = 1_048_576;
const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_RENDER_MS = 10_000;
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  "connect-src 'none'",
  'media-src data: blob:',
  'font-src data:',
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface CanvasAsset {
  name: string;
  data: string;
  mimeType: string;
}

export interface CanvasScreenshotInput {
  html: string;
  assets?: CanvasAsset[];
  viewport?: { width: number; height: number };
}

export interface CanvasScreenshot {
  data: Buffer;
  mimeType: 'image/png';
}

type BrowserFactory = () => Promise<Pick<Browser, 'newPage' | 'close'>>;

function validateAssets(assets: CanvasAsset[] = []): CanvasAsset[] {
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) {
    throw new Error(`Canvas supports at most ${MAX_ASSETS} image assets.`);
  }
  const names = new Set<string>();
  let totalBytes = 0;
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(asset.name)) {
      throw new Error('Canvas asset name must contain only letters, digits, underscores, and hyphens.');
    }
    if (names.has(asset.name)) throw new Error(`Duplicate canvas asset name: ${asset.name}`);
    names.add(asset.name);
    if (!ALLOWED_IMAGE_TYPES.has(asset.mimeType)) throw new Error('Unsupported canvas asset type.');
    if (typeof asset.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) {
      throw new Error(`Canvas asset ${asset.name} is not valid base64.`);
    }
    totalBytes += Buffer.byteLength(asset.data, 'base64');
  }
  if (totalBytes > MAX_ASSET_BYTES) throw new Error('Canvas assets exceed 32 MiB total.');
  return assets;
}

function buildOfflineDocument(html: string, assets: CanvasAsset[]): string {
  let document = html;
  for (const asset of assets) {
    document = document.split(`{{asset:${asset.name}}}`).join(`data:${asset.mimeType};base64,${asset.data}`);
  }
  if (/\{\{asset:[^}]+\}\}/.test(document)) throw new Error('Canvas references an unknown local asset.');

  const policy = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  if (/<head(?:\s[^>]*)?>/i.test(document)) {
    return document.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}<meta charset="utf-8">${policy}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(document)) {
    return document.replace(/<html(?:\s[^>]*)?>/i, (htmlTag) => `${htmlTag}<head><meta charset="utf-8">${policy}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${document}</body></html>`;
}

export async function captureCanvasScreenshot(
  input: CanvasScreenshotInput,
  options: { browserFactory?: BrowserFactory; timeoutMs?: number } = {},
): Promise<CanvasScreenshot> {
  if (!input || typeof input.html !== 'string' || !input.html.trim()) throw new Error('Canvas HTML is required.');
  if (Buffer.byteLength(input.html, 'utf8') > MAX_HTML_BYTES) throw new Error('Canvas HTML exceeds 1 MiB.');
  const assets = validateAssets(input.assets);
  const viewport = input.viewport || { width: 1440, height: 900 };
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)
    || viewport.width < 320 || viewport.height < 240
    || viewport.width > 1920 || viewport.height > 1080) {
    throw new Error('Canvas viewport must be between 320x240 and 1920x1080.');
  }

  const browserFactory = options.browserFactory || (() => chromium.launch({ headless: true }));
  let browser: Pick<Browser, 'newPage' | 'close'>;
  try {
    browser = await browserFactory();
  } catch {
    throw new Error('Headless Chromium is unavailable. Install it with `npx playwright install chromium`.');
  }

  const timeoutMs = Math.min(options.timeoutMs || MAX_RENDER_MS, MAX_RENDER_MS);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const render = async (): Promise<CanvasScreenshot> => {
      const page = await browser.newPage({ viewport });
      await page.route('**/*', async (route) => {
        let protocol = '';
        try {
          protocol = new URL(route.request().url()).protocol;
        } catch {
          await route.abort();
          return;
        }
        if (protocol === 'data:' || protocol === 'blob:' || protocol === 'about:') {
          await route.continue();
        } else {
          await route.abort();
        }
      });
      await page.setContent(buildOfflineDocument(input.html, assets), { waitUntil: 'load', timeout: timeoutMs });
      const data = Buffer.from(await page.screenshot({ type: 'png', timeout: timeoutMs }));
      return { data, mimeType: 'image/png' };
    };
    return await Promise.race([
      render(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void browser.close();
          reject(new Error('Canvas render timed out.'));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && /timed out/i.test(error.message)) throw error;
    throw new Error('Canvas screenshot failed to render.');
  } finally {
    if (timeout) clearTimeout(timeout);
    await browser.close().catch(() => {});
  }
}
