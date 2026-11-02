const { readFile, writeFile, rename, rm } = require('node:fs/promises');
const { join } = require('node:path');

function chineseName(value) {
  return typeof value === 'string' && value.trim().length <= 80
    && /\p{Script=Han}/u.test(value) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : null;
}

function buildNames(steam, bindings) {
  if (!Array.isArray(steam) || !steam.length || !Array.isArray(bindings) || !bindings.length) {
    throw new Error('中文名称来源为空或格式无效');
  }
  const names = {};
  const wiki = new Map();
  for (const row of bindings) {
    const id = row.steam?.value;
    const entity = row.item?.value;
    const language = row.name?.['xml:lang'];
    const name = chineseName(row.name?.value);
    if (!/^\d+$/.test(id) || !/^https?:\/\/www.wikidata.org\/entity\/Q\d+$/.test(entity)
        || !['zh-hans', 'zh-cn', 'zh'].includes(language) || !name) continue;
    const candidates = wiki.get(id) ?? [];
    candidates.push({ name, entity, rank: ['zh-hans', 'zh-cn', 'zh'].indexOf(language) });
    wiki.set(id, candidates);
  }
  let conflicts = 0;
  for (const [id, candidates] of wiki) {
    // 同一 AppID 对应多个实体时不猜版本；简体标签优先于未指定字形的中文标签。
    const bestRank = Math.min(...candidates.map((entry) => entry.rank));
    const preferred = candidates.filter((entry) => entry.rank === bestRank);
    if (new Set(candidates.map((entry) => entry.entity)).size !== 1
        || new Set(preferred.map((entry) => entry.name)).size !== 1) {
      conflicts++;
      continue;
    }
    names[`steam:${id}`] = { name: preferred[0].name, source: 'wikidata',
      reference: preferred[0].entity.replace('http:', 'https:') };
  }
  const seen = new Set();
  for (const entry of steam) {
    if (!Number.isSafeInteger(entry.appid) || entry.appid <= 0 || seen.has(entry.appid)
        || !Number.isInteger(entry.success)) throw new Error('Steam 名称响应的 AppID 或状态无效');
    seen.add(entry.appid);
    const name = entry.success === 1 ? chineseName(entry.name) : null;
    if (name) names[`steam:${entry.appid}`] = { name, source: 'steam',
      reference: `https://store.steampowered.com/app/${entry.appid}/?l=schinese` };
  }
  if (!Object.keys(names).length) throw new Error('未获取到有效中文名称，不替换现有名称库');
  return { schema_version: 1, sources: {
    steam: { url: 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/', language: 'schinese',
      queried_apps: steam.length, unavailable_apps: steam.filter((entry) => entry.success !== 1).length },
    wikidata: { url: 'https://query.wikidata.org/sparql', property: 'P1733', license: 'CC0',
      rows: bindings.length, conflicting_appids: conflicts },
  }, names: Object.fromEntries(Object.entries(names).sort(([left], [right]) => left.localeCompare(right, 'en'))) };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('请提供名称采集缓存目录');
  const cache = process.argv[2];
  const steam = JSON.parse(await readFile(join(cache, 'steam.json'), 'utf8'));
  const wiki = JSON.parse(await readFile(join(cache, 'wikidata.json'), 'utf8'));
  const snapshot = buildNames(Object.values(steam), wiki.results?.bindings);
  const target = join(__dirname, 'resources/game-names.json');
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const { names, ...metadata } = snapshot;
    const rows = Object.entries(names).map(([key, entry]) => `${JSON.stringify(key)}:${JSON.stringify(entry)}`);
    await writeFile(temporary, `${JSON.stringify(metadata).slice(0, -1)},"names":{\n${rows.join(',\n')}\n}}\n`, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`已生成 ${Object.keys(snapshot.names).length} 个按 AppID 关联的中文名称。`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildNames };
