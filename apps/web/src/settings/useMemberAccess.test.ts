import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type EffectScope } from 'vue';
import { authRequest } from '../auth/authApi';
import { type AccessLinkRecord } from '../auth/accountAccess';
import { useMemberAccess, type MemberAccessMode } from './useMemberAccess';

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
async function open(active = ref(true), mode: MemberAccessMode = 'links') {
  scope = effectScope();
  const state = scope.run(() => useMemberAccess(active, mode))!;
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
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  serverLinks = [link()];
  request.mockImplementation(async (path, method) => {
    if (method === 'POST' || path.endsWith('/url')) return { url, record: link() };
    if (method === 'DELETE' || method === 'PUT') return undefined;
    return path.startsWith('access/members') ? [member] : serverLinks;
  });
});
afterEach(() => {
  scope?.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('成员访问链接', () => {
  it('打开邀请窗口复用并自动复制，只有主动生成才创建额外邀请', async () => {
    const { state, active } = await open(ref(true), 'invite');
    expect(request).toHaveBeenCalledWith('access/links/invite', 'POST', undefined, expect.any(AbortSignal));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(url);
    expect(state.copyStatus.value).toBe('已复制链接');
    expect(request).toHaveBeenCalledWith('access/links?offset=0&status=PENDING&kind=INVITE', 'GET', undefined, expect.any(AbortSignal));
    active.value = false; active.value = true; await settle();
    expect(request.mock.calls.filter(([path]) => path === 'access/links')).toHaveLength(0);
    await state.generate('INVITE');
    expect(request).toHaveBeenCalledWith('access/links', 'POST', { kind: 'INVITE', targetId: null, note: '' }, expect.any(AbortSignal));
  });

  it('旧链接不能还原时保留记录，不自动重新生成', async () => {
    request.mockImplementation(async (path) => path === 'access/links/invite' ? { record: link(), url: null } : serverLinks);
    const { state } = await open(ref(true), 'invite');
    expect(state.links.value).toHaveLength(1);
    expect(state.error.value).toContain('旧链接');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
  });

  it('修改备注只写备注，保留链接与有效期', async () => {
    const { state } = await open(ref(true), 'invite');
    const expiry = state.links.value[0].expiresAt;
    request.mockClear();
    expect(await state.saveNote('link-a', '  给朋友  ')).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith('access/links/link-a/note', 'PUT', { note: '  给朋友  ' }, expect.any(AbortSignal));
    expect(state.links.value[0]).toMatchObject({ note: '给朋友', expiresAt: expiry });
    expect(state.generatedUrl.value).toBe(url);
  });

  it('复制失败保留手动复制入口，不谎报成功', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'));
    const { state } = await open(ref(true), 'invite');
    expect(state.generatedUrl.value).toBe(url);
    expect(state.error.value).toBe('复制失败，请选择链接手动复制。');
    expect(state.copyStatus.value).toBe('');
  });

  it('桌面复制失败不走浏览器替代路径', async () => {
    vi.stubGlobal('window', { lycanDesktop: { copyText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const { state } = await open(ref(true), 'invite');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(state.error.value).toContain('复制失败');
  });

  it('链接失效后不再展示或复制缓存地址', async () => {
    const { state } = await open(ref(true), 'invite');
    request.mockRejectedValue(new Error('链接已使用'));
    vi.mocked(navigator.clipboard.writeText).mockClear();
    expect(await state.copyLink()).toBe(false);
    expect(state.generatedUrl.value).toBe('');
    expect(state.error.value).toBe('链接已使用');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('分类查询由服务器过滤，切换分类重置分页', async () => {
    const { state } = await open();
    state.offset.value = 100;
    state.filter.value = 'USED'; await settle();
    expect(state.offset.value).toBe(0);
    expect(request).toHaveBeenLastCalledWith('access/links?offset=0&status=USED', 'GET', undefined, expect.any(AbortSignal));
  });

  it('分类切换后忽略旧查询的迟到结果', async () => {
    const { state } = await open();
    let finish!: (records: AccessLinkRecord[]) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const previous = state.refresh();
    serverLinks = [];
    state.filter.value = 'REVOKED'; await settle();
    finish([link()]); await previous;
    expect(state.links.value).toEqual([]);
  });

  it('待使用记录每五秒刷新，隐藏后停止，恢复可见立即查询', async () => {
    const { state } = await open();
    state.note.value = '正在编辑'; request.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.note.value).toBe('正在编辑');
    setVisibility('hidden'); request.mockClear();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(request).not.toHaveBeenCalled();
    setVisibility('visible'); await settle();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('空列表每三十秒刷新，列表失败不覆盖操作错误', async () => {
    serverLinks = [];
    const { state } = await open(); request.mockClear();
    await vi.advanceTimersByTimeAsync(29_999); expect(request).not.toHaveBeenCalled();
    request.mockRejectedValue(new Error('读取失败')); state.error.value = '复制失败';
    await vi.advanceTimersByTimeAsync(1);
    expect(state.recordsError.value).toBe('读取失败');
    expect(state.error.value).toBe('复制失败');
  });

  it('关闭窗口后迟到的生成结果不写剪贴板', async () => {
    let finish!: (result: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { state, active } = await open(ref(true), 'invite');
    active.value = false; finish({ record: link(), url }); await settle();
    expect(state.generatedUrl.value).toBe('');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('恢复链接由确认操作生成，备注原样提交', async () => {
    const { state } = await open(ref(true), 'recovery');
    expect(request).not.toHaveBeenCalled();
    expect(await state.generate('RECOVERY')).toBe(false);
    state.target.value = member.id; state.note.value = '朋友 的恢复链接';
    await state.generate('RECOVERY');
    expect(request).toHaveBeenCalledWith('access/links', 'POST', { kind: 'RECOVERY', targetId: member.id, note: '朋友 的恢复链接' }, expect.any(AbortSignal));
  });

  it('撤销当前链接后清理复制结果', async () => {
    const { state } = await open(ref(true), 'invite');
    await state.revoke('link-a');
    expect(state.generatedUrl.value).toBe('');
    expect(state.generatedRecord.value).toBeNull();
    expect(state.copyStatus.value).toBe('');
  });

  it('销毁后停止刷新', async () => {
    await open(); scope.stop(); request.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility('visible'); await settle();
    expect(request).not.toHaveBeenCalled();
  });
});
