const { open } = require('node:fs/promises');
const { Readable } = require('node:stream');

// 只从录像索引解析文件；按 Range 流式读取，预览和拖动进度不缓存整段录像。
async function serveRecordingMedia(request, library) {
  const match = /^\/recordings\/([a-f0-9-]{36})$/i.exec(new URL(request.url).pathname);
  if (!match) return new Response(null, { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  let file;
  try {
    const path = await library.filePath(match[1]);
    file = await open(path, 'r');
    const { size } = await file.stat();
    const headers = { 'Content-Type': path.endsWith('.mp4') ? 'video/mp4' : 'video/x-matroska', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    let start = 0;
    let end = size - 1;
    const range = request.headers.get('Range');
    if (range) {
      const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (parts && (parts[1] || parts[2])) {
        start = parts[1] ? Number(parts[1]) : Math.max(0, size - Number(parts[2]));
        end = parts[1] && parts[2] ? Math.min(size - 1, Number(parts[2])) : size - 1;
      } else start = size;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        await file.close(); file = undefined;
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(Math.max(0, end - start + 1));
    const status = range ? 206 : 200;
    if (request.method === 'HEAD' || size === 0) {
      await file.close(); file = undefined;
      return new Response(null, { status, headers });
    }
    const stream = file.createReadStream({ start, end, highWaterMark: 64 * 1024 });
    file = undefined; // 流的关闭、取消和错误负责释放句柄。
    const abort = () => stream.destroy();
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    const body = Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } });
    if (request.signal.aborted) abort();
    return new Response(body, { status, headers });
  } catch (error) {
    if (file) await file.close();
    const unavailable = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)
      || ['recordingEntryMissing', 'recordingFileUnavailable', 'recordingBusy'].includes(error.message);
    return new Response(null, { status: unavailable ? 404 : 500 });
  }
}

module.exports = { serveRecordingMedia };
