import { onScopeDispose, ref, shallowRef, type Ref } from 'vue';
import { AvatarImageError, decodeAvatarFile } from './avatarImage';

export interface AvatarCropSource {
  bitmap: ImageBitmap;
  previewUrl: string;
}

export function useAvatarCrop(error: Ref<string>) {
  const cropSource = shallowRef<AvatarCropSource | null>(null);
  const picking = ref(false);
  let selection = 0;
  let disposed = false;

  function clearCrop() {
    selection++;
    picking.value = false;
    cropSource.value?.bitmap.close();
    if (cropSource.value) URL.revokeObjectURL(cropSource.value.previewUrl);
    cropSource.value = null;
  }

  async function pickAvatar(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await loadAvatar(file);
  }

  async function editAvatar(avatar: string) {
    if (!avatar || disposed) return;
    clearCrop();
    const current = selection;
    picking.value = true;
    error.value = '';
    try {
      const header = /^data:(image\/(?:png|jpeg));base64,/.exec(avatar);
      if (!header) throw new AvatarImageError('此头像无法直接编辑，请更换图片。');
      // 已保存的头像就在内存中，直接解码；安装版 connect-src 不允许 fetch(data:)。
      const binary = atob(avatar.slice(header[0].length));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      await loadAvatar(new File([bytes], 'avatar', { type: header[1] }));
    } catch (exception) {
      if (!disposed && current === selection) error.value = exception instanceof AvatarImageError ? exception.message : '无法读取当前头像，请更换图片。';
    } finally {
      if (current === selection) picking.value = false;
    }
  }

  async function loadAvatar(file: File) {
    if (disposed) return;
    clearCrop();
    const current = selection;
    picking.value = true;
    error.value = '';
    let bitmap: ImageBitmap | null = null;
    try {
      // 先验证并解码，再打开裁剪；父级持有唯一位图，避免失败文件进入空裁剪器。
      bitmap = await decodeAvatarFile(file);
      if (current !== selection) return;
      // 原图只在本机预览，不复制成可能很大的 Base64 字符串。
      const previewUrl = URL.createObjectURL(file);
      cropSource.value = { bitmap, previewUrl };
      bitmap = null;
    } catch (exception) {
      if (current === selection) error.value = exception instanceof AvatarImageError ? exception.message : '无法读取头像文件，请重新选择。';
    } finally {
      bitmap?.close();
      if (current === selection) picking.value = false;
    }
  }

  onScopeDispose(() => { disposed = true; clearCrop(); });
  return { cropSource, picking, pickAvatar, editAvatar, clearCrop };
}
