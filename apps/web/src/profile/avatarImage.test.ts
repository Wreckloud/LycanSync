import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AvatarImageError,
  calculateAvatarCrop,
  decodeAvatarFile,
  encodeAvatarCrop,
  zoomAvatarWithWheel,
} from './avatarImage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('头像图片处理', () => {
  it('滚轮按比例缩放，上限扩展到 9 倍', () => {
    expect(zoomAvatarWithWheel(2, -100, 0)).toBeCloseTo(2 * Math.exp(0.1));
    expect(zoomAvatarWithWheel(2, 100, 0)).toBeCloseTo(2 * Math.exp(-0.1));
    expect(zoomAvatarWithWheel(9, -100, 0)).toBe(9);
    expect(zoomAvatarWithWheel(1, 100, 0)).toBe(1);
    expect(zoomAvatarWithWheel(2, 0, 0)).toBe(2);
  });

  it('兼容按行和按页的滚轮，单次大滚动不跳到边界', () => {
    expect(zoomAvatarWithWheel(2, -3, 1)).toBeCloseTo(2 * Math.exp(0.048));
    expect(zoomAvatarWithWheel(2, 1, 2)).toBeCloseTo(2 * Math.exp(-0.2));
    expect(zoomAvatarWithWheel(2, -10_000, 0)).toBeCloseTo(2 * Math.exp(0.2));
  });

  it('原图超过 10 MB 仍可解码，上传只使用裁剪区域', async () => {
    const source = bitmap(1200, 800);
    const decode = vi.fn().mockResolvedValue(source);
    vi.stubGlobal('createImageBitmap', decode);

    await expect(decodeAvatarFile({
      type: 'image/jpeg',
      size: 50 * 1024 * 1024,
    } as File)).resolves.toBe(source);
    expect(decode).toHaveBeenCalledOnce();
  });

  it('为透明 PNG 保留 PNG 输出格式', async () => {
    const { canvas, clearRect, drawImage, toBlob } = installCanvas((done, type) => {
      done(new Blob([new Uint8Array(128)], { type }));
    });
    const source = bitmap(1200, 800);

    const result = await encodeAvatarCrop(source, { x: 200, y: 0, size: 800 });

    expect(result.type).toBe('image/png');
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
    expect(clearRect).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(source, -600, -400);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  });

  it('把损坏图片转换为明确错误', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));

    await expect(decodeAvatarFile({ type: 'image/png', size: 128 } as File))
      .rejects.toEqual(new AvatarImageError('图片已损坏或无法读取。'));
  });

  it('裁剪 PNG 超过旧 96 KB 限制时仍提交，不在客户端反复降质', async () => {
    const mocked = installCanvas((done, type) => {
      done(new Blob([new Uint8Array(512 * 1024)], { type }));
    });
    const result = await encodeAvatarCrop(bitmap(800, 800), { x: 0, y: 0, size: 800 });
    expect(result.size).toBe(512 * 1024);
    expect(mocked.canvas.width).toBe(512);
    expect(mocked.toBlob).toHaveBeenCalledOnce();
  });

  it('生成裁剪图失败时显示明确错误', async () => {
    const { toBlob } = installCanvas((done) => done(null));

    await expect(encodeAvatarCrop(bitmap(800, 800), { x: 0, y: 0, size: 800 }))
      .rejects.toThrow('无法生成裁剪后的头像');
    expect(toBlob).toHaveBeenCalledOnce();
  });

  it('保留解码尺寸保护并释放过大位图', async () => {
    const source = bitmap(10000, 10000);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(source));
    await expect(decodeAvatarFile({ type: 'image/png' } as File)).rejects.toThrow('4000 万像素');
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('根据拖动和缩放位置计算原图裁剪区域', () => {
    expect(calculateAvatarCrop(1200, 800, 280, 2, 35, -70)).toEqual({
      x: 350,
      y: 300,
      size: 400,
      rotation: 0,
    });
  });

  it('旋转和极端拖动后四角仍位于原图中，不露空白', () => {
    for (const zoom of [1, 2, 9]) for (const rotation of [-180, -90, -45, 0, 30, 45, 90, 180]) {
      const crop = calculateAvatarCrop(1200, 800, 300, zoom, 10000, -10000, rotation);
      const radians = rotation * Math.PI / 180;
      for (const x of [-crop.size / 2, crop.size / 2]) {
        for (const y of [-crop.size / 2, crop.size / 2]) {
          const sourceX = crop.x + crop.size / 2 + Math.cos(radians) * x + Math.sin(radians) * y;
          const sourceY = crop.y + crop.size / 2 - Math.sin(radians) * x + Math.cos(radians) * y;
          expect(sourceX).toBeGreaterThanOrEqual(-0.000001);
          expect(sourceX).toBeLessThanOrEqual(1200.000001);
          expect(sourceY).toBeGreaterThanOrEqual(-0.000001);
          expect(sourceY).toBeLessThanOrEqual(800.000001);
        }
      }
    }
  });

  it('输出使用与预览相同的旋转和中心位置', async () => {
    const { translate, rotate, scale } = installCanvas((done, type) => done(new Blob(['png'], { type })));
    await encodeAvatarCrop(bitmap(800, 800), { x: 200, y: 200, size: 400, rotation: 90 });
    expect(translate).toHaveBeenCalledWith(256, 256);
    expect(rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(scale).toHaveBeenCalledWith(1.28, 1.28);
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
  const translate = vi.fn(); const rotate = vi.fn(); const scale = vi.fn();
  const toBlob = vi.fn((done: BlobCallback, type = 'image/png') => encode(done, type));
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ clearRect, drawImage, translate, rotate, scale })),
    toBlob,
  } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  return { canvas, clearRect, drawImage, toBlob, translate, rotate, scale };
}
