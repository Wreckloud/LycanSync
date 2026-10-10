import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { renameTestUser, setTestAvatar, useNewTestGroups } from './fixtures/authenticatedRtc';
import { installTestGroups } from './fixtures/authenticatedGroups';

test.beforeEach(async ({ context }) => { useNewTestGroups(); await installTestGroups(context); });

const webPort = Number(process.env.WEB_PORT ?? 4173);
const webBaseUrl = `http://127.0.0.1:${webPort}`;

declare global {
  interface Window {
    __rtcTest: {
      peers: RTCPeerConnection[];
      tracks: MediaStreamTrack[];
      microphoneCalls: number;
      microphoneConstraints?: MediaStreamConstraints;
      screenCalls: number;
      captureOptions?: DisplayMediaStreamOptions;
      denyScreen: boolean;
      delayScreen: boolean;
      releaseScreen?: () => void;
    };
    __customEntrancePlayCount: number;
    __tonePlayCount: number;
  }
}

function silentWav(durationMs = 100) {
  const sampleRate = 8_000;
  const dataLength = Math.round(sampleRate * durationMs / 1_000);
  const buffer = Buffer.alloc(44 + dataLength, 128);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

async function installCallSoundProbe(context: BrowserContext) {
  await context.addInitScript(() => {
    window.__customEntrancePlayCount = 0;
    window.__tonePlayCount = 0;
    const createBufferSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function createTrackedBufferSource() {
      const source = createBufferSource.call(this);
      const start = source.start.bind(source);
      source.start = (...args) => {
        window.__customEntrancePlayCount++;
        start(...args);
      };
      return source;
    };
    const createOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function createTrackedOscillator() {
      const oscillator = createOscillator.call(this);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (...args) => {
        window.__tonePlayCount++;
        start(...args);
      };
      return oscillator;
    };
  });
}

async function installSyntheticMedia(context: BrowserContext, screenSize = { width: 1280, height: 720 }) {
  await installTestGroups(context);
  await context.addInitScript((size) => {
    const state = window.__rtcTest = {
      peers: [] as RTCPeerConnection[], tracks: [] as MediaStreamTrack[],
      microphoneCalls: 0, screenCalls: 0, denyScreen: false, delayScreen: false,
      microphoneConstraints: undefined as MediaStreamConstraints | undefined,
      captureOptions: undefined as DisplayMediaStreamOptions | undefined,
      releaseScreen: undefined as (() => void) | undefined,
    };
    // 仅在测试页记录 WebRTC 统计，不给应用暴露测试接口或真实媒体。
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args) {
        const peer = Reflect.construct(target, args) as RTCPeerConnection;
        state.peers.push(peer);
        return peer;
      },
    });
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.microphoneCalls++;
      state.microphoneConstraints = constraints;
      const stream = await getUserMedia(constraints);
      state.tracks.push(...stream.getTracks());
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      state.screenCalls++;
      state.captureOptions = options;
      if (state.denyScreen) throw new DOMException('Test permission denied', 'NotAllowedError');
      if (state.delayScreen) await new Promise<void>((resolve) => { state.releaseScreen = resolve; });
      // 合成动态画面替代桌面采集，测试绝不读取真实窗口或屏幕。
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const drawing = canvas.getContext('2d')!;
      let frame = 0;
      const paint = () => {
        drawing.fillStyle = '#263958';
        drawing.fillRect(0, 0, size.width, size.height);
        drawing.fillStyle = '#8fd9bc';
        drawing.fillRect(70 + (frame++ % 90) * 4, 390, 300, 10);
        drawing.font = '48px sans-serif';
        drawing.fillStyle = '#dfe9ff';
        drawing.fillText('LycanSync / Synthetic screen', 70, 290);
        drawing.font = '24px sans-serif';
        drawing.fillText('WebRTC media test · No real screen captured', 70, 345);
      };
      paint();
      const interval = window.setInterval(paint, 66);
      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { window.clearInterval(interval); stop(); };
      state.tracks.push(track);
      return stream;
    };
  }, screenSize);
}

async function join(page: Page, nickname: string) {
  renameTestUser(page.context(), nickname);
  await page.goto('/');
  await page.getByRole('button', { name: /开黑小队，单击预览，双击加入语音/ }).dblclick();
  await expect(page.getByTestId('callbar').getByRole('status')).toContainText('语音已连接');
  await expect(page.getByRole('button', { name: '关闭麦克风' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '离开语音', exact: true })).toBeEnabled();
}

async function inboundBytes(page: Page, kind: 'audio' | 'video') {
  return page.evaluate(async (mediaKind) => {
    let bytes = 0;
    for (const peer of window.__rtcTest.peers) {
      const stats = await peer.getStats();
      stats.forEach((entry) => {
        if (entry.type === 'inbound-rtp' && entry.kind === mediaKind) bytes += entry.bytesReceived ?? 0;
      });
    }
    return bytes;
  }, kind);
}

async function outboundBytes(page: Page) {
  return page.evaluate(async () => {
    let bytes = 0;
    for (const peer of window.__rtcTest.peers) {
      const stats = await peer.getStats();
      stats.forEach((entry) => {
        if (entry.type === 'outbound-rtp' && entry.kind === 'video') bytes += entry.bytesSent ?? 0;
      });
    }
    return bytes;
  });
}

