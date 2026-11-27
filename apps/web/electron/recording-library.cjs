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
              && (basename(entry.path).endsWith(`-${entry.id}.mkv`) || basename(entry.path).endsWith(`-${entry.id}.mp4`))
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
      return { availability: unchanged ? 'available' : 'changed', bytes: unchanged ? file.size : null };
    } catch (error) {
      return { availability: error.code === 'ENOENT' ? 'missing' : 'unavailable', bytes: null };
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
      // 剪辑在成品落盘后才登记；录制和回放仍先预留记录，结束时再确认。
      const completed = current.kind === 'clip';
      if (completed && (!file.isFile() || !file.size)) throw new Error('剪辑工具未生成有效的片段文件。');
      const createdAt = Date.now();
      await change(items => [...items, { id: current.id, sessionId: current.librarySessionId,
        path: current.path, kind: current.kind || 'recording', applicationName: current.applicationName || '', fileIdentity: `${file.dev}:${file.ino}`, createdAt,
        durationMs: completed ? current.durationMs : null, width: completed ? current.width : null,
        height: completed ? current.height : null, state: completed ? 'saved' : 'pending' }]);
      return { createdAt, bytes: file.size };
    },
    finish(current) {
      return change(async items => {
        const existing = await find(current.id);
        // OBS 会重建预留文件，保存完成后才记录最终输出的文件身份。
        const file = current.saved ? await io.lstat(existing.path) : null;
        if (file && !file.isFile()) throw new Error('recordingFileUnavailable');
        return items.map(entry => entry.id === current.id ? { ...entry,
          fileIdentity: file ? `${file.dev}:${file.ino}` : entry.fileIdentity,
          state: current.saved ? 'saved' : 'interrupted', durationMs: current.durationMs ?? null,
          width: current.width ?? null, height: current.height ?? null } : entry);
      });
    },
    async list(offset = 0, kind = 'all') {
      if (!['all', 'recording', 'replay', 'clip'].includes(kind)) throw new Error('recordingEntryMissing');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('recordingEntryMissing');
      await saving; await load();
      const sorted = entries.filter(entry => kind === 'all' || entryKind(entry) === kind).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      const items = await Promise.all(sorted.slice(offset, offset + 50).map(async entry => ({
        id: entry.id, sessionId: entry.sessionId, kind: entryKind(entry), applicationName: entry.applicationName || '', fileName: basename(entry.path), createdAt: entry.createdAt,
        durationMs: entry.durationMs, width: entry.width, height: entry.height,
        state: isActive(entry.id) ? 'recording' : entry.state === 'pending' ? 'interrupted' : entry.state,
        ...await inspect(entry),
      })));
      return { items, hasMore: offset + items.length < sorted.length };
    },
    updateDuration(id, durationMs) {
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('recordingMetadataInvalid');
      return change(async items => {
        const entry = await find(id);
        if (isActive(id)) throw new Error('recordingBusy');
        const file = await inspect(entry);
        if (file.availability !== 'available' || !file.bytes) throw new Error('recordingFileUnavailable');
        // 播放器只补齐缺失时长，不能覆盖录制宿主已经确认的结果。
        return items.map(item => item.id === entry.id && item.durationMs === null ? { ...item, durationMs } : item);
      });
    },
    filePath,
    async entry(id) { await saving; return { ...await find(id) }; },
    relink(id) {
      return change(async items => {
        const entry = await find(id);
        if (isActive(id)) throw new Error('recordingBusy');
        const file = await io.lstat(entry.path);
        if (!file.isFile() || file.size === 0) throw new Error('recordingFileUnavailable');
        return items.map(item => item.id === id ? { ...item, fileIdentity: `${file.dev}:${file.ino}` } : item);
      });
    },
    clearUnavailable() {
      return change(async items => {
        const keep = await Promise.all(items.map(async item => isActive(item.id) || !['missing', 'changed'].includes((await inspect(item)).availability)));
        return items.filter((_item, index) => keep[index]);
      });
    },
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

function entryKind(entry) {
  return entry.kind || (basename(entry.path).startsWith('LycanSync-Replay-') ? 'replay' : 'recording');
}
function recordingFileName(applicationName, kind, id, createdAt = Date.now()) {
  const application = String(applicationName || '窗口').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || '窗口';
  const date = new Date(createdAt);
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${application} · ${{ recording: '录制', replay: '回放', clip: '剪辑' }[kind]} · ${stamp}-${id}.${kind === 'clip' ? 'mp4' : 'mkv'}`;
}
module.exports = { createRecordingLibrary, recordingFileName };
