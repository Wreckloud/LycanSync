import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { Room } from 'livekit-client';
import { expect, it } from 'vitest';
import MediaDiagnostics from './MediaDiagnostics.vue';
import { readVideoLayers } from '../rtc/mediaStats';
import type { MediaDiagnosticsSnapshot } from '../diagnostics/mediaDiagnostics';

it('面板分开显示用户目标和已确认采集目标，调整失败不冒充成功或实际 FPS', async () => {
  const statistics = { streams: [{ identity: 'member', name: '成员', direction: '发送', layers: [],
    subscription: { subscribed: null, enabled: null, muted: false },
    nativeInput: { requestedFrameRate: 120, captureFrameRate: 30, frameRateAdjustmentFailed: true },
  }], failures: [] } as unknown as MediaDiagnosticsSnapshot;
  const html = await renderToString(createSSRApp(MediaDiagnostics, { room: {} as Room, statistics }));
  expect(html).toContain('用户帧率目标 120 FPS');
  expect(html).toContain('已确认采集目标 30 FPS（非实测帧率）');
  expect(html).toContain('自动调整失败，请重新选择画质');
});

it.each(['发送', '接收'] as const)('面板按%s方向标注实际编解码帧率，接收丢帧不限定在解码阶段', async (direction) => {
  const layers = readVideoLayers(new Map([['video', { id: 'video', kind: 'video', timestamp: 1000,
    type: direction === '发送' ? 'outbound-rtp' : 'inbound-rtp', framesEncoded: 58, framesDecoded: 58, framesDropped: 3 }]]) as RTCStatsReport,
  direction === '发送' ? 'outbound-rtp' : 'inbound-rtp', new Map(), 'track');
  const statistics = { streams: [{ identity: 'member', name: '成员', direction, layers,
    subscription: { subscribed: true, enabled: true, muted: false } }], failures: [] } as unknown as MediaDiagnosticsSnapshot;
  const html = await renderToString(createSSRApp(MediaDiagnostics, { room: {} as Room, statistics }));
  expect(html).toContain(`${direction === '发送' ? '编码' : '解码'} 等待统计 fps`);
  expect(html).not.toContain('累计解码丢帧');
  if (direction === '接收') expect(html).toContain('累计接收丢帧 3');
});

it('OBS 面板区分区间渲染、滚动耗时与等待，零延误仍显示真实零', async () => {
  const statistics = { streams: [], failures: [], obsRenderInterval: null,
    native: { state: 'running', captureBackend: 'obsLibobs', obsRender: { activeFps: null, averageRenderMs: null } },
  } as unknown as MediaDiagnosticsSnapshot;
  const render = () => renderToString(createSSRApp(MediaDiagnostics, { room: {} as Room, statistics }));
  expect(await render()).toContain('等待统计');
  statistics.obsRenderInterval = { elapsedMs: 2500, totalFrames: 150, laggedFrames: 0, renderedFps: 60, laggedPercent: 0 };
  statistics.native!.obsRender!.activeFps = 59.8;
  statistics.native!.obsRender!.averageRenderMs = 1.25;
  const html = await render();
  expect(html).toContain('60 FPS');
  expect(html).toContain('区间延误 0 / 150');
  expect(html).toContain('59.8 FPS');
  expect(html).toContain('1.25 ms');
  expect(html).toContain('不代表不同来源帧、编码或端到端延迟');
});

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
