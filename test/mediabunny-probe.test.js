const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const harnessPath = path.join(__dirname, '../tools/renderer-probes/mediabunny/main.cjs');

// Exercise the real entry point, HTTP server and disk writes. Only Electron and
// its watchdog clock are substituted so these regressions need no GUI/codecs.
async function startProbe(t, { loadError } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mediabunny-probe-test-'));
  const out = path.join(root, 'out');
  await fs.mkdir(out);
  await Promise.all([
    fs.writeFile(path.join(root, 'index.html'), '<!doctype html>'),
    fs.writeFile(path.join(out, 'render.webm'), 'previous successful render'),
    fs.writeFile(path.join(out, 'render.webm.tmp'), 'previous partial render'),
    fs.writeFile(path.join(out, 'renderer-result.json'), '{"status":"ok","previous":true}'),
  ]);
  let startup;
  let resolveLoaded;
  let resolveExit;
  const loaded = new Promise(resolve => { resolveLoaded = resolve; });
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const state = { root, out, timers: new Set(), exits: [] };
  const app = new EventEmitter();
  app.setPath = () => {};
  app.whenReady = () => ({ then(callback) {
    startup = Promise.resolve().then(callback);
    // Observe the old harness's unhandled startup failure without polluting the
    // test runner; its missing terminal result is what the regression asserts.
    startup.catch(() => {});
    return startup;
  } });
  app.exit = code => { state.exits.push(code); resolveExit(code); };
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      state.window = this;
      this.webContents = new EventEmitter();
      this.destroyed = false;
    }
    loadURL(url) {
      state.url = url;
      resolveLoaded();
      const result = loadError ? Promise.reject(loadError) : Promise.resolve();
      result.catch(() => {});
      return result;
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  t.after(async () => {
    if (state.server) {
      state.server.closeAllConnections();
      await new Promise(resolve => state.server.close(resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  vm.runInNewContext(await fs.readFile(harnessPath, 'utf8'), {
    __dirname: root,
    Buffer,
    URL,
    console: { log() {}, error() {} },
    process: Object.assign(new EventEmitter(), { env: {} }),
    require(id) {
      if (id === 'electron') return { app, BrowserWindow };
      if (id === 'node:http') return { createServer(...args) {
        state.server = http.createServer(...args);
        return state.server;
      } };
      return require(id);
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      state.timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { state.timers.delete(timer); },
  }, { filename: harnessPath });
  await startup;
  await loaded;
  state.request = (pathname, result) => new Promise((resolve, reject) => {
    const request = http.request(new URL(pathname, state.url), {
      method: result === undefined ? 'GET' : 'POST', agent: false,
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(result === undefined ? undefined : JSON.stringify(result));
  });
  state.finished = async () => {
    let timeout;
    const code = await Promise.race([
      exited,
      new Promise(resolve => { timeout = setTimeout(() => resolve(null), 500); }),
    ]);
    clearTimeout(timeout);
    assert.notEqual(code, null, 'probe must reach a terminal exit');
    assert.equal(state.server.listening, false, 'terminal probe must close its HTTP server');
    assert.equal(state.window.isDestroyed(), true, 'terminal probe must destroy its window');
    assert.equal(state.timers.size, 0, 'terminal probe must clear its watchdog');
    assert.deepEqual(state.exits, [code], 'terminal cleanup must only exit once');
    return code;
  };
  state.result = async () => JSON.parse(await fs.readFile(path.join(out, 'renderer-result.json'), 'utf8'));
  state.noRender = async () => {
    for (const name of ['render.webm', 'render.webm.tmp']) {
      await assert.rejects(fs.stat(path.join(out, name)), { code: 'ENOENT' }, `${name} must not survive`);
    }
  };
  return state;
}

// Removing startup cleanup would let an old success masquerade as this run.
test('mediabunny probe clears stale output before loading the renderer', async t => {
  const probe = await startProbe(t);
  await probe.noRender();
  await assert.rejects(fs.stat(path.join(probe.out, 'renderer-result.json')), { code: 'ENOENT' });
});

// Returning early or forgetting terminal cleanup must break the success path too.
test('mediabunny probe persists successful bytes and cancellation evidence before clean exit', async t => {
  const probe = await startProbe(t);
  const result = {
    status: 'ok', cancellation: { partialTargetBytes: 0, addAfterCancelRejected: true },
    output: { byteLength: 4, bytesArray: [1, 2, 3, 4] },
  };
  assert.equal(await probe.request('/result', result), 200);
  assert.equal(await probe.finished(), 0);
  assert.deepEqual(await fs.readFile(path.join(probe.out, 'render.webm')), Buffer.from([1, 2, 3, 4]));
  delete result.output.bytesArray;
  assert.deepEqual(await probe.result(), result);
  await assert.rejects(fs.stat(path.join(probe.out, 'render.webm.tmp')), { code: 'ENOENT' });
});

// Publishing bytes without checking status would leak partial failed output.
for (const status of ['error', 'cancelled']) {
  test(`mediabunny probe removes output from a renderer result with status ${status}`, async t => {
    const probe = await startProbe(t);
    assert.equal(await probe.request('/result', {
      status, error: 'render interrupted', output: { bytesArray: [9, 9] },
    }), 200);
    assert.equal(await probe.finished(), 1);
    await probe.noRender();
    assert.equal((await probe.result()).status, status);
    assert.equal((await probe.result()).output.bytesArray, undefined);
  });
}

// Logging renderer death without terminating leaves a listening server forever.
test('mediabunny probe terminates and records a renderer crash', async t => {
  const probe = await startProbe(t);
  probe.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
  assert.equal(await probe.finished(), 1);
  await probe.noRender();
  assert.match((await probe.result()).error, /render.*crashed/i);
});

test('mediabunny probe terminates when its page fails to load', async t => {
  const probe = await startProbe(t, { loadError: new Error('ERR_CONNECTION_REFUSED') });
  assert.equal(await probe.finished(), 1);
  await probe.noRender();
  assert.match((await probe.result()).error, /ERR_CONNECTION_REFUSED/);
});

test('mediabunny probe treats closing the renderer as cancellation', async t => {
  const probe = await startProbe(t);
  probe.window.destroy();
  assert.equal(await probe.finished(), 1);
  await probe.noRender();
  assert.match((await probe.result()).error, /closed|cancel/i);
});

// Missing module imports happen before probe.js can POST its catch result.
test('mediabunny probe terminates when the Mediabunny module cannot be served', async t => {
  const probe = await startProbe(t);
  assert.equal(await probe.request('/mediabunny.mjs'), 400);
  assert.equal(await probe.finished(), 1);
  await probe.noRender();
  assert.match((await probe.result()).error, /ENOENT|mediabunny/);
});

test('mediabunny probe terminates on a server error', async t => {
  const probe = await startProbe(t);
  assert.doesNotThrow(() => probe.server.emit('error', new Error('listen failed')));
  assert.equal(await probe.finished(), 1);
  await probe.noRender();
  assert.match((await probe.result()).error, /listen failed/);
});

// A missing watchdog would leave module evaluation or codec stalls unbounded.
test('mediabunny probe watchdog bounds a renderer that never reports a result', async t => {
  const probe = await startProbe(t);
  assert.equal(probe.timers.size, 1, 'a running probe must have one watchdog');
  const [timer] = probe.timers;
  assert.ok(Number.isFinite(timer.delay) && timer.delay > 0 && timer.delay <= 120_000);
  timer.callback();
  assert.equal(await probe.finished(), 1);
  await probe.noRender();
  assert.match((await probe.result()).error, /timed? ?out|timeout/i);
});

// Chromium can request a favicon independently of the probe's required inputs.
test('mediabunny probe ignores a missing optional favicon', async t => {
  const probe = await startProbe(t);
  assert.equal(await probe.request('/favicon.ico'), 404);
  assert.deepEqual(probe.exits, []);
  assert.equal(probe.server.listening, true);
  assert.equal(await probe.request('/result', { status: 'ok', output: { bytesArray: [1] } }), 200);
  assert.equal(await probe.finished(), 0);
});

test('mediabunny probe removes a new render if saving the result fails', async t => {
  const probe = await startProbe(t);
  await fs.mkdir(path.join(probe.out, 'renderer-result.json'));
  assert.equal(await probe.request('/result', { status: 'ok', output: { bytesArray: [1] } }), 500);
  assert.equal(await probe.finished(), 1);
  await probe.noRender();
});

test('mediabunny probe watchdog closes an unfinished result request without publishing bytes', async t => {
  const probe = await startProbe(t);
  const received = new Promise(resolve => probe.server.once('request', resolve));
  const request = http.request(new URL('/result', probe.url), { method: 'POST', agent: false });
  const disconnected = new Promise(resolve => request.once('error', resolve));
  request.write('{"status":"ok","output":{"bytesArray":[');
  await received;
  const [watchdog] = probe.timers;
  watchdog.callback();
  assert.equal(await probe.finished(), 1);
  await disconnected;
  await probe.noRender();
  assert.equal((await probe.result()).status, 'error');
});

// A status alone cannot establish that this invocation produced a usable file.
for (const result of [{ status: 'ok' }, { status: 'ok', output: { bytesArray: [] } }, null]) {
  test(`mediabunny probe rejects an incomplete result: ${JSON.stringify(result)}`, async t => {
    const probe = await startProbe(t);
    await probe.request('/result', result);
    assert.equal(await probe.finished(), 1);
    await probe.noRender();
    assert.equal((await probe.result()).status, 'error');
    assert.match((await probe.result()).error, /result|bytes/i);
  });
}

test('mediabunny probe cannot replace the first result with a concurrent result', async t => {
  const probe = await startProbe(t);
  const results = await Promise.allSettled([
    probe.request('/result', { status: 'ok', output: { bytesArray: [1] } }),
    probe.request('/result', { status: 'ok', output: { bytesArray: [2] } }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value === 200).length, 1);
  assert.equal(await probe.finished(), 0);
  const bytes = await fs.readFile(path.join(probe.out, 'render.webm'));
  const winner = results.findIndex(result => result.status === 'fulfilled' && result.value === 200);
  assert.deepEqual(bytes, Buffer.from([winner + 1]));
});
