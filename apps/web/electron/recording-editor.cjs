const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { dirname, join, basename } = require('node:path');
const { recordingFileName } = require('./recording-library.cjs');

function createRecordingEditor({ library, executablePath, onProgress, onDiagnostic, spawnProcess = spawn }) {
  let active;
  async function exportClip(requestId, sourceId, startMs, endMs) {
    if (active) throw new Error('已有片段正在保存，请稍后再试。');
    if (!/^[a-f0-9-]{36}$/i.test(requestId) || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
        || startMs < 0 || endMs - startMs < 100) throw new Error('请选择至少 0.1 秒的片段。');
    const task = active = { requestId, child: null, cancelled: false, done: null };
    task.done = (async () => {
      let temporary; let destination; let renamed = false; let registered = false;
      try {
        const source = await library.entry(sourceId);
        const sourcePath = await library.filePath(sourceId);
        if (source.durationMs !== null && endMs > source.durationMs + 100) throw new Error('片段超出了录像时长。');
        const id = randomUUID();
        destination = join(dirname(sourcePath), recordingFileName(source.applicationName, 'clip', id));
        const pendingPath = destination + '.partial';
        const reservation = await fs.open(pendingPath, 'wx'); temporary = pendingPath;
        await reservation.close();
        if (task.cancelled) throw new Error('已取消保存片段。');
        await new Promise((resolve, reject) => {
          const child = task.child = spawnProcess(executablePath, [sourcePath, temporary, String(startMs), String(endMs)],
            { windowsHide: true, cwd: dirname(executablePath), stdio: ['ignore', 'pipe', 'pipe'] });
          let lines = ''; let diagnostics = '';
          child.stdout.on('data', chunk => {
            lines += chunk.toString();
            const parts = lines.split(/\r?\n/); lines = parts.pop();
            for (const part of parts) if (/^\d{1,3}$/.test(part)) onProgress({ requestId, percent: Math.min(100, Number(part)) });
          });
          child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2048); });
          child.once('error', reject);
          child.once('close', code => {
            task.child = null;
            if (task.cancelled) reject(new Error('已取消保存片段。'));
            else if (code !== 0) { onDiagnostic?.({ stage: 'recordingClipFailed', code, message: diagnostics.replaceAll(sourcePath, '[recording]').replaceAll(temporary, '[clip]') }); reject(new Error('片段保存失败，请检查磁盘空间或使用系统播放器确认原片能够播放。')); }
            else resolve();
          });
        });
        if (task.cancelled) throw new Error('已取消保存片段。');
        await fs.rename(temporary, destination); renamed = true; temporary = null;
        const clip = { id, librarySessionId: source.sessionId, path: destination, kind: 'clip',
          applicationName: source.applicationName, saved: true, durationMs: endMs - startMs,
          width: source.width ? source.width & ~1 : null, height: source.height ? source.height & ~1 : null };
        await library.register(clip); registered = true;
        await library.finish(clip);
        const entry = await library.entry(id);
        return { id, sessionId: source.sessionId, kind: 'clip', applicationName: entry.applicationName,
          fileName: basename(destination), createdAt: entry.createdAt, durationMs: entry.durationMs,
          width: entry.width, height: entry.height, bytes: (await fs.stat(destination)).size, state: 'saved', availability: 'available' };
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('剪辑工具或原片不可用，请检查安装与录像文件。');
        if (['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw new Error('无法保存片段，请检查录像目录的空间与写入权限。');
        if (['recordingFileUnavailable', 'recordingEntryMissing', 'recordingBusy'].includes(error.message)) throw new Error('原片暂时无法读取，请关闭剪辑窗口后重新选择。');
        if (error.message === 'recordingLibraryUnavailable') throw new Error('录像列表未能保存，请检查录像目录后重试。');
        throw error;
      } finally {
        // 只删除本任务独占创建、尚未登记的半成品；原片始终只读。
        for (const file of [temporary, renamed && !registered && destination].filter(Boolean)) {
          try { await fs.unlink(file); }
          catch (error) { if (error.code !== 'ENOENT') onDiagnostic?.({ stage: 'recordingClipCleanupFailed', message: error.code }); }
        }
      }
    })();
    try { return await task.done; } finally { if (active === task) active = null; }
  }
  async function cancel(requestId) {
    const task = active;
    if (!task || requestId !== undefined && task.requestId !== requestId) return;
    task.cancelled = true; task.child?.kill();
    await task.done.catch(() => {});
  }
  return { exportClip, cancel };
}
module.exports = { createRecordingEditor };
