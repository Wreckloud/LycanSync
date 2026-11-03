const { serverUrl } = require('./server-settings.cjs');

function qqLoginFromArguments(argv) {
  const value = argv.find(value => typeof value === 'string' && value.startsWith('lycansync://qq'));
  try {
    if (!value || value.length > 2048) return null;
    const link = new URL(value);
    const fragment = new URLSearchParams(link.hash.slice(1));
    const request = fragment.get('request');
    if (link.protocol !== 'lycansync:' || link.hostname !== 'qq' || !['', '/'].includes(link.pathname)
        || link.username || link.password || link.port || link.searchParams.getAll('server').length !== 1
        || [...link.searchParams.keys()].some(key => key !== 'server')
        || fragment.getAll('request').length !== 1 || [...fragment.keys()].some(key => key !== 'request')
        || !/^[A-Za-z0-9_-]{43}$/.test(request ?? '')) return null;
    const server = serverUrl(link.searchParams.get('server'));
    return server.startsWith('https://') ? { server, request } : null;
  } catch { return null; }
}

function validateQqAuthorization(value, server) {
  const url = new URL(value);
  if (url.origin !== new URL(server).origin || url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/api/auth/qq/authorize' || url.hash
      || url.searchParams.getAll('request').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'request')
      || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('request') ?? '')) throw new Error('QQ 授权地址不符合当前服务器设置');
  return url.href;
}

module.exports = { qqLoginFromArguments, validateQqAuthorization };
