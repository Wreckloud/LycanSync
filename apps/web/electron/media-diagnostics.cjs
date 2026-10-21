const { appendFile, mkdir, open, rename, stat } = require('node:fs/promises');
const { dirname } = require('node:path');

// 保存故障与一次性启动摘要；串行轮转避免并发写入时覆盖日志。
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

// 仅读取有界日志尾部；导出阶段/错误码，不把异常正文、路径或凭据带入报告。
async function readDiagnosticEvents(path, startedAt, endedAt) {
  const events = [];
  for (const file of [`${path}.previous`, path]) {
    let handle;
    try {
      handle = await open(file, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
      if (start > 0) lines.shift();
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const time = Date.parse(entry.time);
        if (!Number.isFinite(time) || time < startedAt || time > endedAt) continue;
        const stage = typeof entry.stage === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(entry.stage)
          ? entry.stage : 'unknown';
        const message = typeof entry.message === 'string' ? entry.message : '';
        const hresults = [...new Set(message.match(/\b0x[0-9a-fA-F]{8}\b/g) ?? [])].slice(0, 8);
        const audioTiming = {};
        if (stage === 'screenAudioStartup') {
          if (['published', 'failed'].includes(entry.outcome)) audioTiming.outcome = entry.outcome;
          if (['capture', 'graph', 'publish'].includes(entry.phase)) audioTiming.phase = entry.phase;
          for (const key of ['pluginLoadMs', 'captureReadyMs', 'graphReadyMs', 'publishMs']) {
            if (Number.isFinite(entry[key]) && entry[key] >= 0 && entry[key] <= 300_000) audioTiming[key] = entry[key];
          }
        }
        events.push({ time: new Date(time).toISOString(), stage, hresults,
          ...(typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? { durationMs: entry.durationMs } : {}),
          ...audioTiming });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取本机故障诊断，请检查用户目录权限。');
    } finally { await handle?.close(); }
  }
  return events.sort((left, right) => left.time.localeCompare(right.time)).slice(-200);
}

module.exports = { createMediaDiagnostics, readDiagnosticEvents };
