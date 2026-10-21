import type { CustomScreenShareQuality, ScreenShareQualityId } from './screenShareQuality';
import { screenShareDegradationPreference, screenShareQuality, screenShareThumbnailPreset } from './screenShareQuality';

type EncodingLimits = Pick<RTCRtpEncodingParameters, 'rid' | 'maxBitrate' | 'maxFramerate' | 'scaleResolutionDownBy'>;
export interface ScreenShareEncodingLimits {
  encodings: EncodingLimits[];
  degradationPreference?: RTCDegradationPreference;
}

function validateEncodings(encodings: RTCRtpEncodingParameters[]) {
  // 极小来源可由 SDK 发布为单层；正常双层固定为 q、h，拒绝未知布局。
  if (encodings.length === 1) return;
  if (encodings.length !== 2 || encodings[0].rid !== 'q' || encodings[1].rid !== 'h') {
    throw new Error('screenShareEncodingUnavailable');
  }
}

export function readScreenShareEncoding(sender: RTCRtpSender): ScreenShareEncodingLimits {
  const parameters = sender.getParameters();
  validateEncodings(parameters.encodings);
  return { encodings: parameters.encodings.map(({ rid, maxBitrate, maxFramerate, scaleResolutionDownBy }) =>
    ({ rid, maxBitrate, maxFramerate, scaleResolutionDownBy })), degradationPreference: parameters.degradationPreference };
}

export async function applyScreenShareEncoding(sender: RTCRtpSender, limits: ScreenShareEncodingLimits) {
  // 读取最新参数，保留 SDK 管理的 active 和优先级，回滚也不得唤醒无人观看的层。
  const parameters = sender.getParameters();
  validateEncodings(parameters.encodings);
  if (parameters.encodings.length !== limits.encodings.length) throw new Error('screenShareEncodingUnavailable');
  parameters.encodings.forEach((encoding, index) => {
    const limit = limits.encodings[index];
    if (encoding.rid !== limit.rid) throw new Error('screenShareEncodingUnavailable');
    for (const key of ['maxBitrate', 'maxFramerate', 'scaleResolutionDownBy'] as const) {
      if (limit[key] === undefined) delete encoding[key];
      else encoding[key] = limit[key];
    }
  });
  if (limits.degradationPreference === undefined) delete parameters.degradationPreference;
  else parameters.degradationPreference = limits.degradationPreference;
  await sender.setParameters(parameters);
}

export function screenShareEncodingLimits(id: ScreenShareQualityId, current: ScreenShareEncodingLimits,
  dimensions: { width: number; height: number }, custom?: CustomScreenShareQuality): ScreenShareEncodingLimits {
  const quality = screenShareQuality(id, custom);
  const thumbnail = screenShareThumbnailPreset();
  const scale = Math.min(1, quality.width / dimensions.width, quality.height / dimensions.height);
  const thumbnailShortSide = Math.min(thumbnail.width, thumbnail.height);
  return {
    degradationPreference: screenShareDegradationPreference(id),
    encodings: current.encodings.map((encoding, index) => {
      if (current.encodings.length === 2 && index === 0) {
        return {
          rid: encoding.rid,
          maxBitrate: thumbnail.encoding.maxBitrate,
          maxFramerate: Math.min(quality.fps, thumbnail.encoding.maxFramerate!),
          scaleResolutionDownBy: Math.max(1, Math.min(dimensions.width, dimensions.height) * scale / thumbnailShortSide),
        };
      }
      return {
        rid: encoding.rid,
        maxBitrate: quality.bitrate,
        maxFramerate: quality.fps,
        scaleResolutionDownBy: encoding.scaleResolutionDownBy,
      };
    }),
  };
}
