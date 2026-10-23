import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const user = { id: 'viewing-user', nickname: '自己', avatar: '', administrator: true };
const groups = ['观看测试', '另一群组'].map((name, index) => ({
  id: `viewing-group-${index}`, name, description: '', avatar: '', role: 'OWNER', memberCount: 7,
  createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', members: [{ userId: 'viewing-user', nickname: '自己', role: 'OWNER', avatar: '' },
    ...['A','B','C','D','E','F'].map((id) => ({ userId: id, nickname: '成员' + id, role: 'MEMBER', avatar: '' }))],
}));

// 只替换网络和 RTC 边界；App、窗口登记、设置和成员组件使用生产实现。
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
      return route.fulfill({ json: { serverInstanceId: 'viewing-test', version: 0, changed: true } });
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
import { LocalVideoTrack, RemoteVideoTrack, RemoteTrackPublication, Track, TrackEvent, RoomEvent } from ${JSON.stringify(livekitPath)};
export function useRtcRoom() {
  const revision = ref(0), status = ref('idle'), room = shallowRef(null), participants = shallowRef([]);
  const listening = ref(true), microphoneIntent = ref(false), microphoneEnabled = ref(false);
  const remoteControlShares = ref({}), remoteControlActive = ref(null), remoteControlPending = ref(null);
  const inputs = [];
  const makeRoom = () => {
    const callbacks = new Map();
    return markRaw({ localParticipant: local, remoteParticipants: new Map(friends.map((member) => [member.identity, member])), state: 'connected',
      on(name, callback) { const listeners = callbacks.get(name) || new Set(); listeners.add(callback); callbacks.set(name, listeners); return this; },
      off(name, callback) { callbacks.get(name)?.delete(callback); return this; },
      emit(name, ...args) { for (const callback of callbacks.get(name) || []) callback(...args); }
    });
  };
  const currentScreenShareQuality = ref('standard');
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
    isScreenShareEnabled: false, isMicrophoneEnabled: false, isSpeaking: false, audioLevel: 0,
    getTrackPublication(source) { return source === 'screen_share' && this.isScreenShareEnabled ? publication : undefined; }
  }); };
  const local = makeParticipant('user-viewing-user', '自己', true);
  const friends = ['A','B','C','D','E','F'].map((id) => makeParticipant(id, '成员' + id));
  window.__viewingTest = {
    sharing(ids) {
      for (const member of [local, ...friends]) member.isScreenShareEnabled = ids.includes(member.identity);
      revision.value++;
    },
    control(identity) { remoteControlShares.value = { ...remoteControlShares.value, [identity]: { kind: 'monitor', shareSessionId: identity + '-share' } }; revision.value++; },
    grant(identity) { remoteControlPending.value = null; remoteControlActive.value = { identity, shareSessionId: identity + '-share', controlSessionId: identity + '-control' }; },
    inputEvents() { return inputs.slice(); },
    disconnected(identity) {
      participants.value = participants.value.filter((member) => member.identity !== identity);
      room.value.emit(RoomEvent.ParticipantDisconnected, friends.find((member) => member.identity === identity));
      revision.value++;
    },
    visibility() { return { ...visibility }; },
    quality() { return { ...quality }; },
    connection(value) { status.value = value; if (value === 'connected') room.value.emit(RoomEvent.Reconnected); },
    reorder() { participants.value = [local, ...friends.slice().reverse()]; revision.value++; }
  };
  window.addEventListener('pagehide', () => {
    remoteTracks.forEach((track) => track.stop());
    track.stop();
    stream.getTracks().forEach((track) => track.stop());
  }, { once: true });
  return { revision, status, room, participants, notice: ref(''), busySources: ref([]),
    listening, microphoneIntent, microphoneEnabled,
    needsAudioPlayback: ref(false), remoteControlShares, remoteControlActive,
    remoteControlPending, remoteControlRequest: ref(null), remoteControlOwner: ref(null),
    remoteControlCleanupPending: ref(false), remoteControlGranting: ref(false),
    currentScreenShareQuality, screenShareQualityBusy: ref(false), screenShareSourceBusy: ref(false),
    currentScreenShareAudioMode: ref('unavailable'),
    async join() { room.value = makeRoom();
      listening.value = true; microphoneIntent.value = true; microphoneEnabled.value = true;
      local.isMicrophoneEnabled = true;
      participants.value = [local, ...friends]; status.value = 'connected'; revision.value++; return true; },
    async leave() { [local, ...friends].forEach((member) => member.isScreenShareEnabled = false);
      microphoneIntent.value = false; microphoneEnabled.value = false; local.isMicrophoneEnabled = false;
      room.value = null; participants.value = []; status.value = 'idle'; revision.value++; },
    async updateListeningState(enabled) {
      listening.value = enabled; microphoneEnabled.value = enabled && microphoneIntent.value;
      local.isMicrophoneEnabled = microphoneEnabled.value; revision.value++;
    },
    async enableAudioPlayback() {},
    setMicrophoneInputGain() {}, setMicrophoneProcessing() {}, setRemoteAudioSubscribed() {},
    async sendEntranceSound() {}, async toggleMedia(source) {
      if (source !== Track.Source.Microphone || status.value !== 'connected') return;
      microphoneIntent.value = !microphoneEnabled.value;
      if (microphoneIntent.value) listening.value = true;
      microphoneEnabled.value = listening.value && microphoneIntent.value;
      local.isMicrophoneEnabled = microphoneEnabled.value; revision.value++;
    },
    async setScreenShareQuality(value) { currentScreenShareQuality.value = value; return true; },
    async setScreenShareAudioEnabled() { return false; }, async changeScreenShareSource() { return false; },
    async requestRemoteControl(identity) { remoteControlPending.value = { identity }; },
    sendRemoteControlInput(input) { inputs.push(input); },
    async exitRemoteControl() { remoteControlActive.value = null; },
    async revokeRemoteControl() {}, async retryRemoteControlCleanup() {}, async allowRemoteControl() {},
    async rejectRemoteControl() {}, async cancelPendingRemoteControl() { remoteControlPending.value = null; }, cancelPendingScreenShareSelection() {}
  };
}` });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^观看测试，/ }).dblclick();
  await expect(page.getByTestId('member-count')).toContainText('7 人');
});

async function sharing(page: Page, ids: string[]) {
  await page.evaluate((identities) => (window as unknown as { __viewingTest: { sharing(ids: string[]): void } }).__viewingTest.sharing(identities), ids);
}

test('主动诊断记录返回应用后继续，离房结束并导出匿名报告', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await sharing(page, ['A', 'B']);
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await page.getByRole('button', { name: '关于与诊断', exact: true }).click();
  const report = page.locator('.diagnostic-report-settings');
  await report.getByRole('textbox', { name: '体验说明（选填）' }).fill('合成界面回归');
  await report.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect(report.getByRole('status')).toContainText('记录中');
  await expect(report.getByRole('status')).not.toContainText('0 份统计');
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: '离开语音', exact: true }).click();
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await page.getByRole('button', { name: '关于与诊断', exact: true }).click();
  await expect(report.getByRole('status')).toContainText('记录已结束');
  await expect(report.getByRole('textbox', { name: '体验说明（选填）' })).toHaveValue('合成界面回归');
  const downloading = page.waitForEvent('download');
  await report.getByRole('button', { name: '导出报告', exact: true }).click();
  const download = await downloading;
  const path = await download.path();
  if (!path) throw new Error('未取得测试报告下载');
  const text = await readFile(path, 'utf8');
  const result = JSON.parse(text);
  expect(result.kind).toBe('lycansync-diagnostics');
  expect(result.stopReason).toBe('roomChanged');
  expect(result.samples.length).toBeGreaterThan(1);
  expect(result.notes).toBe('合成界面回归');
  expect(text).not.toContain('user-viewing-user');
  expect(text).not.toContain('成员A');
  expect(pageErrors).toEqual([]);
});


async function openViewer(page: Page, identity: string) {
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开成员' + identity + '的独立观看窗口', exact: true }).click();
  const viewer = await popup;
  await expect(viewer.getByTestId('viewer-screen')).toBeVisible();
  return viewer;
}

test('两路独立观看不自动开窗，不重复打开，保留群聊与草稿，关闭不停止共享', async ({ page, context }) => {
  const errors: string[] = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  page.on('pageerror', (error) => errors.push(error.message));
  await sharing(page, ['A', 'B']);
  expect(context.pages()).toHaveLength(1);
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('稍后继续写');
  const original = await input.elementHandle();
  const a = await openViewer(page, 'A'), b = await openViewer(page, 'B');
  await page.getByRole('button', { name: '打开成员A的独立观看窗口', exact: true }).click();
  expect(context.pages()).toHaveLength(3);
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('稍后继续写');
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(a).toHaveTitle('成员A · 观看测试 · LycanSync');
  await expect(b).toHaveTitle('成员B · 观看测试 · LycanSync');
  const quality = () => page.evaluate(() => (window as unknown as { __viewingTest: { quality(): Record<string, number> } }).__viewingTest.quality());
  await expect.poll(quality).toMatchObject({ A: 2, B: 2 });
  expect(await a.locator('video').evaluate((video: HTMLVideoElement) => video.muted && !video.controls)).toBe(true);
  expect(await a.locator('audio').count()).toBe(0);
  await a.close();
  await expect.poll(quality).toMatchObject({ A: 0, B: 2 });
  await expect(page.getByRole('button', { name: '打开成员A的独立观看窗口', exact: true })).toBeVisible();
  await expect(b.getByTestId('viewer-screen')).toBeVisible();
  expect(errors).toEqual([]);
});

test('设置或预览别群不关闭观看，停止共享保留结束页，新共享不自动接管；离房关闭全部', async ({ page }) => {
  await sharing(page, ['A', 'B']);
  const a = await openViewer(page, 'A'), b = await openViewer(page, 'B');
  const callbar = page.getByTestId('callbar');
  await expect(callbar).toHaveCSS('animation-name', 'none');
  await callbar.evaluate((element) => {
    element.setAttribute('data-replayed', '0');
    element.addEventListener('animationstart', () => element.setAttribute('data-replayed', '1'));
  });
  await page.getByRole('button', { name: '语音与音频设置', exact: true }).click();
  await expect(a.getByTestId('viewer-screen')).toBeVisible();
  await page.getByRole('button', { name: '客户端', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '自动填充舞台', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await page.getByRole('button', { name: /^另一群组，/ }).click();
  await expect(b.getByTestId('viewer-screen')).toBeVisible();
  await page.getByRole('button', { name: '返回当前通话群组' }).click();
  await expect(callbar).toHaveAttribute('data-replayed', '0');
  await sharing(page, ['B']);
  await expect(a.getByRole('status').filter({ hasText: '共享已结束' })).toBeVisible();
  await expect(a.locator('video')).toHaveCount(0);
  await sharing(page, ['A', 'B']);
  await expect(a.locator('video')).toHaveCount(0);
  await page.getByRole('button', { name: '离开语音', exact: true }).click();
  await expect.poll(() => a.isClosed() && b.isClosed()).toBe(true);
});

test('真实切房和成员离开清理观看，预览切群不重播通话动画', async ({ page }) => {
  await sharing(page, ['A', 'B']);
  const a = await openViewer(page, 'A'), b = await openViewer(page, 'B');
  await page.evaluate(() => (window as unknown as { __viewingTest: { disconnected(id: string): void } }).__viewingTest.disconnected('A'));
  await expect.poll(() => a.isClosed()).toBe(true);
  await page.getByRole('button', { name: /^另一群组，/ }).dblclick();
  expect(b.isClosed()).toBe(false);
  await page.getByRole('button', { name: '切换', exact: true }).click();
  await expect.poll(() => b.isClosed()).toBe(true);
  await expect(page.getByTestId('callbar')).toBeVisible();
});

test('常驻成员栏保留搜索与王冠，语音横跨上方，聊天及个人名片边界对齐', async ({ page }) => {
  const directory = page.getByRole('complementary', { name: '群组成员', exact: true });
  const searchButton = directory.getByRole('button', { name: '搜索群组成员' });
  await expect(directory).toBeVisible();
  await expect(directory.getByRole('img', { name: '群主' })).toHaveCount(1);
  await expect(directory.locator('.group-member-row')).toHaveCount(7);
  await searchButton.click();
  await directory.getByRole('searchbox').fill('成员A');
  await expect(directory.locator('.group-member-row')).toHaveCount(1);
  await directory.getByRole('searchbox').press('Escape');
  await expect(searchButton).toBeFocused();
  await expect(directory.getByRole('searchbox')).toHaveCount(0);
  await expect(directory.locator('.group-member-row')).toHaveCount(7);
  await expect(page.getByRole('button', { name: '查看全部群组成员' })).toHaveCount(0);
  const chat = page.getByRole('region', { name: '观看测试群聊' });
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('保留这条草稿');
  const original = await input.elementHandle();
  for (const width of [1440, 960, 640, 420]) {
    await page.setViewportSize({ width, height: 900 });
    const members = await directory.boundingBox();
    const voice = await page.getByRole('region', { name: '当前语音成员', exact: true }).boundingBox();
    const conversation = await chat.boundingBox();
    const personal = await page.getByLabel('个人状态与设置').boundingBox();
    expect(Math.abs(members!.y - (voice!.y + voice!.height))).toBeLessThanOrEqual(1);
    expect(Math.abs(members!.y - conversation!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(members!.x - (conversation!.x + conversation!.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(members!.x - personal!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(members!.width - personal!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(voice!.x + voice!.width - members!.x - members!.width)).toBeLessThanOrEqual(1);
    await expect(input).toBeInViewport();
    await expect(page.getByRole('button', { name: '语音与音频设置', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '离开语音', exact: true }).click();
  await expect(page.getByRole('region', { name: '当前语音成员', exact: true })).toHaveCount(0);
  const header = await page.locator('.group-header').boundingBox();
  const members = await directory.boundingBox();
  expect(Math.abs(members!.y - header!.y - header!.height)).toBeLessThanOrEqual(1);
  await expect(input).toHaveValue('保留这条草稿');
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('members-sidebar.png') });
});

test('远控只在独立画面接收输入，失焦释放、不自动恢复，Esc与关闭结束控制', async ({ page }) => {
  await sharing(page, ['A']);
  await page.evaluate(() => (window as unknown as { __viewingTest: { control(id: string): void } }).__viewingTest.control('A'));
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: '申请远程控制', exact: true }).click();
  const viewer = await popup;
  await expect(viewer.getByRole('button', { name: '取消远程控制申请' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __viewingTest: { grant(id: string): void } }).__viewingTest.grant('A'));
  await expect(viewer.locator('.remote-control-status').filter({ hasText: '点击画面开始操作' })).toBeVisible();
  await expect.poll(() => viewer.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await viewer.setViewportSize({ width: 1000, height: 900 });
  await viewer.locator('.participant-media').click({ position: { x: 5, y: 5 } });
  await viewer.locator('.participant-media').focus();
  await viewer.keyboard.press('a');
  const beforeActivation = await page.evaluate(() => (window as unknown as { __viewingTest: { inputEvents(): unknown[] } }).__viewingTest.inputEvents());
  expect(beforeActivation).toEqual([]);
  await viewer.locator('.participant-media').click();
  await viewer.locator('.participant-media').press('a');
  const inputs = () => page.evaluate(() => (window as unknown as { __viewingTest: { inputEvents(): Array<{ kind: string; key: string }> } }).__viewingTest.inputEvents());
  await expect.poll(inputs).toContainEqual({ kind: 'keyDown', key: 'letterA' });
  await viewer.locator('.participant-media').focus();
  await viewer.keyboard.down('b');
  await viewer.evaluate(() => window.dispatchEvent(new Event('lycan-viewer-disarm')));
  await expect.poll(inputs).toContainEqual({ kind: 'keyUp', key: 'letterB' });
  const count = (await inputs()).length;
  await viewer.keyboard.press('c');
  expect((await inputs()).length).toBe(count);
  await viewer.keyboard.press('Escape');
  await expect(viewer.getByRole('button', { name: '申请远程控制' })).toBeVisible();
  await viewer.getByRole('button', { name: '申请远程控制', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __viewingTest: { grant(id: string): void } }).__viewingTest.grant('A'));
  await expect(viewer.locator('.remote-control-status').filter({ hasText: '点击画面开始操作' })).toBeVisible();
  await viewer.close();
  await expect(page.getByRole('button', { name: '申请远程控制', exact: true })).toBeVisible();
});
