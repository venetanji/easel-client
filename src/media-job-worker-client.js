const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createMediaJobWorkerClient({ userDataPath, workerFactory = (filename, options) => new Worker(filename, options) }) {
  const worker = workerFactory(path.join(__dirname, 'media-job-worker.js'), { workerData: { userDataPath } });
  const requests = new Map();
  let sequence = 0;
  let closed = false;
  let closing;
  let failure;
  worker.unref?.();

  function fail(error) {
    failure = error;
    for (const request of requests.values()) request.reject(error);
    requests.clear();
    worker.unref?.();
  }
  worker.on('error', fail);
  worker.on('exit', () => {
    if (!closed && (!closing || requests.size)) fail(new Error('The media polling worker stopped. The saved job ID will be retried.'));
  });
  worker.on('message', async (message) => {
    const request = requests.get(message.id);
    if (!request) return;
    if (message.type === 'checkpoint') {
      let response;
      try {
        const accepted = await request.onSaved?.(message.asset);
        response = { type: 'checkpoint-result', checkpointId: message.checkpointId, ok: accepted !== false };
      } catch (error) {
        response = { type: 'checkpoint-result', checkpointId: message.checkpointId, ok: false, error: error.message };
      }
      try { worker.postMessage(response); }
      catch (error) { fail(error); }
      return;
    }
    requests.delete(message.id);
    if (!requests.size) worker.unref?.();
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });

  function request(type, input = {}, onSaved) {
    if (failure) return Promise.reject(failure);
    if (closed || closing && type !== 'close') return Promise.reject(new Error('The media polling worker is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      requests.set(id, { resolve, reject, onSaved });
      worker.ref?.();
      try { worker.postMessage({ type, id, ...input }); }
      catch (error) { requests.delete(id); if (!requests.size) worker.unref?.(); reject(error); }
    });
  }
  function close() {
    if (closing) return closing;
    closing = (async () => {
      try { await request('close'); }
      finally { closed = true; await worker.terminate(); }
    })();
    return closing;
  }
  function forget(jobId) {
    if (closed || closing || failure) return;
    try { worker.postMessage({ type: 'forget', jobId }); }
    catch (error) { fail(error); }
  }
  return { poll: (entry, launchOptions, onSaved) => request('poll', { entry, launchOptions }, onSaved), forget, close, get failed() { return failure; } };
}

module.exports = { createMediaJobWorkerClient };
