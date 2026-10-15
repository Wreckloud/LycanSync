export const MAX_AVATAR_SOURCE_PIXELS = 40_000_000;
export const AVATAR_CROP_SIZE = 512;
export const AVATAR_MAX_ZOOM = 9;

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
  rotation?: number;
}

export function zoomAvatarWithWheel(zoom: number, deltaY: number, deltaMode: number): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 280 : 1);
  return Math.max(1, Math.min(AVATAR_MAX_ZOOM, zoom * Math.exp(-Math.max(-200, Math.min(200, pixels)) / 1000)));
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
  rotation = 0,
): AvatarCrop {
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const coverage = Math.abs(cosine) + Math.abs(sine);
  // 旋转只提高防露白所需的最低倍率，不叠乘用户已经选择的放大倍率。
  const displayScale = viewportSize / Math.min(sourceWidth, sourceHeight) * Math.max(coverage, zoom);
  const size = viewportSize / displayScale;
  // 将拖动量转回图片坐标；四个裁剪角始终落在原图范围内。
  const marginX = Math.max(0, sourceWidth / 2 - size * coverage / 2);
  const marginY = Math.max(0, sourceHeight / 2 - size * coverage / 2);
  const shiftX = Math.max(-marginX, Math.min(marginX, (cosine * offsetX + sine * offsetY) / displayScale));
  const shiftY = Math.max(-marginY, Math.min(marginY, (-sine * offsetX + cosine * offsetY) / displayScale));
  return {
    x: sourceWidth / 2 - shiftX - size / 2,
    y: sourceHeight / 2 - shiftY - size / 2,
    size, rotation,
  };
}

export async function encodeAvatarCrop(
  source: ImageBitmap,
  crop: AvatarCrop,
): Promise<Blob> {
  if (!Number.isFinite(crop.x) || !Number.isFinite(crop.y) || !Number.isFinite(crop.size)
      || !Number.isFinite(crop.rotation ?? 0)
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
  context.translate(AVATAR_CROP_SIZE / 2, AVATAR_CROP_SIZE / 2);
  context.rotate((crop.rotation ?? 0) * Math.PI / 180);
  context.scale(AVATAR_CROP_SIZE / crop.size, AVATAR_CROP_SIZE / crop.size);
  context.drawImage(source, -crop.x - crop.size / 2, -crop.y - crop.size / 2);
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
