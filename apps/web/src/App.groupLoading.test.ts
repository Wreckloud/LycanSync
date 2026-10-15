import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { ApiRequestError } from './auth/authApi';
import type { GroupDetail } from './group/groupApi';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const loadGroup = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'loadGroup')!.getText(sourceFile);
const compiled = ts.transpile(loadGroup, { target: ts.ScriptTarget.ES2022 });

function detail(id: string): GroupDetail {
  return { id, name: id, avatar: '', description: '', role: 'MEMBER', memberCount: 1, members: [],
    createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const request = deferred<GroupDetail>();
  const state = { selectedGroupId: ref<string | null>('one'), selectedGroupDetail: ref<GroupDetail | null>(detail('one')),
    joinedGroupId: ref<string | null>('one'), joiningGroupId: ref<string | null>(null),
    joinedGroupDetail: ref<GroupDetail | null>(detail('one')), management: ref<{ group: GroupDetail } | null>(null),
    groupError: ref(''), groupLoading: ref(false), detailRequest: null,
    findGroup: vi.fn((_id: string, _signal: AbortSignal) => request.promise),
    leaveVoice: vi.fn(), refreshGroups: vi.fn(async () => {}),
  };
  // 只控制 HTTP 返回顺序，执行正式群资料查询及其失败清理。
  const load = runInNewContext(`${compiled}\nloadGroup`, { ...state, AbortController, Error, ApiRequestError }) as
    (groupId: string, keepExisting?: boolean) => Promise<void>;
  return { state, load, request };
}

it('旧群失败不覆盖新预览的提示或加载状态', async () => {
  const { state, load, request } = setup();
  const reading = load('one');
  state.selectedGroupId.value = 'two';
  state.selectedGroupDetail.value = detail('two');
  state.groupError.value = '新群提示';
  state.groupLoading.value = true;
  request.reject(new Error('旧群读取失败'));
  await reading;
  expect(state.groupError.value).toBe('新群提示');
  expect(state.groupLoading.value).toBe(true);
  expect(state.selectedGroupDetail.value?.id).toBe('two');
});

it('旧预览群失去成员资格时仍退出该群通话，但保留新预览', async () => {
  const { state, load, request } = setup();
  const reading = load('one');
  state.selectedGroupId.value = 'two';
  state.selectedGroupDetail.value = detail('two');
  state.groupError.value = '新群提示';
  request.reject(new ApiRequestError(404, 'GROUP_NOT_FOUND', '不再属于旧群'));
  await reading;
  expect(state.leaveVoice).toHaveBeenCalledOnce();
  expect(state.refreshGroups).toHaveBeenCalledWith(false);
  expect(state.selectedGroupDetail.value?.id).toBe('two');
  expect(state.groupError.value).toBe('新群提示');
});

it('当前群读取失败仍显示错误，404 清除对应管理窗口并退出', async () => {
  const { state, load, request } = setup();
  state.management.value = { group: detail('one') };
  const reading = load('one', true);
  request.reject(new ApiRequestError(404, 'GROUP_NOT_FOUND', '该群已不存在'));
  await reading;
  expect(state.groupError.value).toBe('该群已不存在');
  expect(state.selectedGroupDetail.value).toBeNull();
  expect(state.management.value).toBeNull();
  expect(state.groupLoading.value).toBe(false);
  expect(state.leaveVoice).toHaveBeenCalledOnce();
});

it('新资料请求取消旧请求，旧结果不清除新请求的加载状态', async () => {
  const { state, load, request } = setup();
  const old = load('one');
  const signal = state.findGroup.mock.calls[0][1];
  const current = deferred<GroupDetail>();
  state.findGroup.mockReturnValueOnce(current.promise);
  state.selectedGroupId.value = 'two';
  const reading = load('two');
  expect(signal.aborted).toBe(true);
  request.resolve(detail('one'));
  await old;
  expect(state.groupLoading.value).toBe(true);
  expect(state.selectedGroupDetail.value).toBeNull();
  current.resolve(detail('two'));
  await reading;
  expect(state.selectedGroupDetail.value?.id).toBe('two');
  expect(state.groupLoading.value).toBe(false);
});

it('当前群正常刷新同步预览、通话资料与同群管理窗口', async () => {
  const { state, load, request } = setup();
  state.management.value = { group: detail('one') };
  const reading = load('one', true);
  request.resolve({ ...detail('one'), name: '新群名' });
  await reading;
  expect(state.selectedGroupDetail.value?.name).toBe('新群名');
  expect(state.joinedGroupDetail.value?.name).toBe('新群名');
  expect(state.management.value?.group.name).toBe('新群名');
  expect(state.groupError.value).toBe('');
});
