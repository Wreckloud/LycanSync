export const MAX_AVATAR_SOURCE_PIXELS = 40_000_000;
export const AVATAR_CROP_SIZE = 512;

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg']);

export class AvatarImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarImageError';
  }
}

export interface AvatarCrop {
  x: number;
  y: number;
  size: number;
}

export function zoomAvatarWithWheel(zoom: number, deltaY: number, deltaMode: number): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 280 : 1);
  return Math.max(1, Math.min(3, zoom - Math.max(-200, Math.min(200, pixels)) / 1000));
}

export async function decodeAvatarFile(file: File): Promise<ImageBitmap> {
  if (!ACCEPTED_TYPES.has(file.type)) {
    throw new AvatarImageError('请选择 PNG 或 JPEG 图片。');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new AvatarImageError('图片已损坏或无法读取。');
  }
  if (bitmap.width <= 0 || bitmap.height <= 0
      || bitmap.width * bitmap.height > MAX_AVATAR_SOURCE_PIXELS) {
    bitmap.close();
    throw new AvatarImageError('图片尺寸过大，请选择不超过 4000 万像素的图片。');
  }
  return bitmap;
}

export function calculateAvatarCrop(
  sourceWidth: number,
  sourceHeight: number,
  viewportSize: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
): AvatarCrop {
  const displayScale = viewportSize / Math.min(sourceWidth, sourceHeight) * zoom;
  const size = viewportSize / displayScale;
  const x = sourceWidth / 2 - (viewportSize / 2 + offsetX) / displayScale;
  const y = sourceHeight / 2 - (viewportSize / 2 + offsetY) / displayScale;
  return {
    x: Math.max(0, Math.min(sourceWidth - size, x)),
    y: Math.max(0, Math.min(sourceHeight - size, y)),
    size,
  };
}

export async function encodeAvatarCrop(
  source: ImageBitmap,
  crop: AvatarCrop,
): Promise<Blob> {
  if (!Number.isFinite(crop.x) || !Number.isFinite(crop.y) || !Number.isFinite(crop.size)
      || crop.size <= 0) {
    throw new AvatarImageError('头像裁剪区域无效。');
  }
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_CROP_SIZE;
  canvas.height = AVATAR_CROP_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new AvatarImageError('当前设备无法处理头像图片。');
  // 只提交用户选中的区域，保留透明度；最终尺寸和压缩由服务器统一处理。
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
  const blob = await canvasToBlob(canvas);
  if (!blob) throw new AvatarImageError('无法生成裁剪后的头像，请重试。');
  return blob;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AvatarImageError('无法读取处理后的头像。'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
