import { expect, it } from 'vitest';
import { audioCounters, readAudioQuality } from './audioQuality';

const baseline = { id: 'audio', timestamp: 1000, packetsReceived: 100, packetsLost: 2,
  totalSamplesReceived: 48000, concealedSamples: 100, concealmentEvents: 1,
  silentConcealedSamples: 20, jitterBufferDelay: 480, jitterBufferEmittedCount: 48000 };
it('丢包和迟到补偿按同一轨道区间计算，不把累计值当比例或端到端延迟', () => {
  expect(readAudioQuality({ ...baseline, timestamp: 3000, packetsReceived: 190, packetsLost: 12,
    totalSamplesReceived: 144000, concealedSamples: 4900, concealmentEvents: 4,
    jitterBufferDelay: 3360, jitterBufferEmittedCount: 144000 }, baseline)).toMatchObject({
    intervalMs: 2000, receivedPackets: 90, lostPackets: 10, lossPercent: 10,
    concealedSamples: 4800, concealmentPercent: 5, concealmentEvents: 3, jitterBufferMs: 30,
  });
});
it('首次、轨道重建、累计回退、零分母和缺失字段不伪造正常值', () => {
  expect(readAudioQuality(baseline, undefined).lossPercent).toBeNull();
  expect(readAudioQuality({ ...baseline, id: 'new', timestamp: 3000 }, baseline).intervalMs).toBeNull();
  expect(readAudioQuality({ ...baseline, timestamp: 3000, packetsLost: 0 }, baseline).lossPercent).toBeNull();
  expect(readAudioQuality({ ...baseline, timestamp: 3000 }, baseline).jitterBufferMs).toBeNull();
  const missing = audioCounters({ id: 'audio', timestamp: 3000, type: 'inbound-rtp' });
  expect(readAudioQuality(missing, baseline).concealmentPercent).toBeNull();
});
