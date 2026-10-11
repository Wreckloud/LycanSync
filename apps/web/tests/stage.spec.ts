import { test, expect, type Page } from '@playwright/test';

const user = { id: 'stage-user', nickname: '自己', avatar: '', administrator: true };
const groups = ['舞台测试', '另一群组'].map((name, index) => ({
  id: `stage-group-${index}`, name, description: '', avatar: '', role: 'OWNER', memberCount: 7,
  createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', members: [],
}));

// 只替换网络和 RTC 边界；App、舞台规则、设置和成员组件使用生产实现。
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/options') return route.fulfill({ json: { mode: 'invite' } });
    if (path === '/api/auth/me' || path === '/api/auth/session') return route.fulfill({ json: user });
    if (path === '/api/presence/heartbeat') return route.fulfill({ status: 204 });
    if (path === '/api/groups') return route.fulfill({ json: groups });
    if (path.endsWith('/messages')) return route.fulfill({ json: { messages: [], hasMore: false } });
    if (path.endsWith('/presence-changes')) {
      if (new URL(route.request().url()).searchParams.has('serverInstanceId')) return new Promise<void>(() => {});
      return route.fulfill({ json: { serverInstanceId: 'stage-test', version: 0, changed: true } });
    }
    if (path.endsWith('/presences') || path === '/api/rtc/room-occupancies') return route.fulfill({ json: [] });
    if (path.startsWith('/api/rtc/room-summary')) return route.fulfill({ json: { participantCount: 0, participants: [] } });
    const group = groups.find((entry) => path === '/api/groups/' + entry.id);
    return group ? route.fulfill({ json: group }) : route.fulfill({ status: 404, json: { detail: '未提供的测试接口' } });
  });
  await page.route('**/src/rtc/useCallSounds.ts*', (route) => route.fulfill({
    contentType: 'text/javascript', body: 'export function useCallSounds() { return new Proxy({}, { get: () => async () => {} }); }',
  }));
  await page.route('**/src/rtc/useRtcRoom.ts*', async (route) => {
    const original = await (await route.fetch()).text();
    const vuePath = original.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)?.[1];
    const livekitPath = original.match(/from ["']([^"']*\/livekit-client\.js[^"']*)["']/)?.[1];
    if (!vuePath || !livekitPath) throw new Error('未找到 Vite Vue 或 LiveKit 模块');
    await route.fulfill({ contentType: 'text/javascript', body: `
import { ref, shallowRef, markRaw } from ${JSON.stringify(vuePath)};
import { LocalVideoTrack, RemoteVideoTrack, RemoteTrackPublication, Track, TrackEvent } from ${JSON.stringify(livekitPath)};
export function useRtcRoom() {
  const revision = ref(0), status = ref('idle'), room = shallowRef(null), participants = shallowRef([]);
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  canvas.getContext('2d').fillRect(0, 0, 320, 180);
  const stream = canvas.captureStream(0);
  const track = new LocalVideoTrack(stream.getVideoTracks()[0], undefined, true);
  const visibility = {}, quality = {}, remoteTracks = [];
  const makeParticipant = (identity, name, isLocal = false) => {
    const video = isLocal ? track : new RemoteVideoTrack(stream.getVideoTracks()[0].clone(), 'share-' + identity,
      { getStats: async () => new Map() });
    const publication = isLocal ? { track: video, isMuted: false } : new RemoteTrackPublication(Track.Kind.Video,
      { sid: 'share-' + identity, name: 'share', type: 1, source: 3, simulcast: true }, true);
    if (!isLocal) {
      remoteTracks.push(video);
      publication.setTrack(video);
      publication.on(TrackEvent.UpdateSettings, (settings) => {
        visibility[identity] = !settings.disabled; quality[identity] = settings.quality;
      });
    }
    return markRaw({ identity, name, attributes: {},
    isScreenShareEnabled: false, isMicrophoneEnabled: false, isSpeaking: false,
    getTrackPublication(source) { return source === 'screen_share' && this.isScreenShareEnabled ? publication : undefined; }
  }); };
  const local = makeParticipant('user-stage-user', '自己', true);
  const friends = ['A','B','C','D','E','F'].map((id) => makeParticipant(id, '成员' + id));
  window.__stageTest = {
    sharing(ids) { for (const member of [local, ...friends]) member.isScreenShareEnabled = ids.includes(member.identity); revision.value++; },
    visibility() { return { ...visibility }; },
    quality() { return { ...quality }; },
    connection(value) { status.value = value; },
    reorder() { participants.value = [local, ...friends.slice().reverse()]; revision.value++; }
  };
  window.addEventListener('pagehide', () => {
    remoteTracks.forEach((track) => track.stop());
    track.stop();
    stream.getTracks().forEach((track) => track.stop());
  }, { once: true });
  return { revision, status, room, participants, notice: ref(''), busySources: ref([]),
    needsAudioPlayback: ref(false), remoteControlShares: ref({}), remoteControlActive: ref(null),
    remoteControlPending: ref(null), remoteControlRequest: ref(null), remoteControlOwner: ref(null),
    remoteControlCleanupPending: ref(false), microphoneLoopbackState: ref('idle'), microphoneLoopbackNotice: ref(''),
    currentScreenShareQuality: ref('standard'), screenShareQualityBusy: ref(false),
    async join() { room.value = markRaw({ localParticipant: local, remoteParticipants: new Map(), state: 'connected' });
      participants.value = [local, ...friends]; status.value = 'connected'; revision.value++; return true; },
    leave() { friends.forEach((friend) => friend.isScreenShareEnabled = false); room.value = null; participants.value = []; status.value = 'idle'; revision.value++; },
    async updateListeningState() {}, stopMicrophoneLoopback() {}, setMicrophoneLoopbackVolume() {},
    setMicrophoneInputGain() {}, setMicrophoneProcessing() {}, setRemoteAudioSubscribed() {},
    async sendEntranceSound() {}, async toggleMedia() {}, cancelPendingScreenShareSelection() {}
  };
}` });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^舞台测试，/ }).dblclick();
  await expect(page.getByTestId('member-count')).toContainText('7 人');
});

