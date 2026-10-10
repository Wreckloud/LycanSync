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
  const supportsSignature = computed(() => typeof user.value.signature === 'string');
  const busy = ref(false);
  const error = ref('');
  const dirty = computed(() => nickname.value.trim() !== savedNickname.value || avatar.value !== savedAvatar.value
    || (supportsSignature.value && signature.value.trim() !== savedSignature.value));
  let pendingSave: Promise<boolean> | null = null;

  watch(user, (updated) => {
    if (nickname.value.trim() === savedNickname.value) nickname.value = updated.nickname;
    if (avatar.value === savedAvatar.value) avatar.value = updated.avatar;
    if (signature.value.trim() === savedSignature.value) signature.value = updated.signature ?? '';
    savedNickname.value = updated.nickname;
    savedAvatar.value = updated.avatar;
    savedSignature.value = updated.signature ?? '';
  }, { deep: true });

  function save(): Promise<boolean> {
    if (pendingSave) return pendingSave;
    const profile: ProfileUpdate = { nickname: nickname.value.trim(), avatar: avatar.value };
    if (supportsSignature.value) profile.signature = signature.value.trim();
    if (!profile.nickname) {
      error.value = '昵称不能为空。';
      return Promise.resolve(false);
    }
    if (profile.signature !== undefined && profile.signature.length > 120) {
      error.value = '个性签名最多 120 个字符。';
      return Promise.resolve(false);
    }
    if (!dirty.value) {
      nickname.value = profile.nickname;
      if (profile.signature !== undefined) signature.value = profile.signature;
      error.value = '';
      return Promise.resolve(true);
    }
    busy.value = true;
    error.value = '';
    pendingSave = Promise.resolve().then(async () => {
      try {
        const updated = await saveProfile(profile);
        if (profile.signature !== undefined && typeof updated.signature !== 'string') {
          throw new Error('服务端未返回签名，无法确认保存结果。');
        }
        savedNickname.value = updated.nickname;
        savedAvatar.value = updated.avatar;
        savedSignature.value = updated.signature ?? '';
        if (nickname.value.trim() === profile.nickname) nickname.value = updated.nickname;
        if (avatar.value === profile.avatar) avatar.value = updated.avatar;
        if (profile.signature !== undefined && signature.value.trim() === profile.signature) signature.value = updated.signature!;
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

  return { nickname, avatar, signature, supportsSignature, busy, error, save };
}
