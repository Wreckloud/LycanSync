const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createMediaDiagnostics, readDiagnosticEvents } = require('./media-diagnostics.cjs');

test('故障日志串行写入并轮转，保留最近一份历史', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lycansync-diagnostics-'));
  try {
    const path = join(directory, 'nested', 'screen-share-error.log');
    const write = createMediaDiagnostics(path, 200);
    await Promise.all([write({ stage: 'first', message: 'a'.repeat(80) }),
      write({ stage: 'second', message: 'b'.repeat(80) }),
      write({ stage: 'third', message: 'c'.repeat(80) })]);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).stage, 'third');
    assert.equal(JSON.parse(await readFile(`${path}.previous`, 'utf8')).stage, 'second');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('报告日志只保留时间/阶段/HRESULT，忽略坏行并限制数量与时间范围', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lycansync-report-'));
  try {
    const path = join(directory, 'error.log');
    const time = '2026-10-15T00:00:01.000Z';
    const entry = { time, stage: 'helperStderr', message: 'private-user https://server/#token=secret C:\\private 0x80070005',
      sessionId: 'private-session', durationMs: 3 };
    await writeFile(path, ['null', 'invalid-json', ...Array(250).fill(JSON.stringify(entry)),
      JSON.stringify({ ...entry, time: '2026-10-14T00:00:00Z' })].join('\n'));
    const events = await readDiagnosticEvents(path, Date.parse('2026-10-15T00:00:00Z'), Date.parse('2026-10-15T00:00:02Z'));
    assert.equal(events.length, 200);
    assert.deepEqual(events[0], { time, stage: 'helperStderr', hresults: ['0x80070005'], durationMs: 3 });
    assert.doesNotMatch(JSON.stringify(events), /secret|private|token|server/);
    assert.deepEqual(await readDiagnosticEvents(join(directory, 'missing'), 0, Date.now()), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function exportFixture() {
  const main = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = main.indexOf("ipcMain.handle('diagnostics:export'");
  const end = main.indexOf("ipcMain.handle('presence:system-idle-state'", start);
  assert.ok(start >= 0 && end > start);
  let exportReport;
  const calls = { read: 0, dialog: 0, writes: [] };
  const state = { closing: false, diagnosticExportPending: false, trustedSender: () => true,
    Buffer, JSON, Date, Error, resolve: join, mainWindow: {}, process: { versions: { electron: 'test' }, platform: 'win32', arch: 'x64' },
    osRelease: () => 'test-os', app: { getPath: () => '/private', getVersion: () => 'test-version', getGPUFeatureStatus: () => ({ video_encode: 'enabled' }) },
    readDiagnosticEvents: async () => { calls.read++; return [{ stage: 'test' }]; },
    dialog: { showSaveDialog: async () => { calls.dialog++; return { canceled: false, filePath: '/selected/report.json' }; } },
    writeFile: async (...args) => { calls.writes.push(args); },
    ipcMain: { handle: (_name, callback) => { exportReport = callback; } },
  };
  runInNewContext(main.slice(start, end), state);
  const text = JSON.stringify({ kind: 'lycansync-diagnostics', schemaVersion: 4,
    startedAt: '2026-10-15T00:00:00Z', endedAt: '2026-10-15T00:00:01Z', samples: [] });
  return { state, calls, text, exportReport: (...args) => exportReport(...args) };
}

test('诊断导出仅允许可信页面，验证格式并通过用户选址写入，不泄露系统路径', async () => {
  const { state, calls, text, exportReport } = exportFixture();
  state.trustedSender = () => false;
  await assert.rejects(exportReport({}, text), /不能导出/);
  assert.equal(calls.read, 0);
  state.trustedSender = () => true;
  await assert.rejects(exportReport({}, '{}'), /无效/);
  await assert.rejects(exportReport({}, text.replace('"schemaVersion":4', '"schemaVersion":3')), /无效/);
  await assert.rejects(exportReport({}, 'x'.repeat(8 * 1024 * 1024 + 1)), /过大/);
  await exportReport({}, text);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0][0], '/selected/report.json');
  const report = JSON.parse(calls.writes[0][1]);
  assert.equal(report.environment.appVersion, 'test-version');
  assert.equal(report.environment.gpuUtilization, null);
  assert.equal(Object.hasOwn(report.environment, 'helperVersion'), false);
  assert.doesNotMatch(calls.writes[0][1], /\/private|\/selected/);
});

test('选址取消或关闭期间迟到结果不写入，保存失败后仍可重试', async () => {
  const { state, calls, text, exportReport } = exportFixture();
  state.dialog.showSaveDialog = async () => ({ canceled: true });
  await exportReport({}, text);
  assert.equal(calls.writes.length, 0);
  state.dialog.showSaveDialog = async () => { state.closing = true; return { canceled: false, filePath: '/selected/report.json' }; };
  await exportReport({}, text);
  assert.equal(calls.writes.length, 0);
  state.closing = false;
  state.dialog.showSaveDialog = async () => ({ canceled: false, filePath: '/selected/report.json' });
  state.writeFile = async () => { throw new Error('disk full'); };
  await assert.rejects(exportReport({}, text), /disk full/);
  assert.equal(state.diagnosticExportPending, false);
  state.writeFile = async (...args) => { calls.writes.push(args); };
  await exportReport({}, text);
  assert.equal(calls.writes.length, 1);
});