async function sharing(page: Page, ids: string[]) {
  await page.evaluate((identities) => (window as unknown as { __stageTest: { sharing(ids: string[]): void } }).__stageTest.sharing(identities), ids);
}

async function stageNames(page: Page) {
  return page.getByTestId('viewer-screen').locator('.participant-meta > strong').allTextContents();
}

test('隐藏观看保留远端轨道，返回恢复可见需求，本地预览暂停不结束采集', async ({ page }) => {
  await sharing(page, ['user-stage-user', 'A', 'B']);
  const visibility = () => page.evaluate(() => (window as unknown as {
    __stageTest: { visibility(): Record<string, boolean> }
  }).__stageTest.visibility());
  await expect.poll(visibility).toMatchObject({ A: true, B: true });
  const localVideo = page.getByTestId('viewer-screen').getByLabel('自己的共享画面', { exact: true });
  await expect.poll(() => localVideo.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  const localStream = await localVideo.evaluateHandle((video: HTMLVideoElement) => video.srcObject);
  const remoteStream = await page.getByLabel('成员A的共享画面', { exact: true }).evaluateHandle((video: HTMLVideoElement) => video.srcObject);
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await expect.poll(visibility).toMatchObject({ A: false, B: false });
  await expect.poll(() => localVideo.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  // 模拟最小化后恢复的文档事件，让真实 SDK 执行恢复播放；设置页仍未关闭。
  const restoredPreview = await localVideo.evaluate(async (video: HTMLVideoElement) => {
    let playbackAttempts = 0;
    const recordPlayback = () => { playbackAttempts++; };
    video.addEventListener('play', recordPlayback);
    try {
      for (const state of ['hidden', 'visible']) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
        document.dispatchEvent(new Event('visibilitychange'));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return { playbackAttempts, paused: video.paused };
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
      video.removeEventListener('play', recordPlayback);
    }
  });
  expect(restoredPreview.playbackAttempts).toBeGreaterThan(0);
  expect(restoredPreview.paused).toBe(true);
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await expect.poll(visibility).toMatchObject({ A: true, B: true });
  await expect.poll(() => localVideo.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  expect(await localVideo.evaluate((video: HTMLVideoElement, stream) => video.srcObject === stream, localStream)).toBe(true);
  expect(await localVideo.evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getVideoTracks()[0].readyState)).toBe('live');
  expect(await page.getByLabel('成员A的共享画面', { exact: true }).evaluate(
    (video: HTMLVideoElement, stream) => video.srcObject === stream, remoteStream)).toBe(true);
  await page.getByRole('button', { name: '单路观看成员A的共享画面', exact: true }).click();
  await expect.poll(visibility).toMatchObject({ A: true, B: false });
  await page.getByRole('button', { name: '返回多人舞台', exact: true }).click();
  await expect.poll(visibility).toMatchObject({ A: true, B: true });
  await page.getByRole('button', { name: /^另一群组，/ }).click();
  await expect.poll(visibility).toMatchObject({ A: false, B: false });
  await page.getByRole('button', { name: '返回当前通话群组' }).click();
  await expect.poll(visibility).toMatchObject({ A: true, B: true });
  await localStream.dispose();
  await remoteStream.dispose();
});

test('成员小窗请求低层，四路舞台请求主层，单路隐藏其他画面且返回恢复', async ({ page }) => {
  await sharing(page, ['A', 'B', 'C', 'D', 'E']);
  await page.getByRole('button', { name: '展开其他成员' }).click();
  await page.getByRole('button', { name: '下一页成员' }).click();
  const qualities = () => page.evaluate(() => (window as unknown as {
    __stageTest: { quality(): Record<string, number> }
  }).__stageTest.quality());
  const visibility = () => page.evaluate(() => (window as unknown as {
    __stageTest: { visibility(): Record<string, boolean> }
  }).__stageTest.visibility());
  // SDK 的 LOW=0、HIGH=2；舞台四路也请求主层，不设置额外的帧率上限。
  await expect.poll(qualities).toMatchObject({ A: 2, B: 2, C: 2, D: 2, E: 0 });
  await page.getByRole('button', { name: '单路观看成员A的共享画面', exact: true }).click();
  await expect.poll(visibility).toMatchObject({ A: true, B: false, C: false, D: false, E: false });
  await page.getByRole('button', { name: '返回多人舞台', exact: true }).click();
  await expect.poll(visibility).toMatchObject({ A: true, B: true, C: true, D: true });
  await expect.poll(qualities).toMatchObject({ A: 2, B: 2, C: 2, D: 2 });
});

test('四槽自动补位、手工替换、单路返回及预览其他群保持安排', async ({ page }) => {
  await sharing(page, ['A']);
  await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
  await sharing(page, ['A', 'B', 'C', 'D', 'E', 'F']);
  await expect.poll(() => stageNames(page)).toEqual(['成员A', '成员B', '成员C', '成员D']);
  await page.screenshot({ path: test.info().outputPath('four-slot-stage.png') });
  await page.getByRole('button', { name: '从舞台移出成员B的共享画面', exact: true }).click();
  await expect.poll(() => stageNames(page)).toEqual(['成员A', '成员E', '成员C', '成员D']);
  await page.getByRole('button', { name: '展开其他成员' }).click();
  await page.getByRole('button', { name: '下一页成员' }).click();
  await page.getByRole('button', { name: '放大成员F的共享画面', exact: true }).click();
  await expect.poll(() => stageNames(page)).toEqual(['成员F', '成员E', '成员C', '成员D']);
  await page.evaluate(() => (window as unknown as { __stageTest: { connection(value: string): void } }).__stageTest.connection('reconnecting'));
  await sharing(page, []);
  await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
  await sharing(page, ['A', 'B', 'C', 'D', 'E', 'F']);
  await page.evaluate(() => (window as unknown as { __stageTest: { connection(value: string): void } }).__stageTest.connection('connected'));
  await expect.poll(() => stageNames(page)).toEqual(['成员F', '成员E', '成员C', '成员D']);
  await page.getByRole('button', { name: '单路观看成员C的共享画面', exact: true }).click();
  await expect.poll(() => stageNames(page)).toEqual(['成员C']);
  await page.getByRole('button', { name: '返回多人舞台', exact: true }).click();
  await expect.poll(() => stageNames(page)).toEqual(['成员F', '成员E', '成员C', '成员D']);
  await page.getByRole('button', { name: /^另一群组，/ }).click();
  await page.getByRole('button', { name: '返回当前通话群组' }).click();
  await expect.poll(() => stageNames(page)).toEqual(['成员F', '成员E', '成员C', '成员D']);
  await sharing(page, ['A', 'B', 'D', 'E', 'F']);
  await expect.poll(() => stageNames(page)).toEqual(['成员F', '成员E', '成员D']);
});

test('设置即时生效、拖动交换和空槽吸附、双击单路及离房清理', async ({ page }) => {
  await sharing(page, ['A', 'B', 'C', 'D', 'E']);
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await page.getByRole('button', { name: '客户端', exact: true }).click();
  await page.getByRole('checkbox', { name: '自动填充舞台', exact: true }).uncheck();
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await page.getByRole('button', { name: '从舞台移出成员B的共享画面', exact: true }).click();
  await expect.poll(() => stageNames(page)).toEqual(['成员A', '成员C', '成员D']);
  await page.getByRole('button', { name: '拖动排列成员A的共享画面', exact: true }).dragTo(page.locator('[data-stage-slot="3"]'));
  await expect.poll(() => stageNames(page)).toEqual(['成员D', '成员C', '成员A']);
  await page.getByRole('button', { name: '拖动排列成员C的共享画面', exact: true }).dragTo(page.locator('[data-stage-slot="1"]'));
  await expect.poll(() => stageNames(page)).toEqual(['成员D', '成员C', '成员A']);
  await expect(page.locator('[data-stage-slot="1"]')).toContainText('成员C');
  await page.locator('[data-stage-slot="1"] .participant-media').dblclick();
  await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
  await page.getByRole('button', { name: '返回多人舞台', exact: true }).click();
  await page.getByRole('button', { name: '拖动排列成员A的共享画面', exact: true }).press('Alt+ArrowUp');
  await expect(page.locator('[data-stage-slot="1"]')).toContainText('成员A');
  await page.getByRole('button', { name: '离开语音', exact: true }).click();
  await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
  await page.getByRole('button', { name: /^舞台测试，/ }).dblclick();
  await sharing(page, ['A', 'B']);
  await expect(page.getByTestId('viewer-screen')).toHaveCount(0);
  await page.getByRole('button', { name: '放大成员A的共享画面', exact: true }).click();
  await expect.poll(() => stageNames(page)).toEqual(['成员A']);
  expect(await page.evaluate(() => localStorage.getItem('lycansync.stage-auto-fill.v1.stage-user'))).toBe('false');
});

test('全屏和窗口全屏只显示所选一路，返回后恢复舞台且没有播放器控件', async ({ page }) => {
  await sharing(page, ['A', 'B']);
  await page.getByRole('button', { name: '窗口全屏观看成员A的共享画面', exact: true }).click();
  await expect(page.locator('.is-window-fullscreen')).toHaveCount(1);
  await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
  await page.getByRole('button', { name: '返回多人舞台成员A的共享画面', exact: true }).click();
  await expect(page.locator('.is-window-fullscreen')).toHaveCount(0);
  await expect(page.getByTestId('viewer-screen')).toHaveCount(2);
  await page.getByRole('button', { name: '全屏观看成员A的共享画面', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid'))).toBe('viewer-screen');
  await expect(page.getByTestId('viewer-screen')).toHaveCount(1);
  expect(await page.locator('video').evaluateAll((elements) => elements.every((element) => !(element as HTMLVideoElement).controls))).toBe(true);
  await page.getByRole('button', { name: '返回多人舞台成员A的共享画面', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect.poll(() => stageNames(page)).toEqual(['成员A', '成员B']);
  await page.setViewportSize({ width: 960, height: 720 });
  await sharing(page, ['A', 'B', 'C', 'D']);
  await expect(page.getByRole('button', { name: '从舞台移出成员D的共享画面', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('narrow-stage.png') });
});
