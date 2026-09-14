export const MAX_ORIGINAL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 8_294_400;
const MAX_COMPRESSED_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_COMPRESSED_OUTPUT_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg']);

export class ChatImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatImageError';
  }
}

export async function prepareOriginalImage(file: File): Promise<File> {
  await validateImage(file, MAX_ORIGINAL_IMAGE_BYTES);
  return file;
}

export async function compressChatImage(file: File): Promise<File> {
  if (!ACCEPTED_TYPES.has(file.type)) throw new ChatImageError('目前仅支持 PNG 或 JPEG 图片。');
  if (file.size > MAX_COMPRESSED_SOURCE_BYTES) throw new ChatImageError('待压缩图片不能超过 10 MB。');
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ChatImageError('图片已损坏或无法读取。');
  }
  try {
    if (source.width <= 0 || source.height <= 0 || source.width * source.height > 40_000_000) {
      throw new ChatImageError('图片尺寸过大，请选择不超过 4000 万像素的图片。');
    }
    const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const widths = [2560, 2048, 1600].map((edge) => Math.min(edge, Math.max(source.width, source.height)));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new ChatImageError('当前设备无法处理图片。');
    for (const edge of [...new Set(widths)]) {
      const scale = edge / Math.max(source.width, source.height);
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      for (const quality of outputType === 'image/png' ? [undefined] : [0.9, 0.82, 0.74]) {
        const blob = await canvasToBlob(canvas, outputType, quality);
        if (blob && blob.size <= MAX_COMPRESSED_OUTPUT_BYTES) {
          return new File([blob], outputType === 'image/png' ? 'image.png' : 'image.jpg', { type: outputType });
        }
      }
    }
    throw new ChatImageError('图片内容过于复杂，无法压缩到 2 MB 以内。请使用加号选择原图。');
  } finally {
    source.close();
  }
}

async function validateImage(file: File, maxBytes: number) {
  if (!ACCEPTED_TYPES.has(file.type)) throw new ChatImageError('目前仅支持 PNG 或 JPEG 图片。');
  if (file.size > maxBytes) throw new ChatImageError('原图不能超过 5 MB。');
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ChatImageError('图片已损坏或无法读取。');
  }
  try {
    if (source.width <= 0 || source.height <= 0 || source.width * source.height > MAX_IMAGE_PIXELS) {
      throw new ChatImageError('图片尺寸不能超过 829 万像素。');
    }
  } finally {
    source.close();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
