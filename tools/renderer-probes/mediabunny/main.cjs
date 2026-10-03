const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = __dirname;
const outputDir = path.join(root, 'out');
const mediaBundle = path.join(root, 'node_modules/mediabunny/dist/bundles/mediabunny.mjs');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
};
const resultLimit = 2 * 1024 * 1024;

app.setPath('userData', path.join(os.tmpdir(), 'easel-mediabunny-probe-profile'));

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > resultLimit) throw new Error('Probe result exceeded 2 MiB limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

app.whenReady().then(async () => {
  await mkdir(outputDir, { recursive: true });
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (request.method === 'POST' && pathname === '/result') {
        const result = JSON.parse(await readRequestBody(request));
        if (result.output?.bytesArray) {
          const bytes = Buffer.from(result.output.bytesArray);
          const temporaryPath = path.join(outputDir, 'render.webm.tmp');
          await writeFile(temporaryPath, bytes);
          await rename(temporaryPath, path.join(outputDir, 'render.webm'));
          delete result.output.bytesArray;
        }
        await writeFile(path.join(outputDir, 'renderer-result.json'), JSON.stringify(result, null, 2));
        response.writeHead(200).end('ok');
        server.close();
        app.exit(result.status === 'ok' ? 0 : 1);
        return;
      }

      const filePath = pathname === '/mediabunny.mjs'
        ? mediaBundle
        : path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (filePath !== mediaBundle && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const contents = await readFile(filePath);
      response.writeHead(200, {
        'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
        'x-content-type-options': 'nosniff',
      }).end(contents);
    } catch (error) {
      console.error(error);
      response.writeHead(400).end('invalid probe request');
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window.webContents.on('console-message', (_event, level, message) => {
      console.log(`renderer[${level}] ${message}`);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('render-process-gone', details);
    });
    window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  });
});
