import type { ScreenShareQualityId } from './screenShareQuality';
import { screenShareQuality } from './screenShareQuality';

export interface ScreenShareEncodingLimits { maxBitrate?: number; maxFramerate?: number }

export function readScreenShareEncoding(sender: RTCRtpSender): ScreenShareEncodingLimits {
  const parameters = sender.getParameters();
  if (parameters.encodings.length !== 1) throw new Error('screenShareEncodingUnavailable');
  const { maxBitrate, maxFramerate } = parameters.encodings[0];
  return { maxBitrate, maxFramerate };
}

export async function applyScreenShareEncoding(sender: RTCRtpSender, limits: ScreenShareEncodingLimits) {
  // 每次读取最新参数，保留 SDK 管理的 active、RID 和编码器字段；不重发布轨道。
  const parameters = sender.getParameters();
  if (parameters.encodings.length !== 1) throw new Error('screenShareEncodingUnavailable');
  const encoding = parameters.encodings[0];
  if (limits.maxBitrate === undefined) delete encoding.maxBitrate;
  else encoding.maxBitrate = limits.maxBitrate;
  if (limits.maxFramerate === undefined) delete encoding.maxFramerate;
  else encoding.maxFramerate = limits.maxFramerate;
  await sender.setParameters(parameters);
}

export function screenShareEncodingLimits(id: ScreenShareQualityId): { maxBitrate: number; maxFramerate: number } {
  const quality = screenShareQuality(id);
  return { maxBitrate: quality.bitrate, maxFramerate: quality.fps };
}
