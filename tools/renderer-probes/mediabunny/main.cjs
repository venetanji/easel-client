const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
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
const timeoutMs = 60_000;
const renderPath = path.join(outputDir, 'render.webm');
const temporaryPath = `${renderPath}.tmp`;
const resultPath = path.join(outputDir, 'renderer-result.json');
let server;
let window;
let finished = false;
const watchdog = setTimeout(() => {
  fail(new Error(`Probe timed out after ${timeoutMs} ms`));
}, timeoutMs);

app.setPath('userData', path.join(os.tmpdir(), 'easel-mediabunny-probe-profile'));

async function removeRender() {
  await Promise.all([renderPath, temporaryPath].map(file => rm(file, { force: true })));
}

async function finish(result, response) {
  if (finished) {
    response?.writeHead(409).end('probe already finished');
    return;
  }
  if (!result || typeof result.status !== 'string') {
    result = { status: 'error', error: 'Invalid probe result' };
  } else if (result.status === 'ok'
    && (!Array.isArray(result.output?.bytesArray) || result.output.bytesArray.length === 0)) {
    result = { status: 'error', error: 'Successful probe result is missing output bytes' };
  }
  finished = true;
  clearTimeout(watchdog);
  let exitCode = result.status === 'ok' ? 0 : 1;
  try {
    await mkdir(outputDir, { recursive: true });
    if (exitCode === 0 && result.output?.bytesArray) {
      await writeFile(temporaryPath, Buffer.from(result.output.bytesArray));
      await rename(temporaryPath, renderPath);
    } else {
      await removeRender();
    }
    if (result.output) delete result.output.bytesArray;
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    response?.writeHead(200).end('ok');
  } catch (error) {
    exitCode = 1;
    console.error(error);
    await removeRender().catch(cleanupError => console.error(cleanupError));
    await writeFile(resultPath, JSON.stringify({ status: 'error', error: String(error) }, null, 2))
      .catch(writeError => console.error(writeError));
    response?.writeHead(500).end('failed to save probe result');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    // close() alone can wait forever for a stalled POST or keep-alive socket.
    server?.close();
    server?.closeAllConnections();
    app.exit(exitCode);
  }
}

function fail(error) {
  if (finished) return;
  console.error(error);
  return finish({ status: 'error', error: String(error), stack: error.stack });
}

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
  if (finished) return;
  await mkdir(outputDir, { recursive: true });
  await removeRender();
  await rm(resultPath, { force: true });
  if (finished) return;
  server = createServer(async (request, response) => {
    try {
      if (finished) {
        response.writeHead(409).end('probe already finished');
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/favicon.ico') {
        response.writeHead(404).end();
        return;
      }
      if (request.method === 'POST' && pathname === '/result') {
        const result = JSON.parse(await readRequestBody(request));
        await finish(result, response);
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
      response.writeHead(400).end('invalid probe request');
      await fail(error);
    }
  });
  server.on('error', fail);

  server.listen(0, '127.0.0.1', () => {
    if (finished) return;
    try {
      window = new BrowserWindow({
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
        fail(new Error(`Renderer process gone: ${details.reason} (exit ${details.exitCode})`));
      });
      window.on('closed', () => fail(new Error('Probe window closed before completion')));
      window.loadURL(`http://127.0.0.1:${server.address().port}/`).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}).catch(fail);
