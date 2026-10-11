import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasExpectedEncodingDimensions, hasValidEncodingCostStats } from './fixtures/encodingCost';
import { startEncodingBenchmarkServer } from './fixtures/encodingBenchmarkServer';

// 编码测量会占用 CPU/GPU，只由明确的定向命令运行，不混入普通桌面回归。
test.skip(process.env.LYCANSYNC_RUN_ENCODING_BENCHMARK !== '1', '需明确启用合成编码测量');

for (const layerCount of [1, 2, 3]) {
  test(`合成屏幕 H.264 ${layerCount} 层编码成本`, async ({}, testInfo) => {
    test.setTimeout(60_000);
    const server = await startEncodingBenchmarkServer();
    let application: ElectronApplication | undefined;
    try {
      const directory = testInfo.outputPath('encoding-client');
      mkdirSync(directory, { recursive: true });
      const entry = resolve(directory, 'entry.cjs');
      writeFileSync(entry, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  window.loadURL(${JSON.stringify(server.url)});
});
`);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      delete env.ELECTRON_RUN_AS_NODE;
      application = await electron.launch({ args: [entry, '--user-data-dir=' + resolve(directory, 'profile')], env });
      const page = await application.firstWindow();
      await page.waitForLoadState();
      await page.waitForFunction(() => Boolean((window as unknown as { livekit: unknown }).livekit));
      // 保留正常硬件加速；只创建测试进程，不加载生产主进程或连接业务服务。
      const environment = await application.evaluate(({ app }) => ({
        versions: process.versions,
        gpuFeatures: app.getGPUFeatureStatus(),
      }));
      await page.evaluate(async ({ count, url, publisherToken, receiverToken }) => {
        const sdk = (window as unknown as { livekit: typeof import('livekit-client') }).livekit;
        // 本次要比较所有发送层的成本，关闭层暂停；正式应用继续使用自己的 dynacast 策略。
        const publisher = new sdk.Room({ adaptiveStream: false, dynacast: false });
        const receiver = new sdk.Room({ adaptiveStream: false });
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const context = canvas.getContext('2d')!;
        const stream = canvas.captureStream(0);
        const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        document.body.append(video);
        let interval: ReturnType<typeof setInterval> | undefined;
        let drawnFrames = 0;
        const failures: string[] = [];
        publisher.on(sdk.RoomEvent.Disconnected, () => failures.push('publisher disconnected'));
        receiver.on(sdk.RoomEvent.Disconnected, () => failures.push('receiver disconnected'));
        const localTrack = new sdk.LocalVideoTrack(track, undefined, true);
        let receivedTrack: import('livekit-client').RemoteTrack | undefined;
        receiver.on(sdk.RoomEvent.TrackSubscribed, (remoteTrack) => {
          if (remoteTrack.kind !== 'video') return;
          receivedTrack = remoteTrack;
          remoteTrack.attach(video);
        });
        (window as unknown as { encodingBenchmark: unknown }).encodingBenchmark = {
          sender: () => localTrack.sender, receivedTrack: () => receivedTrack, failures,
          frames: () => drawnFrames,
          stop: async () => {
            clearInterval(interval);
            await Promise.all([publisher.disconnect(), receiver.disconnect()]);
            stream.getTracks().forEach((track) => track.stop());
            video.srcObject = null;
            video.remove();
          },
        };
        // 固定内容与绘制节奏；绘制不足 120 帧会如实计入结果，不用目标值代替实测。
        interval = setInterval(() => {
          context.fillStyle = '#151b21';
          context.fillRect(0, 0, canvas.width, canvas.height);
          for (let index = 0; index < 32; index++) {
            context.fillStyle = `hsl(${index * 11}, 65%, 55%)`;
            context.fillRect((drawnFrames * 9 + index * 61) % canvas.width, index * 33, 100, 28);
          }
          drawnFrames++;
          track.requestFrame();
        }, 1000 / 120);
        await receiver.connect(url, receiverToken);
        await publisher.connect(url, publisherToken);
        const layers = [];
        if (count >= 2) layers.push(new sdk.VideoPreset(640, 360, 1_000_000, 30));
        if (count === 3) layers.push(new sdk.VideoPreset(1280, 720, 8_000_000, 120));
        await publisher.localParticipant.publishTrack(localTrack, {
          source: sdk.Track.Source.ScreenShare, videoCodec: 'h264', simulcast: count > 1,
          screenShareEncoding: { maxBitrate: 20_000_000, maxFramerate: 120, priority: 'high' },
          screenShareSimulcastLayers: layers, degradationPreference: 'maintain-framerate',
        });
      }, { count: layerCount, url: server.livekitUrl, publisherToken: server.publisherToken, receiverToken: server.receiverToken });

      async function sample() {
        return page.evaluate(async () => {
          const state = (window as unknown as { encodingBenchmark: {
            sender(): RTCRtpSender; receivedTrack(): import('livekit-client').RemoteTrack | undefined;
            failures: string[]; frames(): number;
          } }).encodingBenchmark;
          const report = await state.sender().getStats();
          const layers: Array<Record<string, unknown>> = [];
          report.forEach((stat) => {
            if (stat.type !== 'outbound-rtp' || (stat.kind ?? stat.mediaType) !== 'video' || stat.isRemote) return;
            layers.push({ id: stat.rid ?? stat.id, timestamp: stat.timestamp, frames: stat.framesEncoded,
              bytes: stat.bytesSent, width: stat.frameWidth, height: stat.frameHeight,
              encodeTime: stat.totalEncodeTime, encoder: stat.encoderImplementation,
              limitation: stat.qualityLimitationReason, codec: report.get(stat.codecId)?.mimeType });
          });
          return { timestamp: performance.now(), drawnFrames: state.frames(), layers,
            parameters: state.sender().getParameters(), failures: state.failures.slice(),
            receiving: state.receivedTrack()?.mediaStreamTrack.readyState === 'live' };
        });
      }
      await expect.poll(async () => (await sample()).layers.some((layer) => Number(layer.frames) > 0)).toBe(true);
      await expect.poll(async () => (await sample()).receiving).toBe(true);
      // 带宽估计尚未稳定时可能降分辨率或暂停层，不能拿它和全尺寸编码比较。
      await page.waitForTimeout(10_000);
      const warmupDeadline = Date.now() + 25_000;
      while (!hasExpectedEncodingDimensions(layerCount, (await sample()).layers.map((layer) => ({
        width: layer.width, height: layer.height,
      }))) && Date.now() < warmupDeadline) await page.waitForTimeout(1000);
      await application.evaluate(({ app }) => app.getAppMetrics());
      const start = await sample();
      const processSamples = [];
      for (let index = 0; index < 5; index++) {
        await page.waitForTimeout(1000);
        processSamples.push(await application!.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({
          type: metric.type, cpuPercent: metric.cpu.percentCPUUsage, memoryKb: metric.memory.workingSetSize,
        }))));
      }
      const end = await sample();
      const seconds = (end.timestamp - start.timestamp) / 1000;
      const layers = end.layers.map((layer) => {
        const before = start.layers.find((entry) => entry.id === layer.id);
        const frames = Number(layer.frames) - Number(before?.frames);
        return { ...layer, codec: layer.codec, width: layer.width, height: layer.height, measuredFps: frames / seconds,
          measuredKbps: (Number(layer.bytes) - Number(before?.bytes)) * 8 / seconds / 1000,
          averageEncodeMs: frames > 0 ? (Number(layer.encodeTime) - Number(before?.encodeTime)) * 1000 / frames : null };
      });
      const sourceFps = (end.drawnFrames - start.drawnFrames) / seconds;
      const statisticsValid = hasValidEncodingCostStats(layerCount, layers, sourceFps, end.failures);
      const result = { room: server.room, requestedLayers: layerCount, statisticsValid,
        limitation: 'LiveKit 合成测试含发送和接收进程开销，不能代替真实屏幕、游戏与异地网络验收',
        environment, sourceFps,
        start, end, layers, processSamples };
      const reportPath = testInfo.outputPath('encoding-cost.json');
      writeFileSync(reportPath, JSON.stringify(result, null, 2));
      await testInfo.attach('encoding-cost.json', { path: reportPath, contentType: 'application/json' });
      // 无效统计也先保存原始数据；有效统计不等于各次实际输出相同。
      expect(end.failures).toEqual([]);
      expect(statisticsValid, '未输出全部请求层或统计无效，请检查原始记录').toBe(true);
    } finally {
      try {
        const windows = application?.windows() ?? [];
        if (windows.length) await windows[0].evaluate(async () => {
          await (window as unknown as { encodingBenchmark?: { stop(): Promise<void> } }).encodingBenchmark?.stop();
        });
      } finally {
        try { await application?.close(); }
        finally { await server.close(); }
      }
    }
  });
}
