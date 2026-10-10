'use strict';
const token = new URLSearchParams(location.hash.slice(1)).get('token');
// 保留片段以支持安装后刷新；片段不会随 HTTP 请求或 Referer 发往服务器。
const status = document.getElementById('status');
const open = document.getElementById('open');
const labels = { PENDING: '链接有效，请在应用中确认。', COMPLETED: '此链接已使用，可下载应用；恢复登录请联系服主。', EXPIRED: '此链接已过期，请联系服主重新生成。', REVOKED: '此链接已撤销，请联系服主。' };
if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
  status.textContent = '链接不完整，请重新打开服主发来的链接。';
} else {
  open.disabled = false;
  open.addEventListener('click', () => {
    location.href = `lycansync://access?server=${encodeURIComponent(location.origin)}#token=${token}`;
  });
  fetch('/api/auth/access/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'omit', cache: 'no-store', body: JSON.stringify({ token }), signal: AbortSignal.timeout(15000),
  }).then(async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || '无法检查链接');
    document.getElementById('title').textContent = result.serverName;
    status.textContent = labels[result.status] || '链接状态无法确认。';
  }).catch((error) => { status.textContent = '链接检查未完成，可以重试打开原链接。'; document.getElementById('error').textContent = error.message; });
}
