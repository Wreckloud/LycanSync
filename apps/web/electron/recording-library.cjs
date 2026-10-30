const fs = require('node:fs/promises');
const { basename, isAbsolute, join } = require('node:path');

const ID = /^[a-f0-9-]{36}$/i;

// 只管理宿主创建并登记的原片；页面不能指定路径，也不扫描用户目录。
function createRecordingLibrary({ dataDirectory, isActive, io = fs }) {
  const indexPath = join(dataDirectory, 'recording-library.json');
  let entries;
  let loaded;
  let saving = Promise.resolve();

  async function load() {
    loaded ??= (async () => {
      try {
        const stored = JSON.parse(await io.readFile(indexPath, 'utf8'));
        if (stored?.schemaVersion !== 1 || !Array.isArray(stored.entries)
            || !stored.entries.every(entry => entry && ID.test(entry.id) && ID.test(entry.sessionId)
              && typeof entry.path === 'string' && isAbsolute(entry.path) && !entry.path.includes('\0')
              && basename(entry.path).endsWith(`-${entry.id}.mkv`) && basename(entry.path).startsWith('LycanSync-')
              && Number.isSafeInteger(entry.createdAt) && entry.createdAt > 0
              && ['pending', 'saved', 'interrupted'].includes(entry.state)
              && (entry.durationMs === null || Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0)
              && ['width', 'height'].every(key => entry[key] === null || Number.isSafeInteger(entry[key]) && entry[key] > 0)
              && typeof entry.fileIdentity === 'string')
            || new Set(stored.entries.map(entry => entry.id)).size !== stored.entries.length) throw new Error('invalidIndex');
        entries = stored.entries;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('recordingLibraryUnavailable');
        entries = [];
      }
    })();
    try { await loaded; }
    catch (error) { loaded = undefined; throw error; }
  }
  function change(update) {
    const result = saving.then(async () => {
      await load();
      const next = await update(entries);
      await io.mkdir(dataDirectory, { recursive: true });
      await io.writeFile(indexPath + '.pending', JSON.stringify({ schemaVersion: 1, entries: next }));
      await io.rename(indexPath + '.pending', indexPath);
      entries = next;
    }).catch(error => {
      if (['recordingFileUnavailable', 'recordingBusy', 'recordingEntryMissing'].includes(error.message)) throw error;
      throw new Error('recordingLibraryUnavailable');
    });
    saving = result.catch(() => {});
    return result;
  }
  async function find(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('recordingEntryMissing');
    await load();
    const entry = entries.find(item => item.id === id);
    if (!entry) throw new Error('recordingEntryMissing');
    return entry;
  }
  async function inspect(entry) {
    try {
      const file = await io.lstat(entry.path);
      // 文件被替换或改成链接后，不再播放或删除它；保留记录让用户自行检查。
      const unchanged = file.isFile() && `${file.dev}:${file.ino}` === entry.fileIdentity;
      return { availability: unchanged ? 'available' : 'changed', bytes: unchanged ? file.size : 0 };
    } catch (error) {
      return { availability: error.code === 'ENOENT' ? 'missing' : 'unavailable', bytes: 0 };
    }
  }
  async function filePath(id) {
    await saving;
    const entry = await find(id);
    if (isActive(id)) throw new Error('recordingBusy');
    const file = await inspect(entry);
    if (file.availability !== 'available' || file.bytes === 0) throw new Error('recordingFileUnavailable');
    return entry.path;
  }
  return {
    ready: load,
    async register(current) {
      const file = await io.lstat(current.path);
      await change(items => [...items, { id: current.id, sessionId: current.librarySessionId,
        path: current.path, fileIdentity: `${file.dev}:${file.ino}`, createdAt: Date.now(),
        durationMs: null, width: null, height: null, state: 'pending' }]);
    },
    finish(current) {
      return change(items => items.map(entry => entry.id === current.id ? { ...entry,
        state: current.saved ? 'saved' : 'interrupted', durationMs: current.durationMs ?? null,
        width: current.width ?? null, height: current.height ?? null } : entry));
    },
    async list(offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('recordingEntryMissing');
      await saving; await load();
      const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      const items = await Promise.all(sorted.slice(offset, offset + 50).map(async entry => ({
        id: entry.id, sessionId: entry.sessionId, createdAt: entry.createdAt,
        durationMs: entry.durationMs, width: entry.width, height: entry.height,
        state: isActive(entry.id) ? 'recording' : entry.state === 'pending' ? 'interrupted' : entry.state,
        ...await inspect(entry),
      })));
      return { items, hasMore: offset + items.length < sorted.length };
    },
    filePath,
    remove(id) {
      return change(async items => {
        const entry = await find(id);
        if (isActive(id)) throw new Error('recordingBusy');
        const file = await inspect(entry);
        if (file.availability === 'available') await io.unlink(entry.path);
        else if (!['missing', 'changed'].includes(file.availability)) throw new Error('recordingFileUnavailable');
        return items.filter(item => item.id !== id);
      });
    },
  };
}

module.exports = { createRecordingLibrary };
