function abortError(signal, partialText) {
  const error = new Error('Stopped.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (signal?.reason !== undefined) error.cause = signal.reason;
  if (typeof partialText === 'string' && partialText) error.partialText = partialText;
  return error;
}

function isTurnAbort(error, signal) {
  return Boolean(signal?.aborted || ['AbortError', 'APIUserAbortError'].includes(error?.name) || error?.code === 'ABORT_ERR');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

// Only race network waits; local saves and canvas mutations must settle before stopping.
function awaitAbortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError(signal));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(abortError(signal));
      else resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', stop);
      reject(error);
    });
    if (signal.aborted) stop();
  });
}

function combinedSignal(first, second) {
  return first && second && first !== second ? AbortSignal.any([first, second]) : first || second;
}

module.exports = { abortError, awaitAbortable, combinedSignal, isTurnAbort, throwIfAborted };
