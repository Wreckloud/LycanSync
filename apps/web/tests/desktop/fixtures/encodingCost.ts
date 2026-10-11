export interface EncodingCostLayer {
  measuredFps: number;
  measuredKbps: number;
  averageEncodeMs: number | null;
  codec: unknown;
  width: unknown;
  height: unknown;
}

export function hasExpectedEncodingDimensions(requestedLayers: number, layers: Array<{ width: unknown; height: unknown }>): boolean {
  const expected = [[1920, 1080]];
  if (requestedLayers >= 2) expected.push([640, 360]);
  if (requestedLayers === 3) expected.push([1280, 720]);
  return layers.length === requestedLayers && expected.every(([width, height]) =>
    layers.some((layer) => layer.width === width && layer.height === height));
}

// 只校验本次统计有效性；跨次成本比较还需核对实际源帧率和各层输出。
export function hasValidEncodingCostStats(requestedLayers: number, layers: EncodingCostLayer[], sourceFps: number, failures: string[]): boolean {
  return Number.isFinite(sourceFps) && sourceFps > 0 && failures.length === 0
    && hasExpectedEncodingDimensions(requestedLayers, layers) && layers.every((layer) =>
      layer.codec === 'video/H264'
      && Number.isFinite(layer.measuredFps) && layer.measuredFps > 0
      && Number.isFinite(layer.measuredKbps) && layer.measuredKbps >= 0
      && layer.averageEncodeMs !== null && Number.isFinite(layer.averageEncodeMs) && layer.averageEncodeMs >= 0);
}
