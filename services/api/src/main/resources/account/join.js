'use strict';
const token = new URLSearchParams(location.hash.slice(1)).get('token');
// 保留片段以支持安装后刷新；片段不会随 HTTP 请求或 Referer 发往服务器。
const status = document.getElementById('status');
const open = document.getElementById('open');
const retry = document.getElementById('retry');
const error = document.getElementById('error');
const kinds = {
  ACTIVATE: { label: '服主激活', subtitle: '开启你的朋友小天地' },
  INVITE: { label: '邀请加入', subtitle: '和朋友一起开黑，一起看' },
  RECOVERY: { label: '恢复登录', subtitle: '回到你的朋友身边' },
};
const labels = { PENDING: '链接有效，请在应用中确认。', COMPLETED: '此链接已使用，可下载应用；恢复登录请联系服主。', EXPIRED: '此链接已过期，请联系服主重新生成。', REVOKED: '此链接已撤销，请联系服主。' };
document.getElementById('server').textContent = location.host;

open.addEventListener('click', () => {
  if (open.disabled) return;
  location.href = `lycansync://access?server=${encodeURIComponent(location.origin)}#token=${token}`;
});
document.getElementById('download').addEventListener('click', () => {
  document.getElementById('instruction').textContent = '安装完成后，点击本页“打开应用”继续。';
});
retry.addEventListener('click', checkLink);

if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
  status.textContent = '链接不完整，请重新打开服主发来的链接。';
} else {
  checkLink();
}

async function checkLink() {
  if (retry.disabled) return;
  retry.disabled = true;
  open.disabled = true;
  error.textContent = '';
  status.textContent = '正在检查链接…';
  try {
    const response = await fetch('/api/auth/access/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'omit', cache: 'no-store', body: JSON.stringify({ token }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => { throw new Error('服务器暂时无法检查链接，请稍后重试。'); });
    if (!response.ok) throw new Error(result.detail || '无法检查链接，请稍后重试。');
    if (!result || !Object.hasOwn(kinds, result.kind) || !Object.hasOwn(labels, result.status) || typeof result.serverName !== 'string') {
      throw new Error('链接状态无法确认，请稍后重试。');
    }
    document.getElementById('title').textContent = result.serverName;
    document.getElementById('kind').textContent = `· ${kinds[result.kind].label}`;
    document.getElementById('subtitle').textContent = kinds[result.kind].subtitle;
    document.title = `LycanSync · ${kinds[result.kind].label}`;
    status.textContent = labels[result.status];
    open.disabled = result.status !== 'PENDING';
    retry.hidden = true;
  } catch (exception) {
    status.textContent = '链接检查未完成';
    error.textContent = exception instanceof Error && exception.name === 'Error' ? exception.message : '无法连接服务器，请检查网络后重试。';
    retry.hidden = false;
  } finally {
    retry.disabled = false;
  }
}
