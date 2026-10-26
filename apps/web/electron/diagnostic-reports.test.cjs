const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { createDiagnosticReportStore, parseDiagnosticReport } = require('./diagnostic-reports.cjs');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

async function fixture(context) {
  const base = resolve(__dirname, '../../../release/test-cache/diagnostics');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'saved-report-'));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  return { directory, store: createDiagnosticReportStore(directory) };
}

function report(version) {
  return JSON.stringify({ kind: 'lycansync-diagnostics', schemaVersion: 9,
    startedAt: '2026-10-26T00:00:00Z', endedAt: '2026-10-26T00:01:00Z',
    runtime: { clientVersion: version }, samples: [{ streams: [] }], notes: '',
    events: [{ stage: 'screenVideoPublished' }] });
}

test('重新打开只读设置不覆盖上次使用，本次连续快照只轮转一次', async (context) => {
  const { directory, store } = await fixture(context);
  const first = JSON.stringify({ ...JSON.parse(report('first')), notes: '测试字节大小' }, null, 2);
  assert.equal(await store.save(first), Buffer.byteLength(first));
  const reopened = createDiagnosticReportStore(directory);
  assert.equal((await reopened.info()).clientVersion, 'first');
  assert.equal((await reopened.info()).bytes, Buffer.byteLength(first));
  assert.equal((await createDiagnosticReportStore(directory).info()).clientVersion, 'first');
  await reopened.save(report('second'));
  await reopened.save(report('second-latest'));
  assert.equal((await reopened.previous()).runtime.clientVersion, 'first');
  const afterExit = createDiagnosticReportStore(directory);
  assert.equal((await afterExit.previous()).runtime.clientVersion, 'second-latest');
  assert.deepEqual((await afterExit.previous()).events, [{ stage: 'screenVideoPublished' }]);
});

test('中断写入不读取半份文件，主文件缺失时仍保留上一份有效报告', async (context) => {
  const { directory, store } = await fixture(context);
  await store.save(report('retained'));
  await rename(join(directory, 'current.json'), join(directory, 'previous.json'));
  await writeFile(join(directory, 'current.pending'), '{incomplete');
  const reopened = createDiagnosticReportStore(directory);
  assert.equal((await reopened.previous()).runtime.clientVersion, 'retained');
  await reopened.save(report('new'));
  assert.equal((await reopened.previous()).runtime.clientVersion, 'retained');
});

test('无效或过大报告不覆盖文件，损坏旧文件明确失败而不覆盖有效历史', async (context) => {
  const { directory, store } = await fixture(context);
  await store.save(report('retained'));
  assert.throws(() => store.save('{}'), /无效/);
  assert.throws(() => store.save('x'.repeat(8 * 1024 * 1024 + 1)), /过大/);
  assert.throws(() => store.save(report('bad').replace('"schemaVersion":9', '"schemaVersion":8')), /无效/);
  const reopened = createDiagnosticReportStore(directory);
  await reopened.save(report('current'));
  await writeFile(join(directory, 'current.json'), '{broken');
  const afterCorruption = createDiagnosticReportStore(directory);
  await assert.rejects(afterCorruption.previous(), /无法读取/);
  await assert.rejects(afterCorruption.save(report('replacement')), /无法读取/);
  assert.equal(JSON.parse(await readFile(join(directory, 'previous.json'), 'utf8')).runtime.clientVersion, 'retained');
});

test('清除排在在途保存之后，不会被旧写入恢复，清除后可重新记录', async (context) => {
  const { directory, store } = await fixture(context);
  await writeFile(join(directory, 'user-export.json'), 'manual report');
  const saving = store.save(report('old'));
  const clearing = store.clear();
  await Promise.all([saving, clearing]);
  assert.equal(await createDiagnosticReportStore(directory).info(), null);
  assert.equal(await readFile(join(directory, 'user-export.json'), 'utf8'), 'manual report');
  await store.save(report('fresh'));
  assert.equal(await store.previous(), null);
  assert.equal((await createDiagnosticReportStore(directory).previous()).runtime.clientVersion, 'fresh');
});

