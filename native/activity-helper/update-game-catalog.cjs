const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { readFile, writeFile, rename, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { promisify } = require('node:util');

const SOURCE_URL = 'https://discord.com/api/v10/applications/detectable';
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

function checkedText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength
      || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`无效的${label}`);
  return value.trim();
}

function executableRule(entry, role) {
  const path = checkedText(entry.name, '程序规则', 1024).replace(/^>/, '')
    .replaceAll('/', '\\').replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (/[<>:"|?*]/.test(path) || path.startsWith('\\')
      || path.split('\\').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`无效的程序路径规则：${path}`);
  }
  if (!['game', 'client', 'launcher'].includes(role)) throw new Error('无效的程序角色');
  return { path, role, ...(entry.arguments == null ? {}
    : { arguments: checkedText(entry.arguments, '参数条件', 1024) }) };
}

function buildCatalog(source, overrides) {
  if (!Array.isArray(source) || !source.length) throw new Error('游戏库必须为非空数组');
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('游戏修正必须为对象');
  }
  const games = [];
  const seen = new Set();
  const applied = new Set();
  for (const application of source) {
    const entries = application.executables?.filter((entry) => entry.os === 'win32') ?? [];
    if (!entries.length) continue;
    const id = checkedText(application.id, '游戏 ID', 32);
    if (!/^\d+$/.test(id) || seen.has(id)) throw new Error(`游戏 ID 重复或无效：${id}`);
    seen.add(id);
    const patch = overrides[id];
    if (patch) applied.add(id);
    if (patch?.disabled) continue;
    const rules = new Map();
    for (const entry of entries) {
      const rule = executableRule(entry, entry.is_launcher ? 'launcher' : 'game');
      rules.set(`${rule.path}\0${rule.arguments ?? ''}`, rule);
    }
    for (const entry of patch?.executables ?? []) {
      const rule = executableRule(entry, entry.role);
      rules.set(`${rule.path}\0${rule.arguments ?? ''}`, rule);
    }
    const installKeys = [...new Set((application.third_party_skus ?? [])
      .filter((sku) => sku.distributor === 'steam' && /^\d+$/.test(sku.id))
      .map((sku) => `steam:${sku.id}`))].sort();
    games.push({
      id,
      name: checkedText(application.name, '游戏名称', 256),
      ...(patch?.nameZhCn ? { name_zh_cn: checkedText(patch.nameZhCn, '中文名称', 80) } : {}),
      install_keys: installKeys,
      executables: [...rules.values()].sort((left, right) =>
        left.path.localeCompare(right.path, 'en')
        || (left.arguments ?? '').localeCompare(right.arguments ?? '', 'en')),
    });
  }
  for (const id of Object.keys(overrides)) {
    if (!applied.has(id)) throw new Error(`修正对应的游戏已不在上游 Windows 库中：${id}`);
  }
  if (!games.length) throw new Error('没有可用的 Windows 游戏规则');
  return games.sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

async function downloadSource() {
  // Windows 维护入口沿用系统代理；仅下载固定公开地址，不接受脚本或用户 URL。
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
      + `[Console]::Write((Invoke-WebRequest -UseBasicParsing -Uri '${SOURCE_URL}' -TimeoutSec 60).Content)`,
  ], { windowsHide: true, encoding: 'utf8', maxBuffer: MAX_SOURCE_BYTES, timeout: 70_000 });
  return stdout;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--source')) {
    throw new Error('用法：node update-game-catalog.cjs [--source 上游JSON文件]');
  }
  const content = args.length ? await readFile(args[1], 'utf8') : await downloadSource();
  if (Buffer.byteLength(content) > MAX_SOURCE_BYTES) throw new Error('游戏库超出大小限制');
  const overrides = JSON.parse(await readFile(join(__dirname, 'resources/game-overrides.json'), 'utf8'));
  const games = buildCatalog(JSON.parse(content.replace(/^\uFEFF/, '')), overrides);
  const source = { url: SOURCE_URL, sha256: createHash('sha256').update(content).digest('hex') };
  const snapshot = `{"schema_version":1,"source":${JSON.stringify(source)},"games":[\n${games.map((game) => JSON.stringify(game)).join(',\n')}\n]}\n`;
  const target = join(__dirname, 'resources/games.json');
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, snapshot, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`已更新 ${games.length} 个游戏，${games.filter((game) => game.name_zh_cn).length} 个中文名称。`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { buildCatalog };
