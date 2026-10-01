const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTrustedSender } = require('../src/ipc-contract');

function makeWindow() {
  const mainFrame = {};
  return { webContents: { mainFrame } };
}

test('accepts only the main window main frame as an IPC sender', () => {
  const window = makeWindow();
  assert.equal(assertTrustedSender({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  }, window), undefined);
  assert.throws(() => assertTrustedSender({
    sender: {},
    senderFrame: window.webContents.mainFrame,
  }, window), /untrusted IPC sender/i);
  assert.throws(() => assertTrustedSender({
    sender: window.webContents,
    senderFrame: {},
  }, window), /untrusted IPC sender/i);
});
