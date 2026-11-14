import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type EffectScope } from 'vue';
import { authRequest } from '../auth/authApi';
import { type AccessLinkRecord } from '../auth/accountAccess';
import { useMemberAccess, type MemberAccessMode } from './useMemberAccess';

vi.mock('../auth/authApi', () => ({ authRequest: vi.fn() }));
const request = vi.mocked(authRequest);
const member = { id: 'member-a', nickname: '朋友', avatar: '', administrator: false };
const url = 'https://example.com/access#token=private';
const notice = vi.fn();
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
  const state = scope.run(() => useMemberAccess(active, mode, notice))!;
  await settle();
  return { state, active };
}
function setVisibility(value: string) {
  visibility = value;
  events.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset(); notice.mockReset();
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
  it('已有邀请时展示最新链接，只在点击生成时创建额外链接', async () => {
    const { state } = await open(ref(true), 'invite');
    expect(state.generatedUrl.value).toBe(url);
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(0);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    await state.generate('INVITE');
    expect(request).toHaveBeenCalledWith('access/links', 'POST', { kind: 'INVITE', targetId: null, note: '' }, expect.any(AbortSignal));
    expect(notice).toHaveBeenCalledWith('邀请链接已复制。');
  });

  it('没有可用邀请时自动生成并复制一次', async () => {
    serverLinks = [];
    const { state } = await open(ref(true), 'invite');
    await settle();
    expect(state.generatedUrl.value).toBe(url);
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(url);
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
  });

  it('旧链接不能还原时不自动重新生成', async () => {
    const { state } = await open();
    request.mockImplementation(async () => ({ record: link(), url: null }));
    expect(await state.copyLink('link-a')).toBe(false);
    expect(state.error.value).toContain('旧链接');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(0);
  });

  it('修改备注只写备注，保留链接与有效期', async () => {
    const { state } = await open(ref(true), 'invite');
    await state.generate('INVITE');
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
    await state.generate('INVITE');
    expect(state.generatedUrl.value).toBe(url);
    expect(state.error.value).toBe('复制失败，请选择链接手动复制。');
    expect(notice).not.toHaveBeenCalled();
  });

  it('桌面复制失败不走浏览器替代路径', async () => {
    vi.stubGlobal('window', { lycanDesktop: { copyText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const { state } = await open(ref(true), 'invite');
    await state.generate('INVITE');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(state.error.value).toContain('复制失败');
  });

  it('链接失效后不再展示或复制缓存地址', async () => {
    const { state } = await open(ref(true), 'invite');
    await state.generate('INVITE');
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
    const { state, active } = await open(ref(true), 'invite');
    let finish!: (result: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const generation = state.generate('INVITE');
    active.value = false; finish({ record: link({ id: 'late-link' }), url: 'https://example.com/access#token=late' }); await generation;
    expect(state.generatedRecord.value?.id).toBe('link-a');
    expect(state.generatedUrl.value).toBe(url);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('恢复链接由确认操作生成，备注原样提交', async () => {
    const { state } = await open(ref(true), 'recovery');
    expect(request).toHaveBeenCalledWith('access/links?offset=0&status=PENDING&kind=RECOVERY', 'GET', undefined, expect.any(AbortSignal));
    expect(await state.generate('RECOVERY')).toBe(false);
    state.target.value = member.id; state.note.value = '朋友 的恢复链接';
    await state.generate('RECOVERY');
    expect(request).toHaveBeenCalledWith('access/links', 'POST', { kind: 'RECOVERY', targetId: member.id, note: '朋友 的恢复链接' }, expect.any(AbortSignal));
  });

  it('生成后列表刷新期间仍禁止重复生成', async () => {
    const { state } = await open(ref(true), 'invite');
    const original = request.getMockImplementation()!;
    let finish!: (value: AccessLinkRecord[]) => void;
    request.mockImplementation((path, ...args) => path.includes('access/links?')
      ? new Promise(resolve => { finish = resolve; }) : original(path, ...args));
    const generating = state.generate('INVITE');
    await settle();
    expect(state.locked.value).toBe(true);
    expect(await state.generate('INVITE')).toBe(false);
    finish([link()]); await generating;
    expect(state.locked.value).toBe(false);
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
  });

  it('恢复成员列表读取全部有效恢复链接，不遗漏后续页', async () => {
    request.mockImplementation(async path => {
      const offset = new URL(path, 'https://example.com').searchParams.get('offset');
      return offset === '0' ? Array.from({ length: 100 }, (_, index) => link({ id: `r-${index}`, kind: 'RECOVERY', targetId: `member-${index}` }))
        : [link({ id: 'last', kind: 'RECOVERY', targetId: 'last-member' })];
    });
    const { state } = await open(ref(true), 'recovery');
    expect(state.links.value).toHaveLength(101);
    expect(state.links.value.at(-1)?.targetId).toBe('last-member');
    expect(state.recordsLoaded.value).toBe(true);
  });

  it('未能核对已有邀请时不自动生成，重试后读取已有链接', async () => {
    request.mockRejectedValueOnce(new Error('读取失败'));
    const { state } = await open(ref(true), 'invite');
    expect(state.recordsLoaded.value).toBe(false);
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(0);
    await state.prepareInvitation();
    expect(state.generatedUrl.value).toBe(url);
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(0);
  });

  it('撤销当前链接后清理复制结果', async () => {
    const { state } = await open(ref(true), 'invite');
    await state.generate('INVITE'); notice.mockClear();
    await state.revoke('link-a');
    expect(state.generatedUrl.value).toBe('');
    expect(state.generatedRecord.value).toBeNull();
    expect(notice).not.toHaveBeenCalled();
  });

  it('销毁后停止刷新', async () => {
    await open(); scope.stop(); request.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility('visible'); await settle();
    expect(request).not.toHaveBeenCalled();
  });
});
