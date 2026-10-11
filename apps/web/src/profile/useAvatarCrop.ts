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

  onScopeDispose(clearCrop);
  return { cropSource, picking, pickAvatar, clearCrop };
}
