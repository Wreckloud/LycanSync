import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startEncodingBenchmarkServer } from './fixtures/encodingBenchmarkServer';

interface ScenarioWindow {
  livekit: typeof import('livekit-client');
  viewing: {
    sample(): Promise<{ encodings: RTCRtpEncodingParameters[]; width: number; height: number; decoded: number; enabled: boolean }>;
    high(): void; hide(): void; show(): void;
    configure(): Promise<void>; stop(): Promise<void>;
  };
}

test.skip(process.env.LYCANSYNC_RUN_ENCODING_BENCHMARK !== '1', '需明确启用隔离 LiveKit 合成测试');

test('双层真实订阅切换、无人观看暂停、恢复及运行中画质更新', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const server = await startEncodingBenchmarkServer();
  let application: ElectronApplication | undefined;
  try {
    const directory = testInfo.outputPath('viewing-client');
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
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [entry, '--user-data-dir=' + resolve(directory, 'profile')], env });
    const page = await application.firstWindow();
    await page.waitForFunction(() => Boolean((window as unknown as ScenarioWindow).livekit));
    await page.evaluate(async ({ url, publisherToken, receiverToken }) => {
      const sdk = (window as unknown as ScenarioWindow).livekit;
      const { observeScreenShareView } = await import('/screenShareViewing.js' as string) as typeof import('../../src/rtc/screenShareViewing');
      const { applyScreenShareEncoding, readScreenShareEncoding, screenShareEncodingLimits } = await import('/screenShareEncoding.js' as string) as typeof import('../../src/rtc/screenShareEncoding');
      const { screenShareThumbnailPreset, screenShareQuality } = await import('/screenShareQuality.js' as string) as typeof import('../../src/rtc/screenShareQuality');
      const publisher = new sdk.Room({ adaptiveStream: false, dynacast: true });
      const receiver = new sdk.Room({ adaptiveStream: false });
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
      const context = canvas.getContext('2d')!;
      const stream = canvas.captureStream(0);
      const source = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      const localTrack = new sdk.LocalVideoTrack(source, undefined, true);
      const video = document.createElement('video'); video.autoplay = true; video.muted = true;
      video.width = 640; video.height = 360; document.body.append(video);
      let remoteTrack: import('livekit-client').RemoteTrack | undefined;
      let remotePublication: import('livekit-client').RemoteTrackPublication | undefined;
      let view: ReturnType<typeof observeScreenShareView> | undefined;
      receiver.on(sdk.RoomEvent.TrackSubscribed, (track, publication) => {
        if (track.kind !== 'video') return;
        remoteTrack = track; remotePublication = publication; track.attach(video);
        view = observeScreenShareView(publication, video, sdk.VideoQuality.LOW);
      });
      let frame = 0;
      const interval = setInterval(() => {
        context.fillStyle = '#151b21'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#74ccae'; context.fillRect(frame++ * 9 % canvas.width, 100, 200, 200);
        source.requestFrame();
      }, 1000 / 120);
      (window as unknown as ScenarioWindow).viewing = {
        async sample() {
          const stats = await remoteTrack?.getRTCStatsReport();
          let width = 0, height = 0, decoded = 0;
          stats?.forEach((stat) => {
            if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
              width = stat.frameWidth; height = stat.frameHeight; decoded = stat.framesDecoded;
            }
          });
          return { encodings: localTrack.sender?.getParameters().encodings ?? [], width, height, decoded,
            enabled: remotePublication?.isEnabled ?? false };
        },
        high: () => view!.setQuality(sdk.VideoQuality.HIGH),
        hide: () => { video.style.display = 'none'; },
        show: () => { video.style.display = ''; },
        async configure() {
          const sender = localTrack.sender!;
          const limits = readScreenShareEncoding(sender);
          await applyScreenShareEncoding(sender, screenShareEncodingLimits('text', limits, { width: 1920, height: 1080 }));
          const quality = screenShareQuality('text');
          localTrack.publishOptions!.screenShareEncoding = { maxBitrate: quality.bitrate, maxFramerate: quality.fps };
        },
        async stop() {
          clearInterval(interval); view?.stop(); remoteTrack?.detach(video); video.remove();
          await Promise.all([publisher.disconnect(), receiver.disconnect()]);
          stream.getTracks().forEach((track) => track.stop());
        },
      };
      await receiver.connect(url, receiverToken);
      await publisher.connect(url, publisherToken);
      const quality = screenShareQuality('highFrameRate');
      await publisher.localParticipant.publishTrack(localTrack, {
        source: sdk.Track.Source.ScreenShare, videoCodec: 'h264', simulcast: true,
        screenShareEncoding: { maxBitrate: quality.bitrate, maxFramerate: quality.fps, priority: 'high' },
        screenShareSimulcastLayers: [screenShareThumbnailPreset()], degradationPreference: 'maintain-framerate',
      });
    }, { url: server.livekitUrl, publisherToken: server.publisherToken, receiverToken: server.receiverToken });
    const sample = () => page.evaluate(() => (window as unknown as ScenarioWindow).viewing.sample());
    const active = async () => (await sample()).encodings.map((encoding) => encoding.active);
    await expect.poll(sample, { timeout: 30_000 }).toMatchObject({ width: 640, height: 360 });
    await expect.poll(active).toEqual([true, false]);
    const low = await sample();
    await page.evaluate(() => (window as unknown as ScenarioWindow).viewing.high());
    await expect.poll(sample, { timeout: 30_000 }).toMatchObject({ width: 1920, height: 1080 });
    // 观看主层时，SFU 可能保留低层用于带宽降级；不强行覆盖 SDK 的层调度。
    await expect.poll(async () => (await sample()).encodings[1]?.active).toBe(true);
    const high = await sample();
    await page.evaluate(() => (window as unknown as ScenarioWindow).viewing.hide());
    await expect.poll(async () => (await sample()).enabled).toBe(false);
    await expect.poll(active, { timeout: 30_000 }).toEqual([false, false]);
    const hidden = await sample();
    await page.evaluate(() => (window as unknown as ScenarioWindow).viewing.show());
    await expect.poll(async () => (await sample()).encodings[1]?.active).toBe(true);
    await expect.poll(async () => (await sample()).decoded).toBeGreaterThan(hidden.decoded);
    await page.evaluate(() => (window as unknown as ScenarioWindow).viewing.configure());
    const changed = await sample();
    expect(changed.encodings.map(({ maxFramerate, maxBitrate }) => ({ maxFramerate, maxBitrate }))).toEqual([
      { maxFramerate: 30, maxBitrate: 1_000_000 }, { maxFramerate: 30, maxBitrate: 8_000_000 },
    ]);
    const reportPath = testInfo.outputPath('viewing-flow.json');
    writeFileSync(reportPath, JSON.stringify({ room: server.room, low, high, hidden, changed }, null, 2));
    await testInfo.attach('viewing-flow.json', { path: reportPath, contentType: 'application/json' });
  } finally {
    try {
      const page = application?.windows()[0];
      if (page) await page.evaluate(() => (window as unknown as ScenarioWindow).viewing?.stop());
    } finally {
      try { await application?.close(); } finally { await server.close(); }
    }
  }
});
