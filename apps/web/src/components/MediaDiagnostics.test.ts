import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { Room } from 'livekit-client';
import { expect, it } from 'vitest';
import MediaDiagnostics from './MediaDiagnostics.vue';
import { readVideoLayers } from '../rtc/mediaStats';
import type { MediaDiagnosticsSnapshot } from '../diagnostics/mediaDiagnostics';

it('面板展示未知和false编码线索，网络与缓冲值不标成端到端延迟', async () => {
  const stats = new Map([
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp: 1000, powerEfficientEncoder: false }],
    ['rr', { id: 'rr', type: 'remote-inbound-rtp', localId: 'video', timestamp: 900, roundTripTime: 0.045, fractionLost: 0.02 }],
  ]) as RTCStatsReport;
  const layers = readVideoLayers(stats, 'outbound-rtp', new Map(), 'track');
  const snapshot = { streams: [{ identity: 'local', name: '自己', direction: '发送', layers,
    sourceFrames: null, sourceFps: null, sourceIntervalMs: null, playbackFps: null,
    subscription: { subscribed: null, enabled: null, muted: false } }], failures: [] } as unknown as MediaDiagnosticsSnapshot;
  const html = await renderToString(createSSRApp(MediaDiagnostics, { room: {} as Room, statistics: snapshot }));
  expect(html).toContain('节能编码标志 否');
  expect(html).toContain('到 SFU RTT 45 ms');
  expect(html).toContain('SFU 报告丢包 2%');
  expect(html).toContain('不是端到端画面延迟');
  layers[0].powerEfficientEncoder = null;
  layers[0].roundTripMs = null; layers[0].receiverReportedLossPercent = null;
  const missing = await renderToString(createSSRApp(MediaDiagnostics, { room: {} as Room, statistics: snapshot }));
  expect(missing).toContain('节能编码标志 未知');
  expect(missing).toContain('本次采样没有新的接收报告');
});
