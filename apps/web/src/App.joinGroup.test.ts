import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./App.vue', import.meta.url), 'utf8');
const start = source.indexOf('async function joinGroup(');
const end = source.indexOf('function requestJoin(', start);
const script = transpileModule(source.slice(start, end), {}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function joining() {
  const context = {
    joinAttempt: 0, selectCaptureSource: vi.fn(), viewingWindows: { value: { closeAll: vi.fn() } },
    selectedGroupId: { value: '' }, pendingSwitchGroupId: { value: null }, joiningGroupId: { value: '' as string | null },
    viewerNotice: { value: '' },
    callbarLeaving: { value: false }, departingGroupId: { value: null },
    joinedGroupId: { value: null as string | null }, joinedGroupDetail: { value: null as { id: string } | null },
    locallyLeftVoiceGroupId: { value: null as string | null },
    selectedGroupDetail: { value: null as { id: string } | null }, listening: { value: true },
    callSounds: { left: vi.fn(), joined: vi.fn() },
    rtc: { leave: vi.fn(async () => {}), join: vi.fn(async () => true) },
    findGroup: vi.fn(async (id: string) => ({ id })), props: { user: { id: 'user' } },
    loadEntranceSound: vi.fn(() => null), refreshGroups: vi.fn(),
    joinGroup: undefined as unknown as (id: string) => Promise<void>,
  };
  runInNewContext(script, context);
  return context;
}

it.each(['success', 'failure'])('旧群成员查询迟到 %s 不覆盖新群资料或加入状态', async (result) => {
  const context = joining();
  const previous = deferred<{ id: string }>();
  context.findGroup.mockReturnValueOnce(previous.promise);
  const oldJoin = context.joinGroup('old');
  context.joinAttempt++;
  await context.joinGroup('current');
  if (result === 'success') previous.resolve({ id: 'old' });
  else previous.reject(new Error('旧群不可用'));
  await oldJoin;
  expect(context.joinedGroupId.value).toBe('current');
  expect(context.joinedGroupDetail.value).toEqual({ id: 'current' });
  expect(context.viewerNotice.value).toBe('');
  expect(context.rtc.join).toHaveBeenCalledTimes(1);
});

it('旧离房等待完成不清空后来已加入的群组', async () => {
  const context = joining();
  const leaving = deferred<void>();
  context.joinedGroupId.value = 'initial';
  context.rtc.leave.mockReturnValueOnce(leaving.promise);
  const oldJoin = context.joinGroup('old');
  context.joinAttempt++;
  context.joinedGroupId.value = null;
  await context.joinGroup('current');
  leaving.resolve();
  await oldJoin;
  expect(context.joinedGroupId.value).toBe('current');
  expect(context.joinedGroupDetail.value).toEqual({ id: 'current' });
  expect(context.rtc.join).toHaveBeenCalledTimes(1);
});