async function expectStageFits(page: Page, minimumChatHeight = 180) {
  await expect.poll(() => page.locator('.voice-panel').evaluate((panel) =>
    panel.scrollHeight <= panel.clientHeight + 1)).toBe(true);
  if (await page.getByTestId('member-filmstrip').isVisible()) {
    await expect.poll(() => page.getByTestId('member-filmstrip').evaluate((strip) =>
      strip.scrollWidth <= strip.clientWidth + 1)).toBe(true);
  }
  await expect(page.locator('.chat-panel')).toBeInViewport();
  await expect.poll(() => page.locator('.chat-panel').evaluate((panel) => panel.clientHeight)).toBeGreaterThanOrEqual(minimumChatHeight);
}

async function stageGeometry(page: Page) {
  return page.evaluate(() => {
    const viewer = document.querySelector('.viewer-grid')!.getBoundingClientRect();
    const chat = document.querySelector('.chat-panel')!.getBoundingClientRect();
    const toggle = document.querySelector('.member-strip-toggle')!.getBoundingClientRect();
    const thumbnail = document.querySelector('.member-filmstrip .participant-card')?.getBoundingClientRect();
    const filmstrip = document.querySelector('.filmstrip-row')?.getBoundingClientRect();
    return {
      viewerHeight: viewer.height,
      viewerBottom: viewer.bottom,
      chatTop: chat.top,
      toggleCenter: toggle.left + toggle.width / 2,
      toggleTop: toggle.top,
      toggleBottom: toggle.bottom,
      viewerCenter: viewer.left + viewer.width / 2,
      thumbnailRatio: thumbnail ? thumbnail.width / thumbnail.height : null,
      filmstripTop: filmstrip?.top ?? null,
    };
  });
}

async function toggleMembersAndMeasureVideo(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 220));
    const viewer = document.querySelector('.viewer-grid')!;
    const voicePanel = document.querySelector('.voice-panel')!;
    const toggle = document.querySelector<HTMLButtonElement>('.member-strip-toggle')!;
    const positions = [viewer.getBoundingClientRect()];
    const panelHeights = [voicePanel.getBoundingClientRect().height];
    toggle.click();
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      positions.push(viewer.getBoundingClientRect());
      panelHeights.push(voicePanel.getBoundingClientRect().height);
    }
    const heights = positions.map((position) => position.height);
    const tops = positions.map((position) => position.top);
    const startHeight = panelHeights[0];
    const endHeight = panelHeights.at(-1)!;
    const lowerHeight = Math.min(startHeight, endHeight) + 1;
    const upperHeight = Math.max(startHeight, endHeight) - 1;
    return {
      viewerShift: Math.max(Math.max(...heights) - Math.min(...heights), Math.max(...tops) - Math.min(...tops)),
      panelHeightDelta: Math.abs(endHeight - startHeight),
      intermediatePanelHeights: new Set(panelHeights.slice(1, -1)
        .filter((height) => height > lowerHeight && height < upperHeight)
        .map((height) => Math.round(height))).size,
    };
  });
}

function expectImmediateFilmstripLayout(layout: Awaited<ReturnType<typeof toggleMembersAndMeasureVideo>>) {
  expect(layout.viewerShift).toBeLessThan(2);
  expect(layout.panelHeightDelta).toBeGreaterThan(85);
  expect(layout.intermediatePanelHeights).toBe(0);
}

