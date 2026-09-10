import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AvatarImageError,
  MAX_AVATAR_OUTPUT_BYTES,
  MAX_AVATAR_SOURCE_BYTES,
  calculateAvatarCrop,
  decodeAvatarFile,
  encodeAvatarCrop,
} from './avatarImage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('头像图片处理', () => {
  it('在解码前拒绝超过 10 MB 的原图', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);

    await expect(decodeAvatarFile({
      type: 'image/jpeg',
      size: MAX_AVATAR_SOURCE_BYTES + 1,
    } as File)).rejects.toThrow('原图不能超过 10 MB');
    expect(decode).not.toHaveBeenCalled();
  });

  it('为透明 PNG 保留 PNG 输出格式', async () => {
    const { canvas, clearRect, drawImage, toBlob } = installCanvas((done, type) => {
      done(new Blob([new Uint8Array(128)], { type }));
    });
    const source = bitmap(1200, 800);

    const result = await encodeAvatarCrop(source, { x: 200, y: 0, size: 800 }, 'image/png');

    expect(result.type).toBe('image/png');
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
    expect(clearRect).toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(source, 200, 0, 800, 800, 0, 0, 512, 512);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });

  it('把损坏图片转换为明确错误', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));

    await expect(decodeAvatarFile({ type: 'image/png', size: 128 } as File))
      .rejects.toEqual(new AvatarImageError('图片已损坏或无法读取。'));
  });

  it('所有尺寸和质量都超限时报告压缩失败', async () => {
    const { toBlob } = installCanvas((done, type) => {
      done(new Blob([new Uint8Array(MAX_AVATAR_OUTPUT_BYTES + 1)], { type }));
    });

    await expect(encodeAvatarCrop(bitmap(800, 800), { x: 0, y: 0, size: 800 }, 'image/jpeg'))
      .rejects.toThrow('无法压缩到 512 KB 以内');
    expect(toBlob).toHaveBeenCalledTimes(12);
  });

  it('根据拖动和缩放位置计算原图裁剪区域', () => {
    expect(calculateAvatarCrop(1200, 800, 280, 2, 35, -70)).toEqual({
      x: 350,
      y: 300,
      size: 400,
    });
  });
});

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function installCanvas(
  encode: (done: BlobCallback, type: string) => void,
) {
  const clearRect = vi.fn();
  const drawImage = vi.fn();
  const toBlob = vi.fn((done: BlobCallback, type = 'image/png') => encode(done, type));
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ clearRect, drawImage })),
    toBlob,
  } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  return { canvas, clearRect, drawImage, toBlob };
}
