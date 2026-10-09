export interface ScreenStatusMessage {
  title: string;
  description: string;
}

/** 只绘制不含真实画面的状态帧，刷新频率与释放由所属视频会话负责。 */
export function createScreenStatusFrame(
  width: number,
  height: number,
  timestamp: number,
  message: ScreenStatusMessage,
): VideoFrame {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('screenStatusCanvasUnavailable');
  context.fillStyle = '#111820';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#f0f3f8';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `600 ${Math.max(18, Math.round(width / 34))}px sans-serif`;
  context.fillText(message.title, width / 2, height / 2 - 20, width);
  context.fillStyle = '#a8b2c2';
  context.font = `${Math.max(14, Math.round(width / 50))}px sans-serif`;
  context.fillText(message.description, width / 2, height / 2 + 28, width);
  return new VideoFrame(canvas, { timestamp });
}
