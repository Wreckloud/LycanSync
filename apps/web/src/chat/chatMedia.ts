import type { ChatAttachment } from './chatApi';

export type ChatMediaKind = 'image' | 'video' | 'audio';

const formats: Record<string, { kind: ChatMediaKind; contentType: string }> = {
  png: { kind: 'image', contentType: 'image/png' },
  jpg: { kind: 'image', contentType: 'image/jpeg' },
  jpeg: { kind: 'image', contentType: 'image/jpeg' },
  gif: { kind: 'image', contentType: 'image/gif' },
  webp: { kind: 'image', contentType: 'image/webp' },
  avif: { kind: 'image', contentType: 'image/avif' },
  mp4: { kind: 'video', contentType: 'video/mp4' },
  webm: { kind: 'video', contentType: 'video/webm' },
  mov: { kind: 'video', contentType: 'video/quicktime' },
  m4v: { kind: 'video', contentType: 'video/mp4' },
  mkv: { kind: 'video', contentType: 'video/x-matroska' },
  '3gp': { kind: 'video', contentType: 'video/3gpp' },
  mp3: { kind: 'audio', contentType: 'audio/mpeg' },
  m4a: { kind: 'audio', contentType: 'audio/mp4' },
  ogg: { kind: 'audio', contentType: 'audio/ogg' },
  wav: { kind: 'audio', contentType: 'audio/wav' },
  flac: { kind: 'audio', contentType: 'audio/flac' },
};

export function chatMediaFormat(attachment: ChatAttachment) {
  // 普通文件接口统一返回 octet-stream，只按最后一个扩展名提供预览入口。
  const extension = attachment.fileName?.split('.').at(-1)?.toLowerCase();
  if (extension) return formats[extension] ?? null;
  return Object.values(formats).find(format => format.contentType === attachment.contentType) ?? null;
}

// 图片、动图和视频采用相同的原始比例与聊天区域尺寸上限。
export function chatMediaFrameStyle(width: number, height: number) {
  return {
    width: `min(100%, 420px, ${Math.min(width, 340 * width / height)}px)`,
    aspectRatio: `${width} / ${height}`,
  };
}
