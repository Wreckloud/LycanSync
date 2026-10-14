import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { AuthUser, ProfileUpdate } from '../auth/authApi';
import { useProfileDraft } from './useProfileDraft';

const initialUser: AuthUser = {
  id: 'profile-user', nickname: '初始昵称', avatar: '', administrator: false,
  signature: '', createdAt: '2026-09-06T08:00:00Z',
};

function setup(saveProfile = vi.fn(async (profile: ProfileUpdate) => ({ ...initialUser, ...profile }))) {
  const scope = effectScope();
  const user = ref({ ...initialUser });
  const draft = scope.run(() => useProfileDraft(user, saveProfile))!;
  return { scope, user, draft, saveProfile };
}

describe('个人资料草稿与保存', () => {
  it('仅编辑草稿不会提交，首次资料页可以直接跳过', async () => {
    const { scope, draft, saveProfile } = setup();
    draft.nickname.value = '草稿昵称';
    draft.avatar.value = 'data:image/png;base64,AAAA';
    draft.signature.value = '草稿签名';
    await nextTick();
    expect(saveProfile).not.toHaveBeenCalled();
    scope.stop();
  });

  it('只聚焦或没有实质修改时不提交', async () => {
    const { scope, draft, saveProfile } = setup();
    expect(await draft.save()).toBe(true);
    draft.nickname.value = ' 初始昵称 ';
    expect(await draft.save()).toBe(true);
    expect(draft.nickname.value).toBe('初始昵称');
    expect(saveProfile).not.toHaveBeenCalled();
    scope.stop();
  });

  it('保存昵称和头像，并采用服务端规范值', async () => {
    const saveProfile = vi.fn(async (profile: ProfileUpdate) => ({ ...initialUser, ...profile,
      nickname: '规范昵称', avatar: 'data:image/png;base64,normalized' }));
    const { scope, draft } = setup(saveProfile);
    draft.nickname.value = ' 新昵称 ';
    draft.avatar.value = 'data:image/png;base64,AAAA';
    expect(await draft.save()).toBe(true);
    expect(saveProfile).toHaveBeenCalledWith({ nickname: '新昵称', avatar: 'data:image/png;base64,AAAA', signature: '' });
    expect(draft.nickname.value).toBe('规范昵称');
    expect(draft.avatar.value).toBe('data:image/png;base64,normalized');
    expect(await draft.save()).toBe(true);
    expect(saveProfile).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('失焦和关闭同时触发时共用同一次请求', async () => {
    let complete!: (user: AuthUser) => void;
    const saveProfile = vi.fn(() => new Promise<AuthUser>((resolve) => { complete = resolve; }));
    const { scope, draft } = setup(saveProfile);
    draft.nickname.value = '新昵称';
    const first = draft.save();
    const second = draft.save();
    expect(second).toBe(first);
    expect(draft.busy.value).toBe(true);
    await nextTick();
    complete({ ...initialUser, nickname: '新昵称' });
    expect(await second).toBe(true);
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(draft.busy.value).toBe(false);
    scope.stop();
  });

  it('首次资料提交失败保留修改，下一次保存可以重试', async () => {
    const { scope, draft, saveProfile } = setup();
    saveProfile.mockRejectedValueOnce(new Error('暂时无法保存'));
    draft.nickname.value = '保留草稿';
    expect(await draft.save()).toBe(false);
    expect(draft.nickname.value).toBe('保留草稿');
    expect(draft.error.value).toBe('暂时无法保存');
    expect(await draft.save()).toBe(true);
    expect(draft.error.value).toBe('');
    scope.stop();
  });

  it('日常设置回退到最近确认的服务端值，保留保存失败提示', async () => {
    const { scope, draft, user, saveProfile } = setup();
    user.value = { ...initialUser, nickname: '最新昵称', avatar: '已保存头像', signature: '已保存签名' };
    await nextTick();
    draft.nickname.value = '失败的修改';
    draft.avatar.value = '失败的新头像';
    draft.signature.value = '失败的新签名';
    saveProfile.mockRejectedValueOnce(new Error('服务暂不可用'));
    expect(await draft.save()).toBe(false);
    draft.resetDraft();
    expect(draft.nickname.value).toBe('最新昵称');
    expect(draft.avatar.value).toBe('已保存头像');
    expect(draft.signature.value).toBe('已保存签名');
    expect(draft.dirty.value).toBe(false);
    expect(draft.error.value).toBe('服务暂不可用');
    scope.stop();
  });

  it('空昵称明确提示，不提交', async () => {
    const { scope, draft, saveProfile } = setup();
    draft.nickname.value = '  ';
    expect(await draft.save()).toBe(false);
    expect(draft.error.value).toBe('昵称不能为空。');
    expect(saveProfile).not.toHaveBeenCalled();
    scope.stop();
  });

  it('保存与清空签名，不修改注册时间', async () => {
    const { scope, draft, saveProfile } = setup();
    draft.signature.value = ' 一起开黑\n一起看 ';
    expect(await draft.save()).toBe(true);
    expect(saveProfile).toHaveBeenLastCalledWith({ nickname: '初始昵称', avatar: '', signature: '一起开黑\n一起看' });
    expect(draft.signature.value).toBe('一起开黑\n一起看');
    draft.signature.value = '';
    expect(await draft.save()).toBe(true);
    expect(saveProfile).toHaveBeenLastCalledWith({ nickname: '初始昵称', avatar: '', signature: '' });
    scope.stop();
  });

  it('超长签名不提交，草稿保留', async () => {
    const { scope, draft, saveProfile } = setup();
    draft.signature.value = '字'.repeat(121);
    expect(await draft.save()).toBe(false);
    expect(saveProfile).not.toHaveBeenCalled();
    expect(draft.error.value).toBe('个性签名最多 120 个字符。');
    expect(draft.signature.value).toHaveLength(121);
    scope.stop();
  });

  it('缺少签名的旧资料也沿用当前签名提交约定，不保留旧服务保存分支', async () => {
    const { scope, draft, user, saveProfile } = setup();
    const { signature: _signature, ...legacyUser } = initialUser;
    user.value = legacyUser;
    await nextTick();
    draft.nickname.value = '新昵称';
    expect(await draft.save()).toBe(true);
    expect(saveProfile).toHaveBeenCalledWith({ nickname: '新昵称', avatar: '', signature: '' });
    scope.stop();
  });

  it('服务端未返回签名时不能伪报保存成功', async () => {
    const { signature: _signature, ...legacyUser } = initialUser;
    const saveProfile = vi.fn(async () => legacyUser);
    const { scope, draft } = setup(saveProfile);
    draft.signature.value = '保留草稿';
    expect(await draft.save()).toBe(false);
    expect(draft.error.value).toBe('服务端未返回签名，无法确认保存结果。');
    expect(draft.signature.value).toBe('保留草稿');
    scope.stop();
  });

  it('服务器刷新未编辑字段，不覆盖正在编辑的昵称和签名', async () => {
    const { scope, draft, user } = setup();
    draft.nickname.value = '正在编辑';
    draft.signature.value = '签名草稿';
    user.value = { ...initialUser, nickname: '外部更新', avatar: 'new-avatar', signature: '外部签名' };
    await nextTick();
    expect(draft.nickname.value).toBe('正在编辑');
    expect(draft.avatar.value).toBe('new-avatar');
    expect(draft.signature.value).toBe('签名草稿');
    scope.stop();
  });
});
