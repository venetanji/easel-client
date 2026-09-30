const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKENDS = new Set(['builtin', 'external', 'codex']);

function createAgentControl({ userDataPath, fileSystem = fs, isAgentBusy = () => false, onChanged } = {}) {
  const filename = path.join(userDataPath, 'agent-control.json');
  let preferences = { backend: 'builtin', codexModel: '', externalChatId: '' };
  if (fileSystem.existsSync(filename)) {
    const saved = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
    if (BACKENDS.has(saved.backend)) preferences.backend = saved.backend;
    if (typeof saved.codexModel === 'string' && saved.codexModel.length <= 160 && !/[\u0000-\u001f]/.test(saved.codexModel)) preferences.codexModel = saved.codexModel.trim();
    if (/^[a-f0-9]{32}$/.test(saved.externalChatId || '')) preferences.externalChatId = saved.externalChatId;
  }
  let owner;
  let operations = 0;
  let queue = Promise.resolve();
  let shuttingDown = false;
  function persist(next) {
    fileSystem.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
    fileSystem.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    try { fileSystem.renameSync(temporary, filename); }
    catch (error) { fileSystem.rmSync(temporary, { force: true }); throw error; }
  }
  function changed() { onChanged?.(getState()); }
  function error(message, code) { return Object.assign(new Error(message), { code }); }
  function assertIdle() { if (operations || isAgentBusy()) throw error('Stop the current agent run before changing its controller.', 'CONTROL_BUSY'); }
  function canConnect() { return !shuttingDown && preferences.backend !== 'builtin'; }
  function authorizeConnection({ sessionId, name }) {
    if (!canConnect()) throw error('Select External MCP or Codex in Settings > Agent to connect.', 'CONTROL_DISABLED');
    if (owner && owner.sessionId !== sessionId) throw error('Another agent already controls Easel. Disconnect it before connecting this client.', 'CONTROL_BUSY');
    if (!sessionId || typeof sessionId !== 'string') throw error('MCP session identity is missing.', 'CONTROL_DISABLED');
    owner = { sessionId, name: String(name || 'MCP client').slice(0, 100) };
    changed();
    return true;
  }
  function releaseConnection(sessionId) {
    if (owner?.sessionId !== sessionId) return;
    owner = undefined;
    changed();
  }
  async function runTool(sessionId, action, signal) {
    if (!canConnect() || owner?.sessionId !== sessionId) throw error('This MCP controller is disconnected or disabled.', 'CONTROL_DISABLED');
    operations += 1;
    changed();
    const pending = queue.then(async () => {
      signal?.throwIfAborted();
      if (!canConnect() || owner?.sessionId !== sessionId) throw error('The agent controller changed before this tool ran.', 'CONTROL_DISABLED');
      return action();
    });
    queue = pending.catch(() => {});
    try { return await pending; }
    finally { operations -= 1; changed(); }
  }
  function setBackend(backend) {
    if (!BACKENDS.has(backend)) throw new Error('Choose Built-in, External MCP, or Codex.');
    assertIdle();
    const next = { ...preferences, backend };
    persist(next);
    preferences = next;
    changed();
    return getState();
  }
  function selectCodexModel(model) {
    assertIdle();
    if (typeof model !== 'string' || !model.trim() || model.length > 160 || /[\u0000-\u001f]/.test(model)) throw new Error('Codex model is invalid.');
    const next = { ...preferences, codexModel: model.trim() };
    persist(next);
    preferences = next;
    changed();
    return getState();
  }
  function getExternalChatId() {
    if (!preferences.externalChatId) {
      const next = { ...preferences, externalChatId: crypto.randomUUID().replaceAll('-', '') };
      persist(next);
      preferences = next;
    }
    return preferences.externalChatId;
  }
  function getState() { return { ...preferences, controller: owner ? { name: owner.name } : null, busy: operations > 0 || isAgentBusy() }; }
  return { getState, getBackend: () => preferences.backend, getCodexModel: () => preferences.codexModel,
    getExternalChatId, canConnect, authorizeConnection, releaseConnection, runTool, setBackend, selectCodexModel,
    assertIdle, isToolBusy: () => operations > 0, async shutdown() { shuttingDown = true; await queue; },
    cancelShutdown() { shuttingDown = false; } };
}

module.exports = { createAgentControl };
