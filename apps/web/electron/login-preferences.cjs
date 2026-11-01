const { readFile, mkdir, writeFile, rename, unlink } = require('node:fs/promises');
const { dirname } = require('node:path');

function createLoginPreferences(file, server) {
  let pending = Promise.resolve();
  function enqueue(operation) {
    const result = pending.then(operation);
    // 前次保存失败不能阻止后续重试；调用方仍收到原始失败。
    pending = result.catch(() => {});
    return result;
  }
  function validateAccount(accountId) {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 100) throw new Error('账号无效。');
  }
  return {
    get(accountId) {
      validateAccount(accountId);
      return enqueue(async () => {
        let saved;
        try { saved = JSON.parse(await readFile(file, 'utf8')); }
        catch (error) {
          if (error.code === 'ENOENT') return { enabled: true, manualEntryRequired: false };
          throw new Error('无法读取自动登录设置，请重新选择该选项后重试。');
        }
        if (!saved || typeof saved.server !== 'string' || typeof saved.accountId !== 'string'
            || typeof saved.autoLogin !== 'boolean' || typeof saved.manualEntryRequired !== 'boolean') throw new Error('自动登录设置无效，请重新选择。');
        return saved.server === server && saved.accountId === accountId
          ? { enabled: saved.autoLogin, manualEntryRequired: saved.manualEntryRequired }
          : { enabled: true, manualEntryRequired: false };
      });
    },
    set(accountId, autoLogin, manualEntryRequired) {
      validateAccount(accountId);
      if (typeof autoLogin !== 'boolean' || typeof manualEntryRequired !== 'boolean') throw new Error('自动登录设置无效。');
      return enqueue(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, `${JSON.stringify({ server, accountId, autoLogin, manualEntryRequired })}\n`, 'utf8');
        await rename(`${file}.tmp`, file);
        return autoLogin;
      });
    },
    clear() {
      return enqueue(async () => {
        for (const path of [file, `${file}.tmp`]) {
          try { await unlink(path); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      });
    },
  };
}

module.exports = { createLoginPreferences };
