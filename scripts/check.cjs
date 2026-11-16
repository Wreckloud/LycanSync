const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function runCheck(check, directory) {
  const logPath = path.join(directory, `${check.name}.log`);
  const descriptor = fs.openSync(logPath, 'wx');
  const startedAt = Date.now();
  let result;
  try {
    result = spawnSync(check.executable, check.args, {
      cwd: check.cwd, windowsHide: true, stdio: ['ignore', descriptor, descriptor],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
  } finally { fs.closeSync(descriptor); }
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  return {
    name: check.name, command: check.command, logPath,
    status: !result.error && result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status, signal: result.signal, error: result.error?.message,
    durationMs: Date.now() - startedAt,
    summary: lines.filter(line => /Test Files|Tests\s+\d|Tests run:|# (tests|pass|fail|skipped)|# SKIP|BUILD (SUCCESS|FAILURE)/.test(line)),
  };
}

function main() {
  const root = path.resolve(__dirname, '..');
  const startedAt = new Date().toISOString();
  const outputRoot = path.join(root, 'output/checks');
  fs.mkdirSync(outputRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(outputRoot, 'run-'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/package.json'), 'utf8')).version;
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const changes = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (revision.status !== 0 || changes.status !== 0) throw new Error('无法读取 Git 基线。');
  fs.mkdirSync(path.join(root, 'services/api/target/check-temp'), { recursive: true });
  const commands = [
    ['web-tests', 'apps/web', 'npm run test -- --reporter=dot'],
    ['electron-tests', 'apps/web', 'npm run test:electron-unit'],
    // 临时文件留在构建目录，不依赖系统临时目录的清理权限。
    ['api-tests', 'services/api', 'mvn -B -ntp -DargLine=-Djava.io.tmpdir=target/check-temp test'],
    ['web-build', 'apps/web', 'npm run build'],
  ];
  const report = { version, revision: revision.stdout.trim(), dirty: Boolean(changes.stdout.trim()),
    startedAt, status: 'running', checks: [],
    excluded: ['数据库集成 verify', '浏览器与桌面流程', '原生编译', '真实媒体与系统输入', '安装升级'] };
  const reportPath = path.join(directory, 'summary.json');
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  for (const [name, relativeDirectory, command] of commands) {
    if (report.status === 'failed') {
      report.checks.push({ name, command, status: 'not-run' });
      continue;
    }
    console.log(`正在检查 ${name}：${command}`);
    const check = runCheck({ name, command, cwd: path.join(root, relativeDirectory),
      executable: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      args: process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command] }, directory);
    if (name === 'api-tests') {
      const reports = path.join(root, 'services/api/target/surefire-reports');
      check.skippedReports = fs.existsSync(reports) ? fs.readdirSync(reports)
        .filter(file => /^TEST-.*Tests\.xml$/.test(file))
        .map(file => path.join(reports, file))
        .filter(file => fs.statSync(file).mtimeMs >= Date.parse(startedAt))
        .map(file => ({ report: path.basename(file),
          reasons: Array.from(fs.readFileSync(file, 'utf8').matchAll(/<skipped\b[^>]*message="([^"]*)"/g), match => match[1]) }))
        .filter(report => report.reasons.length) : [];
    }
    report.checks.push(check);
    console.log(`${check.status} (${Math.round(check.durationMs / 1000)} 秒)：${check.logPath}`);
    if (check.summary.length) console.log(check.summary.join('\n'));
    if (check.status === 'failed') {
      report.status = 'failed';
      console.error(check.error || fs.readFileSync(check.logPath, 'utf8').split(/\r?\n/).slice(-20).join('\n'));
    }
    save();
  }
  report.status = report.status === 'failed' ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`基础检查${report.status === 'passed' ? '通过' : '失败'}，汇总：${reportPath}`);
  console.log('跳过原因见各项日志；未执行的专项验收见汇总 excluded，基础检查不代表实机验收。');
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

module.exports = { runCheck };
if (require.main === module) main();
