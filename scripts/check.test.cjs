const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCheck } = require('./check.cjs');
const { spawnSync } = require('node:child_process');

function fixture(context) {
  const outputRoot = path.resolve(__dirname, '../output/check-runner-tests');
  fs.mkdirSync(outputRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(outputRoot, 'run-'));
  context.after(() => {
    if (!directory.startsWith(outputRoot + path.sep)) throw new Error('测试清理目录超出范围。');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('子进程失败保留错误日志和退出码，不能报告成功', context => {
  const directory = fixture(context);
  const result = runCheck({ name: 'failure', command: 'synthetic failure', cwd: directory,
    executable: process.execPath, args: ['-e', "console.error('expected failure'); process.exit(7)"] }, directory);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.match(fs.readFileSync(result.logPath, 'utf8'), /expected failure/);
});

test('命令缺失明确失败，测试跳过汇总和原因保留在日志', context => {
  const directory = fixture(context);
  const missing = runCheck({ name: 'missing', command: 'missing tool', cwd: directory,
    executable: path.join(directory, 'missing-tool'), args: [] }, directory);
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /ENOENT/);
  const skipped = runCheck({ name: 'skipped', command: 'synthetic summary', cwd: directory,
    executable: process.execPath, args: ['-e', "console.log('ok 1 - media # SKIP requires fixture'); console.log('# skipped 1')"] }, directory);
  assert.equal(skipped.status, 'passed');
  assert.deepEqual(skipped.summary, ['ok 1 - media # SKIP requires fixture', '# skipped 1']);
});

test('入口遇到首项失败后停止，后续检查明确标为未执行并返回非零', context => {
  const directory = fixture(context);
  const windows = process.platform === 'win32';
  fs.writeFileSync(path.join(directory, windows ? 'npm.cmd' : 'npm'),
    windows ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = directory + path.delimiter + env[pathKey];
  const result = spawnSync(process.execPath, [path.join(__dirname, 'check.cjs')], {
    cwd: directory, env, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 1, result.stderr);
  const reportPath = result.stdout.match(/汇总：([^\r\n]+)/)?.[1];
  assert.ok(reportPath, result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.checks[0].exitCode, 7);
  assert.deepEqual(report.checks.map(check => check.status), ['failed', 'not-run', 'not-run', 'not-run']);
});
