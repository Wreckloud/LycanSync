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
      screenCalls: number;
      denyScreen: boolean;
      delayScreen: boolean;
      releaseScreen?: () => void;
    };
  }
}

async function installSyntheticMedia(context: BrowserContext, screenSize = { width: 1280, height: 720 }) {
  await installTestGroups(context);
  await context.addInitScript((size) => {
    const state = window.__rtcTest = {
      peers: [] as RTCPeerConnection[], tracks: [] as MediaStreamTrack[],
      microphoneCalls: 0, screenCalls: 0, denyScreen: false, delayScreen: false,
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
      const stream = await getUserMedia(constraints);
      state.tracks.push(...stream.getTracks());
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      state.screenCalls++;
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
  await expect(page.getByRole('status')).toContainText('语音已连接');
  await expect(page.getByRole('button', { name: '关闭麦克风' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '离开当前群组语音' })).toBeEnabled();
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
    const viewer = document.querySelector('.viewer-grid')!;
    const toggle = document.querySelector<HTMLButtonElement>('.member-strip-toggle')!;
    const positions = [viewer.getBoundingClientRect()];
    toggle.click();
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      positions.push(viewer.getBoundingClientRect());
    }
    const heights = positions.map((position) => position.height);
    const tops = positions.map((position) => position.top);
    return Math.max(Math.max(...heights) - Math.min(...heights), Math.max(...tops) - Math.min(...tops));
  });
}

