const { serverUrl } = require('./server-settings.cjs');

// 唤起链接只携带服务器和一次性凭据，不允许注入其他协议或路径。
function parseAccessLink(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('邀请链接无效');
  const link = new URL(value);
  // 浏览器或系统协议处理器可能把空路径规范化为根路径。
  if (link.protocol !== 'lycansync:' || link.hostname !== 'access' || !['', '/'].includes(link.pathname)
      || link.username || link.password || link.port
      || [...link.searchParams.keys()].some((key) => key !== 'server')
      || link.searchParams.getAll('server').length !== 1) throw new Error('邀请链接无效');
  const fragment = new URLSearchParams(link.hash.slice(1));
  const token = fragment.get('token');
  if (fragment.getAll('token').length !== 1 || [...fragment.keys()].some((key) => key !== 'token')
      || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw new Error('邀请凭据无效');
  const server = serverUrl(link.searchParams.get('server'));
  if (!server.startsWith('https://')) throw new Error('邀请服务器必须使用 HTTPS');
  return { server, token };
}

function accessLinkFromArguments(argv) {
  const candidate = argv.find((value) => typeof value === 'string' && value.startsWith('lycansync:'));
  if (!candidate) return null;
  try { return parseAccessLink(candidate); }
  catch { return null; } // 非法系统参数不影响启动，也不记录凭据。
}

function parseManualAccessLink(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请填写完整的邀请或恢复登录链接。');
  try {
    const link = new URL(value.trim());
    if (link.protocol === 'lycansync:') return parseAccessLink(link.href);
    if (link.protocol !== 'https:' || link.pathname !== '/join' || link.search
        || link.username || link.password) throw new Error('链接无效');
    // 网页链接只转换为现有邀请结构；预览、确认兑换和换服务器仍走原流程。
    return parseAccessLink(`lycansync://access?server=${encodeURIComponent(link.origin)}${link.hash}`);
  } catch {
    throw new Error('链接无效，请粘贴完整的 HTTPS 邀请链接或 LycanSync 打开链接。');
  }
}

module.exports = { parseAccessLink, accessLinkFromArguments, parseManualAccessLink };
