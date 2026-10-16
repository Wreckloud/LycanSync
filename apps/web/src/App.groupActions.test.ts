import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, nextTick, onScopeDispose, ref, watch } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { GroupDetail } from './group/groupApi';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const functionNames = ['openEditor', 'closeGroupEditor', 'createGroupFromDialog', 'applyGroupDetail', 'joinedFromCode', 'openGroupAction'];
const callbacks = sourceFile.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return Boolean(statement.name && functionNames.includes(statement.name.text));
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations
    .some((declaration) => ['groupActionRequest', 'groupEditorGeneration'].includes(declaration.name.getText(sourceFile)));
  const text = statement.getText(sourceFile);
  return text.startsWith('watch(selectedGroupId,') || (text.startsWith('onScopeDispose(') && text.includes('joinAttempt++'));
}).map((statement) => statement.getText(sourceFile)).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach((scope) => scope.stop()); });

function detail(id: string): GroupDetail {
  return { id, name: id, avatar: '', description: '', role: 'OWNER', memberCount: 1, members: [],
    createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' };
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const scope = effectScope();
  scopes.push(scope);
  const state = { selectedGroupId: ref<string | null>('one'), selectedGroupDetail: ref<GroupDetail | null>(detail('one')),
    joinedGroupId: ref<string | null>(null), joinedGroupDetail: ref<GroupDetail | null>(null), groups: ref([detail('one')]),
    editorOpen: ref(false), editingGroup: ref<GroupDetail | null>(null),
    management: ref<{ group: GroupDetail; mode: string } | null>(null), groupError: ref(''),
    memberSearchOpen: ref(false), memberSearch: ref(''),
    findGroup: vi.fn((_id: string, _signal: AbortSignal): Promise<GroupDetail> => Promise.resolve(detail('one'))),
    createGroup: vi.fn(async () => detail('created')), updateGroup: vi.fn(async () => detail('one')),
    refreshGroups: vi.fn(async () => {}), groupPresences: ref({}), presenceConnectionLost: ref(false),
    startGroupPresenceSync: vi.fn(), joinAttempt: 0, selectCaptureSource: vi.fn(), removeCloseListener: null,
    detailRequest: null, listRequest: null, rtc: { leave: vi.fn(async () => {}) },
  };
  // 执行 App 正式弹窗回调、切群监听及销毁清理；只替代 HTTP 和 RTC 边界。
  const app = scope.run(() => runInNewContext(`${compiled}\n({ ${functionNames.join(', ')} })`, {
    ...state, AbortController, onScopeDispose, watch,
  })) as {
    openEditor(): void; closeGroupEditor(): void; createGroupFromDialog(name: string, description: string, avatar: string): Promise<void>;
    openGroupAction(action: 'edit' | 'members' | 'invite'): Promise<void>; joinedFromCode(group: GroupDetail): void;
  };
  return { state, app, scope };
}

it('切群时取消旧管理请求，旧失败不覆盖新群错误', async () => {
  const { state, app } = setup();
  const pending = deferred<GroupDetail>();
  state.findGroup.mockReturnValue(pending.promise);
  const opening = app.openGroupAction('members');
  const signal = state.findGroup.mock.calls[0][1];
  state.selectedGroupId.value = 'two';
  state.groupError.value = '新群提示';
  await nextTick();
  expect(signal.aborted).toBe(true);
  pending.reject(new Error('旧群失败'));
  await opening;
  expect(state.groupError.value).toBe('新群提示');
  expect(state.management.value).toBeNull();
});

it('离开再返回同群，旧请求也不能重新弹出管理窗口', async () => {
  const { state, app } = setup();
  const pending = deferred<GroupDetail>();
  state.findGroup.mockReturnValue(pending.promise);
  const opening = app.openGroupAction('members');
  state.selectedGroupId.value = 'two';
  await nextTick();
  state.selectedGroupId.value = 'one';
  await nextTick();
  pending.resolve(detail('one'));
  await opening;
  expect(state.management.value).toBeNull();
});

it('后一次菜单操作替代前一次，当前有效请求仍可打开编辑窗口', async () => {
  const { state, app } = setup();
  const old = deferred<GroupDetail>();
  state.findGroup.mockReturnValueOnce(old.promise);
  const opening = app.openGroupAction('members');
  await app.openGroupAction('edit');
  old.resolve(detail('one'));
  await opening;
  expect(state.editorOpen.value).toBe(true);
  expect(state.editingGroup.value?.id).toBe('one');
  expect(state.management.value).toBeNull();
});

it('打开创建窗口后，迟到的菜单结果不能打开第二个弹窗', async () => {
  const { state, app } = setup();
  const pending = deferred<GroupDetail>();
  state.findGroup.mockReturnValue(pending.promise);
  const opening = app.openGroupAction('members');
  app.openEditor();
  pending.resolve(detail('one'));
  await opening;
  expect(state.editorOpen.value).toBe(true);
  expect(state.editingGroup.value).toBeNull();
  expect(state.management.value).toBeNull();
});

it('当前有效菜单请求失败仍明确显示错误', async () => {
  const { state, app } = setup();
  state.findGroup.mockRejectedValueOnce('unavailable');
  await app.openGroupAction('members');
  expect(state.groupError.value).toBe('无法读取群组，请重试。');
});

it('正常创建和凭码入群会选择该群、关闭弹窗，保持未加入语音', async () => {
  const { state, app } = setup();
  app.openEditor();
  await app.createGroupFromDialog('新群', '', '');
  expect(state.selectedGroupId.value).toBe('created');
  expect(state.groups.value.map((group) => group.id)).toEqual(['one', 'created']);
  expect(state.editorOpen.value).toBe(false);
  expect(state.refreshGroups).toHaveBeenCalledOnce();
  app.openEditor();
  app.joinedFromCode(detail('joined'));
  expect(state.selectedGroupId.value).toBe('joined');
  expect(state.editorOpen.value).toBe(false);
  expect(state.joinedGroupId.value).toBeNull();
});

it('旧创建结果不关闭新创建窗口，也不再读取群列表', async () => {
  const { state, app } = setup();
  const pending = deferred<GroupDetail>();
  state.createGroup.mockReturnValueOnce(pending.promise);
  app.openEditor();
  const saving = app.createGroupFromDialog('旧群', '', '');
  app.closeGroupEditor();
  app.openEditor();
  pending.resolve(detail('old-created'));
  await saving;
  expect(state.editorOpen.value).toBe(true);
  expect(state.selectedGroupId.value).toBe('one');
  expect(state.refreshGroups).not.toHaveBeenCalled();
});

it('旧编辑结果不覆盖新窗口或群资料，请求仍绑定原群标识', async () => {
  const { state, app } = setup();
  await app.openGroupAction('edit');
  const pending = deferred<GroupDetail>();
  state.updateGroup.mockReturnValueOnce(pending.promise);
  const saving = app.createGroupFromDialog('修改名称', '', '');
  expect(state.updateGroup).toHaveBeenCalledWith('one', '修改名称', '', '');
  app.closeGroupEditor();
  app.openEditor();
  pending.resolve({ ...detail('one'), name: '旧修改' });
  await saving;
  expect(state.editorOpen.value).toBe(true);
  expect(state.selectedGroupDetail.value?.name).toBe('one');
});

it('当前编辑成功更新资料并关闭窗口，不改变选群或重新读取列表', async () => {
  const { state, app } = setup();
  await app.openGroupAction('edit');
  state.updateGroup.mockResolvedValueOnce({ ...detail('one'), name: '新名称' });
  await app.createGroupFromDialog('新名称', '', '');
  expect(state.selectedGroupDetail.value?.name).toBe('新名称');
  expect(state.groups.value[0].name).toBe('新名称');
  expect(state.selectedGroupId.value).toBe('one');
  expect(state.editorOpen.value).toBe(false);
  expect(state.refreshGroups).not.toHaveBeenCalled();
});

it('创建后的列表刷新迟到时，也不能关闭后打开的窗口', async () => {
  const { state, app } = setup();
  const refreshing = deferred<void>();
  const refreshStarted = deferred<void>();
  state.refreshGroups.mockImplementationOnce(() => { refreshStarted.resolve(); return refreshing.promise; });
  app.openEditor();
  const saving = app.createGroupFromDialog('旧群', '', '');
  await refreshStarted.promise;
  expect(state.refreshGroups).toHaveBeenCalledOnce();
  app.closeGroupEditor();
  app.openEditor();
  refreshing.resolve();
  await saving;
  expect(state.editorOpen.value).toBe(true);
  expect(state.selectedGroupId.value).toBe('one');
});

it('销毁 App 取消菜单读取并使未完成创建失效', async () => {
  const { state, app, scope } = setup();
  app.openEditor();
  const pending = deferred<GroupDetail>();
  state.createGroup.mockReturnValueOnce(pending.promise);
  const saving = app.createGroupFromDialog('旧群', '', '');
  const menu = deferred<GroupDetail>();
  state.findGroup.mockReturnValueOnce(menu.promise);
  const opening = app.openGroupAction('members');
  const signal = state.findGroup.mock.calls[0][1];
  scope.stop();
  expect(signal.aborted).toBe(true);
  pending.resolve(detail('old-created'));
  menu.resolve(detail('one'));
  await Promise.all([saving, opening]);
  expect(state.editorOpen.value).toBe(false);
  expect(state.management.value).toBeNull();
  expect(state.refreshGroups).not.toHaveBeenCalled();
});
