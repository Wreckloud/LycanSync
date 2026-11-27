const { randomUUID } = require('node:crypto');
const { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } = require('node:fs/promises');
const { dirname, join, relative, sep } = require('node:path');
const { receivedReportPath, reportIdPattern } = require('./diagnostic-reports.cjs');
const { saveChatDownload } = require('./chat-download.cjs');

const retentionMs = 3 * 24 * 60 * 60 * 1000;
const capacity = 128 * 1024 * 1024;

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

// 只进入应用约定的真实目录。旧版的用户导出目录可能也含手工保存的 JSON。
function createDiagnosticCopies(base) {
  const received = join(base, 'exports', 'received');
  const submitted = join(base, 'diagnostics', 'submitted');
  let pending = Promise.resolve();
  function run(operation) {
    const task = pending.then(operation);
    pending = task.catch(() => {});
    return task;
  }
  async function directory(path, create = false) {
    let parent = base;
    for (const segment of relative(base, path).split(sep)) {
      parent = join(parent, segment);
      if (create) {
        try { await mkdir(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const entry = await info(parent);
      if (!entry) return false;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('日志目录已更换，请检查保存位置。');
    }
    return true;
  }
  function candidates(entry) {
    return new Set([receivedReportPath(received, entry.id, entry.userId, entry.uploadedAt), receivedReportPath(received, entry.id)]);
  }
  async function locate(entry) {
    for (const candidate of candidates(entry)) {
      if (!await directory(dirname(candidate))) continue;
      const file = await info(candidate);
      if (!file) continue;
      if (file.isFile() && file.size === entry.byteSize) return candidate;
    }
    return null;
  }
  async function discard(path, expected) {
    if (!await directory(dirname(path))) return;
    const current = await info(path);
    if (!current) return;
    if (!current.isFile() || current.ino !== expected.ino || current.dev !== expected.dev
        || current.size !== expected.size || current.ctimeMs !== expected.ctimeMs) throw new Error('日志副本已变化，请重新打开管理器。');
    try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function prune(protect) {
    const files = [], folders = [];
    const cutoff = Date.now() - retentionMs;
    async function scan(path, depth) {
      if (!await directory(path)) return;
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name, child = join(path, name);
        if (entry.isDirectory() && (depth === 0 && reportIdPattern.test(name)
            || depth === 1 && /^\d{4}-\d{2}-\d{2}$/.test(name))) {
          await scan(child, depth + 1);
          folders.push(child);
        } else if (entry.isFile() && depth !== 1) {
          const id = /^LycanSync-diagnostics-([0-9a-f-]+)\.json$/i.exec(name)?.[1];
          const part = /^\.lycansync-([0-9a-f-]+)\.part$/i.exec(name)?.[1];
          if (!reportIdPattern.test(id ?? part ?? '')) continue;
          const file = await info(child);
          if (!file?.isFile()) continue;
          if (part) {
            if (file.mtimeMs < cutoff) await discard(child, file);
          } else files.push({ path: child, stat: file });
        }
      }
    }
    await scan(received, 0);
    await scan(submitted, 3);
    let total = files.reduce((sum, f) => sum + f.stat.size, 0);
    files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    for (const file of files) {
      if (file.path !== protect && (file.stat.mtimeMs < cutoff || total > capacity)) {
        await discard(file.path, file.stat);
        total -= file.stat.size;
      }
    }
    for (const folder of folders) {
      if (!await directory(folder)) continue;
      try { await rmdir(folder); } catch (error) { if (!['ENOTEMPTY','ENOENT','EEXIST'].includes(error.code)) throw error; }
    }
  }
  return {
    locate,
    clean: () => run(() => prune()),
    submit: (json, ensureCurrent) => run(async () => {
      ensureCurrent();
      await directory(submitted, true);
      const id = randomUUID();
      const temp = join(submitted, '.lycansync-' + id + '.part');
      const path = receivedReportPath(submitted, id);
      try {
        await writeFile(temp, json, { flag: 'wx' });
        ensureCurrent();
        await rename(temp, path);
      } finally {
        try { await unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await prune(path);
      return path;
    }),
    open: (entry, download, signal, ensureCurrent) => run(async () => {
      ensureCurrent();
      const saved = await locate(entry);
      if (saved) return saved;
      const path = receivedReportPath(received, entry.id, entry.userId, entry.uploadedAt);
      await directory(dirname(path), true);
      if (await info(path)) throw new Error('日志文件已被替换，请先移走同名文件。');
      const response = await download();
      ensureCurrent();
      if (!response.ok) throw new Error('无法接收报告，请确认日志仍在且拥有服主权限。');
      await saveChatDownload(path, response, entry.byteSize, signal, ensureCurrent);
      await prune(path);
      return path;
    }),
    remove: (entry, ensureCurrent) => run(async () => {
      // 升级前后可能各留一份，删除后不能因发现旧平铺副本又显示为已下载。
      for (const path of candidates(entry)) {
        if (!await directory(dirname(path))) continue;
        const file = await info(path);
        ensureCurrent();
        if (file?.isFile() && file.size === entry.byteSize) await discard(path, file);
      }
    }),
  };
}

module.exports = { createDiagnosticCopies };

