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
    write(indexPath, { ...index, activeId: id });
  }

  function save({ id = crypto.randomUUID().replaceAll('-', ''), title, history }) {
    if (!Array.isArray(history) || typeof title !== 'string') throw new Error('Chat history is invalid.');
    const index = readIndex();
    const metadata = { id, title: title.slice(0, 120), updatedAt: Date.now() };
    write(filename(id), { ...metadata, history });
    write(indexPath, { activeId: id, chats: [metadata, ...index.chats.filter((chat) => chat.id !== id)] });
    return metadata;
  }

  return {
    save,
    get,
    activate,
    list: () => readIndex().chats,
    getActive: () => { const { activeId } = readIndex(); return activeId ? get(activeId) : null; },
  };
}

module.exports = { createChatStore };
