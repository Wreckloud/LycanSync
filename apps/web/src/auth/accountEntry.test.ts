import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

const script = readFileSync(new URL('../../../../services/api/src/main/resources/account/join.js', import.meta.url), 'utf8');
const token = 'a'.repeat(43);

function entry(fetchMock: ReturnType<typeof vi.fn>, hash = `#token=${token}`) {
  const elements = Object.fromEntries(['status', 'open', 'retry', 'error', 'server', 'download', 'instruction', 'title', 'kind', 'subtitle']
    .map((id) => [id, { textContent: '', disabled: id === 'open', hidden: id === 'retry',
      listeners: {} as Record<string, () => void | Promise<void>>,
      addEventListener(event: string, callback: () => void | Promise<void>) { this.listeners[event] = callback; } }]));
  const location = { hash, host: 'friends.example', origin: 'https://friends.example', href: '' };
  const document = { title: '', getElementById: (id: string) => elements[id] };
  runInNewContext(script, { document, location, fetch: fetchMock, URLSearchParams, AbortSignal, Error });
  return { elements, location, document };
}

function preview(kind = 'INVITE', status = 'PENDING') {
  return Response.json({ kind, status, serverName: '朋友的小队' });
}

describe('浏览器账号入口', () => {
  test.each([['ACTIVATE', '服主激活'], ['INVITE', '邀请加入'], ['RECOVERY', '恢复登录']])('%s 沿用同一页面并显示对应操作', async (kind, label) => {
    const fetchMock = vi.fn().mockResolvedValue(preview(kind));
    const { elements, location, document } = entry(fetchMock);
    expect(elements.open.disabled).toBe(true);
    await vi.waitFor(() => expect(elements.open.disabled).toBe(false));
    expect(elements.title.textContent).toBe('朋友的小队');
    expect(document.title).toBe(`LycanSync · ${label}`);
    elements.download.listeners.click();
    expect(elements.instruction.textContent).toContain('安装完成后');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/access/preview', expect.objectContaining({ credentials: 'omit', cache: 'no-store' }));
    elements.open.listeners.click();
    expect(location.href).toBe(`lycansync://access?server=https%3A%2F%2Ffriends.example#token=${token}`);
  });

  test.each(['COMPLETED', 'EXPIRED', 'REVOKED'])('%s 链接可以下载但不能发起激活', async (status) => {
    const { elements, location } = entry(vi.fn().mockResolvedValue(preview('INVITE', status)));
    await vi.waitFor(() => expect(elements.status.textContent).not.toBe('正在检查链接…'));
    expect(elements.open.disabled).toBe(true);
    elements.open.listeners.click();
    expect(location.href).toBe('');
  });

  test('缺失或非法凭据不请求服务器', () => {
    const fetchMock = vi.fn();
    const { elements } = entry(fetchMock, '#token=invalid');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(elements.open.disabled).toBe(true);
    expect(elements.status.textContent).toContain('链接不完整');
  });

  test('连接失败可重新检查，恢复后清除错误', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(preview());
    const { elements } = entry(fetchMock);
    await vi.waitFor(() => expect(elements.retry.hidden).toBe(false));
    expect(elements.open.disabled).toBe(true);
    expect(elements.error.textContent).toBe('无法连接服务器，请检查网络后重试。');
    await elements.retry.listeners.click();
    expect(elements.open.disabled).toBe(false);
    expect(elements.error.textContent).toBe('');
    expect(elements.retry.hidden).toBe(true);
  });

  test('业务错误保留说明，未知响应不能开放操作', async () => {
    const { elements } = entry(vi.fn().mockResolvedValue(Response.json({ detail: '链接不存在' }, { status: 404 })));
    await vi.waitFor(() => expect(elements.error.textContent).toBe('链接不存在'));
    const invalid = entry(vi.fn().mockResolvedValue(Response.json({ status: 'PENDING' })));
    await vi.waitFor(() => expect(invalid.elements.error.textContent).toContain('无法确认'));
    expect(invalid.elements.open.disabled).toBe(true);
  });

  test('代理返回 HTML 时说明服务器异常，不伪报网络断开', async () => {
    const { elements } = entry(vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 })));
    await vi.waitFor(() => expect(elements.error.textContent).toBe('服务器暂时无法检查链接，请稍后重试。'));
    expect(elements.open.disabled).toBe(true);
    expect(elements.retry.hidden).toBe(false);
  });
});
