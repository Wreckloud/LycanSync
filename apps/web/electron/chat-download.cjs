const { randomUUID } = require('node:crypto');
const { open, rename, unlink } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { pipeline } = require('node:stream/promises');

// 同目录写完再替换，取消或中途断线都不截断用户选中的已有文件。
async function saveChatDownload(target, response, size, signal, progress) {
  if (!response.body) throw new Error('服务器没有返回文件内容。');
  const temporary = join(dirname(target), '.lycansync-' + randomUUID() + '.part');
  const file = await open(temporary, 'wx');
  let saved = false;
  try {
    await pipeline(response.body, async function* (chunks) {
      let bytes = 0;
      for await (const chunk of chunks) {
        bytes += chunk.byteLength;
        if (bytes > size) throw new Error('文件未能完整下载，请重试。');
        yield chunk;
        progress(bytes);
      }
      if (bytes !== size) throw new Error('文件未能完整下载，请重试。');
    }, file.createWriteStream(), { signal });
    signal.throwIfAborted();
    await rename(temporary, target);
    saved = true;
  } finally {
    await file.close();
    if (!saved) await unlink(temporary);
  }
}

module.exports = { saveChatDownload };
