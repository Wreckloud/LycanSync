const tints = new Map<string, string>();
const CACHE_LIMIT = 8;

export function profileTint(pixels: Uint8ClampedArray): string | undefined {
  let weight = 0;
  const channels = [0, 0, 0];
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    weight += alpha;
    for (let channel = 0; channel < 3; channel++) channels[channel] += pixels[index + channel] * alpha;
  }
  if (!weight) return undefined;
  // 头像只给头部提供少量色调，正文和状态色继续使用应用原来的设计变量。
  const panel = [22, 27, 34];
  return `rgb(${channels.map((value, index) => Math.round(value / weight * 0.24 + panel[index] * 0.76)).join(', ')})`;
}

export function readAvatarTint(image: HTMLImageElement): string | undefined {
  const source = image.getAttribute('src');
  if (!source || !image.naturalWidth || !image.naturalHeight) return undefined;
  const cached = tints.get(source);
  if (cached) return cached;
  const canvas = image.ownerDocument.createElement('canvas');
  canvas.width = canvas.height = 24;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(image, 0, 0, 24, 24);
    const tint = profileTint(context.getImageData(0, 0, 24, 24).data);
    if (tint) {
      if (tints.size >= CACHE_LIMIT) tints.delete(tints.keys().next().value!);
      tints.set(source, tint);
    }
    return tint;
  } catch {
    // 取色只是装饰，图片不可读时保留面板色，不影响资料展示。
    return undefined;
  } finally { canvas.width = canvas.height = 0; }
}
