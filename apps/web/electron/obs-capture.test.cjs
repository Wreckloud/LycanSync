const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdtemp } = require('node:fs/promises');
const { once } = require('node:events');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ObsCaptureHostManager } = require('./obs-capture-host.cjs');
const deviceTestSkip = process.env.LYCANSYNC_RUN_OBS_CAPTURE_TEST === '1' ? false
  : '真实显示器及插件系统副作用测试需获得授权后设置 LYCANSYNC_RUN_OBS_CAPTURE_TEST=1';

function primaryMonitorName() {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.DeviceName'],
  { encoding: 'utf8', windowsHide: true }).trim();
}

test('OBS 真实宿主固定三槽背压、恢复和正常停止，不含 Electron 导入验收', { skip: deviceTestSkip, timeout: 35_000 }, async (context) => {
  assert.equal(process.platform, 'win32');
  const prepared = resolve(__dirname, '../../../release/build-cache/obs-32.2.2/prepared');
  const failures = [], diagnostics = [];
  const heldSlots = new Set();
  let holding = false;
  const manager = new ObsCaptureHostManager({
    executablePath: resolve(prepared, 'bin/64bit/lycansync-obs-capture-host.exe'),
    modulePath: resolve(prepared, 'obs-plugins/64bit/win-capture.dll'),
    dataPath: resolve(prepared, 'data/obs-plugins/win-capture'),
    configPath: resolve(prepared, '../test-config'),
    onFrame: (state, frame) => {
      if (holding) heldSlots.add(frame.slotIndex);
      else void state.releaseSharedTextureSlot(state.videoSessionId, frame.slotIndex).catch((error) => failures.push(error.message));
    },
    onFailure: (_state, error) => failures.push(error.message),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  const monitor = primaryMonitorName();
  try {
    for (let run = 0; run < 3; run++) {
      const sessionId = randomUUID();
      await manager.start('monitor:1:0', 60, sessionId, { kind: 'monitor', monitorName: monitor }, { hideCursor: true, hideBorder: false });
      const state = manager.state;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
      const before = await manager.getDiagnostics(sessionId);
      holding = true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
      const blocked = await manager.getDiagnostics(sessionId);
      assert.equal(heldSlots.size, 3);
      assert.ok(blocked.bridgeFrames - before.bridgeFrames <= 3);
      assert.ok(blocked.bridgeDroppedFrames > before.bridgeDroppedFrames);
      holding = false;
      for (const slot of heldSlots) await state.releaseSharedTextureSlot(sessionId, slot);
      heldSlots.clear();
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      const resumed = await manager.getDiagnostics(sessionId);
      assert.ok(resumed.bridgeFrames > blocked.bridgeFrames + 3);
      const stopStart = performance.now();
      await manager.stop(sessionId);
      assert.equal(manager.state, undefined);
      assert.equal(state.child.exitCode, 0);
      context.diagnostic(JSON.stringify({ run, actualVersion: state.helperVersion, emittedFrames: resumed.bridgeFrames,
        blockedSlotDrops: blocked.bridgeDroppedFrames - before.bridgeDroppedFrames,
        stopMs: Math.round(performance.now() - stopStart) }));
    }
    assert.deepEqual(failures, []);
    assert.ok(!diagnostics.some((line) => /Double destroy|without specifying a canvas|GpuWaitFailed|acquireTexture/.test(line)), diagnostics.join('\n'));
    context.diagnostic(JSON.stringify({ nativeWarnings: [...new Set(diagnostics)] }));
  } finally {
    if (manager.state) await manager.stop(manager.state.videoSessionId);
  }
});

test('OBS 真实来源纹理经生产入口到页面轨道，重复停止及故障后可重开', { skip: deviceTestSkip, timeout: 140_000 }, async (context) => {
  assert.equal(process.platform, 'win32');
  const projectRoot = resolve(__dirname, '../../..');
  const host = resolve(projectRoot, 'release/build-cache/obs-32.2.2/prepared/bin/64bit/lycansync-obs-capture-host.exe');
  assert.ok(existsSync(host), '先执行 native/obs-capture-host/build.ps1');
  const monitor = primaryMonitorName();
  const { build } = await import('vite');
  await build({ configFile: false, root: resolve(__dirname, 'obs-capture-smoke'), base: './',
    build: { outDir: resolve(projectRoot, 'release/build-cache/obs-32.2.2/smoke-page'), emptyOutDir: false,
      rollupOptions: { input: resolve(__dirname, 'obs-capture-smoke/renderer.html') } } });
  const profile = await mkdtemp(join(tmpdir(), 'lycan-obs-capture-test-'));
  const child = spawn(require('electron'), [`--user-data-dir=${profile}`, resolve(__dirname, 'obs-capture-smoke/main.cjs'), monitor],
    { cwd: resolve(__dirname, '..'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [], errors = [];
  child.stdout.on('data', (chunk) => { output.push(chunk); for (const line of String(chunk).trim().split('\n')) {
    if (line.includes('"phase"')) context.diagnostic(line);
  } });
  child.stderr.on('data', (chunk) => errors.push(chunk));
  let timer, forceTimer;
  try {
    timer = setTimeout(() => child.stdin.write('abort\n'), 115_000);
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 130_000);
    const [code] = await once(child, 'close');
    const text = Buffer.concat(output).toString('utf8');
    const resultLine = text.split(/\r?\n/).find((line) => line.includes('"type":"obsCaptureSmokeResult"'));
    const details = `${text}\n${Buffer.concat(errors).toString('utf8')}`;
    assert.ok(resultLine, details);
    const result = JSON.parse(resultLine);
    assert.equal(code, 0, details);
    assert.equal(result.ok, true, details);
    assert.equal(result.helperClosed, true, details);
    assert.equal(result.cases.length, process.env.LYCANSYNC_CAPTURE_RESOURCE_CHECK === '1'
      || process.env.LYCANSYNC_CAPTURE_QUALITY_CHECK === '1' || process.env.LYCANSYNC_CAPTURE_WINDOW_CHECK === '1' ? 1 : 6, details);
    if (process.env.LYCANSYNC_CAPTURE_WINDOW_CHECK === '1') {
      assert.deepEqual(result.cases[0].windowActions,
        ['same-title', 'rename-and-refresh', 'minimize', 'restore', 'stop-and-reopen', 'close-without-takeover'], details);
      assert.equal(result.cases[0].pixelsChecked, true, details);
    }
    if (process.env.LYCANSYNC_CAPTURE_QUALITY_CHECK === '1') {
      assert.deepEqual(result.cases[0].qualityChanges.map((entry) => entry.targetFps), [30, 120, 60], details);
    }
    for (const entry of result.cases.filter((entry) => entry.mode === 'success')) {
      assert.equal(entry.pixelsChecked, true, details);
      assert.equal(entry.helperExitCode, 0, details);
    }
    context.diagnostic(JSON.stringify(result));
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.write('abort\n');
      const closed = once(child, 'close');
      let forceTimer;
      try {
        // 只结束本测试创建且仍持有的进程对象，不按进程名清理其他客户端。
        forceTimer = setTimeout(() => child.kill(), 8000);
        await closed;
      } finally { clearTimeout(forceTimer); }
    }
    // 测试 profile 仅保留本机临时缓存，不保存画面；不复用真实账号目录。
    context.diagnostic(`临时测试目录：${profile}`);
  }
});
