const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { compactSavedSamples, createDiagnosticReportStore, parseDiagnosticReport, prepareCheckpoint, validateReportText, receivedReportPath, reportIdPattern } = require('./diagnostic-reports.cjs');
const { createDiagnosticCopies } = require('./diagnostic-copies.cjs');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

async function fixture(context) {
  const base = resolve(__dirname, '../../../release/test-cache/diagnostics');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'saved-report-'));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  return { directory, store: createDiagnosticReportStore(directory) };
}

function savedReport(version) {
  return { kind: 'lycansync-diagnostics', schemaVersion: 9,
    startedAt: '2026-10-26T00:00:00Z', endedAt: '2026-10-26T00:01:00Z',
    runtime: { clientVersion: version }, samples: [{ streams: [] }], notes: '',
    events: [{ stage: 'screenVideoPublished' }] };
}

function report(version) { return JSON.stringify(savedReport(version)); }

test('新回放报告使用 schema 10，已有 schema 9 报告仍能保留并导出', async context => {
  const f = await fixture(context);
  await writeFile(join(f.directory, 'current.json'), report('previous'));
  const current = report('current').replace('"schemaVersion":9', '"schemaVersion":10');
  await f.store.save(JSON.parse(current));
  const { previous } = (await f.store.all()).reports;
  assert.equal(previous.schemaVersion, 9);
  assert.equal(previous.runtime.clientVersion, 'previous');
  assert.equal(parseDiagnosticReport(current).schemaVersion, 10);
});

function screenReport(version, lastActiveAt, ended = false) {
  const sample = { time: lastActiveAt, streams: [{ member: 'member-1', direction: '发送', sourceFps: 60 }] };
  return { ...savedReport(version), endedAt: '2026-10-26T00:10:00Z',
    samples: ended ? [sample, { time: '2026-10-26T00:10:00Z', streams: [] }] : [sample] };
}

test('重启后优先显示带有较新问题标记的报告，不能总被旧共享报告遮住', async context => {
  const f = await fixture(context);
  await f.store.save(screenReport('old-screen', '2026-10-26T00:05:00Z', true));
  const marked = { ...JSON.parse(report('marked-voice')), schemaVersion: 12, endedAt: '2026-10-26T00:15:00Z',
    problemMarkers: [{ time: '2026-10-26T00:14:00Z', category: 'no-audio', recording: true }] };
  await f.store.save(marked);
  const restarted = createDiagnosticReportStore(f.directory);
  const { current: previous } = (await restarted.all()).reports;
  assert.equal((await restarted.info()).clientVersion, 'marked-voice');
  assert.equal(previous.runtime.clientVersion, 'marked-voice');
  assert.deepEqual(previous.problemMarkers, marked.problemMarkers);
  assert.throws(() => parseDiagnosticReport(JSON.stringify({ ...marked, problemMarkers: 'invalid' })), /标记无效/);
  assert.throws(() => parseDiagnosticReport(JSON.stringify({ ...marked, problemMarkers: Array(101).fill(marked.problemMarkers[0]) })), /标记无效/);
});

test('共享结束固定完整窗口，随后闲置、裁剪窗口及重启不会冲掉性能证据', async context => {
  const { directory, store } = await fixture(context);
  await store.save(screenReport('screen-session', '2026-10-26T00:01:00Z'));
  await store.save(screenReport('screen-session', '2026-10-26T00:02:00Z', true));
  const path = join(directory, 'last-screen-usage.json');
  const retained = await readFile(path, 'utf8');
  assert.equal((await store.info()).kind, 'screen-media');
  await store.save(screenReport('trimmed-window', '2026-10-26T00:02:00Z', true));
  await store.save(savedReport('idle-no-screen'));
  assert.equal(await readFile(path, 'utf8'), retained);
  const reopened = createDiagnosticReportStore(directory);
  assert.equal((await reopened.info()).clientVersion, 'screen-session');
  assert.equal((await reopened.all()).reports.lastScreenUsage.samples[0].streams[0].sourceFps, 60);
  assert.equal((await reopened.info()).bytes, Buffer.byteLength(retained));
});

