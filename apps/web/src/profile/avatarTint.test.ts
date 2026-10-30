import { expect, it, vi } from 'vitest';
import { profileTint, readAvatarTint } from './avatarTint';

it('头像取色忽略透明像素，只给原面板混入少量颜色', () => {
  expect(profileTint(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0]))).toBe('rgb(78, 21, 26)');
  expect(profileTint(new Uint8ClampedArray([0, 0, 0, 0]))).toBeUndefined();
});

it('复用同一头像的取色结果，释放临时画布；更换头像重新计算', () => {
  const drawImage = vi.fn();
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 255, 0, 255]) }) }) };
  let source = 'avatar:first';
  const image = { getAttribute: () => source, naturalWidth: 256, naturalHeight: 256,
    ownerDocument: { createElement: () => canvas } } as unknown as HTMLImageElement;
  expect(readAvatarTint(image)).toBe('rgb(17, 82, 26)');
  expect(readAvatarTint(image)).toBe('rgb(17, 82, 26)');
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
  source = 'avatar:second';
  readAvatarTint(image);
  expect(drawImage).toHaveBeenCalledTimes(2);
});

it('图片读取失败只撤掉装饰，不影响卡片展示', () => {
  const canvas = { width: 0, height: 0, getContext: () => { throw new Error('unreadable'); } };
  const image = { getAttribute: () => 'avatar:unreadable', naturalWidth: 256, naturalHeight: 256,
    ownerDocument: { createElement: () => canvas } } as unknown as HTMLImageElement;
  expect(readAvatarTint(image)).toBeUndefined();
  expect(canvas.width).toBe(0);
});
