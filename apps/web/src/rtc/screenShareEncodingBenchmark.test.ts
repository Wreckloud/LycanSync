import { expect, it } from 'vitest';
import { hasValidEncodingCostStats } from '../../tests/desktop/fixtures/encodingCost';

const layer = { codec: 'video/H264', width: 1920, height: 1080, measuredFps: 120, measuredKbps: 8000, averageEncodeMs: 2 };
const lowLayer = { ...layer, width: 640, height: 360, measuredFps: 30 };

it('只有全部请求层实际编码且统计完整时，本次统计才有效', () => {
  expect(hasValidEncodingCostStats(2, [layer, lowLayer], 120, [])).toBe(true);
  expect(hasValidEncodingCostStats(3, [layer], 120, [])).toBe(false);
  expect(hasValidEncodingCostStats(2, [layer, { ...layer, measuredFps: 0 }], 120, [])).toBe(false);
  expect(hasValidEncodingCostStats(1, [{ ...layer, width: 480, height: 270 }], 120, [])).toBe(false);
  expect(hasValidEncodingCostStats(2, [layer, layer], 120, [])).toBe(false);
});

it('实际未达到目标帧率仍可记录有效统计，但不自动宣称可比较', () => {
  expect(hasValidEncodingCostStats(1, [{ ...layer, measuredFps: 30 }], 30, [])).toBe(true);
});

it('拒绝计数器重置、缺失统计、非 H.264 或连接失败的结果', () => {
  for (const invalid of [
    { ...layer, measuredFps: NaN }, { ...layer, measuredKbps: -1 },
    { ...layer, averageEncodeMs: null }, { ...layer, averageEncodeMs: Infinity },
    { ...layer, codec: 'video/VP8' },
  ]) expect(hasValidEncodingCostStats(1, [invalid], 120, [])).toBe(false);
  expect(hasValidEncodingCostStats(1, [layer], 0, [])).toBe(false);
  expect(hasValidEncodingCostStats(1, [layer], 120, ['ICE failed'])).toBe(false);
});
