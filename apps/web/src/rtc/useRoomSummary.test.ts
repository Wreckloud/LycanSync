import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { requestRoomSummary, type RtcRoomSummary } from './roomSummaryApi';
import { useRoomSummary } from './useRoomSummary';

vi.mock('./roomSummaryApi', () => ({ requestRoomSummary: vi.fn() }));
const requestSummary = vi.mocked(requestRoomSummary);
let scope: EffectScope | undefined;

afterEach(() => {
  scope?.stop();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubDocumentVisibility(initial: DocumentVisibilityState) {
  let visibilityState = initial;
  const documentStub = new EventTarget();
  Object.defineProperty(documentStub, 'visibilityState', { get: () => visibilityState });
  vi.stubGlobal('document', documentStub);
  return (next: DocumentVisibilityState) => {
    visibilityState = next;
    documentStub.dispatchEvent(new Event('visibilitychange'));
  };
}

describe('Vue 房间摘要生命周期', () => {
  it('切换群组后忽略迟到的旧摘要', async () => {
    let finishOld!: (summary: RtcRoomSummary) => void;
    requestSummary.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    requestSummary.mockResolvedValue({ participantCount: 1, participantNames: ['新房间成员'] });
    const groupId = ref('pack');
    scope = effectScope();
    const summary = scope.run(() => useRoomSummary(groupId, ref(true)))!;
    const oldSignal = requestSummary.mock.calls[0][1];
    groupId.value = 'racing';
    await nextTick();
    await nextTick();
    expect(oldSignal.aborted).toBe(true);
    expect(summary.value?.participantNames).toEqual(['新房间成员']);
    finishOld({ participantCount: 1, participantNames: ['旧房间成员'] });
    await nextTick();
    expect(summary.value?.participantNames).toEqual(['新房间成员']);
  });

  it('入房后清除预览并停止后续轮询', async () => {
    vi.useFakeTimers();
    requestSummary.mockResolvedValue({ participantCount: 0, participantNames: [] });
    const enabled = ref(true);
    scope = effectScope();
    const summary = scope.run(() => useRoomSummary(ref('pack'), enabled))!;
    await nextTick();
    expect(summary.value?.participantCount).toBe(0);
    enabled.value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(summary.value).toBeNull();
    expect(requestSummary).toHaveBeenCalledTimes(1);
    expect(requestSummary.mock.calls[0][1].aborted).toBe(true);
  });

  it('作用域销毁后取消请求且不接受迟到响应', async () => {
    vi.useFakeTimers();
    let finish!: (summary: RtcRoomSummary) => void;
    requestSummary.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    scope = effectScope();
    const summary = scope.run(() => useRoomSummary(ref('pack'), ref(true)))!;
    scope.stop();
    expect(requestSummary.mock.calls[0][1].aborted).toBe(true);
    finish({ participantCount: 1, participantNames: ['迟到成员'] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(summary.value).toBeNull();
    expect(requestSummary).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('页面隐藏时暂停轮询并在恢复可见后立即刷新', async () => {
    vi.useFakeTimers();
    const setVisibility = stubDocumentVisibility('visible');
    requestSummary.mockResolvedValue({ participantCount: 0, participantNames: [] });
    scope = effectScope();
    scope.run(() => useRoomSummary(ref('pack'), ref(true)));
    await nextTick();
    expect(requestSummary).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await nextTick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestSummary).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await nextTick();
    expect(requestSummary).toHaveBeenCalledTimes(2);
  });

  it('可见页面每十秒刷新一次摘要', async () => {
    vi.useFakeTimers();
    stubDocumentVisibility('visible');
    requestSummary.mockResolvedValue({ participantCount: 0, participantNames: [] });
    scope = effectScope();
    scope.run(() => useRoomSummary(ref('pack'), ref(true)));
    await nextTick();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(requestSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSummary).toHaveBeenCalledTimes(2);
  });
});