test('未共享时显示群成员头像，停止共享后恢复头像', async ({ context, page }) => {
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  setTestAvatar(context, avatar);
  await installSyntheticMedia(context);
  await join(page, '头像测试');
  const localCard = page.getByTestId('participant-card');
  await expect(page.locator('.callbar').getByRole('button', { name: '关闭麦克风', exact: true }).locator('.voice-level-mic')).toHaveCount(1);
  await expect(localCard.locator('.voice-level-mic')).toHaveCount(1);
  await expect(localCard.locator('.voice-level-fill')).toHaveAttribute('width', '6');
  await expect(localCard.locator('.voice-level-fill')).toHaveCSS('transition-duration', '0s');
  expect(await page.evaluate(() => window.__rtcTest.microphoneConstraints?.audio)).toMatchObject({
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  });
  expect(await page.evaluate(() => {
    const sourceTrack = window.__rtcTest.tracks.find((track) => track.kind === 'audio');
    const senderTrack = window.__rtcTest.peers.flatMap((peer) => peer.getSenders())
      .find((sender) => sender.track?.kind === 'audio')?.track;
    return Boolean(sourceTrack && senderTrack && sourceTrack.id !== senderTrack.id);
  })).toBe(true);
  const microphoneButton = page.locator('.callbar').getByRole('button', { name: '关闭麦克风', exact: true });
  await microphoneButton.hover();
  const quickVolumeSettings = page.getByRole('region', { name: '音量快捷设置' });
  await expect(quickVolumeSettings.getByRole('slider')).toHaveCount(2);
  await expect(quickVolumeSettings.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '媒体诊断' })).toHaveCount(0);
  const peerCountBeforeSettings = await page.evaluate(() => window.__rtcTest.peers.length);
  await page.getByRole('button', { name: '打开语音与音频设置' }).click();
  const settingsPage = page.locator('.settings-view');
  await expect(settingsPage).toBeVisible();
  await expect(settingsPage).not.toHaveAttribute('role', 'dialog');
  await expect(settingsPage).not.toHaveAttribute('aria-modal', 'true');
  const audioSettingsSection = page.locator('.audio-settings');
  await expect(audioSettingsSection).toBeVisible();
  await expect(audioSettingsSection.getByRole('checkbox', { name: '回声消除' })).toBeEnabled();
  await expect(audioSettingsSection.getByText('人声增强', { exact: true })).toBeVisible();
  await expect(audioSettingsSection.getByRole('meter', { name: '麦克风输入等级' })).toBeVisible();
  const inputGainSlider = audioSettingsSection.getByRole('slider', { name: '麦克风输入音量' });
  await inputGainSlider.fill('2');
  await audioSettingsSection.getByRole('checkbox', { name: '环境降噪' }).uncheck();
  await expect.poll(() => page.evaluate(() => window.__rtcTest.tracks
    .find((track) => track.kind === 'audio')?.getConstraints().noiseSuppression)).toBe(false);
  await audioSettingsSection.getByRole('slider', { name: 'LycanSync 总输出音量' }).fill('2');
  await page.getByRole('button', { name: '关于与诊断', exact: true }).click();
  await expect(page.locator('.media-diagnostics')).toHaveCount(0);
  await page.getByRole('button', { name: '查看媒体诊断' }).click();
  await expect(page.locator('.media-diagnostics')).toBeVisible();
  await expect(page.locator('.native-capture-probe')).toBeVisible();
  await page.getByRole('button', { name: '返回应用' }).click();
  expect(await page.evaluate(() => window.__rtcTest.peers.length)).toBe(peerCountBeforeSettings);
  await expect(page.getByTestId('member-count')).toContainText('1 人');
  await localCard.getByRole('button', { name: /输入音量200%/ }).hover();
  await expect(localCard.locator('.participant-volume-popover').filter({ hasText: '输入 200%' })).toBeVisible();
  await expect(page.locator('.callbar').getByRole('button', { name: '停止接收声音', exact: true })).toBeEnabled();
  await localCard.getByRole('button', { name: /LycanSync 总输出200%/ }).hover();
  await expect(localCard.locator('.participant-volume-popover').filter({ hasText: '输出 200%' })).toBeVisible();
  await localCard.getByRole('button', { name: '关闭自己的麦克风' }).click();
  await expect(localCard.locator('.participant-volume-popover').filter({ hasText: /^输入/ })).toHaveCount(0);
  await expect(page.locator('.callbar').getByRole('button', { name: '开启麦克风', exact: true })).toBeEnabled();
  await localCard.getByRole('button', { name: '开启自己的麦克风' }).click();
  await expect(page.locator('.callbar').getByRole('button', { name: '关闭麦克风', exact: true })).toBeEnabled();
  await localCard.getByRole('button', { name: '停止接收所有成员声音' }).click();
  await expect(localCard.locator('.participant-volume-popover').filter({ hasText: /^输出/ })).toHaveCount(0);
  await localCard.getByRole('button', { name: '恢复接收所有成员声音' }).click();
  await expect(localCard.getByRole('button', { name: /停止接收所有成员声音/ })).toBeEnabled();
  await expect(page.locator('.callbar').getByRole('button', { name: '语音设置' })).toHaveCount(0);
  await expect(page.getByLabel('个人状态与设置').getByRole('button', { name: '语音与音频设置' })).toBeVisible();
  expect(await page.evaluate(() => window.__rtcTest.tracks.some((track) => track.kind === 'audio'))).toBe(true);
  await expect(localCard.locator('.large-avatar img')).toHaveAttribute('src', avatar);
  await page.getByRole('button', { name: '开始屏幕共享' }).click();
  await expect(page.getByTestId('viewer-screen')).toBeVisible();
  await expectStageFits(page);
  await expect(page.locator('video')).toHaveCount(1);
  await page.getByRole('button', { name: '停止屏幕共享' }).click();
  await expect(localCard.locator('.large-avatar img')).toHaveAttribute('src', avatar);
});

