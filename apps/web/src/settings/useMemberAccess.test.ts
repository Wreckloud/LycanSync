import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type EffectScope } from 'vue';
import { authRequest } from '../auth/authApi';
import type { AccessLinkRecord } from '../auth/accountAccess';
import { useMemberAccess } from './useMemberAccess';

vi.mock('../auth/authApi', () => ({ authRequest: vi.fn() }));
const request = vi.mocked(authRequest);
const member = { id: 'member-a', nickname: '朋友', avatar: '', administrator: false };
const url = 'https://example.com/access#token=private';
let scope: EffectScope;
let visibility: string;
let events: EventTarget;
let serverLinks: AccessLinkRecord[];

function link(overrides: Partial<AccessLinkRecord> = {}): AccessLinkRecord {
  return { id: 'link-a', kind: 'INVITE', targetId: null, note: '朋友', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), consumedAt: null, revokedAt: null,
    resultUserId: null, lastFailure: null, ...overrides };
}
async function settle() { for (let count = 0; count < 8; count++) await Promise.resolve(); }
async function open(active = ref(true)) {
  scope = effectScope();
  const state = scope.run(() => useMemberAccess(active))!;
  await settle();
  return { state, active };
}
function setVisibility(value: string) {
  visibility = value;
  events.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
  visibility = 'visible';
  events = new EventTarget();
  vi.stubGlobal('document', { get visibilityState() { return visibility; },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  vi.stubGlobal('window', { confirm: vi.fn(() => true) });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  serverLinks = [link()];
  request.mockImplementation(async (path, method) => {
    if (method === 'POST') return { url, record: link() };
    if (method === 'DELETE') return undefined;
    return path.startsWith('access/members') ? [member] : serverLinks;
  });
});
afterEach(() => {
  scope?.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('邀请页记录刷新与操作反馈', () => {
  it('有待使用链接时每五秒只刷新记录，不重载成员或清空选择和链接', async () => {
    const { state } = await open();
    state.target.value = member.id;
    state.note.value = '备注';
    await state.generate('INVITE');
    request.mockClear();
    serverLinks = [link({ consumedAt: new Date().toISOString(), resultUserId: member.id })];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('access/links?offset=0');
    expect(state.links.value[0].consumedAt).not.toBeNull();
    expect(state.target.value).toBe(member.id);
    expect(state.note.value).toBe('备注');
    expect(state.generatedUrl.value).toBe(url);
  });

  it('没有待使用记录时降到三十秒，隐藏时停止，返回时立即刷新', async () => {
    serverLinks = [];
    await open();
    request.mockClear();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    request.mockClear();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(request).not.toHaveBeenCalled();
    setVisibility('visible');
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('隐藏状态打开页面不请求，恢复可见后加载记录和成员', async () => {
    visibility = 'hidden';
    const { state } = await open();
    expect(request).not.toHaveBeenCalled();
    setVisibility('visible');
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.members.value).toEqual([member]);
  });

  it('请求未完成时不积压刷新，退出页后取消请求并拒绝迟到响应', async () => {
    const { state, active } = await open();
    let finish!: (value: AccessLinkRecord[]) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    request.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    const signal = request.mock.calls[0][3]!;
    await vi.advanceTimersByTimeAsync(20_000);
    await state.refresh();
    expect(request).toHaveBeenCalledTimes(1);
    active.value = false;
    expect(signal.aborted).toBe(true);
    finish([]);
    await settle();
    expect(state.links.value).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('读取失败保留旧记录，并降低失败重试频率', async () => {
    const { state } = await open();
    request.mockRejectedValueOnce(new Error('服务暂不可用'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.recordsError.value).toBe('服务暂不可用');
    expect(state.links.value).toHaveLength(1);
    request.mockClear();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.recordsError.value).toBe('');
  });

  it('生成失败保留已有原链接，并只显示对应表单错误', async () => {
    const { state } = await open();
    await state.generate('INVITE');
    request.mockRejectedValueOnce(new Error('没有权限'));
    state.target.value = member.id;
    await state.generate('RECOVERY');
    expect(state.recoveryError.value).toBe('没有权限');
    expect(state.inviteError.value).toBe('');
    expect(state.generatedUrl.value).toBe(url);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.recoveryError.value).toBe('没有权限');
  });

  it('桌面使用固定复制接口，并在四秒后收起成功反馈', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { lycanDesktop: { copyText } });
    const { state } = await open();
    await state.generate('INVITE');
    expect(await state.copyLink()).toBe(true);
    expect(copyText).toHaveBeenCalledWith(url);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(state.copyStatus.value).toBe('已复制链接');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(state.copyStatus.value).toBe('');
  });

  it('浏览器复制失败就近提示，不因记录刷新而清掉错误', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'));
    const { state } = await open();
    await state.generate('INVITE');
    expect(await state.copyLink()).toBe(false);
    expect(state.linkError.value).toContain('复制失败');
    expect(state.recordsError.value).toBe('');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.linkError.value).toContain('复制失败');
  });

  it('浏览器仍可复制，桌面失败不静默回退网页接口', async () => {
    const { state } = await open();
    await state.generate('INVITE');
    expect(await state.copyLink()).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(url);
    vi.mocked(navigator.clipboard.writeText).mockClear();
    vi.stubGlobal('window', { lycanDesktop: { copyText: vi.fn().mockRejectedValue(new Error('denied')) } });
    expect(await state.copyLink()).toBe(false);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('撤销别的记录不丢失新链接，撤销当前新链接才清空', async () => {
    const { state } = await open();
    await state.generate('INVITE');
    await state.revoke('other');
    expect(state.generatedUrl.value).toBe(url);
    await state.revoke('link-a');
    expect(state.generatedUrl.value).toBe('');
  });

  it('离开页时释放监听和计时器，不在重新可见后继续请求', async () => {
    await open();
    scope.stop();
    request.mockClear();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).not.toHaveBeenCalled();
  });
});