test('未共享时显示群成员头像，停止共享后恢复头像', async ({ context, page }) => {
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  setTestAvatar(context, avatar);
  await installSyntheticMedia(context);
  await join(page, '头像测试');
  await expect(page.getByTestId('participant-card').locator('.large-avatar img')).toHaveAttribute('src', avatar);
  await page.getByRole('button', { name: '开始屏幕共享' }).click();
  await expect(page.getByTestId('viewer-screen')).toBeVisible();
  await expectStageFits(page);
  await expect(page.locator('video')).toHaveCount(1);
  await page.getByRole('button', { name: '停止屏幕共享' }).click();
  await expect(page.getByTestId('participant-card').locator('.large-avatar img')).toHaveAttribute('src', avatar);
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
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    await page.getByRole('button', { name: '展开其他成员' }).click();
    await page.getByRole('button', { name: '从主观看区移除福州小狼的共享画面' }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
    await expect(page.getByTestId('participant-card')).toHaveCount(2);
    await expect(page.getByTestId('participant-card').locator('video')).toHaveCount(1);
    await expect(page.locator('.voice-panel')).not.toHaveClass(/has-sharing/);
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expect.poll(() => page.getByTestId('participant-card').locator('video').evaluate((video) =>
      (video as HTMLVideoElement).videoHeight)).toBeLessThanOrEqual(360);
    await page.locator('.chat-heading').click();
    await page.screenshot({ path: testInfo.outputPath('screen-grid.png'), fullPage: true });
    await page.getByRole('button', { name: '开始屏幕共享', exact: true }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
    await expect(page.getByTestId('participant-card').locator('video')).toHaveCount(2);

    await page.getByRole('button', { name: '放大福州小狼的共享画面' }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    await page.getByTestId('viewer-screen').locator('.participant-media').dblclick();
    await expect(page.locator('.voice-panel')).toHaveClass(/is-focused/);
    await expect(page.locator('.chat-panel')).toHaveCount(0);
    await expect(page.getByTestId('member-filmstrip')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '退出专注观看福州小狼的共享画面' })).toBeVisible();
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
    await page.getByRole('button', { name: '退出专注观看福州小狼的共享画面' }).click();
    await expect(page.locator('.chat-panel')).toBeVisible();
    await page.getByRole('button', { name: '专注观看福州小狼的共享画面' }).click();
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
      expect(await toggleMembersAndMeasureVideo(participantPage)).toBeLessThan(2);
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
      getComputedStyle(card).animationName)).toContain('viewer-appear');
    await page.getByTestId('viewer-screen').filter({ hasText: '福州小狼' }).locator('.participant-media').dblclick();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    await expect(page.locator('.chat-panel')).toHaveCount(0);
    await page.getByRole('button', { name: '退出专注观看福州小狼的共享画面' }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(2);
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: '展开其他成员' })).toBeVisible();
    expect(await toggleMembersAndMeasureVideo(page)).toBeLessThan(2);
    await expect.poll(() => page.locator('video').evaluateAll((videos) => videos.every(
      (video) => video instanceof HTMLVideoElement && video.videoWidth > 0 && video.currentTime > 0,
    ))).toBe(true);
    await page.locator('.chat-heading').click();
    await page.screenshot({ path: testInfo.outputPath('two-screens-expanded.png'), fullPage: true });
    const expanded = await stageGeometry(page);
    expect(await toggleMembersAndMeasureVideo(page)).toBeLessThan(2);
    await expect(page.getByTestId('member-filmstrip')).toHaveCount(0);
    const collapsed = await stageGeometry(page);
    expect(Math.abs(collapsed.viewerHeight - expanded.viewerHeight)).toBeLessThan(2);
    expect(expanded.chatTop - collapsed.chatTop).toBeGreaterThan(85);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expectStageFits(page);
    await expect(page.locator('video')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('two-screens.png'), fullPage: true });
    await expect(page.getByRole('button', { name: '全屏观看福州小狼的共享画面' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '画中画观看福州小狼的共享画面' })).toBeEnabled();
    await expect(page.getByLabel('正在共享屏幕')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /聚焦.*共享画面/ })).toHaveCount(0);
    await expect(page.getByTestId('member-filmstrip')).toHaveCount(0);
    const compactCollapsed = await stageGeometry(page);
    expect(await toggleMembersAndMeasureVideo(page)).toBeLessThan(2);
    const compactExpanded = await stageGeometry(page);
    expect(Math.abs(compactExpanded.viewerHeight - compactCollapsed.viewerHeight)).toBeLessThan(2);
    expect(compactExpanded.chatTop - compactCollapsed.chatTop).toBeGreaterThan(85);
    await expectStageFits(page, 140);
    await page.locator('.chat-heading').click();
    await page.screenshot({ path: testInfo.outputPath('two-screens-compact-expanded.png'), fullPage: true });
    await page.getByRole('button', { name: '从主观看区移除福州小狼的共享画面' }).click();
    await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
    await page.getByRole('button', { name: '调整本机接收音量' }).click();
    const volumeSlider = page.getByRole('slider', { name: '本机接收音量' });
    await volumeSlider.fill('0.35');
    await expect.poll(() => page.locator('audio').evaluateAll(
      (audios) => audios[0] instanceof HTMLAudioElement ? audios[0].volume : undefined,
    )).toBeCloseTo(0.35);
    await volumeSlider.fill('0');
    await expect(page.getByRole('button', { name: '开启麦克风', exact: true })).toBeEnabled();
    await expect(otherPage.getByTestId('member-thumbnail').filter({ hasText: '苏州小狼' })
      .getByLabel('麦克风已关闭')).toBeVisible();
    await volumeSlider.fill('0.35');
    await expect(page.getByRole('button', { name: '关闭麦克风', exact: true })).toBeEnabled();
    await otherPage.getByRole('button', { name: '停止接收声音', exact: true }).click();
    await expect(page.getByTestId('member-thumbnail').filter({ hasText: '福州小狼' })
      .getByLabel('已停止接收声音')).toBeVisible();
    await expect(otherPage.getByRole('button', { name: '开启麦克风', exact: true })).toBeEnabled();
    await expect(page.getByTestId('member-thumbnail').filter({ hasText: '福州小狼' })
      .getByLabel('麦克风已关闭')).toBeVisible();
    await otherPage.getByRole('button', { name: '恢复接收声音', exact: true }).click();
    await expect(otherPage.getByRole('button', { name: '关闭麦克风', exact: true })).toBeEnabled();
    await expect(page.getByTestId('member-thumbnail').filter({ hasText: '福州小狼' })
      .getByLabel('麦克风已开启')).toBeVisible();
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
    await pages[0].getByRole('button', { name: '收起其他成员' }).click();
    await pages[0].setViewportSize({ width: 1280, height: 720 });
    await expectStageFits(pages[0]);
    await expect(pages[0].locator('video')).toHaveCount(4);
    await pages[0].screenshot({ path: testInfo.outputPath('four-screens.png'), fullPage: true });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
