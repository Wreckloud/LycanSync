const { mkdir, open, rename, unlink, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_REPORT_BYTES = 8 * 1024 * 1024;

function parseDiagnosticReport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new Error('诊断报告过大或无效。');
  const report = JSON.parse(text);
  if (!report || report.kind !== 'lycansync-diagnostics' || ![9, 10, 11, 12, 13].includes(report.schemaVersion) || !Array.isArray(report.samples)
      || report.samples.length > 900 || !Number.isFinite(Date.parse(report.startedAt))
      || !Number.isFinite(Date.parse(report.endedAt)) || Date.parse(report.endedAt) < Date.parse(report.startedAt)) {
    throw new Error('诊断报告无效。');
  }
  if (report.problemMarkers !== undefined && (!Array.isArray(report.problemMarkers) || report.problemMarkers.length > 100
      || report.problemMarkers.some(marker => !marker || !Number.isFinite(Date.parse(marker.time))
        || !['no-audio', 'audio-breakup', 'video-stutter', 'other'].includes(marker.category) || marker.recording !== true))) {
    throw new Error('诊断问题标记无效。');
  }
  return report;
}

function hasScreenMedia(sample) {
  return Array.isArray(sample?.streams) && sample.streams.length > 0 || sample?.native?.state === 'running';
}
function lastScreenActivity(report) {
  const sample = report?.samples.findLast(hasScreenMedia);
  const time = Date.parse(sample?.time);
  return Number.isFinite(time) ? time : null;
}

// 复用有界报告，画面结束后额外固定保留最近一次；不另建采样器或无限历史。
function createDiagnosticReportStore(directory) {
  const current = join(directory, 'current.json');
  const previous = join(directory, 'previous.json');
  const temporary = join(directory, 'current.pending');
  const screenUsage = join(directory, 'last-screen-usage.json');
  const screenTemporary = join(directory, 'last-screen-usage.pending');
  let retainedScreenTime;
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

  async function retainScreenReport(report) {
    const time = lastScreenActivity(report);
    if (time === null || retainedScreenTime !== null && time <= retainedScreenTime) return;
    const retained = { ...report, persistence: { ...report.persistence,
      retainedScreenUsage: true, lastScreenActivityAt: new Date(time).toISOString() } };
    const text = JSON.stringify(retained);
    parseDiagnosticReport(text);
    await writeFile(screenTemporary, text, 'utf8');
    await rename(screenTemporary, screenUsage);
    retainedScreenTime = time;
  }
  async function previousReport() {
    // 本次尚未采样时 current 仍属于上次启动；只打开设置不能覆盖它。
    const prior = savedThisRun ? await read(previous) : (await read(current)) ?? await read(previous);
    const retained = await read(screenUsage);
    const retainedTime = lastScreenActivity(retained?.report);
    const priorTime = lastScreenActivity(prior?.report);
    // 用户在共享结束后或纯语音中标记的问题，不能被较旧的画面报告遮住。
    const markerTime = report => Math.max(-Infinity, ...(report?.problemMarkers ?? [])
      .map(marker => Date.parse(marker.time)).filter(Number.isFinite));
    if (prior && markerTime(prior.report) > Math.max(retainedTime ?? -Infinity, markerTime(retained?.report))) return prior;
    return retainedTime !== null && (priorTime === null || retainedTime >= priorTime) ? retained : prior;
  }

  return {
    save(text) {
      const report = parseDiagnosticReport(text);
      return serialize(async () => {
        await mkdir(directory, { recursive: true });
        if (retainedScreenTime === undefined) retainedScreenTime = lastScreenActivity((await read(screenUsage))?.report);
        if (!savedThisRun) {
          const prior = (await read(current)) ?? await read(previous);
          if (lastScreenActivity(prior?.report) === null) {
            const older = await read(previous);
            if (older) await retainScreenReport(older.report);
          }
          if (prior) await retainScreenReport(prior.report);
        }
        // 首个无画面的快照固定完整使用窗口，后续空闲不能逐步冲掉它。
        if (!hasScreenMedia(report.samples.at(-1))) await retainScreenReport(report);
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
      return { kind: report.persistence?.retainedScreenUsage ? 'screen-media' : 'previous-run',
        startedAt: report.startedAt, endedAt: report.endedAt, bytes,
        clientVersion: report.runtime?.clientVersion ?? null, savedAt: report.persistence?.savedAt ?? report.endedAt };
    }),
    clear: () => serialize(async () => {
      for (const path of [current, previous, temporary, screenUsage, screenTemporary]) {
        try { await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      savedThisRun = false; retainedScreenTime = null;
    }),
    flush: () => pending,
  };
}

module.exports = { createDiagnosticReportStore, parseDiagnosticReport };
