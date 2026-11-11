import { computed, ref, watch, type Ref } from 'vue';
import type { AuthUser, ProfileUpdate } from '../auth/authApi';

export function useProfileDraft(
  user: Ref<AuthUser>,
  saveProfile: (profile: ProfileUpdate) => Promise<AuthUser>,
) {
  const savedNickname = ref(user.value.nickname);
  const savedAvatar = ref(user.value.avatar);
  const savedSignature = ref(user.value.signature ?? '');
  const nickname = ref(savedNickname.value);
  const avatar = ref(savedAvatar.value);
  const signature = ref(savedSignature.value);
  const busy = ref(false);
  const error = ref('');
  const errorField = ref<'avatar' | 'nickname' | 'signature' | null>(null);
  // 半角占一格，其余字符占两格；与服务端共用同一计数规则，不依赖设备字体。
  const nicknameError = computed(() => nickname.value.trim() !== savedNickname.value
    && [...nickname.value.trim()].reduce((width, character) => width + (character.codePointAt(0)! <= 0x7f ? 1 : 2), 0) > 16
    ? '昵称太长，请缩短一些（最多 8 个汉字或 16 个英文、数字）。' : '');
  const dirty = computed(() => nickname.value.trim() !== savedNickname.value || avatar.value !== savedAvatar.value
    || signature.value.trim() !== savedSignature.value);
  let pendingSave: Promise<boolean> | null = null;

  watch(nicknameError, (message, previous) => {
    if (!message && previous && errorField.value === 'nickname' && error.value === previous) {
      error.value = '';
      errorField.value = null;
    }
  });

  watch(user, (updated) => {
    if (nickname.value.trim() === savedNickname.value) nickname.value = updated.nickname;
    if (avatar.value === savedAvatar.value) avatar.value = updated.avatar;
    if (signature.value.trim() === savedSignature.value) signature.value = updated.signature ?? '';
    savedNickname.value = updated.nickname;
    savedAvatar.value = updated.avatar;
    savedSignature.value = updated.signature ?? '';
  }, { deep: true });

  function resetDraft() {
    nickname.value = savedNickname.value;
    avatar.value = savedAvatar.value;
    signature.value = savedSignature.value;
  }

  function save(field: typeof errorField.value = null): Promise<boolean> {
    if (pendingSave) return pendingSave;
    const profile = { nickname: nickname.value.trim(), avatar: avatar.value, signature: signature.value.trim() };
    if (!profile.nickname) {
      errorField.value = 'nickname';
      error.value = '昵称不能为空。';
      return Promise.resolve(false);
    }
    if (nicknameError.value) {
      errorField.value = 'nickname';
      error.value = nicknameError.value;
      return Promise.resolve(false);
    }
    const keepStoredSignature = profile.signature === savedSignature.value && profile.signature.length > 40;
    if (profile.signature.length > 40 && !keepStoredSignature) {
      errorField.value = 'signature';
      error.value = '个性签名最多 40 个字符。';
      return Promise.resolve(false);
    }
    if (!dirty.value) {
      nickname.value = profile.nickname;
      signature.value = profile.signature;
      error.value = '';
      return Promise.resolve(true);
    }
    busy.value = true;
    error.value = '';
    errorField.value = field;
    pendingSave = Promise.resolve().then(async () => {
      try {
        // 旧签名不截断；仅修改昵称或头像时省略签名，沿用服务端保留语义。
        const updated = await saveProfile(keepStoredSignature ? { nickname: profile.nickname, avatar: profile.avatar } : profile);
        if (typeof updated.signature !== 'string') {
          throw new Error('无法确认签名是否保存成功，请重新打开资料查看。');
        }
        savedNickname.value = updated.nickname;
        savedAvatar.value = updated.avatar;
        savedSignature.value = updated.signature;
        if (nickname.value.trim() === profile.nickname) nickname.value = updated.nickname;
        if (avatar.value === profile.avatar) avatar.value = updated.avatar;
        if (signature.value.trim() === profile.signature) signature.value = updated.signature;
        return !dirty.value;
      } catch (exception) {
        error.value = exception instanceof Error ? exception.message : '保存资料失败';
        return false;
      }
    }).finally(() => {
      busy.value = false;
      pendingSave = null;
    });
    return pendingSave;
  }

  return { nickname, nicknameError, avatar, signature, busy, error, errorField, dirty, save, resetDraft };
}
