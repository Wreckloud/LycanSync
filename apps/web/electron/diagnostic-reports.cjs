const { mkdir, open, rename, unlink, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { setImmediate: yieldToMainLoop } = require('node:timers/promises');
const { isDeepStrictEqual } = require('node:util');

const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const reportIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function receivedReportPath(directory, id, userId, uploadedAt) {
  if (typeof id !== 'string' || !reportIdPattern.test(id)) throw new Error('日志标识无效。');
  const name = 'LycanSync-diagnostics-' + id + '.json';
  if (userId == null) return join(directory, name);
  if (typeof userId !== 'string' || !reportIdPattern.test(userId) || !Number.isFinite(Date.parse(uploadedAt))) throw new Error('日志归档信息无效。');
  return join(directory, userId, new Date(uploadedAt).toLocaleDateString('sv-SE'), name);
}

function parseDiagnosticReport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new Error('诊断报告过大或无效。');
  return validateDiagnosticReport(JSON.parse(text));
}

function validateDiagnosticReport(report) {
  if (!report || report.kind !== 'lycansync-diagnostics' || ![9, 10, 11, 12, 13, 14, 15].includes(report.schemaVersion) || !Array.isArray(report.samples)
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

function serializeDiagnosticReport(report) {
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new Error('诊断报告过大或无效。');
  return text;
}

// 只在合并导出时引用相同采样。各磁盘快照始终独立，历史标记、版本和事件仍归各自报告。
async function compactSavedSamples(report, savedReports) {
  const byTime = new Map();
  function remember(sample, pointer) {
    if (typeof sample?.time !== 'string') return;
    const entries = byTime.get(sample.time) ?? [];
    entries.push({ sample, pointer });
    byTime.set(sample.time, entries);
  }
  report.samples.forEach((sample, index) => remember(sample, '#/samples/' + index));
  const compacted = {};
  for (const [source, saved] of Object.entries(savedReports)) {
    const samples = [];
    for (const [index, sample] of saved.samples.entries()) {
      if (index && index % 32 === 0) await yieldToMainLoop();
      const match = byTime.get(sample?.time)?.find(entry => isDeepStrictEqual(entry.sample, sample));
      if (match) {
        samples.push({ $ref: match.pointer });
      } else {
        samples.push(sample);
        remember(sample, '#/savedReports/' + source + '/samples/' + index);
      }
    }
    compacted[source] = { ...saved, samples };
  }
  return compacted;
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
    const text = serializeDiagnosticReport(retained);
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
    save(report) {
      validateDiagnosticReport(report);
      const text = serializeDiagnosticReport(report);
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
    all: () => serialize(async () => {
      const reports = {};
      const unavailable = [];
      for (const [source, path] of Object.entries({ current, previous, lastScreenUsage: screenUsage })) {
        try {
          const saved = await read(path);
          if (saved) reports[source] = saved.report;
        } catch {
          // 单份历史快照损坏时，仍导出其余报告，并在结果中注明缺失项。
          unavailable.push(source);
        }
      }
      return { reports, unavailable };
    }),
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

module.exports = { compactSavedSamples, createDiagnosticReportStore, parseDiagnosticReport, receivedReportPath, reportIdPattern };
