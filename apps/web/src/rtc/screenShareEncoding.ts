import type { CustomScreenShareQuality, ScreenShareQualityId } from './screenShareQuality';
import { screenShareDegradationPreference, screenShareLowerLayers, screenShareQuality } from './screenShareQuality';

type EncodingLimits = Pick<RTCRtpEncodingParameters, 'rid' | 'maxBitrate' | 'maxFramerate' | 'scaleResolutionDownBy'>;
export interface ScreenShareEncodingLimits {
  encodings: EncodingLimits[];
  degradationPreference?: RTCDegradationPreference;
}

export function hasScreenShareSimulcast(encodings: RTCRtpEncodingParameters[]) {
  return encodings[0]?.rid === 'q' && encodings[1]?.rid === 'h'
    && (encodings.length === 2 || (encodings.length === 3 && encodings[2].rid === 'f'));
}

function validateEncodings(encodings: RTCRtpEncodingParameters[]) {
  // SDK 依据来源尺寸协商一到三层，不能在原 sender 上增删 RID。
  if (encodings.length !== 1 && !hasScreenShareSimulcast(encodings)) {
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
  const scale = Math.min(1, quality.width / dimensions.width, quality.height / dimensions.height);
  const scaled = { width: Math.round(dimensions.width * scale), height: Math.round(dimensions.height * scale) };
  const degradationPreference = screenShareDegradationPreference(id, custom);
  const layers = screenShareLowerLayers(scaled, current.encodings.length === 3, quality.bitrate, degradationPreference);
  return {
    degradationPreference,
    encodings: current.encodings.map((encoding, index) => {
      if (index < current.encodings.length - 1) {
        const layer = layers[index];
        return {
          rid: encoding.rid,
          maxBitrate: layer.encoding.maxBitrate,
          maxFramerate: Math.min(quality.fps, layer.encoding.maxFramerate!),
          scaleResolutionDownBy: Math.max(1, Math.min(scaled.width, scaled.height) / Math.min(layer.width, layer.height)),
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
