const { mkdir, open, rename, unlink, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_REPORT_BYTES = 8 * 1024 * 1024;

function parseDiagnosticReport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new Error('诊断报告过大或无效。');
  const report = JSON.parse(text);
  if (!report || report.kind !== 'lycansync-diagnostics' || report.schemaVersion !== 9 || !Array.isArray(report.samples)
      || report.samples.length > 900 || !Number.isFinite(Date.parse(report.startedAt))
      || !Number.isFinite(Date.parse(report.endedAt)) || Date.parse(report.endedAt) < Date.parse(report.startedAt)) {
    throw new Error('诊断报告无效。');
  }
  return report;
}

// 只管理本次与上次报告文件；采样和脱敏继续由原诊断模块负责。
function createDiagnosticReportStore(directory) {
  const current = join(directory, 'current.json');
  const previous = join(directory, 'previous.json');
  const temporary = join(directory, 'current.pending');
  let savedThisRun = false;
  let pending = Promise.resolve();

  function serialize(action) {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  }

  async function read(path) {
    let handle;
    try {
      handle = await open(path, 'r');
      const { size } = await handle.stat();
      if (size > MAX_REPORT_BYTES) throw new Error('已保存的诊断报告过大。');
      const buffer = Buffer.alloc(size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      return { report: parseDiagnosticReport(buffer.toString('utf8', 0, bytesRead)), bytes: bytesRead };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('无法读取已保存的诊断报告，请检查数据目录或清除详细报告后重试。', { cause: error });
    } finally { await handle?.close(); }
  }

  async function previousReport() {
    // 本次尚未采样时 current 仍属于上次启动；只打开设置不能覆盖它。
    return savedThisRun ? read(previous) : (await read(current)) ?? read(previous);
  }

  return {
    save(text) {
      parseDiagnosticReport(text);
      return serialize(async () => {
        await mkdir(directory, { recursive: true });
        if (!savedThisRun) await read(current);
        await writeFile(temporary, text, 'utf8');
        if (!savedThisRun) {
          try { await rename(current, previous); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          savedThisRun = true;
        }
        await rename(temporary, current);
        return Buffer.byteLength(text);
      });
    },
    previous: () => serialize(async () => (await previousReport())?.report ?? null),
    info: () => serialize(async () => {
      const saved = await previousReport();
      if (!saved) return null;
      const { report, bytes } = saved;
      return { startedAt: report.startedAt, endedAt: report.endedAt, bytes,
        clientVersion: report.runtime?.clientVersion ?? null, savedAt: report.persistence?.savedAt ?? report.endedAt };
    }),
    clear: () => serialize(async () => {
      for (const path of [current, previous, temporary]) {
        try { await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      savedThisRun = false;
    }),
    flush: () => pending,
  };
}

module.exports = { createDiagnosticReportStore, parseDiagnosticReport };
