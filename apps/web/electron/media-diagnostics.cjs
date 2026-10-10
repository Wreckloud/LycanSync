const { appendFile, mkdir, rename, stat } = require('node:fs/promises');
const { dirname } = require('node:path');

// 仅保存故障诊断；串行轮转避免多个失败同时写入时覆盖日志。
function createMediaDiagnostics(path, maxBytes = 1024 * 1024) {
  let pending = Promise.resolve();
  return (entry) => {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
    pending = pending.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const size = await stat(path).then((value) => value.size).catch((error) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      if (size + Buffer.byteLength(line) > maxBytes && size > 0) {
        await rename(path, `${path}.previous`);
      }
      await appendFile(path, line, 'utf8');
    }).catch((error) => {
      console.error('无法写入原生媒体诊断', error.code ?? error.message);
    });
    return pending;
  };
}

module.exports = { createMediaDiagnostics };