test('后续画面使用结束替换固定窗口，清理不留下副本或删除手动导出', async context => {
  const { directory, store } = await fixture(context);
  await store.save(screenReport('first', '2026-10-26T00:01:00Z', true));
  await store.save(screenReport('second', '2026-10-26T00:03:00Z'));
  assert.equal((await store.info()).clientVersion, 'first');
  await store.save(screenReport('second', '2026-10-26T00:04:00Z', true));
  assert.equal((await store.info()).clientVersion, 'second');
  await writeFile(join(directory, 'manual-export.json'), 'keep');
  await store.clear();
  assert.equal(await createDiagnosticReportStore(directory).info(), null);
  await assert.rejects(readFile(join(directory, 'last-screen-usage.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'manual-export.json'), 'utf8'), 'keep');
});

test('画面尚在运行时异常退出，下一启动的空闲快照先保留旧使用证据', async context => {
  const { directory, store } = await fixture(context);
  await store.save(screenReport('interrupted', '2026-10-26T00:05:00Z'));
  const reopened = createDiagnosticReportStore(directory);
  await reopened.save(savedReport('new-idle-run'));
  await reopened.save(savedReport('new-idle-run-later'));
  const afterAnotherExit = createDiagnosticReportStore(directory);
  assert.equal((await afterAnotherExit.info()).clientVersion, 'interrupted');
  assert.equal((await afterAnotherExit.info()).kind, 'screen-media');
});

test('重新打开只读设置不覆盖上次使用，本次连续快照只轮转一次', async (context) => {
  const { directory, store } = await fixture(context);
  const first = { ...savedReport('first'), notes: '测试字节大小' };
  assert.equal(await store.save(first), Buffer.byteLength(JSON.stringify(first)));
  const reopened = createDiagnosticReportStore(directory);
  assert.equal((await reopened.info()).clientVersion, 'first');
  assert.equal((await reopened.info()).bytes, Buffer.byteLength(JSON.stringify(first)));
  assert.equal((await createDiagnosticReportStore(directory).info()).clientVersion, 'first');
  await reopened.save(savedReport('second'));
  await reopened.save(savedReport('second-latest'));
  assert.equal((await reopened.info()).clientVersion, 'first');
  const afterExit = createDiagnosticReportStore(directory);
  assert.equal((await afterExit.info()).clientVersion, 'second-latest');
  assert.deepEqual((await afterExit.all()).reports.current.events, [{ stage: 'screenVideoPublished' }]);
});

test('中断写入不读取半份文件，主文件缺失时仍保留上一份有效报告', async (context) => {
  const { directory, store } = await fixture(context);
  await store.save(savedReport('retained'));
  await rename(join(directory, 'current.json'), join(directory, 'previous.json'));
  await writeFile(join(directory, 'current.pending'), '{incomplete');
  const reopened = createDiagnosticReportStore(directory);
  assert.equal((await reopened.info()).clientVersion, 'retained');
  await reopened.save(savedReport('new'));
  assert.equal((await reopened.info()).clientVersion, 'retained');
});

test('无效或过大报告不覆盖文件，损坏旧文件明确失败而不覆盖有效历史', async (context) => {
  const { directory, store } = await fixture(context);
  await store.save(savedReport('retained'));
  assert.throws(() => store.save({}), /无效/);
  assert.throws(() => store.save({ ...savedReport('large'), events: ['测'.repeat(3 * 1024 * 1024)] }), /过大/);
  assert.throws(() => store.save({ ...savedReport('bad'), schemaVersion: 8 }), /无效/);
  const reopened = createDiagnosticReportStore(directory);
  await reopened.save(savedReport('current'));
  await writeFile(join(directory, 'current.json'), '{broken');
  const afterCorruption = createDiagnosticReportStore(directory);
  await assert.rejects(afterCorruption.info(), /无法读取/);
  await assert.rejects(afterCorruption.save(savedReport('replacement')), /无法读取/);
  assert.equal(JSON.parse(await readFile(join(directory, 'previous.json'), 'utf8')).runtime.clientVersion, 'retained');
});

test('清除排在在途保存之后，不会被旧写入恢复，清除后可重新记录', async (context) => {
  const { directory, store } = await fixture(context);
  await writeFile(join(directory, 'user-export.json'), 'manual report');
  const saving = store.save(savedReport('old'));
  const clearing = store.clear();
  await Promise.all([saving, clearing]);
  assert.equal(await createDiagnosticReportStore(directory).info(), null);
  assert.equal(await readFile(join(directory, 'user-export.json'), 'utf8'), 'manual report');
  await store.save(savedReport('fresh'));
  assert.equal(await store.info(), null);
  assert.equal((await createDiagnosticReportStore(directory).info()).clientVersion, 'fresh');
});

test('大小快照交替保存时共用历史轮换、事件过滤和退出等待；清理排在工作线程之后', async t => {
  const { directory, store } = await fixture(t);
  await store.save(savedReport('previous-session'));
  const reopened = createDiagnosticReportStore(directory);
  const data = screenReport('large', '2026-10-26T00:05:00Z', true);
  data.samples[0].padding = 'x'.repeat(600 * 1024);
  data.notes = 'private feedback';
  const text = JSON.stringify(data);
  const context = { logPath: join(directory, 'events.log'), startedAt: Date.parse(data.startedAt),
    endedAt: Date.parse(data.endedAt), environment: { platform: 'win32' }, persistence: { savedAt: data.endedAt } };
  await writeFile(context.logPath, [
    JSON.stringify({ time: data.startedAt, stage: 'screenVideoPublished', message: 'private-path' }),
    JSON.stringify({ time: '2026-10-27T00:00:00Z', stage: 'outside' }),
  ].join('\n'));
  const saving = reopened.checkpoint(text, context);
  await reopened.flush();
  assert.equal(await saving, Buffer.byteLength(await readFile(join(directory, 'current.json'), 'utf8')));
  await reopened.checkpoint(report('small'), context);
  const { reports } = await reopened.all();
  assert.equal(reports.previous.runtime.clientVersion, 'previous-session');
  assert.equal(reports.current.runtime.clientVersion, 'small');
  assert.deepEqual(reports.lastScreenUsage.samples, data.samples);
  assert.equal(reports.lastScreenUsage.notes, '');
  assert.deepEqual(reports.lastScreenUsage.events.map(event => event.stage), ['screenVideoPublished']);
  assert.ok(!JSON.stringify(reports.lastScreenUsage.events).includes('private-path'));
  assert.deepEqual(reports.lastScreenUsage.environment, context.environment);
  await mkdir(join(directory, 'current.pending'));
  await assert.rejects(reopened.checkpoint(text, context), error => ['EISDIR', 'EPERM', 'EACCES'].includes(error.code));
  assert.equal((await reopened.all()).reports.current.runtime.clientVersion, 'small');
  await rm(join(directory, 'current.pending'), { recursive: true });
  await Promise.all([reopened.checkpoint(text, context), reopened.clear()]);
  assert.deepEqual((await reopened.all()).reports, {});
});

function ipcFixture() {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("ipcMain.handle('diagnostics:checkpoint'");
  const end = source.indexOf("ipcMain.handle('presence:system-idle-state'", start);
  const handlers = new Map();
  const saved = [], writes = [], exportDirectories = [], dialogOptions = [], failures = [];
  let cleared = 0;
  const state = { closing: false, allowQuitAfterMediaHelper: false, diagnosticExportPending: false,
    diagnosticReportsGeneration: 0, diagnosticStartedAt: Date.parse('2026-10-26T00:00:00Z'),
    saveDirectories: { exportDirectory: async () => resolve('/private', 'exports') },
    gzipReport: require('node:util').promisify(require('node:zlib').gzip),
    trustedSender: event => event.trusted, parseDiagnosticReport, validateReportText, compactSavedSamples,
    writeMediaDiagnostic: Object.assign(async entry => failures.push(entry), { flush: async () => {} }),
    Date, JSON, Error, resolve, mainWindow: {}, sessionRevision: 1, AbortController, diagnosticFileTask: undefined,
    diagnosticCopies: { async submit(json, check) { check(); const path = '/managed/report.json'; await state.writeFile(path, json); return path; } },
    process: { platform: 'win32', arch: 'x64', versions: { electron: 'current-electron' } }, osRelease: () => 'current-os',
    app: { getPath: () => '/private', getVersion: () => 'current-version', getGPUFeatureStatus: () => ({}) },
    readDiagnosticEvents: async () => [{ stage: 'current-start' }],
    savedDiagnosticReports: { async checkpoint(text, context) {
      const report = await prepareCheckpoint(text, { ...context, logPath: join(__dirname, 'nonexistent-fixture.log') });
      saved.push(report); return Buffer.byteLength(JSON.stringify(report));
    }, info: async () => null,
      all: async () => ({ reports: { previous: { ...JSON.parse(report('old-version')), environment: { appVersion: 'old-version' },
        events: [{ stage: 'old-start' }] } }, unavailable: [] }), clear: async () => { cleared++; } },
    mkdir: async directory => exportDirectories.push(directory),
    dialog: { showSaveDialog: async (_window, options) => {
      dialogOptions.push(options); return { canceled: false, filePath: '/selected/report.json' };
    } },
    writeFile: async (path, text) => writes.push({ path, report: JSON.parse(text) }),
    ipcMain: { on: (name, callback) => handlers.set(name, callback), handle: (name, callback) => handlers.set(name, callback) },
  };
  runInNewContext(source.slice(start, end), state);
  return { state, handlers, saved, writes, exportDirectories, dialogOptions, failures, cleared: () => cleared };
}

test('主动上传将同一份完整报告保存到默认目录，无需选择位置', async () => {
  const f = ipcFixture();
  const result = await f.handlers.get('diagnostics:prepare-upload')({ trusted: true }, report('new-version'));
  const body = JSON.parse(require('node:zlib').gunzipSync(result.gzip));
  assert.equal(body.kind, 'lycansync-diagnostics');
  assert.equal(body.savedReports.previous.environment.appVersion, 'old-version');
  assert.equal(body.events[0].stage, 'current-start');
  assert.equal(f.writes.length, 1);
  assert.equal(result.filePath, f.writes[0].path);
  assert.deepEqual(f.writes[0].report, body);
  assert.equal(f.dialogOptions.length, 0);
});

test('合并导出可逐条还原重叠窗口和旧版快照，同一时刻不同内容分别保留', async () => {
  const f = ipcFixture();
  const first = { time: '2026-10-26T00:00:01Z', audio: [{ packetsLost: 4 }] };
  const second = { time: '2026-10-26T00:00:03Z', audio: [] };
  const changed = { ...first, audio: [{ packetsLost: null }] };
  const top = { ...savedReport('new'), schemaVersion: 15, samples: [second] };
  const reports = { current: { ...savedReport('new'), samples: [first, second] },
    previous: { ...savedReport('old'), samples: [changed, second] },
    lastScreenUsage: { ...savedReport('old'), samples: [changed, first, second], persistence: { retainedScreenUsage: true } } };
  f.state.savedDiagnosticReports.all = async () => ({ reports, unavailable: [] });
  const result = await f.handlers.get('diagnostics:prepare-upload')({ trusted: true }, JSON.stringify(top));
  const bundle = JSON.parse(require('node:zlib').gunzipSync(result.gzip));
  assert.deepEqual(bundle, f.writes[0].report);
  assert.deepEqual(bundle.savedReports.previous.samples[0], changed);
  assert.deepEqual(bundle.savedReports.lastScreenUsage.samples, [
    { $ref: '#/savedReports/previous/samples/0' }, { $ref: '#/savedReports/current/samples/0' }, { $ref: '#/samples/0' }]);
  for (const [key, saved] of Object.entries(bundle.savedReports)) {
    const samples = saved.samples.map(sample => sample.$ref
      ? sample.$ref.slice(2).split('/').reduce((value, field) => value[field], bundle) : sample);
    assert.deepEqual({ ...saved, samples }, reports[key]);
  }
});

test('本地副本无法写入时仍能上传，并明确返回保存结果', async () => {
  const f = ipcFixture();
  f.state.writeFile = async () => { throw new Error('disk full'); };
  const result = await f.handlers.get('diagnostics:prepare-upload')({ trusted: true }, report('current'));
  assert.equal(result.filePath, null);
  assert.equal(JSON.parse(require('node:zlib').gunzipSync(result.gzip)).kind, 'lycansync-diagnostics');
});

test('报告只有打开时才下载，重复打开复用本地文件，删除后不再自动写回', async t => {
  const { directory } = await fixture(t);
  const f = ipcFixture();
  const id = '30122072-cabb-4be1-89ab-a49351c83457';
  const json = report('联测');
  const entry = { id, userId: '640d8632-a8af-44dc-ad96-15418a6b2f51', uploadedAt: '2026-11-26T20:30:00Z', byteSize: Buffer.byteLength(json) };
  let downloads = 0, revealed, short = false, allowed = true;
  const copies = createDiagnosticCopies(directory);
  Object.assign(f.state, { APP_ORIGIN: 'lycan://app', AbortSignal, Request, reportIdPattern, diagnosticCopies: copies,
    shell: { showItemInFolder: path => { revealed = path; } },
    serveApplication: async request => {
      if (!allowed) return new Response(null, { status: 403 });
      if (request.url.endsWith('/reports')) return Response.json([entry]);
      assert.ok(request.url.endsWith('/' + id)); downloads++; return new Response(short ? '{' : json);
    } });
  const file = action => f.handlers.get('diagnostics:file')({ trusted: true }, id, action);
  await file('open'); await file('open');
  assert.equal(downloads, 1); assert.equal(await readFile(revealed, 'utf8'), json);
  const old = receivedReportPath(join(directory, 'exports', 'received'), id);
  await writeFile(old, json);
  allowed = false; await assert.rejects(file('delete'), /权限/); allowed = true;
  await file('delete'); assert.equal(await copies.locate(entry), null);
  await copies.clean(); assert.equal(downloads, 1);
  short = true; await assert.rejects(file('open'), /完整下载/); assert.equal(await copies.locate(entry), null);
  await assert.rejects(f.handlers.get('diagnostics:file')({ trusted: false }, id, 'open'), /无效/);
  await writeFile(old, json); await file('open'); assert.equal(revealed, old); assert.equal(downloads, 2);
});

test('自动副本按三天和合计容量清理，保护导出、未知文件和其他目录', async t => {
  const { directory } = await fixture(t);
  const copies = createDiagnosticCopies(directory);
  const { utimes, truncate, symlink } = require('node:fs/promises');
  const make = () => copies.submit('{}', () => {});
  const first = await make(), second = await make();
  await truncate(first, 70 * 1024 * 1024);
  await truncate(second, 70 * 1024 * 1024);
  const yesterday = new Date(Date.now() - 86400000);
  await utimes(first, yesterday, yesterday);
  await copies.clean(); await assert.rejects(readFile(first), { code: 'ENOENT' });
  const old = new Date(Date.now() - 4 * 86400000);
  await utimes(second, old, old);
  const managed = join(directory, 'diagnostics', 'submitted');
  const other = join(managed, 'keep.json'); await writeFile(other, 'keep'); await utimes(other, old, old);
  const exported = join(directory, 'exports'); await mkdir(exported, { recursive: true });
  const manual = join(exported, 'LycanSync-diagnostics-12345.json'); await writeFile(manual, 'manual'); await utimes(manual, old, old);
  const archive = join(exported, 'received'); await mkdir(archive);
  const userFolder = join(archive, '217e00df-f909-4cde-a9a8-dcd2a44ab151');
  await mkdir(userFolder);
  const misplaced = receivedReportPath(userFolder, '640d8632-a8af-44dc-ad96-15418a6b2f51');
  await writeFile(misplaced, 'keep'); await utimes(misplaced, old, old);
  const external = join(directory, 'external'); await mkdir(external);
  const outside = receivedReportPath(external, '640d8632-a8af-44dc-ad96-15418a6b2f51'); await writeFile(outside, 'outside'); await utimes(outside, old, old);
  await symlink(external, join(archive, '640d8632-a8af-44dc-ad96-15418a6b2f51'), process.platform === 'win32' ? 'junction' : 'dir');
  await copies.clean();
  await assert.rejects(readFile(second), { code: 'ENOENT' });
  assert.equal(await readFile(other, 'utf8'), 'keep'); assert.equal(await readFile(manual, 'utf8'), 'manual');
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  assert.equal(await readFile(misplaced, 'utf8'), 'keep');
});

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
  const result = await handlers.get('diagnostics:export')({ trusted: true }, text);
  assert.equal(result.filePath, writes[0].path);
  assert.equal(writes[0].report.environment.appVersion, 'current-version');
  assert.deepEqual(writes[0].report.events, [{ stage: 'current-start' }]);
  assert.equal(writes[0].report.notes, 'private feedback');
  const prior = writes[0].report.savedReports.previous;
  assert.equal(prior.environment.appVersion, 'old-version');
  assert.deepEqual(prior.events, [{ stage: 'old-start' }]);
  assert.equal(exportDirectories[0], resolve('/private', 'exports'));
  assert.equal(dialogOptions.length, 0);
});

test('清除使尚在等待事件落盘的旧快照失效，清除后不会被迟到结果写回', async () => {
  const { state, handlers, saved, cleared } = ipcFixture();
  let finish;
  let entered;
  const reading = new Promise(resolveEntered => { entered = resolveEntered; });
  state.writeMediaDiagnostic.flush = () => new Promise(resolveEvents => { finish = resolveEvents; entered(); });
  const checkpoint = handlers.get('diagnostics:checkpoint')({ trusted: true }, report('old'));
  await reading;
  await handlers.get('diagnostics:clear-saved')({ trusted: true });
  finish([]);
  assert.equal(await checkpoint, null);
  assert.equal(cleared(), 1);
  assert.equal(saved.length, 0);
});

test('合并导出读取三种已保存的快照，单份损坏时保留其余内容', async context => {
  const { directory, store } = await fixture(context);
  await store.save(screenReport('screen', '2026-10-26T00:05:00Z', true));
  await createDiagnosticReportStore(directory).save(savedReport('second'));
  const { reports, unavailable } = await store.all();
  assert.deepEqual(unavailable, []);
  assert.equal(reports.current.runtime.clientVersion, 'second');
  assert.equal(reports.previous.runtime.clientVersion, 'screen');
  assert.equal(reports.lastScreenUsage.persistence.retainedScreenUsage, true);
  await writeFile(join(directory, 'current.json'), '{broken');
  const partial = await store.all();
  assert.deepEqual(partial.unavailable, ['current']);
  assert.deepEqual(Object.keys(partial.reports), ['previous', 'lastScreenUsage']);
});

test('自动保存失败明确拒绝并留下固定存储原因，不把磁盘错误伪报成功', async () => {
  const { state, handlers, failures } = ipcFixture();
  state.savedDiagnosticReports.checkpoint = async () => { throw Object.assign(new Error('private-path'), { code: 'ENOSPC' }); };
  await assert.rejects(handlers.get('diagnostics:checkpoint')({ trusted: true }, report('current')), /private-path/);
  assert.deepEqual(JSON.parse(JSON.stringify(failures)), [{ stage: 'diagnosticSnapshotFailed', storageError: 'ENOSPC' }]);
});


test('手动导出与自动保存共用9至15版校验，非法报告不打开保存框', async () => {
  const f = ipcFixture();
  const exportReport = f.handlers.get('diagnostics:export');
  for (const schemaVersion of [9, 10, 11, 12, 13, 14, 15]) {
    await exportReport({ trusted: true }, JSON.stringify({ ...JSON.parse(report('current')), schemaVersion }));
    assert.equal(f.writes.at(-1).report.schemaVersion, schemaVersion);
  }
  const opened = f.dialogOptions.length;
  for (const schemaVersion of [8, 16]) {
    await assert.rejects(exportReport({ trusted: true }, JSON.stringify({ ...JSON.parse(report('bad')), schemaVersion })), /无效/);
  }
  assert.equal(f.dialogOptions.length, opened);
});
