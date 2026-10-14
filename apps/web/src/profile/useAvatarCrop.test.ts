import { effectScope, ref } from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import { useAvatarCrop } from './useAvatarCrop';

afterEach(() => vi.unstubAllGlobals());

function selection(file: File) {
  const input = { files: [file], value: 'selected' };
  return { input, event: { target: input } as unknown as Event };
}

test('视频文件不进入裁剪器、不解码且允许重新选择', async () => {
  const decode = vi.fn();
  vi.stubGlobal('createImageBitmap', decode);
  const scope = effectScope();
  const error = ref('');
  const crop = scope.run(() => useAvatarCrop(error))!;
  const picked = selection(new File(['video'], 'clip.mp4', { type: 'video/mp4' }));
  await crop.pickAvatar(picked.event);
  expect(crop.cropSource.value).toBeNull();
  expect(error.value).toBe('请选择 PNG 或 JPEG 图片。');
  expect(decode).not.toHaveBeenCalled();
  expect(picked.input.value).toBe('');
  expect(crop.picking.value).toBe(false);
  scope.stop();
});

test('损坏图片在打开裁剪器前失败', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
  const scope = effectScope();
  const error = ref('');
  const crop = scope.run(() => useAvatarCrop(error))!;
  await crop.pickAvatar(selection(new File(['broken'], 'broken.png', { type: 'image/png' })).event);
  expect(crop.cropSource.value).toBeNull();
  expect(error.value).toBe('图片已损坏或无法读取。');
  scope.stop();
});

test('有效图片只解码一次，关闭裁剪时释放唯一位图', async () => {
  const bitmap = { width: 256, height: 256, close: vi.fn() };
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('createImageBitmap', decode);
  const revokeObjectURL = vi.fn();
  const createObjectURL = vi.fn(() => 'blob:avatar-preview');
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const scope = effectScope();
  const crop = scope.run(() => useAvatarCrop(ref('')))!;
  await crop.pickAvatar(selection(new File(['png'], 'avatar.png', { type: 'image/png' })).event);
  expect(decode).toHaveBeenCalledOnce();
  expect(crop.cropSource.value?.bitmap).toBe(bitmap);
  expect(crop.cropSource.value?.previewUrl).toBe('blob:avatar-preview');
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(bitmap.close).not.toHaveBeenCalled();
  crop.clearCrop();
  expect(crop.cropSource.value).toBeNull();
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:avatar-preview');
  scope.stop();
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
});

test('选择期间销毁界面，迟到解码释放位图、不打开裁剪器', async () => {
  let finish!: (bitmap: ImageBitmap) => void;
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise<ImageBitmap>((resolve) => { finish = resolve; })));
  const scope = effectScope();
  const error = ref('');
  const crop = scope.run(() => useAvatarCrop(error))!;
  const pending = crop.pickAvatar(selection(new File(['png'], 'avatar.png', { type: 'image/png' })).event);
  scope.stop();
  const bitmap = { width: 256, height: 256, close: vi.fn() } as unknown as ImageBitmap;
  finish(bitmap);
  await pending;
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(crop.cropSource.value).toBeNull();
  expect(error.value).toBe('');
});

test('已有头像本机解码，不请求被安装版 CSP 禁止的 data URL', async () => {
  const fetchAvatar = vi.fn().mockRejectedValue(new Error('CSP blocked'));
  vi.stubGlobal('fetch', fetchAvatar);
  const bitmap = { width: 256, height: 256, close: vi.fn() };
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:existing-avatar'), revokeObjectURL: vi.fn() });
  const scope = effectScope();
  const error = ref('');
  const crop = scope.run(() => useAvatarCrop(error))!;
  await crop.editAvatar('data:image/png;base64,YWJj');
  expect(fetchAvatar).not.toHaveBeenCalled();
  expect(decode).toHaveBeenCalledOnce();
  const file = decode.mock.calls[0][0] as File;
  expect(file.type).toBe('image/png');
  expect(await file.text()).toBe('abc');
  expect(crop.cropSource.value?.bitmap).toBe(bitmap);
  expect(error.value).toBe('');
  scope.stop();
  expect(bitmap.close).toHaveBeenCalledOnce();
});

test('销毁后迟到的已有头像解码释放位图，不重新打开裁剪器', async () => {
  let finish!: (bitmap: ImageBitmap) => void;
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise<ImageBitmap>((resolve) => { finish = resolve; })));
  const scope = effectScope();
  const crop = scope.run(() => useAvatarCrop(ref('')))!;
  const pending = crop.editAvatar('data:image/png;base64,YWJj');
  scope.stop();
  const bitmap = { width: 256, height: 256, close: vi.fn() } as unknown as ImageBitmap;
  finish(bitmap);
  await pending;
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(crop.cropSource.value).toBeNull();
});

test('非法已有头像保持裁剪器关闭并显示读取错误', async () => {
  const decode = vi.fn();
  vi.stubGlobal('createImageBitmap', decode);
  const scope = effectScope();
  const error = ref('');
  const crop = scope.run(() => useAvatarCrop(error))!;
  await crop.editAvatar('data:image/png;base64,%%%');
  expect(decode).not.toHaveBeenCalled();
  expect(crop.cropSource.value).toBeNull();
  expect(crop.picking.value).toBe(false);
  expect(error.value).toBe('无法读取当前头像，请更换图片。');
  scope.stop();
});
