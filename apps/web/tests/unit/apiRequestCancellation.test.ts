import { afterEach, describe, expect, test, vi } from 'vitest';
import { authRequest, setBrowserSession } from '../../src/auth/authApi';
import { findGroups, waitForGroupPresenceChanges } from '../../src/group/groupApi';
import { sendPresenceHeartbeat } from '../../src/presence/presenceApi';
import { requestRoomOccupancies, requestRoomSummary } from '../../src/rtc/roomSummaryApi';

const requests = [
  { name: '认证', send: (signal: AbortSignal) => authRequest('session', 'GET', undefined, signal),
    response: () => Response.json({ id: 'user', nickname: '行者', administrator: false }) },
  { name: '群组', send: (signal: AbortSignal) => findGroups(signal), response: () => Response.json([]) },
  { name: '心跳', send: (signal: AbortSignal) => sendPresenceHeartbeat('ONLINE', null, signal),
    response: () => new Response(null, { status: 204 }) },
  { name: '语音成员预览', send: (signal: AbortSignal) => requestRoomSummary('group', signal),
    response: () => Response.json({ participantCount: 0, participants: [] }) },
  { name: '群组语音人数', send: (signal: AbortSignal) => requestRoomOccupancies(signal),
    response: () => Response.json([]) },
];

afterEach(() => {
  setBrowserSession(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pendingFetch() {
  const deadlines: { milliseconds: number; controller: AbortController }[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  let receivedSignal!: AbortSignal;
  let complete!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    receivedSignal = init.signal as AbortSignal;
    const abort = () => reject(receivedSignal.reason);
    complete = (response) => {
      receivedSignal.removeEventListener('abort', abort);
      resolve(response);
    };
    if (receivedSignal.aborted) abort();
    else receivedSignal.addEventListener('abort', abort, { once: true });
  })));
  // 仅替代网络和超时调度，使用正式请求方法与 AbortSignal.any 的取消传播。
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', { dispatchEvent });
  return { deadlines, dispatchEvent, complete: (response: Response) => complete(response),
    signal: () => receivedSignal };
}

describe('普通请求的取消与超时边界', () => {
  test.each(requests)('$name：传入生命周期信号后仍受十五秒超时约束', async ({ send }) => {
    const request = pendingFetch();
    const caller = new AbortController();
    const result = send(caller.signal);
    expect(request.deadlines.map((deadline) => deadline.milliseconds)).toEqual([15_000]);
    expect(request.signal().aborted).toBe(false);
    const timeout = new DOMException('请求超时', 'TimeoutError');
    const rejected = expect(result).rejects.toBe(timeout);
    request.deadlines[0].controller.abort(timeout);
    await rejected;
    expect(caller.signal.aborted).toBe(false);
    expect(request.dispatchEvent).not.toHaveBeenCalled();
  });

  test.each(requests)('$name：调用方取消立即传到网络，不等待超时或触发登出', async ({ send }) => {
    const request = pendingFetch();
    const caller = new AbortController();
    const result = send(caller.signal);
    const cancellation = new DOMException('当前页面任务已取消', 'AbortError');
    const rejected = expect(result).rejects.toBe(cancellation);
    caller.abort(cancellation);
    await rejected;
    expect(request.signal().aborted).toBe(true);
    expect(request.deadlines[0].controller.signal.aborted).toBe(false);
    expect(request.dispatchEvent).not.toHaveBeenCalled();
  });

  test.each(requests)('$name：有效响应仍正常返回，结束请求不取消调用方的生命周期', async ({ send, response }) => {
    const request = pendingFetch();
    const caller = new AbortController();
    const expectedResponse = response();
    const expected = expectedResponse.status === 204 ? undefined : await expectedResponse.clone().json();
    const result = send(caller.signal);
    request.complete(expectedResponse);
    expect(await result).toEqual(expected);
    expect(caller.signal.aborted).toBe(false);
  });

  test('正常关窗的更短离线上报期限仍先于普通请求期限生效', async () => {
    const request = pendingFetch();
    const closeSignal = AbortSignal.timeout(1_200);
    const result = sendPresenceHeartbeat('OFFLINE', null, closeSignal);
    expect(request.deadlines.map((deadline) => deadline.milliseconds)).toEqual([1_200, 15_000]);
    const timeout = new DOMException('关窗等待结束', 'TimeoutError');
    const rejected = expect(result).rejects.toBe(timeout);
    request.deadlines[0].controller.abort(timeout);
    await rejected;
    expect(request.deadlines[1].controller.signal.aborted).toBe(false);
  });

  test('在线状态长轮询保留五十秒期限，且仍能由切群立即取消', async () => {
    const request = pendingFetch();
    const caller = new AbortController();
    const result = waitForGroupPresenceChanges('group', 'client', 1, null, caller.signal);
    expect(request.deadlines.map((deadline) => deadline.milliseconds)).toEqual([50_000]);
    const cancellation = new DOMException('已切换群组', 'AbortError');
    const rejected = expect(result).rejects.toBe(cancellation);
    caller.abort(cancellation);
    await rejected;
    expect(request.dispatchEvent).not.toHaveBeenCalled();
  });
});
