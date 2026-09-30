const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { once } = require('node:events');
const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

const electronPath = require('electron');
const appRoot = __dirname;
const helperPath = resolve(__dirname, '../../../native/media-helper/target/release/examples/shared_texture_smoke.exe');
const bridgePath = resolve(__dirname, '../../../native/media-bridge/target/x86_64-pc-windows-msvc/release/lycansync_shared_texture_bridge.dll');
const electronEntry = resolve(__dirname, 'shared-texture-smoke/main.cjs');

function runningSmokeHelperCount() {
  const output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return (output.match(/"shared_texture_smoke\.exe"/gi) || []).length;
}

test('keeps main-process shared texture handles stable across success, rejection, and helper crashes', { timeout: 100_000 }, async (t) => {
  assert.ok(existsSync(helperPath), 'build the shared_texture_smoke example in release mode first');
  assert.ok(existsSync(bridgePath), 'build the shared texture bridge in release mode first');
  const existingSmokeHelpers = runningSmokeHelperCount();

  const userDataDir = await mkdtemp(join(tmpdir(), 'lycan-shared-texture-smoke-'));
  const electron = spawn(electronPath, [
    `--user-data-dir=${userDataDir}`,
    electronEntry,
    helperPath,
    bridgePath,
  ], {
    cwd: appRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  let childClosed = false;
  electron.once('close', () => { childClosed = true; });
  electron.stdout.on('data', (chunk) => stdout.push(chunk));
  electron.stderr.on('data', (chunk) => stderr.push(chunk));
  let timer;
  let forceTimer;
  let timedOut = false;
  try {
    const exit = once(electron, 'close');
    timer = setTimeout(() => {
      timedOut = true;
      electron.stdin.write('abort\n');
      forceTimer = setTimeout(() => electron.kill(), 5_000);
    }, 90_000);
    const [code, signal] = await exit;
    assert.equal(timedOut, false, 'Electron smoke timed out and requested helper cleanup');
    const lines = Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/);
    const resultLine = lines.find((line) => line.includes('"type":"sharedTextureSmokeResult"'));
    const diagnostic = `exit=${code}; signal=${signal}; stdout=${lines.join('\n')}; stderr=${Buffer.concat(stderr).toString('utf8')}`;
    assert.ok(resultLine, diagnostic);
    assert.equal(code, 0, diagnostic);
    assert.doesNotMatch(Buffer.concat(stderr).toString('utf8'), /0xC0000005|STATUS_ACCESS_VIOLATION/i, diagnostic);

    const result = JSON.parse(resultLine);
    assert.equal(result.ok, true, diagnostic);
    assert.equal(result.cases.length, 9);
    assert.deepEqual(result.cases.map(({ mode }) => mode), [
      'success',
      'success',
      'receiver-reject',
      'receiver-reject',
      'crash-before-description',
      'crash-after-description-before-copy',
      'crash-after-copy-before-import',
      'crash-after-import-before-release-callback',
      'success',
    ]);
    for (const entry of result.cases) {
      assert.ok(Math.abs(entry.handleCount - result.baselineHandleCount) <= 2, `${entry.mode}: ${diagnostic}`);
    }
    t.diagnostic(`handle baseline ${result.baselineHandleCount}; post-case samples ${result.cases.map(({ mode, handleCount }) => `${mode}=${handleCount}`).join(', ')}`);
    assert.equal(result.cases[0].helperExitCode, 0);
    assert.equal(result.cases[2].expectedError, 'receiverRejected');
    assert.equal(result.cases[4].helperExitCode, 86);
    assert.equal(result.cases[5].helperExitCode, 87);
    assert.equal(result.cases[6].expectedError, 'crashAfterCopyBeforeImport');
    assert.equal(result.cases[7].helperExitCode, 87);
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    if (!childClosed) {
      electron.kill();
      await once(electron, 'close');
    }
    const remainingSmokeHelpers = runningSmokeHelperCount();
    await rm(userDataDir, { recursive: true, force: true });
    assert.equal(remainingSmokeHelpers, existingSmokeHelpers, 'test left a shared_texture_smoke helper process running');
  }
});
