const { existsSync, readFileSync } = require('node:fs');
const { mkdir, writeFile, rename } = require('node:fs/promises');
const { resolve } = require('node:path');

function serverUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('请填写有效的 HTTPS 服务器地址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请填写有效的 HTTPS 服务器地址。'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !['http:', 'https:'].includes(url.protocol)
      || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('服务器地址必须使用 HTTPS，不能包含路径或凭据；本机开发可使用 HTTP。');
  }
  return url.origin;
}

function loadServerSettings({ packaged, userDirectory, resourcesDirectory, developmentUrl }) {
  const userFile = resolve(userDirectory, 'server-config.json');
  // 用户选择优先于安装包默认值，升级只替换默认值。
  const file = packaged && existsSync(userFile) ? userFile : resolve(resourcesDirectory, 'server-config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  return serverUrl(!packaged && developmentUrl ? developmentUrl : config.apiUrl);
}

async function saveServerSettings(userDirectory, value) {
  const apiUrl = serverUrl(value);
  await mkdir(userDirectory, { recursive: true });
  const file = resolve(userDirectory, 'server-config.json');
  await writeFile(`${file}.tmp`, `${JSON.stringify({ apiUrl }, null, 2)}\n`, 'utf8');
  await rename(`${file}.tmp`, file);
  return apiUrl;
}

module.exports = { serverUrl, loadServerSettings, saveServerSettings };
