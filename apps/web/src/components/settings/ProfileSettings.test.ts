import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { effectScope, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { AuthUser, ProfileUpdate } from '../../auth/authApi';
import { useProfileDraft } from '../../profile/useProfileDraft';

const script = parse(readFileSync(new URL('./ProfileSettings.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('ProfileSettings.ts', script, ts.ScriptTarget.Latest, true);
const declaration = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'finishEditing');
if (!declaration) throw new Error('资料编辑回调不存在');
const compiled = ts.transpile(declaration.getText(sourceFile), { target: ts.ScriptTarget.ES2022 });
const initial: AuthUser = { id: 'member', nickname: '已保存昵称', avatar: '已保存头像', signature: '', administrator: false };

function setup() {
  const scope = effectScope();
  const user = ref({ ...initial });
  const saveProfile = vi.fn(async (profile: ProfileUpdate) => ({ ...initial, ...profile }));
  const draft = scope.run(() => useProfileDraft(user, saveProfile))!;
  // 执行设置页正式回调和真实草稿模型，控制服务端失败而不复制回退逻辑。
  const state = { ...draft, saveDraft: draft.save, editingNickname: ref(true), picking: ref(false), cropSource: ref(null) };
  const finish = runInNewContext(`${compiled}\nfinishEditing`, state) as () => Promise<boolean>;
  return { scope, user, draft, state, saveProfile, finish };
}

it('保存失败自动回退，仍允许结束编辑，下一次有修改时可正常保存', async () => {
  const { scope, draft, state, saveProfile, finish } = setup();
  try {
    draft.nickname.value = '未保存昵称';
    draft.avatar.value = '未保存头像';
    saveProfile.mockRejectedValueOnce(new Error('保存失败'));
    expect(await finish()).toBe(true);
    expect(draft.nickname.value).toBe(initial.nickname);
    expect(draft.avatar.value).toBe(initial.avatar);
    expect(draft.error.value).toBe('保存失败');
    expect(state.editingNickname.value).toBe(false);
    await finish();
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(draft.error.value).toBe('保存失败');
    draft.nickname.value = '下一次修改';
    expect(await finish()).toBe(true);
    expect(draft.nickname.value).toBe('下一次修改');
    expect(draft.error.value).toBe('');
  } finally { scope.stop(); }
});

it('非法昵称回退，不发送请求或阻止离开', async () => {
  const { scope, draft, saveProfile, finish } = setup();
  try {
    draft.nickname.value = '  ';
    expect(await finish()).toBe(true);
    expect(draft.nickname.value).toBe(initial.nickname);
    expect(draft.error.value).toBe('昵称不能为空。');
    expect(saveProfile).not.toHaveBeenCalled();
  } finally { scope.stop(); }
});

it('失焦与离开等待同一次保存，失败回退不会重复提交', async () => {
  const { scope, draft, saveProfile, finish } = setup();
  let reject!: (reason: Error) => void;
  saveProfile.mockImplementationOnce(() => new Promise<AuthUser>((_, fail) => { reject = fail; }));
  try {
    draft.signature.value = '未保存签名';
    const first = finish();
    const leaving = finish();
    await Promise.resolve();
    reject(new Error('暂时离线'));
    expect(await first).toBe(true);
    expect(await leaving).toBe(true);
    expect(draft.signature.value).toBe('');
    expect(draft.error.value).toBe('暂时离线');
    expect(saveProfile).toHaveBeenCalledTimes(1);
  } finally { scope.stop(); }
});

it('读取头像时等待处理，不提前结束编辑', async () => {
  const { scope, state, saveProfile, finish } = setup();
  try {
    state.picking.value = true;
    expect(await finish()).toBe(false);
    expect(state.editingNickname.value).toBe(true);
    expect(saveProfile).not.toHaveBeenCalled();
  } finally { scope.stop(); }
});
