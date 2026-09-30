const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID_PATTERN = /^[a-f0-9]{32}$/;

function createChatStore({ userDataPath, fileSystem = fs }) {
  const directory = path.join(userDataPath, 'chats');
  const indexPath = path.join(directory, 'index.json');

  function readIndex() {
    if (!fileSystem.existsSync(indexPath)) return { activeId: '', chats: [] };
    const index = JSON.parse(fileSystem.readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(index.chats) || typeof index.activeId !== 'string') throw new Error('Saved chat index could not be read.');
    return index;
  }

  function filename(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Chat ID is invalid.');
    return path.join(directory, `${id}.json`);
  }

  function write(file, value) {
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fileSystem.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fileSystem.renameSync(temporary, file);
    } catch (error) {
      fileSystem.rmSync(temporary, { force: true });
      throw error;
    }
  }

  function get(id) {
    const chat = JSON.parse(fileSystem.readFileSync(filename(id), 'utf8'));
    if (chat.id !== id || typeof chat.title !== 'string' || !Array.isArray(chat.history)) throw new Error('Saved chat could not be read.');
    return chat;
  }

  function activate(id) {
    if (id) get(id);
    const index = readIndex();
    const backend = id ? get(id).backend || 'builtin' : 'builtin';
    write(indexPath, { ...index, activeId: id, activeIds: { ...(index.activeIds || {}), [backend]: id } });
  }

  function save({ id = crypto.randomUUID().replaceAll('-', ''), title, history, backend, codexThreadId, origin }) {
    if (!Array.isArray(history) || typeof title !== 'string') throw new Error('Chat history is invalid.');
    if (backend !== undefined && !['builtin', 'codex', 'external'].includes(backend)) throw new Error('Chat backend is invalid.');
    if (codexThreadId !== undefined && (typeof codexThreadId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(codexThreadId))) throw new Error('Codex thread ID is invalid.');
    if (origin !== undefined && (!origin || typeof origin !== 'object' || Array.isArray(origin) || Buffer.byteLength(JSON.stringify(origin)) > 8000)) throw new Error('Chat origin is invalid.');
    const index = readIndex();
    const metadata = { id, title: title.slice(0, 120), updatedAt: Date.now(), ...(backend ? { backend } : {}), ...(codexThreadId ? { codexThreadId } : {}), ...(origin ? { origin } : {}) };
    write(filename(id), { ...metadata, history });
    write(indexPath, { ...index, activeId: id, activeIds: { ...(index.activeIds || {}), [backend || 'builtin']: id }, chats: [metadata, ...index.chats.filter((chat) => chat.id !== id)] });
    return metadata;
  }

  function forBackend(backend) {
    if (!['builtin', 'codex', 'external'].includes(backend)) throw new Error('Chat backend is invalid.');
    return {
      save: (input) => save({ ...input, backend }),
      get: (id) => { const chat = get(id); if ((chat.backend || 'builtin') !== backend) throw new Error('This conversation uses another agent backend.'); return chat; },
      list: () => readIndex().chats.filter((chat) => (chat.backend || 'builtin') === backend),
      activate: (id) => {
        if (id && (get(id).backend || 'builtin') !== backend) throw new Error('This conversation uses another agent backend.');
        const index = readIndex();
        write(indexPath, { ...index, activeId: id, activeIds: { ...(index.activeIds || {}), [backend]: id } });
      },
      getActive: () => {
        const index = readIndex();
        const id = index.activeIds?.[backend] ?? (index.activeId && (get(index.activeId).backend || 'builtin') === backend ? index.activeId : '');
        return id ? get(id) : null;
      },
    };
  }

  return {
    forBackend,
    save,
    get,
    activate,
    list: () => readIndex().chats,
    getActive: () => { const { activeId } = readIndex(); return activeId ? get(activeId) : null; },
  };
}

module.exports = { createChatStore };
