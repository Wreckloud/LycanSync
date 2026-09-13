export const MAX_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_AVATAR_SOURCE_PIXELS = 40_000_000;
export const MAX_AVATAR_OUTPUT_BYTES = 96 * 1024;
export const AVATAR_OUTPUT_SIZE = 256;

const OUTPUT_SIZES = [AVATAR_OUTPUT_SIZE, 224, 192];
const JPEG_QUALITIES = [0.9, 0.82, 0.74];
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

export async function decodeAvatarFile(file: File): Promise<ImageBitmap> {
  if (!ACCEPTED_TYPES.has(file.type)) {
    throw new AvatarImageError('请选择 PNG 或 JPEG 图片。');
  }
  if (file.size > MAX_AVATAR_SOURCE_BYTES) {
    throw new AvatarImageError('原图不能超过 10 MB。');
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
  sourceType: string,
): Promise<Blob> {
  if (!Number.isFinite(crop.x) || !Number.isFinite(crop.y) || !Number.isFinite(crop.size)
      || crop.size <= 0) {
    throw new AvatarImageError('头像裁剪区域无效。');
  }
  const outputType = sourceType === 'image/png' ? 'image/png' : 'image/jpeg';
  const qualities = outputType === 'image/png' ? [undefined] : JPEG_QUALITIES;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new AvatarImageError('当前设备无法处理头像图片。');
  for (const outputSize of OUTPUT_SIZES) {
    canvas.width = outputSize;
    canvas.height = outputSize;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.clearRect(0, 0, outputSize, outputSize);
    context.drawImage(
      source,
      crop.x,
      crop.y,
      crop.size,
      crop.size,
      0,
      0,
      outputSize,
      outputSize,
    );
    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, outputType, quality);
      if (blob && blob.size <= MAX_AVATAR_OUTPUT_BYTES) return blob;
    }
  }
  throw new AvatarImageError('图片内容过于复杂，无法压缩到 96 KB 以内。');
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AvatarImageError('无法读取处理后的头像。'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