function ipcFixture() {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('diagnostics:checkpoint'");
  const end = source.indexOf("ipcMain.handle('diagnostics:export'", start);
  const handlers = new Map();
  const saved = [], writes = [], exportDirectories = [], dialogOptions = [], failures = [];
  let cleared = 0;
  const state = { closing: false, allowQuitAfterMediaHelper: false, diagnosticExportPending: false,
    diagnosticReportsGeneration: 0, diagnosticStartedAt: Date.parse('2026-10-26T00:00:00Z'),
    trustedSender: event => event.trusted, parseDiagnosticReport,
    writeMediaDiagnostic: Object.assign(async entry => failures.push(entry), { flush: async () => {} }),
    Date, JSON, Error, resolve, mainWindow: {},
    process: { platform: 'win32', arch: 'x64', versions: { electron: 'current-electron' } }, osRelease: () => 'current-os',
    app: { getPath: () => '/private', getVersion: () => 'current-version', getGPUFeatureStatus: () => ({}) },
    readDiagnosticEvents: async () => [{ stage: 'current-start' }],
    savedDiagnosticReports: { save: async text => { saved.push(JSON.parse(text)); return Buffer.byteLength(text); }, info: async () => null,
      previous: async () => ({ ...JSON.parse(report('old-version')), environment: { appVersion: 'old-version' },
        events: [{ stage: 'old-start' }] }), clear: async () => { cleared++; } },
    mkdir: async directory => exportDirectories.push(directory),
    dialog: { showSaveDialog: async (_window, options) => {
      dialogOptions.push(options); return { canceled: false, filePath: '/selected/report.json' };
    } },
    writeFile: async (path, text) => writes.push({ path, report: JSON.parse(text) }),
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
  };
  runInNewContext(source.slice(start, end), state);
  return { state, handlers, saved, writes, exportDirectories, dialogOptions, failures, cleared: () => cleared };
}

test('保存只接受可信页面且不落盘体验说明，上次导出不混入本次环境或事件', async () => {
  const { handlers, saved, writes, exportDirectories, dialogOptions } = ipcFixture();
  const checkpoint = handlers.get('diagnostics:checkpoint');
  await assert.rejects(checkpoint({ trusted: false }, report('test')), /不能保存/);
  await assert.rejects(checkpoint({ trusted: true }, '{}'), /无效/);
  const text = JSON.stringify({ ...JSON.parse(report('new-version')), notes: 'private feedback' });
  const bytes = await checkpoint({ trusted: true }, text);
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(saved[0])));
  assert.equal(saved[0].notes, '');
  assert.equal(saved[0].environment.appVersion, 'current-version');
  await handlers.get('diagnostics:export-saved')({ trusted: true }, '补充体验');
  assert.equal(writes[0].report.environment.appVersion, 'old-version');
  assert.deepEqual(writes[0].report.events, [{ stage: 'old-start' }]);
  assert.equal(writes[0].report.notes, '补充体验');
  assert.equal(exportDirectories[0], resolve('/private', 'exports'));
  assert.equal(dialogOptions[0].defaultPath, resolve('/private', 'exports', `LycanSync-diagnostics-${Date.parse('2026-10-26T00:01:00Z')}.json`));
});

test('清除使尚在补齐事件的旧快照失效，清除后不会被迟到结果写回', async () => {
  const { state, handlers, saved, cleared } = ipcFixture();
  let finish;
  let entered;
  const reading = new Promise(resolveEntered => { entered = resolveEntered; });
  state.readDiagnosticEvents = () => new Promise(resolveEvents => { finish = resolveEvents; entered(); });
  const checkpoint = handlers.get('diagnostics:checkpoint')({ trusted: true }, report('old'));
  await reading;
  await handlers.get('diagnostics:clear-saved')({ trusted: true });
  finish([]);
  assert.equal(await checkpoint, null);
  assert.equal(cleared(), 1);
  assert.equal(saved.length, 0);
});

test('上次报告选址前关闭时不打开迟到对话框，取消选址不改变保存文件', async () => {
  const { state, handlers, writes } = ipcFixture();
  let dialogs = 0;
  state.dialog.showSaveDialog = async () => { dialogs++; return { canceled: true }; };
  await handlers.get('diagnostics:export-saved')({ trusted: true }, '');
  assert.equal(dialogs, 1);
  assert.equal(writes.length, 0);
  state.mkdir = async () => { state.closing = true; };
  await handlers.get('diagnostics:export-saved')({ trusted: true }, '');
  assert.equal(dialogs, 1);
  assert.equal(writes.length, 0);
});

test('自动保存失败明确拒绝并留下固定存储原因，不把磁盘错误伪报成功', async () => {
  const { state, handlers, failures } = ipcFixture();
  state.savedDiagnosticReports.save = async () => { throw Object.assign(new Error('private-path'), { code: 'ENOSPC' }); };
  await assert.rejects(handlers.get('diagnostics:checkpoint')({ trusted: true }, report('current')), /private-path/);
  assert.deepEqual(JSON.parse(JSON.stringify(failures)), [{ stage: 'diagnosticSnapshotFailed', storageError: 'ENOSPC' }]);
});
