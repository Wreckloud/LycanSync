import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, nextTick, onScopeDispose, ref, watch } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { GroupCandidate, GroupCandidatePage } from '../group/groupApi';

const script = parse(readFileSync(new URL('./GroupManagementDialog.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('GroupManagementDialog.ts', script, ts.ScriptTarget.Latest, true);
const functionNames = ['loadCandidates', 'action', 'addMember', 'page'];
const callbacks = sourceFile.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return Boolean(statement.name && functionNames.includes(statement.name.text));
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((declaration) =>
    ['request', 'disposed', 'searchTimer', 'refreshTimer', 'statusTimer'].includes(declaration.name.getText(sourceFile)));
  const text = statement.getText(sourceFile);
  return text.startsWith('watch(search,') || text.startsWith('onScopeDispose(');
}).map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.useRealTimers();
});
const member: GroupCandidate = { userId: 'friend', nickname: '朋友', avatar: '', joined: false };

function setup() {
  vi.useFakeTimers();
  const scope = effectScope();
  scopes.push(scope);
  const state = { props: { group: { id: 'group' }, mode: 'invite' }, search: ref(''), offset: ref(0),
    candidates: ref<GroupCandidate[]>([member]), hasMore: ref(false), error: ref(''), candidateError: ref(''),
    busy: ref(false), loading: ref(false), status: ref(''), returnFocus: null, emit: vi.fn(),
    findGroupCandidates: vi.fn((_id: string, _search: string, _offset: number, _signal: AbortSignal): Promise<GroupCandidatePage> =>
      Promise.resolve({ members: [{ ...member, nickname: '新结果' }], hasMore: false })),
    addGroupMember: vi.fn(async () => ({ id: 'group' })),
  };
  // 使用正式回调、防抖监听与销毁清理，仅用受控 Promise 替代后端响应。
  const app = scope.run(() => runInNewContext(`${compiled}\n({ ${functionNames.join(', ')} })`, {
    ...state, AbortController, Error, nextTick, watch, onScopeDispose, setTimeout, clearTimeout, clearInterval,
  })) as { loadCandidates(): Promise<void>; addMember(member: GroupCandidate): Promise<void>; page(change: number): void };
  return { scope, state, app };
}

it('修改搜索词立即取消旧请求，防抖结束后仅接受当前搜索结果', async () => {
  const { state, app } = setup();
  let complete!: (page: GroupCandidatePage) => void;
  state.findGroupCandidates.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const old = app.loadCandidates();
  const oldSignal = state.findGroupCandidates.mock.calls[0][3];
  state.search.value = '新';
  await nextTick();
  expect(oldSignal.aborted).toBe(true);
  expect(state.loading.value).toBe(true);
  complete({ members: [{ ...member, nickname: '旧结果' }], hasMore: true });
  await old;
  expect(state.candidates.value[0].nickname).toBe('朋友');
  await vi.advanceTimersByTimeAsync(249);
  expect(state.findGroupCandidates).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.findGroupCandidates).toHaveBeenCalledTimes(2);
  expect(state.findGroupCandidates.mock.calls[1].slice(0, 3)).toEqual(['group', '新', 0]);
  expect(state.candidates.value[0].nickname).toBe('新结果');
  expect(state.loading.value).toBe(false);
});

it('列表恢复会清除读取错误，但不能清除复制或添加操作的错误', async () => {
  const { state, app } = setup();
  state.error.value = '复制失败';
  state.findGroupCandidates.mockRejectedValueOnce(new Error('列表读取失败'));
  await app.loadCandidates();
  expect(state.candidateError.value).toBe('列表读取失败');
  expect(state.error.value).toBe('复制失败');
  await app.loadCandidates();
  expect(state.candidateError.value).toBe('');
  expect(state.error.value).toBe('复制失败');
});

it('分页或添加成员时取消尚未执行的搜索，避免迟到查询覆盖添加结果', async () => {
  const { state, app } = setup();
  state.search.value = '朋';
  await nextTick();
  app.page(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(state.findGroupCandidates).toHaveBeenCalledTimes(1);
  expect(state.findGroupCandidates.mock.calls[0].slice(0, 3)).toEqual(['group', '朋', 20]);
  state.search.value = '朋友';
  await nextTick();
  await app.addMember(member);
  await vi.advanceTimersByTimeAsync(250);
  expect(state.findGroupCandidates).toHaveBeenCalledTimes(1);
  expect(state.candidates.value[0].joined).toBe(true);
  expect(state.emit).toHaveBeenCalledWith('updated', { id: 'group' });
});

it('关闭弹窗会取消读取和搜索计时，不接受迟到的成员列表', async () => {
  const { scope, state, app } = setup();
  let complete!: (page: GroupCandidatePage) => void;
  state.findGroupCandidates.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const pending = app.loadCandidates();
  const signal = state.findGroupCandidates.mock.calls[0][3];
  state.search.value = '新';
  await nextTick();
  scope.stop();
  complete({ members: [], hasMore: true });
  await pending;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(signal.aborted).toBe(true);
  expect(state.findGroupCandidates).toHaveBeenCalledTimes(1);
  expect(state.candidates.value).toEqual([member]);
  expect(state.emit).not.toHaveBeenCalled();
});