test('单击只预览；入房接口未启用时明确提示', async ({ page }) => {
  await page.route('**/api/rtc/token', (route) => route.fulfill({ status: 404 }));
  await page.goto('/');
  await page.getByRole('button', { name: /周末车队，单击预览，双击加入语音/ }).click();
  await expect(page.getByRole('heading', { name: '周末车队' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开启麦克风' })).toHaveCount(0);
  await page.getByRole('button', { name: /周末车队，单击预览，双击加入语音/ }).dblclick();
  await expect(page.getByRole('alert')).toContainText('rtc-local');
  await expect(page.getByRole('button', { name: '加入当前群组语音' })).toBeEnabled();
  await page.getByRole('button', { name: '收起提示', exact: true }).click();
  await expect(page.locator('.app-notice [role="alert"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开提示', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开提示', exact: true }).click();
  await expect(page.locator('.app-notice [role="alert"]')).toContainText('rtc-local');
  await page.screenshot({ path: 'test-results/lobby.png', fullPage: true });
});

test('取消尚未完成的凭证请求后，不允许迟到的响应自动入房', async ({ page }) => {
  let releaseResponse: (() => void) | undefined;
  await page.route('**/api/rtc/token', async (route) => {
    await new Promise<void>((resolve) => { releaseResponse = resolve; });
    await route.fulfill({ status: 503 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /开黑小队，单击预览，双击加入语音/ }).dblclick();
  await expect.poll(() => Boolean(releaseResponse)).toBe(true);
  await page.getByRole('button', { name: '取消连接' }).click();
  releaseResponse!();
  await expect(page.getByRole('button', { name: '加入当前群组语音' })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('通话中单击其他群只预览，双击时要求确认切换', async ({ context, page }) => {
  await installSyntheticMedia(context);
  await join(page, '切群测试狼');
  await page.getByRole('button', { name: /周末车队，单击预览，双击加入语音/ }).click();
  await expect(page.getByRole('heading', { name: '周末车队' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('开黑小队 · 正在浏览 周末车队');
  await expect(page.getByRole('button', { name: '返回当前通话群组' })).toBeEnabled();
  await page.getByRole('button', { name: /周末车队，单击预览，双击加入语音/ }).dblclick();
  await expect(page.getByRole('alert')).toContainText('当前共享会停止，加入后默认开麦');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '返回当前通话群组' }).click();
  await expect(page.getByRole('heading', { name: '开黑小队' })).toBeVisible();
  await page.getByRole('button', { name: '离开语音' }).click();
  await expect(page.getByTestId('callbar')).toHaveClass(/is-leaving/);
  await expect(page.getByTestId('callbar')).toHaveCount(0);
});

test('房间外只能看到语音人数和昵称，不连接媒体房间', async ({ browser, context, page }) => {
  const observer = await browser.newContext({ baseURL: webBaseUrl, viewport: { width: 1440, height: 1000 } });
  await installTestGroups(observer);
  try {
    await installSyntheticMedia(context);
    await join(page, '房内小狼');
    const observerPage = await observer.newPage();
    await observerPage.goto('/');

    await expect(observerPage.getByTestId('room-summary-count')).toContainText('1 人');
    await expect(observerPage.getByLabel('当前语音成员预览')).toContainText('房内小狼');
    await expect(observerPage.getByRole('status')).toHaveCount(0);
    await expect(observerPage.getByRole('button', { name: '开启麦克风' })).toHaveCount(0);
    await expect(observerPage.getByLabel('麦克风已开启')).toHaveCount(0);
    await page.getByRole('button', { name: '离开语音' }).click();
    await expect(observerPage.getByTestId('room-summary-count')).toHaveCount(0, { timeout: 12_000 });
  } finally {
    await observer.close();
  }
});

test('自定义入场音通过房间数据流播放给已在语音中的成员', async ({ browser, context, page }) => {
  const entrant = await browser.newContext({
    baseURL: webBaseUrl, permissions: ['microphone'], viewport: { width: 1440, height: 1000 },
  });
  try {
    await installCallSoundProbe(context);
    await installSyntheticMedia(context);
    await installSyntheticMedia(entrant);
    const entrantPage = await entrant.newPage();
    await entrantPage.goto('/');
    if (!await entrantPage.locator('.settings-view').isVisible()) {
      await entrantPage.getByRole('button', { name: '语音与音频设置', exact: true }).click();
    }
    await entrantPage.getByRole('button', { name: '账号设置', exact: true }).click();
    await entrantPage.getByRole('button', { name: '音效', exact: true }).click();
    await entrantPage.getByLabel('选择入场音效').setInputFiles({
      name: 'hello.wav',
      mimeType: 'audio/wav',
      buffer: silentWav(),
    });
    await expect(entrantPage.getByRole('button', { name: '试听' })).toBeVisible();
    await entrantPage.getByRole('button', { name: '返回应用' }).click();

    await join(page, '等候入场音的小狼');
    await join(entrantPage, '带入场音的小狼');
    await expect.poll(() => page.evaluate(() => window.__customEntrancePlayCount)).toBe(1);
  } finally {
    await entrant.close();
  }
});

test('取消所有放大画面返回语音卡片，双击舞台可专注单路并隐藏聊天', async ({ browser, context, page }, testInfo) => {
  const teammate = await browser.newContext({
    baseURL: webBaseUrl, permissions: ['microphone'], viewport: { width: 1440, height: 1000 },
  });
  try {
    await installSyntheticMedia(context);
    await installSyntheticMedia(teammate, { width: 1920, height: 1080 });
    const otherPage = await teammate.newPage();
    await join(page, '苏州小狼');
    await join(otherPage, '福州小狼');
    await otherPage.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
    expect(await otherPage.evaluate(() => {
      const video = window.__rtcTest.captureOptions?.video as MediaTrackConstraints;
      return { width: video.width, height: video.height, frameRate: video.frameRate };
    })).toEqual({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: 60 });
    await expect.poll(() => otherPage.evaluate(() => window.__rtcTest.peers.flatMap((peer) => peer.getSenders())
      .filter((sender) => sender.track?.kind === 'video')
      .flatMap((sender) => sender.getParameters().encodings ?? [])
      .map((encoding) => ({ maxBitrate: encoding.maxBitrate, maxFramerate: encoding.maxFramerate, priority: encoding.priority }))))
      .toContainEqual(expect.objectContaining({ maxBitrate: 12_000_000, maxFramerate: 60, priority: 'high' }));
    await expect.poll(() => otherPage.evaluate(() => window.__rtcTest.peers.flatMap((peer) => peer.getSenders())
      .filter((sender) => sender.track?.kind === 'video')
      .map((sender) => sender.getParameters().encodings?.length))).toEqual([1]);
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    await expect.poll(() => page.getByTestId('viewer-screen').locator('video').evaluate((video) =>
      (video as HTMLVideoElement).videoHeight)).toBeGreaterThanOrEqual(1000);
    await page.getByRole('button', { name: '展开其他成员' }).click();
    await page.getByRole('button', { name: '从主观看区移除福州小狼的共享画面' }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
    await expect(page.getByTestId('participant-card')).toHaveCount(2);
    await expect(page.getByTestId('participant-card').locator('video')).toHaveCount(1);
    await expect(page.locator('.voice-panel')).not.toHaveClass(/has-sharing/);
    await expect(page.locator('.chat-panel')).toBeVisible();
    // 退出舞台只改变布局；高画质订阅不应因缩略展示被强制降到 720p。
    await expect.poll(() => page.getByTestId('participant-card').locator('video').evaluate((video) =>
      (video as HTMLVideoElement).videoHeight)).toBeGreaterThan(0);
    await page.locator('.chat-heading').click();
    await page.screenshot({ path: testInfo.outputPath('screen-grid.png'), fullPage: true });
    await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
    await expect(page.getByTestId('participant-card').locator('video')).toHaveCount(2);

    await page.getByRole('button', { name: '放大福州小狼的共享画面' }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    const viewer = page.getByTestId('viewer-screen');
    const originalVideo = await viewer.locator('video').elementHandle();
    await expect(page.getByRole('button', { name: /画中画/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '全屏观看福州小狼的共享画面', exact: true })).toHaveAttribute('data-viewer-tooltip', '系统全屏');
    await expect(page.getByRole('button', { name: '窗口全屏观看福州小狼的共享画面', exact: true })).toHaveAttribute('data-viewer-tooltip', '窗口全屏');
    await page.getByRole('button', { name: '窗口全屏观看福州小狼的共享画面', exact: true }).click();
    await expect(viewer).toHaveClass(/is-window-fullscreen/);
    await expect(page.getByRole('button', { name: '退出窗口全屏观看福州小狼的共享画面', exact: true })).toHaveAttribute('data-viewer-tooltip', '退出窗口全屏');
    expect(await viewer.evaluate((card) => {
      const rect = card.getBoundingClientRect();
      const titlebar = document.querySelector('.titlebar')!.getBoundingClientRect();
      return Math.abs(rect.left) < 1 && Math.abs(rect.right - innerWidth) < 1
        && Math.abs(rect.top - titlebar.bottom) < 1 && Math.abs(rect.bottom - innerHeight) < 1
        && document.fullscreenElement === null;
    })).toBe(true);
    expect(await originalVideo!.evaluate((video) => video === document.querySelector('[data-testid="viewer-screen"] video'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(viewer).not.toHaveClass(/is-window-fullscreen/);
    await page.getByRole('button', { name: '窗口全屏观看福州小狼的共享画面', exact: true }).click();
    await page.getByRole('button', { name: '退出窗口全屏观看福州小狼的共享画面', exact: true }).click();
    await expect(viewer).not.toHaveClass(/is-window-fullscreen/);
    await originalVideo!.dispose();
    await page.getByTestId('viewer-screen').locator('.participant-media').dblclick();
    await expect(page.locator('.voice-panel')).toHaveClass(/is-focused/);
    await expect(page.locator('.chat-panel')).toHaveCount(0);
    await expect(page.getByTestId('member-filmstrip')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /专注观看/ })).toHaveCount(0);
    expect(await page.locator('.viewer-action').evaluateAll((buttons) => buttons.every((button) => {
      const buttonRect = button.getBoundingClientRect();
      const iconRect = button.querySelector('svg')!.getBoundingClientRect();
      return Math.abs(iconRect.left + iconRect.width / 2 - buttonRect.left - buttonRect.width / 2) < 1
        && Math.abs(iconRect.top + iconRect.height / 2 - buttonRect.top - buttonRect.height / 2) < 1;
    }))).toBe(true);
    await expect.poll(() => page.getByTestId('viewer-screen').locator('video').evaluate((video) =>
      (video as HTMLVideoElement).videoHeight)).toBeGreaterThanOrEqual(1000);
    await expect.poll(() => page.evaluate(() => {
      const stage = document.querySelector('.voice-panel')!.getBoundingClientRect();
      const callbar = document.querySelector('.callbar')!.getBoundingClientRect();
      return stage.bottom <= callbar.top + 1;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('screen-focused.png'), fullPage: true });
    await page.getByTestId('viewer-screen').locator('.participant-media').dblclick();
    await expect(page.locator('.chat-panel')).toBeVisible();
    await page.getByTestId('viewer-screen').locator('.participant-media').dblclick();
    await page.getByTestId('viewer-screen').locator('.participant-media').dblclick();
    await expect(page.locator('.chat-panel')).toBeVisible();
  } finally {
    await teammate.close();
  }
});

test('双人同时语音和共享：实际收包、多画面观看、静音、停止共享及离房清理', async ({ browser, context, page }, testInfo) => {
  const teammate = await browser.newContext({
    baseURL: webBaseUrl, permissions: ['microphone'], viewport: { width: 1440, height: 1000 },
  });
  try {
    await installSyntheticMedia(context);
    await installSyntheticMedia(teammate);
    const otherPage = await teammate.newPage();
    await join(page, '苏州小狼');
    await join(otherPage, '福州小狼');
    for (const participantPage of [page, otherPage]) {
      await expect(participantPage.getByTestId('member-count')).toContainText('2 人');
      expect(await participantPage.evaluate(() => [window.__rtcTest.microphoneCalls, window.__rtcTest.screenCalls])).toEqual([1, 0]);
      await participantPage.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
      await expect(participantPage.getByRole('button', { name: '停止屏幕共享', exact: true })).toBeEnabled();
    }
    for (const participantPage of [page, otherPage]) {
      await expect(participantPage.getByTestId('viewer-screen')).toHaveCount(1);
      const collapsed = await stageGeometry(participantPage);
      expectImmediateFilmstripLayout(await toggleMembersAndMeasureVideo(participantPage));
      await expect(participantPage.getByTestId('member-thumbnail')).toHaveCount(2);
      const expanded = await stageGeometry(participantPage);
      expect(Math.abs(expanded.viewerHeight - collapsed.viewerHeight)).toBeLessThan(2);
      expect(expanded.chatTop - collapsed.chatTop).toBeGreaterThan(85);
      expect(Math.abs(expanded.toggleCenter - expanded.viewerCenter)).toBeLessThan(2);
      expect(expanded.toggleTop).toBeGreaterThanOrEqual(expanded.viewerBottom);
      expect(expanded.toggleBottom).toBeLessThanOrEqual(expanded.filmstripTop!);
      expect(expanded.thumbnailRatio).toBeGreaterThan(1.5);
      expect(expanded.thumbnailRatio).toBeLessThan(1.8);
      await expect.poll(() => inboundBytes(participantPage, 'audio')).toBeGreaterThan(0);
      await expect.poll(() => inboundBytes(participantPage, 'video')).toBeGreaterThan(0);
      await expect.poll(() => participantPage.locator('video').evaluateAll(
        (videos) => videos.every((video) => video instanceof HTMLVideoElement && video.videoWidth > 0 && video.currentTime > 0),
      )).toBe(true);
      if (await participantPage.getByRole('button', { name: '允许播放声音' }).isVisible()) {
        await participantPage.getByRole('button', { name: '允许播放声音' }).click();
      }
      await expect.poll(() => participantPage.locator('audio').evaluateAll(
        (audios) => audios.length > 0 && audios.every((audio) => audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0),
      )).toBe(true);
    }
    await page.getByRole('button', { name: '放大福州小狼的共享画面' }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(2);
    expect(await page.getByTestId('viewer-screen').last().evaluate((card) =>
      getComputedStyle(card).animationName)).toBe('none');
    await page.getByTestId('viewer-screen').filter({ hasText: '福州小狼' }).locator('.participant-media').dblclick();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    await expect(page.locator('.chat-panel')).toHaveCount(0);
    await page.getByTestId('viewer-screen').locator('.participant-media').dblclick();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(2);
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: '展开其他成员' })).toBeVisible();
    expectImmediateFilmstripLayout(await toggleMembersAndMeasureVideo(page));
    await expect.poll(() => page.locator('video').evaluateAll((videos) => videos.every(
      (video) => video instanceof HTMLVideoElement && video.videoWidth > 0 && video.currentTime > 0,
    ))).toBe(true);
    await page.locator('.chat-heading').click();
    await page.screenshot({ path: testInfo.outputPath('two-screens-expanded.png'), fullPage: true });
    const expanded = await stageGeometry(page);
    expectImmediateFilmstripLayout(await toggleMembersAndMeasureVideo(page));
    await expect(page.getByTestId('member-filmstrip')).toHaveCount(0);
    const collapsed = await stageGeometry(page);
    expect(Math.abs(collapsed.viewerHeight - expanded.viewerHeight)).toBeLessThan(2);
    expect(expanded.chatTop - collapsed.chatTop).toBeGreaterThan(85);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expectStageFits(page);
    await expect(page.locator('video')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('two-screens.png'), fullPage: true });
    await expect(page.getByRole('button', { name: '全屏观看福州小狼的共享画面', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '窗口全屏观看福州小狼的共享画面', exact: true })).toBeEnabled();
    await expect(page.getByLabel('正在共享屏幕')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /聚焦.*共享画面/ })).toHaveCount(0);
    await expect(page.getByTestId('member-filmstrip')).toHaveCount(0);
    const compactCollapsed = await stageGeometry(page);
    expectImmediateFilmstripLayout(await toggleMembersAndMeasureVideo(page));
    const compactExpanded = await stageGeometry(page);
    expect(Math.abs(compactExpanded.viewerHeight - compactCollapsed.viewerHeight)).toBeLessThan(2);
    expect(compactExpanded.chatTop - compactCollapsed.chatTop).toBeGreaterThan(85);
    await expectStageFits(page, 140);
    await page.locator('.chat-heading').click();
    await page.screenshot({ path: testInfo.outputPath('two-screens-compact-expanded.png'), fullPage: true });
    await page.setViewportSize({ width: 920, height: 640 });
    await expectStageFits(page, 96);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expectStageFits(page, 140);
    await page.getByRole('button', { name: '从主观看区移除福州小狼的共享画面' }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    const remoteCard = page.getByTestId('member-thumbnail').filter({ hasText: '福州小狼' });
    const remoteMic = remoteCard.getByRole('button', { name: /福州小狼(?:麦克风已开启|正在说话).*点击取消收听/ });
    await remoteMic.hover();
    await expect(remoteCard.getByRole('slider')).toHaveCount(0);
    await expect(remoteCard.locator('.participant-volume-popover')).toHaveText('接收 100%');
    const remoteMicBounds = await remoteMic.boundingBox();
    if (!remoteMicBounds) throw new Error('远端麦克风按钮不可见');
    await page.mouse.move(remoteMicBounds.x + remoteMicBounds.width / 2, remoteMicBounds.y + remoteMicBounds.height / 2);
    await page.mouse.down();
    const volumeDragger = page.getByRole('slider', { name: '福州小狼接收音量' });
    await expect(volumeDragger).toBeVisible();
    await page.mouse.move(remoteMicBounds.x + remoteMicBounds.width / 2, remoteMicBounds.y - 40, { steps: 4 });
    await expect.poll(async () => Number(await volumeDragger.getAttribute('aria-valuenow'))).toBeGreaterThan(100);
    await page.mouse.up();
    await expect(volumeDragger).toHaveCount(0);
    for (let step = 0; step < 40; step++) await remoteMic.dispatchEvent('wheel', { deltaY: 100 });
    const mutedRemoteMic = remoteCard.getByRole('button', { name: /福州小狼已取消收听，点击恢复收听/ });
    await expect(mutedRemoteMic).toBeVisible();
    await expect(remoteCard.locator('.participant-volume-popover')).toHaveCount(0);
    await mutedRemoteMic.dispatchEvent('wheel', { deltaY: -100 });
    await expect(remoteCard.locator('.participant-volume-popover')).toHaveText('接收 5%');
    for (let step = 0; step < 20; step++) await remoteMic.dispatchEvent('wheel', { deltaY: -100 });
    await expect(remoteCard.locator('.participant-volume-popover')).toHaveText('接收 105%');
    for (let step = 0; step < 20; step++) await remoteMic.dispatchEvent('wheel', { deltaY: -100 });
    await expect(remoteCard.locator('.participant-volume-popover')).toHaveText('接收 200%');
    await remoteMic.click();
    await expect(remoteCard.getByRole('button', { name: /福州小狼已取消收听，点击恢复收听/ })).toBeVisible();
    await expect(remoteCard.locator('.participant-volume-popover')).toHaveCount(0);
    await expect(page.locator('audio')).toHaveCount(0);
    await expect(otherPage.getByTestId('member-thumbnail').filter({ hasText: '苏州小狼' })
      .getByRole('button', { name: /苏州小狼(?:麦克风已开启|正在说话).*点击取消收听/ })).toBeVisible();
    await remoteCard.getByRole('button', { name: /福州小狼已取消收听，点击恢复收听/ }).click();
    await expect(remoteCard.locator('.participant-volume-popover')).toHaveText('接收 200%');
    await expect(page.locator('audio')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => {
      const key = Object.keys(localStorage).find((item) => item.startsWith('lycansync.audio-preferences.v1.'));
      const stored = key ? JSON.parse(localStorage.getItem(key) ?? '{}') : {};
      return Object.values(stored.participantVolumes ?? {});
    })).toContain(2);
    await otherPage.getByRole('button', { name: /停止接收所有成员声音/ }).first().click();
    await expect(page.getByTestId('member-thumbnail').filter({ hasText: '福州小狼' })
      .getByLabel('已停止接收声音')).toBeVisible();
    await expect(otherPage.getByRole('button', { name: '开启麦克风', exact: true })).toBeEnabled();
    await expect(page.getByTestId('member-thumbnail').filter({ hasText: '福州小狼' })
      .getByLabel('麦克风已关闭')).toBeVisible();
    await otherPage.getByRole('button', { name: '恢复接收所有成员声音' }).first().click();
    await expect(otherPage.getByRole('button', { name: '关闭麦克风', exact: true })).toBeEnabled();
    await expect(page.getByTestId('member-thumbnail').filter({ hasText: '福州小狼' })
      .getByRole('button', { name: /福州小狼(?:麦克风已开启|正在说话).*点击取消收听/ })).toBeVisible();
    await otherPage.getByRole('button', { name: '关闭麦克风', exact: true }).click();
    await expect(page.getByTestId('member-thumbnail').filter({ hasText: '福州小狼' })
      .getByLabel('麦克风已关闭')).toBeVisible();
    await otherPage.getByRole('button', { name: '停止屏幕共享', exact: true }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    await otherPage.getByRole('button', { name: '离开语音' }).click();
    await expect(page.getByTestId('member-count')).toContainText('1 人');
    await page.getByRole('button', { name: '离开语音' }).click();
    for (const participantPage of [page, otherPage]) {
      await expect.poll(() => participantPage.evaluate(() => window.__rtcTest.tracks.every((track) => track.readyState === 'ended'))).toBe(true);
      await expect(participantPage.locator('audio, video')).toHaveCount(0);
    }
  } finally {
    await teammate.close();
  }
});

// 只覆盖 WebRTC 侧：本地采集轨道结束、远端订阅释放、不再有 outbound 报文增长。
// 不覆盖开始菜单、系统托盘、输入法候选框响应，也不覆盖 Windows 视频采集服务的行为。
test('停止共享后释放 WebRTC 轨道与远端订阅', async ({ browser, context, page }) => {
  const teammate = await browser.newContext({
    baseURL: webBaseUrl, permissions: ['microphone'], viewport: { width: 1440, height: 1000 },
  });
  try {
    await installCallSoundProbe(context);
    await installCallSoundProbe(teammate);
    await installSyntheticMedia(context);
    await installSyntheticMedia(teammate);
    const otherPage = await teammate.newPage();
    await join(page, '释放测试狼甲');
    await join(otherPage, '释放测试狼乙');
    await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
    await expect(otherPage.getByTestId('viewer-screen')).toHaveCount(1);
    await expect.poll(() => inboundBytes(otherPage, 'video')).toBeGreaterThan(0);
    const bytesBeforeStop = await outboundBytes(page);
    await page.waitForTimeout(900);
    const localTonesBeforeStop = await page.evaluate(() => window.__tonePlayCount);
    const remoteTonesBeforeStop = await otherPage.evaluate(() => window.__tonePlayCount);

    await page.getByRole('button', { name: '停止屏幕共享', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__tonePlayCount)).toBeGreaterThanOrEqual(localTonesBeforeStop + 3);
    await expect.poll(() => otherPage.evaluate(() => window.__tonePlayCount)).toBeGreaterThanOrEqual(remoteTonesBeforeStop + 3);
    // 停止共享只解除这一路画面：按钮立即回到“开始”，采集轨道必须结束，麦克风保持 live。
    await expect(page.getByRole('button', { name: '开始屏幕共享', exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => {
      const videoTracks = window.__rtcTest.tracks.filter((track) => track.kind === 'video');
      return videoTracks.length > 0 && videoTracks.every((track) => track.readyState === 'ended');
    })).toBe(true);
    expect(await page.evaluate(() => window.__rtcTest.tracks
      .some((track) => track.kind === 'audio' && track.readyState === 'live'))).toBe(true);
    await expect(page.getByRole('status')).toContainText('语音已连接');
    // 两侧都不应残留已连接的画面元素，远端订阅必须一并释放。
    await expect(page.locator('video')).toHaveCount(0);
    await expect(otherPage.getByTestId('viewer-screen')).toHaveCount(0);
    await expect(otherPage.locator('video')).toHaveCount(0);
    // 停止后不得再有视频报文增长，否则说明采集或发送并未真正释放。
    await page.waitForTimeout(3_000);
    expect(await outboundBytes(page) - bytesBeforeStop).toBeLessThan(2_000);
  } finally {
    await teammate.close();
  }
});

test('拒绝屏幕权限后可重试；离房后才返回的采集结果必须停止', async ({ context, page }) => {
  await installSyntheticMedia(context);
  await join(page, '权限测试狼');
  await page.evaluate(() => { window.__rtcTest.denyScreen = true; });
  await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('未获授权或已取消');
  await expect(page.getByRole('button', { name: '开始屏幕共享', exact: true })).toBeEnabled();
  await page.evaluate(() => { window.__rtcTest.denyScreen = false; window.__rtcTest.delayScreen = true; });
  await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__rtcTest.releaseScreen))).toBe(true);
  await page.getByRole('button', { name: '离开语音' }).click();
  await page.evaluate(() => window.__rtcTest.releaseScreen!());
  await expect.poll(() => page.evaluate(() => window.__rtcTest.tracks.length > 0
    && window.__rtcTest.tracks.every((track) => track.readyState === 'ended'))).toBe(true);
  await expect(page.getByRole('button', { name: '加入当前群组语音' })).toBeEnabled();
});

test('浏览器结束采集后恢复共享按钮，重新入房仍默认开麦但不共享', async ({ context, page }) => {
  await installSyntheticMedia(context);
  await join(page, '生命周期测试狼');
  await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
  await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
  await page.evaluate(() => {
    const track = window.__rtcTest.tracks.find((candidate) => candidate.kind === 'video')!;
    track.stop();
    // 模拟浏览器“停止共享”产生的 ended 事件；stop() 本身不会派发此事件。
    track.dispatchEvent(new Event('ended'));
  });
  await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始屏幕共享', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
  await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
  await page.getByRole('button', { name: '离开语音' }).click();
  await page.getByRole('button', { name: '加入当前群组语音' }).click();
  await expect(page.getByRole('status')).toContainText('语音已连接');
  await expect(page.getByRole('button', { name: '关闭麦克风', exact: true })).toBeEnabled();
  await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const videoTracks = window.__rtcTest.tracks.filter((track) => track.kind === 'video');
    const audioTracks = window.__rtcTest.tracks.filter((track) => track.kind === 'audio');
    return videoTracks.every((track) => track.readyState === 'ended')
      && audioTracks.some((track) => track.readyState === 'live');
  })).toBe(true);
  await page.getByRole('button', { name: '离开语音' }).click();
});

test('四人同时发布，每位成员均收到其他三人的音视频', async ({ browser }, testInfo) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    for (const nickname of ['苏州小狼', '福州小狼', '四川小狼', '本地小狼']) {
      const context = await browser.newContext({
        baseURL: webBaseUrl, permissions: ['microphone'], viewport: { width: 1440, height: 1000 },
      });
      contexts.push(context);
      await installSyntheticMedia(context);
      const page = await context.newPage();
      pages.push(page);
      await join(page, nickname);
      await expect(page.getByRole('button', { name: '关闭麦克风', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
      await expect(page.getByRole('button', { name: '停止屏幕共享', exact: true })).toBeEnabled();
    }
    for (const page of pages) {
      await expect(page.getByTestId('member-count')).toContainText('4 人');
      await page.getByRole('button', { name: '展开其他成员' }).click();
      await expect(page.getByTestId('member-thumbnail')).toHaveCount(4);
      await expect.poll(() => page.evaluate(async () => {
        const streams = { audio: 0, video: 0 };
        for (const peer of window.__rtcTest.peers) {
          (await peer.getStats()).forEach((entry) => {
            if (entry.type === 'inbound-rtp' && entry.bytesReceived > 0) {
              if (entry.kind === 'audio') streams.audio++;
              if (entry.kind === 'video' && entry.framesDecoded > 0) streams.video++;
            }
          });
        }
        return streams;
      })).toEqual({ audio: 3, video: 3 });
    }
    await expect(pages[0].getByRole('button', { name: /^放大.*的共享画面$/ })).toHaveCount(3);
    for (let index = 0; index < 3; index++) {
      await pages[0].getByRole('button', { name: /^放大.*的共享画面$/ }).first().click();
    }
    await expect(pages[0].getByTestId('viewer-screen')).toHaveCount(4);
    await pages[0].setViewportSize({ width: 1280, height: 720 });
    await pages[0].getByRole('button', { name: '收起其他成员' }).click();
    await expectStageFits(pages[0]);
    await expect(pages[0].locator('video')).toHaveCount(4);
    await pages[0].screenshot({ path: testInfo.outputPath('four-screens.png'), fullPage: true });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
