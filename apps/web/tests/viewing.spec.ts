import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const user = { id: 'viewing-user', nickname: '自己', avatar: '', administrator: true };
const groups = ['观看测试', '另一群组'].map((name, index) => ({
  id: `viewing-group-${index}`, name, description: '', avatar: '', role: 'OWNER', memberCount: 9,
  createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', members: [{ userId: 'viewing-user', nickname: '自己', role: 'OWNER', avatar: '' },
    ...['A','B','C','D','E','F','G','H'].map((id) => ({ userId: id, nickname: '成员' + id, role: 'MEMBER', avatar: '' }))],
}));

// 只替换网络和 RTC 边界；App、窗口登记、设置和成员组件使用生产实现。
test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/options') return route.fulfill({ json: { mode: 'invite' } });
    if (path === '/api/auth/me' || path === '/api/auth/session') return route.fulfill({ json: user });
    if (path === '/api/presence/heartbeat') return route.fulfill({ status: 204 });
    if (path === '/api/groups') return route.fulfill({ json: groups.map(({ members, ...summary }) => summary) });
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
import { LocalVideoTrack, RemoteAudioTrack, RemoteVideoTrack, RemoteTrackPublication, Track, TrackEvent, RoomEvent } from ${JSON.stringify(livekitPath)};
export function useRtcRoom() {
  const revision = ref(0), status = ref('idle'), room = shallowRef(null), participants = shallowRef([]);
  const listening = ref(true), microphoneIntent = ref(false), microphoneEnabled = ref(false);
  const remoteControlShares = ref({}), remoteControlActive = ref(null), remoteControlPending = ref(null);
  const remoteControlAvailable = ref({}), remoteControlRequest = ref(null);
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
  const visibility = {}, quality = {}, remoteTracks = [], reports = {};
  const shareAudioTracks = new Map();
  let shareAudioContext;
  const makeParticipant = (identity, name, isLocal = false) => {
    const video = isLocal ? track : new RemoteVideoTrack(stream.getVideoTracks()[0].clone(), 'share-' + identity,
      { getStats: async () => reports[identity] || new Map() });
    const audio = { isLocal: false, getRTCStatsReport: async () => reports[identity] || new Map() };
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
    getTrackPublication(source) {
      if (source === 'screen_share_audio' && this.isScreenShareEnabled && shareAudioTracks.has(identity)) return { track: shareAudioTracks.get(identity) };
      if (source === 'microphone' && !isLocal && this.isMicrophoneEnabled) return { track: audio };
      return source === 'screen_share' && this.isScreenShareEnabled ? publication : undefined;
    }
  }); };
  const local = makeParticipant('user-viewing-user', '自己', true);
  const friends = ['A','B','C','D','E','F','G','H'].map((id) => makeParticipant(id, '成员' + id));
  window.__viewingTest = {
    addShareAudio(ids) {
      shareAudioContext ??= new AudioContext();
      for (const id of ids) {
        const silent = shareAudioContext.createMediaStreamDestination().stream.getAudioTracks()[0];
        shareAudioTracks.set(id, new RemoteAudioTrack(silent, 'share-audio-' + id, { getStats: async () => new Map() }));
      }
      participants.value = [...participants.value];
      revision.value++;
    },
    shareVolumes() { return Object.fromEntries([...shareAudioTracks].map(([id, audio]) => [id, audio.getVolume()])); },
    requestControl(identity) { remoteControlRequest.value = { identity, requestId: identity + '-incoming' }; },
    transport(identity, ms) {
      const participant = friends.find(friend => friend.identity === identity);
      participant.connectionQuality = 'good';
      participant.isMicrophoneEnabled = true;
      reports[identity] = new Map([
        ['audio', { id: 'audio', type: 'inbound-rtp', kind: 'audio', transportId: 'transport' }],
        ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', frameWidth: 1280, frameHeight: 720, transportId: 'transport' }],
        ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: ms / 1000, responsesReceived: ms }],
      ]);
      revision.value++;
    },
    paint(width, height, color) {
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').fillStyle = color;
      canvas.getContext('2d').fillRect(0, 0, width, height);
      stream.getVideoTracks()[0].requestFrame();
    },
    async diagnostics() {
      const { createMediaDiagnosticsSampler } = await import('/src/diagnostics/mediaDiagnostics.ts');
      return createMediaDiagnosticsSampler().collect(room.value, participants.value);
    },
    sharing(ids) {
      for (const member of [local, ...friends]) member.isScreenShareEnabled = ids.includes(member.identity);
      revision.value++;
    },
    microphones(ids) {
      for (const member of friends) member.isMicrophoneEnabled = ids.includes(member.identity);
      revision.value++;
    },
    setListening(id, enabled) {
      friends.find(member => member.identity === id).attributes['lycansync.listening'] = String(enabled);
      revision.value++;
    },
    control(identity) { remoteControlShares.value = { ...remoteControlShares.value, [identity]: { kind: 'monitor', shareSessionId: identity + '-share' } }; remoteControlAvailable.value = { ...remoteControlAvailable.value, [identity]: true }; revision.value++; },
    grant(identity) { remoteControlPending.value = null; remoteControlActive.value = { identity, shareSessionId: identity + '-share', controlSessionId: identity + '-control', trackSid: 'share-' + identity }; },
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
    shareAudioTracks.forEach(audio => audio.mediaStreamTrack.stop());
    void shareAudioContext?.close();
    remoteTracks.forEach((track) => track.stop());
    track.stop();
    stream.getTracks().forEach((track) => track.stop());
  }, { once: true });
  return { revision, status, room, participants, notice: ref(''), busySources: ref([]),
    async startApplicationAudio() { throw new Error('此观看测试未模拟应用声音采集'); },
    async stopApplicationAudio() {},
    get screenShareActive() { void revision.value; return local.isScreenShareEnabled; },
    listening, microphoneIntent, microphoneEnabled,
    needsAudioPlayback: ref(false), remoteControlShares, remoteControlActive, remoteControlAvailable,
    remoteControlPresentations: ref({}), remoteControlRestoring: ref(false),
    screenShareAudioRestricted: ref(false),
    remoteControlPending, remoteControlRequest, remoteControlOwner: ref(null),
    remoteControlCleanupPending: ref(false), remoteControlGranting: ref(false),
    currentScreenShareQuality, screenShareQualityBusy: ref(false), screenShareSourceBusy: ref(false),
    currentScreenShareAudioMode: ref('unavailable'),
    async join(_groupId, onConnected) { room.value = makeRoom();
      listening.value = true; microphoneIntent.value = true; microphoneEnabled.value = true;
      local.isMicrophoneEnabled = true;
      participants.value = [local, ...friends]; status.value = 'connected'; revision.value++;
      onConnected?.(); return true; },
    async leave() { [local, ...friends].forEach((member) => member.isScreenShareEnabled = false);
      microphoneIntent.value = false; microphoneEnabled.value = false; local.isMicrophoneEnabled = false;
      room.value = null; participants.value = []; status.value = 'idle'; revision.value++; },
    async updateListeningState(enabled) {
      listening.value = enabled; microphoneEnabled.value = enabled && microphoneIntent.value;
      local.isMicrophoneEnabled = microphoneEnabled.value; revision.value++;
    },
    async enableAudioPlayback() {},
    setMicrophoneVoiceMode() {}, setPushToTalkHeld() {},
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
    async requestRemoteControl(identity) { remoteControlPending.value = { identity, requestId: identity + '-request', phase: 'waiting' }; },
    sendRemoteControlInput(input) { inputs.push(input); },
    async exitRemoteControl() { remoteControlActive.value = null; },
    async revokeRemoteControl() {}, async retryRemoteControlCleanup() {}, async allowRemoteControl() {},
    async rejectRemoteControl() { remoteControlRequest.value = null; }, async cancelPendingRemoteControl() { remoteControlPending.value = null; }, cancelPendingScreenShareSelection() {}
  };
}` });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^观看测试，/ }).dblclick();
  await expect(page.getByTestId('participant-card')).toHaveCount(9);
  await expect(page.locator('.callbar-enter-active')).toHaveCount(0);
});

async function sharing(page: Page, ids: string[]) {
  await page.evaluate((identities) => (window as unknown as { __viewingTest: { sharing(ids: string[]): void } }).__viewingTest.sharing(identities), ids);
}

test('离房和切回群组先显示已知的语音成员，慢摘要在原处更新', async ({ page }) => {
  const preview = page.getByRole('region', { name: '当前语音成员预览' });
  const count = page.getByTestId('room-summary-count');
  const first = page.getByRole('button', { name: /^观看测试，/ });
  const second = page.getByRole('button', { name: /^另一群组，/ });
  await page.route('**/api/rtc/room-occupancies', route => route.fulfill({
    json: [{ groupId: groups[1].id, participantCount: 1 }],
  }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/rtc/room-summary*', async route => {
    const id = new URL(route.request().url()).searchParams.get('groupId');
    await held;
    const participants = id === groups[0].id
      ? [{ participantIdentity: 'user-viewing-user', displayName: '自己' }, { participantIdentity: 'A', displayName: '成员A' }]
      : [{ participantIdentity: 'other', displayName: '另一群的成员' }];
    await route.fulfill({ json: { participantCount: participants.length, participants } });
  });
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      const strip = document.querySelector('.voice-preview')!.closest('.layout-reveal')!;
      strip.addEventListener('transitionrun', event => {
        if (event.target === strip && (event as TransitionEvent).propertyName === 'grid-template-rows') {
          strip.setAttribute('data-preview-animated', '');
        }
      });
    });
    await page.getByRole('button', { name: '离开当前群组语音' }).click();
    await expect(count).toHaveText('8 人');
    await expect(preview).toContainText('成员H');
    await expect(preview).not.toContainText('自己');
    await expect(page.locator('.layout-reveal[data-preview-animated]')).toHaveCount(1);
    await second.click();
    await expect(count).toHaveText('1 人');
    await expect(preview.locator('.voice-preview-member')).toHaveCount(0);
    await first.click();
    await expect(count).toHaveText('8 人');
    await expect(preview).toContainText('成员H');
    await preview.evaluate(el => el.setAttribute('data-before-refresh', ''));
  } finally { release(); }
  await expect(count).toHaveText('1 人');
  await expect(preview).toHaveAttribute('data-before-refresh', '');
  await expect(preview.locator('.voice-preview-member strong')).toHaveText(['成员A']);
});

test('成员卡片保留底部麦克风，闭麦时可预调并在画面右下角显示状态', async ({ page }, testInfo) => {
  await sharing(page, ['B']);
  await page.evaluate(() => {
    const rtc = (window as unknown as { __viewingTest: {
      microphones(ids: string[]): void; setListening(id: string, enabled: boolean): void; addShareAudio(ids: string[]): void;
      paint(width: number, height: number, color: string): void;
    } }).__viewingTest;
    rtc.microphones(['A', 'D']);
    rtc.setListening('C', false);
    rtc.addShareAudio(['B']);
    rtc.paint(320, 180, '#8c9ea8');
  });
  const cards = page.getByTestId('participant-card');
  const card = (id: string) => cards.filter({ hasText: '成员' + id });
  await expect(card('A').locator('.member-audio-status')).toHaveCount(0);
  const status = card('B').locator('.participant-media').getByRole('img', { name: '麦克风已关闭' });
  await expect(status).toBeVisible();
  await expect(status).toHaveCSS('pointer-events', 'none');
  await expect(card('B').getByRole('button', { name: '静音这路共享声音' })).toBeEnabled();
  const centers = await card('B').evaluate(element => {
    const centerX = (selector: string) => {
      const { x, width } = element.querySelector(selector)!.getBoundingClientRect();
      return x + width / 2;
    };
    return [centerX('.member-audio-status'), centerX('.member-audio-status svg'), centerX('.participant-meta .volume-button:last-child > svg:first-child')];
  });
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(0.5);
  await expect(card('C').locator('.participant-media').getByRole('img', { name: '已停止接收声音' })).toBeVisible();
  const mic = card('B').getByRole('button', { name: '成员B已闭麦，点击取消收听' });
  await expect(mic).toBeEnabled();
  await mic.press('ArrowUp');
  await expect(mic).toHaveAttribute('aria-description', /105%/);
  await expect(mic.locator('.volume-ring')).toHaveCount(1);
  await expect(mic).toHaveCSS('color', await card('B').locator('.member-signal').evaluate(el => getComputedStyle(el).color));
  await expect(card('C').getByRole('button', { name: '成员C已闭麦，点击取消收听' })).toBeEnabled();
  await card('D').getByRole('button', { name: /点击取消收听/ }).click();
  await expect(card('D').getByRole('button', { name: /点击恢复收听/ })).toBeEnabled();
  await expect(card('D').locator('.member-audio-status')).toHaveCount(0);
  await expect(cards.first().getByRole('button', { name: '停止接收所有成员声音' })).toBeEnabled();
  await page.mouse.move(0, 0);
  await card('B').screenshot({ path: testInfo.outputPath('aligned-card.png') });
  const first = (await cards.first().boundingBox())!, last = (await card('D').boundingBox())!;
  await page.screenshot({ path: testInfo.outputPath('member-card-states.png'),
    clip: { x: first.x, y: first.y, width: last.x + last.width - first.x, height: first.height } });
  const position = await mic.boundingBox();
  await page.evaluate(() => (window as unknown as { __viewingTest: { microphones(ids: string[]): void } }).__viewingTest.microphones(['A', 'B', 'D']));
  const reopened = card('B').getByRole('button', { name: /点击取消收听/ });
  await expect(reopened).toBeEnabled();
  await expect(card('B').locator('.member-audio-status')).toHaveCount(0);
  expect(await reopened.boundingBox()).toEqual(position);
  await expect(reopened).toHaveAttribute('aria-description', /105%/);
});

test('聊天和网格使用背景音量，聚焦和独立窗口只播放所选画面的正常音量', async ({ page }) => {
  await sharing(page, ['A', 'B', 'C']);
  await page.evaluate(() => (window as unknown as { __viewingTest: { addShareAudio(ids: string[]): void } }).__viewingTest.addShareAudio(['A', 'B', 'C']));
  const volumes = () => page.evaluate(() =>
    (window as unknown as { __viewingTest: { shareVolumes(): Record<string, number> } }).__viewingTest.shareVolumes());
  const sound = (name: string) => page.getByTestId('participant-card').filter({ hasText: name }).getByRole('button', { name: '静音这路共享声音' });
  await expect.poll(volumes).toEqual({ A: 0.1, B: 0.1, C: 0.1 });
  await sound('成员B').press('ArrowUp');
  await expect.poll(volumes).toMatchObject({ B: 0.1 });
  await sound('成员B').press('ArrowDown');
  await sound('成员C').click();
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await expect.poll(volumes).toEqual({ A: 0.35, B: 0, C: 0 });
  await page.locator('.viewing-surface').first().hover();
  await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  await expect.poll(volumes).toEqual({ A: 0.1, B: expect.closeTo(0.095, 6), C: 0 });
  await page.getByRole('button', { name: '聚焦成员B', exact: true }).click();
  await expect.poll(volumes).toEqual({ A: 0, B: expect.closeTo(0.3325, 6), C: 0 });
  const popup = page.waitForEvent('popup');
  await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
  await page.getByRole('button', { name: '弹出观看区', exact: true }).click();
  const viewer = await popup;
  await viewer.locator('.viewing-surface').hover();
  await expect.poll(volumes).toEqual({ A: 0, B: expect.closeTo(0.3325, 6), C: 0 });
  await viewer.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  await expect.poll(volumes).toEqual({ A: 0.1, B: expect.closeTo(0.095, 6), C: 0 });
  await viewer.close();
  await expect.poll(volumes).toEqual({ A: 0, B: expect.closeTo(0.3325, 6), C: 0 });
  await page.getByRole('button', { name: '收起共享画面', exact: true }).click();
  await expect.poll(volumes).toEqual({ A: 0.1, B: expect.closeTo(0.095, 6), C: 0 });
});

test('从缩略图进入聚焦只提升选中的实际订阅，退出后恢复低层', async ({ page }) => {
  await sharing(page, ['A', 'B']);
  const quality = () => page.evaluate(() =>
    (window as unknown as { __viewingTest: { quality(): Record<string, number> } }).__viewingTest.quality());
  // 数值来自固定 SDK 的 UpdateSettings 信令，LOW = 0，HIGH = 2。
  await expect.poll(quality).toMatchObject({ A: 0, B: 0 });
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await expect.poll(quality).toMatchObject({ A: 2, B: 0 });
  const surface = page.locator('.viewing-grid.is-focus .viewing-surface');
  await expect(surface).toHaveCSS('animation-name', 'viewing-picture-in');
  await surface.hover();
  await page.getByRole('button', { name: '退出观看', exact: true }).click();
  await expect.poll(quality).toMatchObject({ A: 0, B: 0 });
  const preview = page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).locator('video.is-video-ready');
  await expect(preview).toHaveCSS('animation-name', 'viewing-picture-in');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(preview).toHaveCSS('animation-name', 'none');
});

test('观看状态使用实际往返延迟，滚轮进网格且网格选中一路后放大', async ({ page }) => {
  await sharing(page, ['A', 'B']);
  await page.getByRole('button', { name: '观看成员A的共享画面' }).click();
  const connection = page.locator('.viewing-tile .viewing-connection');
  await expect(connection).not.toHaveAttribute('title');
  const latency = page.locator('.callbar .latency');
  await expect(latency).toHaveText('—');
  await expect(connection.locator('.latency')).toHaveCount(0);
  const cardSignal = page.locator('.participant-card.is-card .participant-name .member-signal').first();
  const bounds = await cardSignal.boundingBox();
  expect(bounds!.width).toBe(bounds!.height);
  const initialWidth = (await connection.boundingBox())!.width;
  for (const ms of [9, 100]) {
    await page.evaluate(value => (window as unknown as { __viewingTest: { transport(id: string, ms: number): void } }).__viewingTest.transport('A', value), ms);
    await expect(latency).toHaveText(ms + ' ms');
    expect((await connection.boundingBox())!.width).toBe(initialWidth);
    await expect(cardSignal.locator('i')).toHaveCount(3);
    await expect(cardSignal.locator('.lit')).toHaveCount(2);
    await expect(page.locator('.viewing-tile .signal-bars .lit')).toHaveCount(2);
  }
  await page.locator('.viewing-surface').hover();
  await page.mouse.wheel(0, 120);
  await expect(page.locator('.viewing-tile')).toHaveCount(2);
  await page.getByRole('button', { name: '聚焦成员B' }).click();
  await expect(page.locator('.viewing-tile')).toHaveCount(1);
  await expect(page.getByRole('region', { name: '语音成员', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '占满窗口' }).click();
  await expect(page.getByRole('button', { name: '展开成员' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '展开成员' })).toBeVisible();
});

test('整体收起和展开保留成员、聚焦或网格布局以及聊天草稿', async ({ page }, testInfo) => {
  await sharing(page, ['A', 'B']);
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('继续聊天');
  const members = page.getByRole('region', { name: '语音成员', exact: true });
  const handle = page.locator('.viewing-fold');
  for (const mode of ['成员', '聚焦', '网格']) {
    if (mode === '聚焦') {
      await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
    }
    if (mode === '网格') await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
    if (mode !== '成员') {
      await handle.click();
      await expect(members).toBeVisible();
      await expect(page.locator('.viewing-stage')).toHaveCSS('height', '0px');
    }
    await handle.press('ArrowUp');
    await expect(members).toHaveCount(0);
    await expect(page.locator('.viewing-stage')).toHaveCSS('height', '0px');
    await expect(page.getByTestId('callbar')).toBeVisible();
    await expect(input).toHaveValue('继续聊天');
    if (mode === '聚焦') await page.screenshot({ path: testInfo.outputPath('view-folded.png') });
    await handle.click();
    await expect(members).toBeVisible();
    await expect(page.locator('.viewing-stage')).toHaveCSS('height', '0px');
    if (mode !== '成员') await handle.click();
    if (mode === '网格') await expect(page.getByRole('button', { name: '聚焦成员B', exact: true })).toBeVisible();
    else await expect(members).toBeVisible();
    if (mode === '聚焦') {
      await expect(page.getByRole('button', { name: '查看全部共享画面', exact: true })).toBeVisible();
      await expect.poll(() => page.locator('.voice-panel').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath('view-expanded.png') });
    }
  }
});

test('群头像短暂停留不弹标签，停满 300 毫秒才显示', async ({ page }) => {
  const avatar = page.getByRole('button', { name: /^观看测试，/ });
  const hint = page.getByRole('tooltip');
  await page.clock.install({ time: new Date('2026-11-20T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-20T12:00:01Z'));
  const anchor = avatar.locator('..');
  await anchor.dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await page.clock.runFor(250);
  expect(await hint.count()).toBe(0);
  await anchor.dispatchEvent('pointerleave');
  await page.clock.runFor(100);
  expect(await hint.count()).toBe(0);
  await anchor.dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await page.clock.runFor(300);
  await expect(hint).toHaveCount(1);
});

test('群头像提示在右侧进退，显示通话状态且不重复系统提示', async ({ page }) => {
  const joined = page.getByRole('button', { name: /^观看测试，/ });
  const other = page.getByRole('button', { name: /^另一群组，/ });
  await expect(joined).not.toHaveAttribute('title');
  await page.mouse.move(500, 400);
  await joined.hover();
  const hint = page.getByRole('tooltip');
  await expect(hint).toHaveText('观看测试 · 语音中');
  await expect.poll(() => hint.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  const anchor = (await joined.boundingBox())!, bounds = (await hint.boundingBox())!;
  const rail = (await page.locator('.group-rail').boundingBox())!;
  expect(bounds.x - rail.x - rail.width).toBeCloseTo(10, 0);
  expect(Math.abs(bounds.y + bounds.height / 2 - anchor.y - anchor.height / 2)).toBeLessThan(1);
  expect(await joined.getAttribute('aria-describedby')).toBe(await hint.getAttribute('id'));
  await page.screenshot({ path: test.info().outputPath('group-hover-hint.png') });
  const leaveFrames = await joined.evaluate(async element => {
    element.parentElement!.dispatchEvent(new PointerEvent('pointerleave'));
    const samples: { opacity: number; x: number }[] = [];
    for (let i = 0; i < 15; i++) {
      await new Promise(requestAnimationFrame);
      const hint = document.querySelector('[role="tooltip"]');
      if (!hint) break;
      const style = getComputedStyle(hint);
      samples.push({ opacity: Number(style.opacity), x: style.transform === 'none' ? 0 : new DOMMatrix(style.transform).m41 });
    }
    return samples;
  });
  expect(leaveFrames.some(frame => frame.opacity > 0 && frame.opacity < 1 && frame.x < 0)).toBe(true);
  await other.hover();
  await expect(hint).toHaveText('另一群组');
  await other.click();
  await expect(hint).toHaveCount(0);
  await expect(page.locator('.group-header')).toContainText('另一群组');
  await page.mouse.move(500, 400);
  await page.keyboard.press('Tab');
  await joined.focus();
  await expect(hint).toHaveText('观看测试 · 语音中');
  await page.keyboard.press('Escape');
  await expect(hint).toHaveCount(0);
  await joined.hover();
  await expect(hint).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(hint).toHaveCount(0);
});

test('成员卡片短按静音、圆环拖动后与底部收听面板同步', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => (window as unknown as { __viewingTest: { microphones(ids: string[]): void } }).__viewingTest.microphones(['A']));
  const local = page.getByTestId('participant-card').first();
  const microphone = local.getByRole('button', { name: '关闭自己的麦克风', exact: true });
  const previous = await page.evaluate(() => JSON.stringify(localStorage));
  await microphone.hover();
  await microphone.dispatchEvent('wheel', { deltaY: -100 });
  await microphone.dispatchEvent('pointerdown', { button: 0, pointerId: 1, clientY: 200 });
  await microphone.dispatchEvent('pointermove', { pointerId: 1, clientY: 100 });
  await microphone.dispatchEvent('pointerup', { pointerId: 1, clientY: 100 });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(previous);
  await expect(page.locator('.participant-volume-popover, .participant-volume-dragger')).toHaveCount(0);
  await microphone.click();
  await expect(local.getByRole('button', { name: '开启自己的麦克风', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收听选项', exact: true }).click();
  await page.getByRole('button', { name: '调整成员音量', exact: true }).click();
  const volume = page.getByRole('slider', { name: '成员A接收音量', exact: true });
  await volume.fill('2');
  await expect(volume).toHaveValue('2');
  await page.keyboard.press('Escape');
  await expect(volume).toBeHidden();
  await expect(page.getByRole('button', { name: '调整成员音量', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '收听选项', exact: true }).click();
  const remote = page.getByTestId('participant-card').filter({ hasText: '成员A' });
  await remote.getByRole('button', { name: /点击取消收听/ }).click();
  await remote.getByRole('button', { name: /点击恢复收听/ }).click();
  const voice = remote.getByRole('button', { name: /点击取消收听/ });
  await voice.hover();
  const box = (await voice.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const ring = voice.locator('.volume-ring');
  await expect(ring).toHaveCSS('opacity', '1');
  await expect(voice).toHaveAttribute('aria-description', /200%/);
  await page.mouse.move(x, y + 42);
  await expect(voice).toHaveAttribute('aria-description', /100%/);
  await page.mouse.up();
  await expect(ring).toHaveCSS('opacity', '0');
  await expect(voice).toHaveAttribute('aria-pressed', 'false');
  await voice.hover();
  const strip = remote.locator('xpath=ancestor::*[contains(@class,"horizontal-viewport")][1]');
  const beforeWheel = await strip.evaluate(element => element.scrollLeft);
  await page.mouse.wheel(0, -100);
  await expect(voice).toHaveAttribute('aria-description', /105%/);
  await page.mouse.wheel(0, 100);
  await expect(voice).toHaveAttribute('aria-description', /100%/);
  await page.mouse.move(0, 0);
  await expect(ring).toHaveCSS('opacity', '0');
  expect(await strip.evaluate(element => element.scrollLeft)).toBe(beforeWheel);
  await page.getByRole('button', { name: '收听选项', exact: true }).click();
  await page.getByRole('button', { name: '调整成员音量', exact: true }).click();
  await expect(volume).toHaveValue('1');
  const submenu = page.getByRole('region', { name: '成员音量', exact: true });
  const parent = page.getByRole('region', { name: '收听选项', exact: true });
  await expect(volume).toBeFocused();
  await expect(submenu).toHaveCSS('opacity', '1');
  const parentBounds = (await parent.boundingBox())!;
  expect((await submenu.boundingBox())!.x).toBeGreaterThan(parentBounds.x + parentBounds.width);
  await page.screenshot({ path: test.info().outputPath('member-volume-panel.png') });
  await page.setViewportSize({ width: 480, height: 600 });
  await expect(parent).toBeHidden();
  const back = submenu.getByRole('button', { name: '返回收听选项' });
  await expect(back).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('member-volume-compact.png') });
  await submenu.getByRole('slider').last().scrollIntoViewIfNeeded();
  await expect(submenu.getByRole('slider').last()).toBeInViewport();
  await back.click();
  await expect(parent.getByRole('button', { name: '调整成员音量' })).toBeFocused();
});

test('后台暂时不可测量时保留观看尺寸，切回后原位显示且不重建视频', async ({ page }) => {
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  const panel = page.locator('.call-viewing-panel');
  const tile = page.locator('.viewing-tile');
  const video = await tile.locator('video').elementHandle();
  await expect.poll(() => panel.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  const samples = await panel.evaluate(async element => {
    const panel = element as HTMLElement;
    const tile = panel.querySelector<HTMLElement>('.viewing-tile')!;
    const before = { width: tile.style.width, height: tile.style.height };
    const frame = () => new Promise(requestAnimationFrame);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    panel.style.display = 'none';
    for (let i = 0; i < 5; i++) await frame();
    const hidden = { width: tile.style.width, height: tile.style.height };
    panel.style.removeProperty('display');
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    const restored = [];
    for (let i = 0; i < 18; i++) {
      await frame();
      restored.push({ width: tile.getBoundingClientRect().width, height: tile.getBoundingClientRect().height });
    }
    return { before, hidden, restored };
  });
  expect(samples.hidden).toEqual(samples.before);
  for (const bounds of samples.restored) {
    expect(bounds.width).toBeCloseTo(Number.parseFloat(samples.before.width), 0);
    expect(bounds.height).toBeCloseTo(Number.parseFloat(samples.before.height), 0);
  }
  expect(await video!.evaluate(element => element === document.querySelector('.viewing-tile video'))).toBe(true);
  await expect(tile).toHaveCSS('transition-property', 'width, height');
  const resized = await panel.evaluate(async element => {
    const panel = element as HTMLElement;
    const tile = panel.querySelector<HTMLElement>('.viewing-tile')!;
    const frame = () => new Promise(requestAnimationFrame);
    window.dispatchEvent(new Event('blur'));
    panel.style.display = 'none';
    panel.style.width = `${panel.parentElement!.clientWidth - 120}px`;
    await frame();
    panel.style.removeProperty('display');
    window.dispatchEvent(new Event('focus'));
    const frames = [];
    for (let i = 0; i < 18; i++) {
      await frame();
      frames.push({ width: tile.getBoundingClientRect().width,
        moving: tile.getAnimations().some(animation => animation.playState === 'running') });
    }
    return { frames, target: Number.parseFloat(tile.style.width) };
  });
  expect(resized.target).toBeLessThan(Number.parseFloat(samples.before.width));
  expect(resized.frames.every(frame => !frame.moving)).toBe(true);
  for (const frame of resized.frames.slice(2)) expect(frame.width).toBeCloseTo(resized.target, 0);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 960, height: 760 }]) {
  test(`单画面聚焦与网格垂直居中连续伸缩，快速反向不补动：${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await sharing(page, ['A']);
    await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
    const tile = page.locator('.viewing-tile');
    const video = await tile.locator('video').elementHandle();
    await expect.poll(() => page.locator('.voice-panel').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    for (const reverse of [false, false, true]) {
      const samples = await tile.evaluate(async (element, reverse) => {
        const surface = element.querySelector<HTMLElement>('.viewing-action-buttons button')!;
        const frame = () => new Promise(requestAnimationFrame);
        const read = () => {
          const rect = element.getBoundingClientRect();
          const stage = element.closest('.viewing-stage')!.getBoundingClientRect();
          return { width: rect.width, height: rect.height, top: rect.top + rect.height / 2 - stage.top - stage.height / 2,
            center: rect.left + rect.width / 2 - stage.left - stage.width / 2 };
        };
        const samples = [read()];
        surface.click();
        for (let i = 0; i < 30; i++) {
          await frame();
          samples.push(read());
          if (reverse && i === 4) surface.click();
        }
        return samples;
      }, reverse);
      for (const sample of samples) {
        expect(Math.abs(sample.center)).toBeLessThanOrEqual(1);
        expect(Math.abs(sample.top)).toBeLessThanOrEqual(1);
      }
      if (reverse) {
        expect(samples.at(-1)!.width).toBeCloseTo(samples[0]!.width, 0);
        expect(samples.at(-1)!.height).toBeCloseTo(samples[0]!.height, 0);
      } else {
        for (const dimension of ['width', 'height'] as const) {
          const direction = Math.sign(samples.at(-1)![dimension] - samples[0]![dimension]);
          for (let i = 1; i < samples.length; i++) {
            expect((samples[i]![dimension] - samples[i - 1]![dimension]) * direction).toBeGreaterThanOrEqual(-1);
          }
        }
      }
    }
    expect(await video!.evaluate(element => element === document.querySelector('.viewing-tile video'))).toBe(true);
  });
}

test('横向浏览渐变跟随滚动位置，键盘滚动遵循减少动态效果设置', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 900 });
  const strip = page.getByRole('region', { name: '语音成员', exact: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(strip).toHaveClass(/can-scroll-right/);
  await expect(page.locator('.scroll-arrow')).toHaveCount(0);
  await strip.focus();
  const immediate = await strip.evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return Math.abs(element.scrollLeft - element.clientWidth * 0.75);
  });
  expect(immediate).toBeLessThanOrEqual(1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(strip).toHaveClass(/can-scroll-left/);
  const motion = await strip.evaluate(async element => {
    const before = element.scrollLeft;
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const immediate = element.scrollLeft;
    await new Promise(resolve => setTimeout(resolve, 50));
    return { before, immediate, during: element.scrollLeft };
  });
  expect(motion.immediate).toBe(motion.before);
  expect(motion.during).toBeGreaterThan(0);
  expect(motion.during).toBeLessThan(motion.before);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await strip.press('ArrowLeft');
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(0);
  await strip.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect(strip).toHaveClass(/can-scroll-left/);
  await expect(strip).not.toHaveClass(/can-scroll-right/);
  await expect(strip).toHaveCSS('mask-image', /linear-gradient/);
  await expect(page.locator('.message-list')).toHaveCSS('mask-image', 'none');
});

test('聚焦卡片只隐藏重复预览，按可用空间居中且不干扰后续手动滚动', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 900 });
  await sharing(page, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const strip = page.getByRole('region', { name: '语音成员', exact: true });
  const card = page.locator('[data-scroll-key="D"]');
  await card.getByRole('button', { name: '观看成员D的共享画面', exact: true }).click();
  await page.mouse.move(950, 850);
  await expect(card.locator('video')).toHaveCount(0);
  await expect(card.getByRole('status')).toHaveText('已聚焦');
  await expect(card.locator('.participant-media')).toHaveAttribute('data-select-hint', '已聚焦');
  await expect(page.locator('.viewing-tile video')).toHaveCount(1);
  const mainVideo = await page.locator('.viewing-tile video').elementHandle();
  await expect.poll(() => strip.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const card = element.querySelector('[data-scroll-key="D"]')!.getBoundingClientRect();
    return Math.abs(card.left + card.width / 2 - bounds.left - element.clientWidth / 2);
  })).toBeLessThan(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __viewingTest: { visibility(): Record<string, boolean> }
  }).__viewingTest.visibility().D)).toBe(true);
  await strip.evaluate(element => { element.scrollLeft = 0; });
  await sharing(page, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  expect(await strip.evaluate(element => element.scrollLeft)).toBe(0);
  expect(await mainVideo!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole('button', { name: '观看成员H的共享画面', exact: true }).click();
  await expect.poll(() => strip.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThan(2);
  await page.getByRole('button', { name: '观看成员H的共享画面', exact: true }).click();
  await expect(page.locator('.viewing-tile')).toHaveCount(1);
  await page.locator('.viewing-tile').hover();
  await page.getByRole('button', { name: '退出观看', exact: true }).click();
  await expect(page.locator('.viewing-tile')).toHaveCount(0);
  await expect(page.locator('[data-scroll-key="H"] video')).toHaveCount(1);
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(0);
  await expect(page.getByRole('button', { name: '查看全部共享画面', exact: true })).toHaveAttribute('title', '点击查看全部共享画面');
  await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  await expect(page.locator('.viewing-tile')).toHaveCount(8);
});

test('滚轮连续输入平滑累积，反向滚动和无溢出成员栏不产生额外位移', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 900 });
  const strip = page.getByRole('region', { name: '语音成员', exact: true });
  const samples = await strip.evaluate(async element => {
    for (let i = 0; i < 3; i++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    const immediate = element.scrollLeft;
    await new Promise(resolve => setTimeout(resolve, 50));
    return { immediate, during: element.scrollLeft };
  });
  expect(samples.immediate).toBe(0);
  expect(samples.during).toBeGreaterThan(0);
  expect(samples.during).toBeLessThan(300);
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(300);
  await strip.evaluate(element => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(250);
  await page.setViewportSize({ width: 3000, height: 1000 });
  await expect.poll(() => strip.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBe(0);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`连贯布局保留同一视频，快速切换和减少动态效果不延迟退出：${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    const memberStrip = await page.locator('.viewing-member-strip').elementHandle();
    await sharing(page, ['A', 'B']);
    await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
    await expect(page.locator('.viewing-tile')).toHaveCount(1);
    const video = await page.locator('.viewing-tile video').elementHandle();
    for (let step = 0; step < 2; step++) {
      await expect(page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').first()).toBeEnabled();
      const excess = await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').first().evaluate(async (element) => {
        element.closest('.viewing-tile')!.querySelector<HTMLButtonElement>('.viewing-action-buttons button')!.click();
        await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        const started = performance.now();
        let maximum = 0;
        await new Promise<void>((resolve) => {
          function measure() {
            for (const tile of document.querySelectorAll('.viewing-tile:not(.view-tile-leave-active)')) {
              const bounds = tile.getBoundingClientRect();
              const media = tile.querySelector('.participant-media')!.getBoundingClientRect();
              maximum = Math.max(maximum, media.height - bounds.height, media.width - bounds.width);
            }
            if (performance.now() - started < 250) requestAnimationFrame(measure);
            else resolve();
          }
          measure();
        });
        return maximum;
      });
      expect(excess).toBeLessThanOrEqual(1);
    }
    expect(await video!.evaluate(element => element.isConnected && element === document.querySelector('.viewing-tile video'))).toBe(true);
    await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
    await page.getByRole('button', { name: '收起成员', exact: true }).click();
    expect(await page.locator('.layout-reveal-leave-active').evaluateAll(elements =>
      elements.every(element => (element as HTMLElement).inert))).toBe(true);
    await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
    await page.getByRole('button', { name: '展开成员', exact: true }).click();
    await expect(page.getByRole('region', { name: '语音成员', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '语音成员', exact: true })).toHaveCount(1);
    if (reducedMotion === 'reduce') {
      await expect(page.locator('.viewing-stage')).toHaveCSS('transition-duration', '0s');
      await expect(page.locator('.group-header-region')).toHaveCSS('visibility', 'hidden');
    }
    await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
    await page.getByRole('button', { name: '退出观看', exact: true }).click();
    // 空间可以继续收起，已退出的主视频不能为退场动画继续持有。
    await expect(page.locator('.viewing-tile')).toHaveCount(0);
    expect(await video!.evaluate(element => element.isConnected)).toBe(false);
    await expect(page.locator('.group-header')).toBeVisible();
    expect(await memberStrip!.evaluate(element => element.isConnected
      && element === document.querySelector('.viewing-member-strip'))).toBe(true);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('main', { name: '设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    await expect(page.getByTestId('callbar')).toBeVisible();
  });
}

test('主动诊断记录返回应用后继续，离房结束并导出匿名报告', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await sharing(page, ['A', 'B']);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '客户端', exact: true }).click();
  const report = page.locator('.diagnostic-report-settings');
  await report.getByRole('button', { name: '更多诊断选项', exact: true }).click();
  await report.getByRole('textbox', { name: /问题说明/ }).fill('合成界面回归');
  await report.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect(report.getByRole('status')).toContainText('记录中');
  await expect(report.getByRole('status')).not.toContainText('0 份统计');
  await report.getByRole('combobox', { name: '问题类型' }).selectOption('video-stutter');
  await report.getByRole('button', { name: '标记刚才的问题' }).click();
  await expect(report).toContainText('最近标记：');
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: '离开语音', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '客户端', exact: true }).click();
  await report.getByRole('button', { name: '更多诊断选项', exact: true }).click();
  await expect(report.getByRole('status')).toContainText('记录已结束');
  await expect(report.getByRole('textbox', { name: /问题说明/ })).toHaveValue('合成界面回归');
  await expect(report.getByRole('group', { name: '日志保存位置' })).toHaveCount(0);
  const downloading = page.waitForEvent('download');
  await report.getByRole('button', { name: '导出全部报告', exact: true }).click();
  const download = await downloading;
  const path = await download.path();
  if (!path) throw new Error('未取得测试报告下载');
  const text = await readFile(path, 'utf8');
  const result = JSON.parse(text);
  expect(result.kind).toBe('lycansync-diagnostics');
  expect(result.stopReason).toBe('roomChanged');
  expect(result.samples.length).toBeGreaterThan(1);
  expect(result.notes).toBe('合成界面回归');
  expect(result.schemaVersion).toBe(14);
  expect(result.samples.some((sample: { streams: { viewing: { inactiveViews: number } | null }[] }) =>
    sample.streams.some(stream => stream.viewing && stream.viewing.inactiveViews > 0))).toBe(true);
  expect(result.problemMarkers).toEqual([{ time: expect.any(String), category: 'video-stutter', recording: true }]);
  expect(text).not.toContain('user-viewing-user');
  expect(text).not.toContain('成员A');
  await page.route('**/api/diagnostics/reports', route => route.fulfill({ status: 204 }));
  const localCopy = page.waitForEvent('download');
  const uploaded = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/diagnostics/reports'));
  await report.getByRole('button', { name: '上传日志', exact: true }).click();
  const copyPath = await (await localCopy).path();
  const compressed = (await uploaded).postDataBuffer();
  if (!copyPath || !compressed) throw new Error('缺少本地副本或上传内容');
  expect(gunzipSync(compressed).toString('utf8')).toBe(await readFile(copyPath, 'utf8'));
  await expect(report).toContainText('日志已上传给服主');
  expect(pageErrors).toEqual([]);
});



async function openWatching(page: Page) {
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  const popup = page.waitForEvent('popup');
  await page.locator('.viewing-tile').first().hover();
  await page.getByRole('button', { name: '弹出观看区', exact: true }).first().click();
  const viewer = await popup;
  await expect(viewer.getByRole('region', { name: '多人观看窗口' })).toBeVisible();
  return viewer;
}

test('网格与弹出卸载重复视频，顶部收回保留卡片实例和语音连接', async ({ page }) => {
  await sharing(page, ['A', 'B']);
  const card = await page.locator('[data-scroll-key="A"]').elementHandle();
  const restoreTimes: number[] = [];
  for (let round = 0; round < 3; round++) {
    const viewer = await openWatching(page);
    await expect(page.locator('.voice-panel video')).toHaveCount(0);
    await expect(page.locator('.viewing-members-panel')).toBeHidden();
    await expect.poll(() => page.locator('.voice-panel').evaluate(element => element.getBoundingClientRect().height)).toBe(0);
    await expect(viewer.locator('video')).toHaveCount(2);
    const elapsed = await page.getByRole('button', { name: '收回画面', exact: true }).evaluate(async element => {
      const start = performance.now();
      (element as HTMLButtonElement).click();
      while (performance.now() - start < 2000) {
        await new Promise(requestAnimationFrame);
        const videos = [...document.querySelectorAll<HTMLVideoElement>('.viewing-tile video')];
        if (videos.length === 2 && videos.every(video => video.readyState >= 2 && !video.paused)) return performance.now() - start;
      }
      throw new Error('恢复观看未及时出现可播放画面');
    });
    restoreTimes.push(elapsed);
    await expect.poll(() => viewer.isClosed()).toBe(true);
    await expect(page.locator('.viewing-tile video')).toHaveCount(2);
    await expect(page.locator('.viewing-member-strip video')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '离开语音', exact: true })).toBeVisible();
    await page.locator('.viewing-tile').first().hover();
    await page.getByRole('button', { name: '退出观看', exact: true }).first().click();
    await expect(page.locator('.viewing-member-strip video')).toHaveCount(2);
    expect(await card!.evaluate(element => element.isConnected)).toBe(true);
  }
  console.log('合成双画面连续收回首帧耗时(ms):', restoreTimes.map(value => Math.round(value)));
});

test('占满窗口与恢复均有纵向画面过渡，不替换视频元素', async ({ page }) => {
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  const video = await page.locator('.viewing-tile video').elementHandle();
  await expect.poll(() => page.locator('.voice-panel').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  for (const label of ['占满窗口', '恢复观看布局']) {
    const samples = await page.locator('.call-viewing-panel').evaluate(async (panel, label) => {
      const stage = panel.querySelector('.viewing-stage')!;
      const read = () => stage.getBoundingClientRect().height;
      const heights = [read()];
      (panel.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click();
      for (let i = 0; i < 24; i++) { await new Promise(requestAnimationFrame); heights.push(read()); }
      return heights;
    }, label);
    const first = samples[0]!, last = samples.at(-1)!;
    expect(Math.abs(last - first)).toBeGreaterThan(40);
    expect(samples.some(height => height > Math.min(first, last) + 5 && height < Math.max(first, last) - 5)).toBe(true);
    const direction = Math.sign(last - first);
    for (let i = 1; i < samples.length; i++) expect((samples[i]! - samples[i - 1]!) * direction).toBeGreaterThanOrEqual(-2);
    expect(await video!.evaluate(element => element.isConnected)).toBe(true);
  }
});

test('矮窗横竖混排时，竖屏卡片按钮留在本卡且能实际点击', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 960, height: 600 });
  await sharing(page, ['A', 'B', 'C']);
  await page.getByRole('button', { name: '观看成员A的共享画面' }).click();
  await page.getByRole('button', { name: '查看全部共享画面' }).click();
  const tile = page.locator('.viewing-tile').filter({ has: page.getByRole('button', { name: '聚焦成员B' }) });
  await tile.locator('video').evaluate(video => {
    Object.defineProperties(video, { videoWidth: { value: 360 }, videoHeight: { value: 640 } });
    video.dispatchEvent(new Event('resize'));
  });
  const handle = page.getByRole('button', { name: '收起共享画面' });
  for (const targetHeight of [132, 64]) {
    const stage = page.locator('.viewing-stage');
    for (let i = 0; i < 30 && await stage.evaluate(el => el.clientHeight) > targetHeight; i++) await handle.press('ArrowUp');
    expect(await stage.evaluate(el => el.clientHeight)).toBeLessThanOrEqual(targetHeight);
    await tile.hover();
    const bounds = await tile.evaluate(el => {
      const card = el.getBoundingClientRect();
      const viewport = el.closest('.horizontal-viewport')!.getBoundingClientRect();
      const buttons = [...el.querySelectorAll('.viewing-action-buttons button')];
      return { width: card.width, buttons: buttons.map(button => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { inside: box.left >= Math.max(card.left, viewport.left) - 0.5 && box.right <= Math.min(card.right, viewport.right) + 0.5
          && box.top >= Math.max(card.top, viewport.top) - 0.5 && box.bottom <= Math.min(card.bottom, viewport.bottom) + 0.5,
          clickable: button.contains(hit) };
      }) };
    });
    expect(bounds.width).toBeLessThan(90);
    expect(bounds.buttons).toEqual(Array(4).fill({ inside: true, clickable: true }));
  }
  await tile.getByRole('button', { name: '占满窗口' }).click();
  await expect(page.locator('.call-viewing-panel')).toHaveClass(/is-expanded/);
});

test('单画面占满观看窗，宽窄画面网格不越界，本地弹出预览持续更新', async ({ page }) => {
  const paint = (width: number, height: number, color: string) => page.evaluate(({ width, height, color }) =>
    (window as unknown as { __viewingTest: { paint(width: number, height: number, color: string): void } }).__viewingTest
      .paint(width, height, color), { width, height, color });
  await sharing(page, ['A']);
  const viewer = await openWatching(page);
  for (const [width, height] of [[640, 180], [160, 240], [320, 180]]) {
    await paint(width, height, '#20d060');
    await expect.poll(() => viewer.locator('.viewing-tile video').evaluate((element: HTMLVideoElement) =>
      [element.videoWidth, element.videoHeight])).toEqual([width, height]);
    await expect.poll(() => viewer.locator('.viewing-stage').evaluate(stage => {
      const outer = stage.getBoundingClientRect(), tile = stage.querySelector('.viewing-tile')!.getBoundingClientRect();
      return Math.max(Math.abs(outer.width - tile.width), Math.abs(outer.height - tile.height),
        Math.abs(outer.top - tile.top), Math.abs(outer.left - tile.left));
    })).toBeLessThan(1);
    await sharing(page, ['A', 'B', 'C', 'D', 'E']);
    await expect(viewer.locator('.viewing-tile')).toHaveCount(5);
    await expect.poll(() => viewer.locator('.viewing-stage').evaluate(stage => {
      const outer = stage.getBoundingClientRect();
      return Math.max(...Array.from(stage.querySelectorAll('.viewing-tile'), tile => {
        const bounds = tile.getBoundingClientRect();
        return Math.max(outer.left - bounds.left, bounds.right - outer.right, outer.top - bounds.top, bounds.bottom - outer.bottom);
      }));
    })).toBeLessThan(2);
    await sharing(page, ['A']);
    await expect(viewer.locator('.viewing-tile')).toHaveCount(1);
  }
  await sharing(page, ['user-viewing-user']);
  await expect(viewer.locator('.viewing-tile')).toHaveCount(1);
  for (const [color, expected] of [['#e02040', [224, 32, 64]], ['#20d060', [32, 208, 96]]] as const) {
    await paint(320, 180, color);
    await expect.poll(() => viewer.locator('.viewing-tile video').evaluate((element: HTMLVideoElement) => {
      if (element.readyState < 2) return [];
      const canvas = element.ownerDocument.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!; context.drawImage(element, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    })).toEqual([...expected]);
  }
  await viewer.locator('.viewing-tile').hover();
  await viewer.getByRole('button', { name: '返回主界面', exact: true }).click();
  await page.locator('.viewing-tile').hover();
  await page.getByRole('button', { name: '占满窗口', exact: true }).click();
  await expect.poll(() => page.locator('.viewing-stage').evaluate(stage => {
    const outer = stage.getBoundingClientRect(), tile = stage.querySelector('.viewing-tile')!.getBoundingClientRect();
    return Math.max(Math.abs(outer.width - tile.width), Math.abs(outer.height - tile.height));
  })).toBeLessThan(1);
});

test('默认仅小预览，网格和聚焦使用原比例，整体弹出后返回保留群聊草稿', async ({ page, context }) => {
  const errors: string[] = [];
  context.on('page', child => child.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  await sharing(page, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  expect(context.pages()).toHaveLength(1);
  await expect(page.locator('.group-header')).toBeVisible();
  await expect(page.getByRole('region', { name: '共享观看区' })).toHaveCount(0);
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('稍后继续写');
  const original = await input.elementHandle();
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await expect(page.locator('.group-header')).toBeHidden();
  await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  await expect(page.locator('.viewing-tile')).toHaveCount(8);
  await page.getByRole('button', { name: '聚焦成员A', exact: true }).click();
  await page.getByRole('button', { name: '展开成员', exact: true }).click();
  await expect(page.locator('.viewing-tile')).toHaveCount(1);
  // 同一布局帧内比较，避免高度过渡期间两次独立测量跨帧。
  await expect.poll(() => page.locator('.viewing-stage').evaluate(stage => {
    const frame = stage.querySelector('.participant-media')!.getBoundingClientRect();
    const bounds = stage.getBoundingClientRect();
    return Math.max(Math.abs(frame.width - bounds.width), Math.abs(frame.height - bounds.height));
  })).toBeLessThan(1);
  await expect(page.locator('.viewing-tile video')).toHaveCSS('object-fit', 'contain');
  await input.focus();
  await input.hover();
  await expect(page.locator('.viewing-actions')).toHaveCSS('opacity', '0');
  await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
  await expect(page.locator('.viewing-actions')).toHaveCSS('opacity', '1');
  expect(await page.locator('.viewing-action-buttons button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
    .toEqual(['查看全部共享画面', '占满窗口', '弹出观看区', '退出观看']);
  const membersToggle = page.getByRole('button', { name: '收起成员', exact: true });
  const center = (box: { x: number; width: number }) => box.x + box.width / 2;
  expect(Math.abs(center((await membersToggle.boundingBox())!) - center((await page.locator('.viewing-actions').boundingBox())!))).toBeLessThan(1);
  await expect(page.getByRole('button', { name: '单路全屏', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('focus-video-and-members.png') });
  const windowSize = await page.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight]);
  await page.getByRole('button', { name: '占满窗口', exact: true }).click();
  await expect(page.locator('.call-viewing-panel')).toHaveClass(/is-expanded/);
  await expect(page.locator('.viewing-members-panel')).not.toBeVisible();
  expect(await page.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight])).toEqual(windowSize);
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  const expanded = await page.locator('.viewing-stage').boundingBox();
  expect(expanded!.x).toBe(0);
  expect(expanded!.width).toBe(windowSize[0]);
  expect(expanded!.y + expanded!.height).toBe(windowSize[1]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.call-viewing-panel')).not.toHaveClass(/is-expanded/);
  // 占满窗口主动覆盖底栏；恢复后必须可以真实点击，不能用强制点击掩盖遮挡。
  await page.getByRole('button', { name: '共享选项', exact: true }).click({ trial: true });
  await expect(page.locator('.viewing-members-panel')).toHaveCount(1);
  await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  const popup = page.waitForEvent('popup');
  await page.locator('.viewing-tile').first().hover();
  await page.getByRole('button', { name: '弹出观看区', exact: true }).first().click();
  const viewer = await popup;
  await expect(viewer.locator('.viewing-tile')).toHaveCount(8);
  await expect(viewer.locator('.viewing-grid')).toHaveCSS('display', 'grid');
  await expect(viewer.getByRole('region', { name: '语音成员', exact: true })).toHaveCount(0);
  await expect(page.locator('.viewing-tile')).toHaveCount(0);
  await expect(page.locator('.group-header')).toBeVisible();
  await expect(page.locator('.viewing-members-panel')).toBeHidden();
  await expect(page.locator('.voice-panel video')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '收回画面', exact: true })).toBeVisible();
  expect(context.pages()).toHaveLength(2);
  await expect(viewer.locator('.viewing-tile')).toHaveCount(8);
  await viewer.getByRole('button', { name: '聚焦成员B', exact: true }).click();
  await expect(viewer.locator('.viewing-tile')).toHaveCount(1);
  await expect(viewer.getByRole('region', { name: '语音成员', exact: true })).toHaveCount(0);
  await viewer.getByRole('button', { name: '展开成员' }).click();
  await expect(viewer.getByRole('region', { name: '语音成员', exact: true })).toBeInViewport({ ratio: 0.95 });
  await viewer.locator('.viewing-surface').hover();
  await viewer.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  expect(await viewer.locator('audio').count()).toBe(0);
  await viewer.locator('.viewing-tile').first().hover();
  await viewer.getByRole('button', { name: '返回主界面', exact: true }).first().click();
  await expect.poll(() => viewer.isClosed()).toBe(true);
  await expect(page.locator('.viewing-tile')).toHaveCount(8);
  const secondPopup = page.waitForEvent('popup');
  await page.locator('.viewing-tile').first().hover();
  await page.getByRole('button', { name: '弹出观看区', exact: true }).first().click();
  const secondViewer = await secondPopup;
  await secondViewer.getByRole('button', { name: '聚焦成员B', exact: true }).click();
  await secondViewer.close();
  await expect(page.locator('.viewing-tile')).toHaveCount(8);
  await expect(page.locator('.group-header')).toBeHidden();
  await sharing(page, ['A']);
  await expect(page.locator('.viewing-tile')).toHaveCount(1);
  for (const width of [1440, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => {
      const tile = await page.locator('.viewing-tile').boundingBox();
      const stage = await page.locator('.viewing-stage').boundingBox();
      return Math.abs(tile!.x + tile!.width / 2 - stage!.x - stage!.width / 2);
    }).toBeLessThan(1);
  }
  await page.locator('.viewing-tile').hover();
  await page.getByRole('button', { name: '退出观看', exact: true }).click();
  await expect(page.locator('.group-header')).toBeVisible();
  await expect(input).toHaveValue('稍后继续写');
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('restored-header.png') });
  expect(errors).toEqual([]);
});

test('观看窗在设置和预览别群时保留；网格跟随当前共享，离房关闭', async ({ page }) => {
  await sharing(page, ['A', 'B']);
  const viewer = await openWatching(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(viewer.locator('.viewing-tile')).toHaveCount(2);
  await expect.poll(() => page.evaluate(async () => {
    const sample = await (window as unknown as { __viewingTest: { diagnostics(): Promise<{
      streams: { identity: string; playbackFrames: number | null; viewing: { visibleViews: number; inactiveViews: number } | null }[];
    }> } }).__viewingTest.diagnostics();
    return sample.streams.filter(stream => ['A', 'B'].includes(stream.identity)).every(stream =>
      stream.playbackFrames !== null && stream.viewing?.visibleViews === 1 && stream.viewing.inactiveViews === 0);
  })).toBe(true);
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await page.getByRole('button', { name: /^另一群组，/ }).click();
  await expect(viewer.locator('.viewing-tile')).toHaveCount(2);
  await page.getByRole('button', { name: '返回当前通话群组' }).click();
  await sharing(page, ['B']);
  await expect(viewer.locator('.viewing-tile')).toHaveCount(1);
  await sharing(page, ['A', 'B']);
  await expect(viewer.locator('.viewing-tile')).toHaveCount(2);
  await page.getByRole('button', { name: '离开语音', exact: true }).click();
  await expect.poll(() => viewer.isClosed()).toBe(true);
});

test('统一卡片尺寸，点击切换与成员折叠记忆，横向拖动不误触', async ({ page }) => {
  const card = page.getByTestId('participant-card').nth(1);
  const before = await card.boundingBox();
  const beforeMeta = await card.locator('.participant-meta').boundingBox();
  await sharing(page, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const after = await card.boundingBox();
  const afterMeta = await card.locator('.participant-meta').boundingBox();
  expect(Math.abs(before!.width - after!.width)).toBeLessThan(1);
  expect(Math.abs(before!.height - after!.height)).toBeLessThan(1);
  expect(Math.abs(beforeMeta!.height - afterMeta!.height)).toBeLessThan(1);
  await expect(page.getByRole('button', { name: '展开网格', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 960, height: 900 });
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  const strip = page.getByRole('region', { name: '语音成员', exact: true });
  await expect(card).toHaveCSS('width', '220px');
  await expect.poll(() => strip.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  const bounds = await strip.boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 - 80, bounds!.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.viewing-tile')).toHaveCount(1);
  await strip.evaluate(element => { element.scrollLeft = 0; });
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await expect(page.locator('.viewing-tile')).toHaveCount(1);
  await page.locator('.viewing-tile').hover();
  await page.getByRole('button', { name: '退出观看', exact: true }).click();
  await expect(page.getByRole('region', { name: '共享观看区' })).toHaveCount(0);
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await page.locator('.viewing-tile').hover();
  await page.getByRole('button', { name: '收起成员', exact: true }).click();
  await expect(strip).toHaveCount(0);
  await expect(page.locator('.viewing-members-panel')).not.toBeVisible();
  const foldedPanel = await page.getByRole('region', { name: '共享观看区' }).boundingBox();
  const foldedStage = await page.locator('.viewing-stage').boundingBox();
  expect(Math.abs(foldedPanel!.height - foldedStage!.height)).toBeLessThan(1);
  await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
  const expand = await page.getByRole('button', { name: '展开成员', exact: true }).boundingBox();
  expect(Math.abs(expand!.x + expand!.width / 2 - foldedStage!.x - foldedStage!.width / 2)).toBeLessThan(1);
  await page.screenshot({ path: test.info().outputPath('focus-members-collapsed.png') });
  await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  await expect(page.locator('.viewing-tile')).toHaveCount(8);
  await expect(strip).toHaveCount(0);
  await page.getByRole('button', { name: '聚焦成员B', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开成员', exact: true })).toBeVisible();
  await expect(strip).toHaveCount(0);
  await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
  await page.getByRole('button', { name: '展开成员', exact: true }).click();
  await expect(strip).toBeVisible();
  await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
  await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  const handle = page.getByRole('button', { name: '收起共享画面' });
  await expect(handle).toBeVisible();
  for (const width of [960, 640, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('textbox', { name: '消息内容' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('region', { name: '共享画面网格' })).toHaveCSS('scrollbar-width', 'none');
  }
  await page.locator('.viewing-tile').first().hover();
  await page.getByRole('button', { name: '退出观看', exact: true }).first().click();
  await expect(page.getByRole('region', { name: '共享观看区' })).toHaveCount(0);
});

test('常驻成员栏保留搜索与王冠，语音覆盖聊天顶部，个人名片边界对齐', async ({ page }) => {
  const directory = page.getByRole('complementary', { name: '群组成员', exact: true });
  const searchButton = directory.getByRole('button', { name: '搜索群组成员' });
  await expect(directory).toBeVisible();
  await expect(directory.getByRole('img', { name: '群主' })).toHaveCount(1);
  await expect(directory.locator('.group-member-row')).toHaveCount(9);
  await searchButton.click();
  await directory.getByRole('searchbox').fill('成员A');
  await expect(directory.locator('.group-member-row')).toHaveCount(1);
  await directory.getByRole('searchbox').press('Escape');
  await expect(searchButton).toBeFocused();
  await expect(directory.getByRole('searchbox')).toHaveCount(0);
  await expect(directory.locator('.group-member-row')).toHaveCount(9);
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
    expect(Math.abs(voice!.y - conversation!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(members!.x - (conversation!.x + conversation!.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(members!.x - personal!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(members!.width - personal!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(voice!.x + voice!.width - members!.x - members!.width)).toBeLessThanOrEqual(1);
    await expect(input).toBeInViewport();
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeInViewport();
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


test('收到远控请求后误点遮罩保留请求，明确拒绝才关闭', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __viewingTest: { requestControl(id: string): void } }).__viewingTest.requestControl('A'));
  const dialog = page.getByRole('dialog', { name: /申请远程控制/ });
  await expect(dialog).toBeVisible();
  await page.locator('.dialog-backdrop').filter({ has: dialog }).click({ position: { x: 6, y: 6 } });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('远控授权和画面匹配后才打开专用控制窗，普通观看关窗不撤销控制', async ({ page, context }) => {
  await sharing(page, ['A']);
  await page.evaluate(() => (window as unknown as { __viewingTest: { control(id: string): void } }).__viewingTest.control('A'));
  const viewer = await openWatching(page);
  await viewer.getByRole('button', { name: '聚焦成员A', exact: true }).click();
  await viewer.locator('.viewing-tile').hover();
  await viewer.getByRole('button', { name: '申请远程控制', exact: true }).click();
  expect(context.pages()).toHaveLength(2);
  const popup = page.waitForEvent('popup');
  await page.evaluate(() => (window as unknown as { __viewingTest: { grant(id: string): void } }).__viewingTest.grant('A'));
  const controller = await popup;
  await expect(controller.getByRole('region', { name: '成员A的远程控制窗口' })).toBeVisible();
  await expect.poll(() => controller.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await controller.locator('.participant-media').click();
  await controller.locator('.participant-media').press('a');
  const inputs = () => page.evaluate(() => (window as unknown as { __viewingTest: { inputEvents(): Array<{ kind: string; key: string }> } }).__viewingTest.inputEvents());
  await expect.poll(inputs).toContainEqual({ kind: 'keyDown', key: 'letterA' });
  await controller.keyboard.down('b');
  await controller.evaluate(() => window.dispatchEvent(new Event('lycan-viewer-disarm')));
  await expect.poll(inputs).toContainEqual({ kind: 'keyUp', key: 'letterB' });
  const count = (await inputs()).length;
  await controller.keyboard.press('c');
  expect((await inputs()).length).toBe(count);
  await viewer.close();
  await expect(controller.locator('.remote-control-status')).toContainText('点击画面开始操作');
  await controller.close();
  await page.getByRole('button', { name: '聚焦成员A', exact: true }).click();
  await page.locator('.viewing-tile').hover();
  await expect(page.getByRole('button', { name: '申请远程控制', exact: true })).toBeVisible();
});


test('成员搜索和设置页退场时立即禁用交互，完成后移除', async ({ page }) => {
  await page.addStyleTag({ content: ':root { --motion-surface-duration: 500ms; --motion-layout-duration: 500ms; --motion-expand-duration: 500ms; }' });
  const directory = page.getByRole('complementary', { name: '群组成员', exact: true });
  await directory.getByRole('button', { name: '搜索群组成员' }).click();
  await expect(page.locator('.member-search-enter-active')).toHaveCount(0);
  await directory.getByRole('searchbox').press('Escape');
  const search = page.locator('.member-search-leave-active');
  expect(await search.evaluate(element => ({ inert: (element as HTMLElement).inert,
    pointerEvents: getComputedStyle(element).pointerEvents }))).toEqual({ inert: true, pointerEvents: 'none' });
  await expect(page.locator('.member-search')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.settings-page-enter-active')).toHaveCount(0);
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  const settings = page.locator('.settings-page-leave-active');
  expect(await settings.evaluate(element => ({ inert: (element as HTMLElement).inert,
    pointerEvents: getComputedStyle(element).pointerEvents }))).toEqual({ inert: true, pointerEvents: 'none' });
  await expect(page.locator('.settings-view')).toHaveCount(0);
  await expect(page.getByTestId('callbar')).toBeVisible();
  expect(await page.locator('button:disabled, input:disabled').evaluateAll(elements => elements.some(element =>
    ['not-allowed', 'no-drop'].includes(getComputedStyle(element).cursor)))).toBe(false);
});

test('聚焦网格和成员折叠只覆盖聊天，保留历史阅读位置与草稿', async ({ page }, testInfo) => {
  await page.route('**/api/groups/viewing-group-0/messages**', route => route.fulfill({ json: {
    messages: Array.from({ length: 80 }, (_, index) => ({ id: 'history-' + index, senderUserId: user.id,
      senderNickname: user.nickname, type: 'TEXT', content: `历史消息 ${index}，保持阅读位置。`,
      createdAt: new Date(Date.UTC(2026, 9, 10, 0, 0, index)).toISOString(), attachment: null })), hasMore: false,
  } }));
  await page.reload();
  await page.getByRole('button', { name: /^观看测试，/ }).dblclick();
  await expect(page.locator('.callbar-enter-active')).toHaveCount(0);
  const list = page.locator('.message-list');
  await expect(page.locator('[data-message-id]')).toHaveCount(80);
  await list.evaluate(element => element.scrollTo({ top: 500, behavior: 'instant' }));
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(500);
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('覆盖布局保留草稿');
  const original = await list.elementHandle();
  const before = await list.boundingBox();
  const readingAnchor = page.locator('[data-message-id="history-30"]');
  const anchorBefore = await readingAnchor.boundingBox();
  await sharing(page, ['A', 'B']);
  const unchanged = async () => {
    await expect.poll(async () => (await readingAnchor.boundingBox())!.y).toBeCloseTo(anchorBefore!.y, 0);
    const after = await list.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(1);
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    await expect(input).toHaveValue('覆盖布局保留草稿');
  };
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await expect(page.locator('.voice-panel')).toHaveClass(/is-viewing/);
  await unchanged();
  const stage = page.locator('.viewing-stage');
  const viewingHeight = await stage.evaluate(el => (el as HTMLElement).style.height);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('main', { name: '设置', exact: true });
    await expect(settings).toHaveCSS('clip-path', 'inset(0px)');
    await expect(page.locator('.app-content')).toHaveCSS('visibility', 'hidden');
    expect(await list.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(before!.height, 0);
    expect((await readingAnchor.boundingBox())!.y).toBeCloseTo(anchorBefore!.y, 0);
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    await unchanged();
    await expect(stage).toHaveCSS('height', viewingHeight);
  }
  await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
  await page.getByRole('button', { name: '收起成员', exact: true }).click();
  await unchanged();
  await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
  await page.getByRole('button', { name: '查看全部共享画面', exact: true }).click();
  await unchanged();
  await page.getByRole('button', { name: '聚焦成员B', exact: true }).click();
  await page.locator('.viewing-tile:not(.view-tile-leave-active) .viewing-surface').hover();
  await page.getByRole('button', { name: '退出观看', exact: true }).click();
  await unchanged();
  const firstMessage = page.locator('[data-message-id="history-0"]');
  for (const focused of [false, true]) {
    if (focused) {
      await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
    }
    await list.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(async () => {
      // 展开期间会补偿阅读位置，持续尝试触顶直到布局稳定后仍能看到最早消息。
      await list.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
      const first = await firstMessage.boundingBox();
      const overlay = await page.locator('.voice-panel').boundingBox();
      return first!.y >= overlay!.y + overlay!.height;
    }).toBe(true);
    await expect(firstMessage).toBeInViewport();
    await expect.poll(() => list.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const overlayBottom = document.querySelector('.voice-panel')!.getBoundingClientRect().bottom;
      const trackStart = top + Number.parseFloat(getComputedStyle(element, '::-webkit-scrollbar-track').marginTop);
      return Math.abs(trackStart - Math.max(top, overlayBottom) - 8);
    })).toBeLessThan(1);
    if (!focused) {
      const bounds = (await list.boundingBox())!;
      const overlay = (await page.locator('.voice-panel').boundingBox())!;
      const thumbTop = overlay.y + overlay.height + 16;
      await page.mouse.move(bounds.x + bounds.width - 3, thumbTop);
      await page.screenshot({ path: testInfo.outputPath('chat-scrollbar.png') });
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 3, thumbTop + 80, { steps: 8 });
      await page.mouse.up();
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(80);
    }
  }
});

test('入退语音在历史顶部、中部和底部都保持消息与输入框的相对位置', async ({ page }) => {
  await page.route('**/api/groups/viewing-group-0/messages**', route => route.fulfill({ json: {
    messages: Array.from({ length: 80 }, (_, index) => ({ id: 'history-' + index, senderUserId: user.id,
      senderNickname: user.nickname, type: 'TEXT', content: `历史消息 ${index}，随输入框移动。`,
      createdAt: new Date(Date.UTC(2026, 9, 10, 0, 0, index)).toISOString(), attachment: null })), hasMore: false,
  } }));
  await page.reload();
  await expect(page.locator('[data-message-id]')).toHaveCount(80);
  const list = page.locator('.message-list');
  const anchor = page.locator('[data-message-id="history-30"]');
  const composer = page.locator('.composer');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('进入语音不丢阅读位置');
  const original = await input.elementHandle();
  for (const position of [0, 800, Number.MAX_SAFE_INTEGER]) {
    await list.evaluate(async (element, top) => {
      element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      element.scrollTo({ top, behavior: 'instant' });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }, position);
    const before = (await anchor.boundingBox())!.y - (await composer.boundingBox())!.y;
    const composerBefore = (await composer.boundingBox())!.y;
    await page.getByRole('button', { name: /^观看测试，/ }).dblclick();
    await expect(page.getByTestId('participant-card')).toHaveCount(9);
    await expect(page.locator('.callbar-enter-active')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y
      - (await composer.boundingBox())!.y - before)).toBeLessThan(2);
    expect((await composer.boundingBox())!.y).toBeLessThan(composerBefore - 20);
    await expect(page.locator('.chat-jump')).toHaveCount(0);
    await page.getByRole('button', { name: '离开语音', exact: true }).click();
    await expect(page.getByTestId('callbar')).toHaveCount(0);
    await expect(page.locator('.voice-panel')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y
      - (await composer.boundingBox())!.y - before)).toBeLessThan(2);
    await expect(input).toHaveValue('进入语音不丢阅读位置');
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  }
});

test('从普通最大高度继续拖动，回拉或取消保留布局，越过底线松手才占满', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面' }).click();
  await page.getByRole('button', { name: '放大聚焦画面' }).click();
  const panel = page.locator('.call-viewing-panel');
  const handle = page.locator('.viewing-fold');
  const above = await handle.boundingBox();
  const x = above!.x + above!.width / 2, y = above!.y + above!.height / 2;
  const drag = async () => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 115, { steps: 5 });
    await expect(panel).not.toHaveClass(/is-expanded/);
  };
  await drag();
  await page.mouse.move(x, y + 35);
  await page.mouse.up();
  await expect(panel).not.toHaveClass(/is-expanded/);
  await drag();
  await handle.dispatchEvent('pointercancel');
  await page.mouse.up();
  await expect(panel).not.toHaveClass(/is-expanded/);
  await drag();
  await page.mouse.up();
  await expect(panel).toHaveClass(/is-expanded/);
  await page.getByRole('button', { name: '恢复观看布局' }).click();
  await expect(handle).toBeVisible();
});

for (const layout of ['聚焦', '网格']) {
  test(`短手柄在${layout}中跟手调高、即时吸附并保留成员卡片`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await sharing(page, ['A', 'B']);
    const memberEdge = await page.locator('.viewing-members-panel').evaluate(el =>
      el.closest('.group-main')!.querySelector('.group-conversation')!.getBoundingClientRect().top + el.getBoundingClientRect().height);
    await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
    if (layout === '网格') await page.getByRole('button', { name: '查看全部共享画面' }).click();
    const handle = page.locator('.viewing-fold');
    const cards = page.locator('.viewing-members-panel');
    const height = () => page.locator('.viewing-stage').evaluate(el => el.getBoundingClientRect().height);
    const settled = () => page.waitForFunction(() => !document.querySelector('.voice-panel')?.getAnimations({ subtree: true })
      .some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity));
    async function grab() {
      const bounds = (await handle.boundingBox())!;
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      return (dy: number) => page.mouse.move(x, y + dy);
    }
    const memberBackground = await page.locator('.voice-panel > .call-viewing-panel').evaluate(el => getComputedStyle(el).backgroundColor);
    const stripBackground = () => page.locator('.viewing-fold-strip').evaluate(el => getComputedStyle(el).backgroundColor);
    await expect.poll(stripBackground).toBe(memberBackground);
    await handle.hover();
    await expect(handle).toHaveCSS('position', 'absolute');
    await expect(handle).toHaveCSS('width', '60px');
    await expect(handle).toHaveCSS('cursor', 'pointer');
    await expect(handle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect(await handle.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      return Math.abs(rect.bottom - el.parentElement!.getBoundingClientRect().bottom) < 1
        && document.elementFromPoint(rect.left + rect.width / 2, y) === el
        && [rect.left - 4, rect.right + 4].every(x => !document.elementFromPoint(x, y)?.closest('.voice-panel'));
    })).toBe(true);
    await expect(handle.locator('path')).toHaveCSS('stroke-width', '2px');
    await settled();
    const initial = await height();
    let pull = await grab();
    await pull(-70);
    await expect.poll(height).toBeCloseTo(initial - 70, 0);
    await page.mouse.up();
    pull = await grab();
    // 先吸附到普通最大高度。超出底线 96px 松手由占满窗口用例覆盖。
    let maximum = await height();
    for (let dy = 20; dy <= 480; dy += 20) {
      const before = maximum;
      await pull(dy);
      maximum = await height();
      if (maximum === before) break;
    }
    await page.mouse.up();
    pull = await grab();
    await pull(-120);
    await page.mouse.up();
    await expect.poll(height).toBeCloseTo(maximum - 120, 0);
    pull = await grab();
    await pull(100);
    await expect.poll(height).toBe(maximum);
    const anchor = (await handle.boundingBox())!.y - 120;
    for (const dy of [170, 55, 104, 165, 45, 106, 40]) {
      await pull(dy);
      if (dy < 80) {
        expect(Math.abs((await handle.boundingBox())!.y - (anchor + dy))).toBeLessThanOrEqual(1);
        expect(await height()).toBeCloseTo(maximum - 120 + dy, 0);
      } else {
        expect(await height()).toBeCloseTo(maximum, 0);
      }
    }
    await page.mouse.up();
    const released = (await handle.boundingBox())!.y;
    await settled();
    expect((await handle.boundingBox())!.y).toBeCloseTo(released, 0);

    const beforeMin = (await handle.boundingBox())!.y;
    pull = await grab();
    for (const dy of [0, -30, 36, 0, -35, 42, 0]) {
      await pull(memberEdge + dy - beforeMin);
      if (dy <= 0) {
        if (layout === '网格') {
          await expect(page.locator('.viewing-stage')).toHaveCSS('opacity', '0');
          await expect(page.locator('.viewing-stage video').first()).toBeAttached();
        } else expect(await height()).toBe(0);
        expect(Math.abs((await handle.boundingBox())!.y - memberEdge)).toBeLessThanOrEqual(1);
      } else {
        expect(await height()).toBeGreaterThan(0);
        expect(Math.abs((await handle.boundingBox())!.y - memberEdge - dy)).toBeLessThanOrEqual(1);
      }
    }
    await expect(cards).toBeVisible();
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    if (layout === '聚焦') {
      const bounds = (await handle.boundingBox())!;
      await page.screenshot({ path: testInfo.outputPath('member-handle.png'),
        clip: { x: Math.floor(bounds.x - 90), y: Math.floor(bounds.y - 28), width: 240, height: 64 } });
    }
    pull = await grab();
    await pull(-36);
    await page.mouse.up();
    await expect(cards).toBeHidden();
    const groupBackground = await page.locator('.group-main').evaluate(el => getComputedStyle(el).backgroundColor);
    await expect.poll(stripBackground).toBe(groupBackground);
    await expect(page.locator('.group-header')).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
    expect(await handle.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return [-12, rect.width + 12].every(dx =>
        !document.elementFromPoint(rect.left + dx, rect.top + rect.height / 2)?.closest('.voice-panel'));
    })).toBe(true);
    await handle.click();
    await expect(cards).toBeVisible();
    await expect.poll(height).toBe(0);
    await settled();
    pull = await grab();
    await pull(36);
    await expect.poll(height).toBeGreaterThan(0);
    await page.mouse.up();
    await expect(page.getByRole('button', { name: layout === '网格' ? '聚焦成员B' : '查看全部共享画面' })).toBeVisible();
    await expect(page.getByTestId('callbar')).toBeVisible();
    if (layout === '聚焦') {
      pull = await grab();
      await pull(38 - await height());
      await page.mouse.up();
      await expect.poll(height).toBe(0);
      await sharing(page, ['B']);
      pull = await grab();
      await pull(180);
      await page.mouse.up();
      await expect(page.locator('.viewing-caption').first()).toContainText('成员B');
      await expect.poll(height).toBeGreaterThan(0);
      await expect(cards).toBeVisible();
    }
  });
}

test('成员条按拖动方向逐级展开，聚焦收起时按住即可看到群标题', async ({ page }) => {
  await sharing(page, ['A', 'B']);
  const cards = page.locator('.viewing-members-panel');
  const handle = page.locator('.viewing-fold');
  async function grab() {
    await handle.click({ trial: true });
    const bounds = (await handle.boundingBox())!;
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    return (dy: number) => page.mouse.move(x, y + dy, { steps: 4 });
  }
  for (const dy of [-36, 36, 36]) {
    const pull = await grab();
    await pull(dy);
    await page.mouse.up();
    if (dy < 0) await expect(cards).toBeHidden();
    else await expect(cards).toBeVisible();
  }
  await expect(page.locator('.viewing-caption').first()).toContainText('成员A');
  await page.getByRole('button', { name: '收起成员', exact: true }).click();
  await expect(cards).toBeHidden();
  const header = page.locator('.group-header-region');
  await expect(header).toHaveCSS('visibility', 'hidden');
  const pull = await grab();
  await pull(-680);
  await expect(header).toHaveCSS('opacity', '1');
  await expect(header).toHaveCSS('visibility', 'visible');
  await expect(header).toHaveAttribute('inert', '');
  await expect(page.locator('.viewing-stage video').first()).toBeAttached();
  await pull(0);
  await expect(header).toHaveCSS('opacity', '0');
  await page.mouse.up();
});

test('手柄点击展开与下拉到普通最大高度一致', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面' }).click();
  await page.getByRole('button', { name: '放大聚焦画面' }).click();
  const handle = page.locator('.viewing-fold');
  const height = () => page.locator('.viewing-stage').evaluate(el => el.getBoundingClientRect().height);
  await handle.click({ trial: true });
  const maximum = await height();
  await handle.press('ArrowUp');
  await expect.poll(height).toBe(maximum - 20);
  await handle.click();
  await expect.poll(height).toBe(0);
  await handle.click();
  await expect.poll(height, { timeout: 2000 }).toBe(maximum);
  await expect(page.locator('.call-viewing-panel')).not.toHaveClass(/is-expanded/);
});

test('聚焦上拖在成员交接区内松手继续收拢', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await sharing(page, ['A']);
  const handle = page.locator('.viewing-fold');
  await handle.click({ trial: true });
  const memberTop = (await handle.boundingBox())!.y;
  await page.getByRole('button', { name: '观看成员A的共享画面' }).click();
  await page.getByRole('button', { name: '放大聚焦画面' }).click();
  for (const distance of [44, 24, 8]) {
    await handle.click({ trial: true });
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, memberTop + box.height / 2 + distance, { steps: 12 });
    const frames = handle.evaluate(el => new Promise<number[][]>(resolve => {
      const stage = document.querySelector<HTMLElement>('.viewing-stage')!;
      const measure = () => [el.getBoundingClientRect().top, stage.offsetHeight ? Number(getComputedStyle(stage).opacity) : 0];
      const positions = [measure()];
      el.addEventListener('pointerup', () => {
        const start = performance.now();
        function sample() {
          positions.push(measure());
          if (performance.now() - start < 300) requestAnimationFrame(sample);
          else resolve(positions);
        }
        requestAnimationFrame(sample);
      }, { once: true });
      el.setAttribute('data-sampling-release', '');
    }));
    await expect(handle).toHaveAttribute('data-sampling-release', '');
    await page.mouse.up();
    const positions = await frames;
    expect(positions[0][1]).toBeGreaterThan(0);
    expect(positions[0][1]).toBeLessThan(1);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i][0]).toBeLessThanOrEqual(positions[i - 1][0] + 1);
      expect(positions[i][1]).toBeLessThanOrEqual(positions[i - 1][1]);
    }
    await expect(handle).toHaveAccessibleName('展开共享画面');
    expect(positions.at(-1)![0]).toBeCloseTo(memberTop, 0);
    await handle.evaluate(el => el.removeAttribute('data-sampling-release'));
    await handle.click();
  }
});

test('成员条按拖动收起后松手保持最终位置', async ({ page }) => {
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面' }).click();
  await page.getByRole('button', { name: '收起成员', exact: true }).click();
  const handle = page.locator('.viewing-fold');
  await handle.hover();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, 80, { steps: 12 });
  await expect(page.locator('.viewing-stage')).toHaveCSS('opacity', '0');
  const samples = handle.evaluate(el => new Promise<number[][]>(resolve => {
    const elements = [el, ...el.parentElement!.querySelectorAll('.viewing-member-strip .member-card')];
    const measure = () => elements.map(element => element.getBoundingClientRect().top);
    const positions = [measure()];
    el.addEventListener('pointerup', () => {
      const start = performance.now();
      function sample() {
        positions.push(measure());
        if (performance.now() - start < 450) requestAnimationFrame(sample);
        else resolve(positions);
      }
      requestAnimationFrame(sample);
    }, { once: true });
    el.setAttribute('data-sampling-release', '');
  }));
  await expect(handle).toHaveAttribute('data-sampling-release', '');
  await page.mouse.up();
  const positions = await samples;
  expect(positions[0].length).toBeGreaterThan(1);
  for (const [index, top] of positions[0].entries()) {
    expect(Math.max(...positions.map(frame => Math.abs(frame[index] - top)))).toBeLessThanOrEqual(1);
  }
  await expect(page.locator('.viewing-members-panel')).toBeVisible();
});

test('收起手柄后标题、聊天和成员名单与未加入语音时等高', async ({ page }) => {
  const handle = page.locator('.viewing-fold');
  const positions = () => page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return [rect('.group-header').bottom, rect('.chat-title').top, rect('.members-directory').top];
  });
  await page.getByRole('button', { name: '离开语音', exact: true }).click();
  await expect(page.locator('.voice-panel')).toHaveCount(0);
  const beforeJoin = await positions();
  await page.getByRole('button', { name: '加入当前群组语音' }).click();
  await handle.press('ArrowUp');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(positions).toEqual(beforeJoin);
  await expect.poll(() => handle.evaluate(el => el.getBoundingClientRect().bottom)).toBe(beforeJoin[0]);
  await handle.click();
  await expect(page.locator('.viewing-members-panel')).toBeVisible();
});

test('聚焦信息栏与下方手柄同步显隐，展开卡片后恢复成员底色', async ({ page }) => {
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面' }).click();
  await page.getByRole('button', { name: '收起成员', exact: true }).click();
  const surface = page.locator('.viewing-surface');
  const actions = page.locator('.viewing-actions');
  const strip = page.locator('.viewing-fold-strip');
  const opacity = () => strip.evaluate(el => getComputedStyle(el, '::before').opacity);
  await surface.hover();
  await expect(actions).toHaveCSS('opacity', '1');
  await expect.poll(opacity).toBe('1');
  await page.mouse.move(2, 2);
  await expect.poll(opacity).toBe('0');
  await expect(actions).toHaveCSS('opacity', '0');
  await surface.hover();
  await page.getByRole('button', { name: '展开成员', exact: true }).click();
  await expect(strip).not.toHaveClass(/is-under-focus/);
  expect(await strip.evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
});

test('手柄悬停提示点击方向，拖动可反向，停手恢复横线', async ({ page }) => {
  const handle = page.locator('.viewing-fold');
  const bend = () => handle.locator('path').evaluate((path: SVGPathElement) =>
    path.getPointAtLength(path.getTotalLength() / 2).y - path.getPointAtLength(0).y);
  await handle.hover();
  await expect.poll(bend).toBeCloseTo(0);
  await handle.click();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await sharing(page, ['A']);
  await handle.hover();
  await expect.poll(bend).toBeCloseTo(4);
  await handle.click();
  await handle.hover();
  await expect.poll(bend).toBeCloseTo(-4);
  await handle.click();
  await handle.hover();
  await expect.poll(bend).toBeCloseTo(4);
  await handle.press('ArrowUp');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await handle.hover();
  await expect.poll(bend).toBeCloseTo(4);
  await handle.click();
  await handle.hover();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.down();
  await page.mouse.move(x, y + 25);
  await expect(handle).toHaveAttribute('data-direction', 'down');
  await page.mouse.move(x, y + 8);
  await expect(handle).toHaveAttribute('data-direction', 'up');
  await expect.poll(bend).toBeCloseTo(0);
  await page.mouse.move(x, y + 2);
  await page.mouse.up();
  await expect.poll(bend).toBeCloseTo(0);
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
});

test('观看默认高度和拖动上限一致，缩窗保留偏好且不遮住必要操作', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  const handle = page.getByRole('button', { name: '收起共享画面' });
  const stageHeight = () => page.locator('.viewing-stage').evaluate(el => el.getBoundingClientRect().height);
  await expect(handle).toBeVisible();
  const initial = await stageHeight();
  await handle.press('ArrowDown');
  expect(await stageHeight()).toBeGreaterThanOrEqual(initial);
  await handle.press('ArrowUp');
  const preferred = await stageHeight();
  for (const height of [560, 900]) {
    await page.setViewportSize({ width: 1280, height });
    await expect(page.getByRole('textbox', { name: '消息内容' })).toBeInViewport();
    await expect(page.getByTestId('callbar')).toBeInViewport();
    await expect(page.getByRole('button', { name: '搜索群组成员' })).toBeInViewport();
    await expect.poll(async () => {
      const voice = await page.getByRole('region', { name: '当前语音成员', exact: true }).boundingBox();
      const composer = await page.locator('.composer').boundingBox();
      return voice!.y + voice!.height <= composer!.y + 1;
    }).toBe(true);
    const panel = await page.getByRole('region', { name: '共享观看区', exact: true }).boundingBox();
    const voice = await page.getByRole('region', { name: '当前语音成员', exact: true }).boundingBox();
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(voice!.y + voice!.height + 1);
  }
  await expect.poll(stageHeight).toBe(preferred);
});

test('群菜单不被标题裁切，控制栏退出时聊天连续复位且保留草稿', async ({ page }) => {
  await page.getByRole('button', { name: '群组菜单', exact: true }).click();
  const menu = page.getByLabel('群组操作', { exact: true });
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate(element => {
    const target = element.lastElementChild!;
    const bounds = target.getBoundingClientRect();
    return target.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
  await page.getByRole('button', { name: '群组菜单', exact: true }).press('Escape');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('动画不清空草稿');
  const positions = await page.evaluate(async () => {
    const input = document.querySelector<HTMLElement>('.composer')!;
    const positions = [input.getBoundingClientRect().bottom];
    document.querySelector<HTMLButtonElement>('button[aria-label="离开语音"]')!.click();
    const started = performance.now();
    while (performance.now() - started < 300) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      positions.push(input.getBoundingClientRect().bottom);
    }
    return positions;
  });
  expect(positions.at(-1)! - positions[0]).toBeGreaterThan(20);
  expect(new Set(positions.map(value => Math.round(value))).size).toBeGreaterThan(3);
  await expect(page.getByTestId('callbar')).toHaveCount(0);
  await expect(input).toHaveValue('动画不清空草稿');
});


test('聚焦共享后浏览其他群组仍显示标题，返回通话群组保留聚焦', async ({ page }) => {
  await sharing(page, ['A']);
  await page.getByRole('button', { name: '观看成员A的共享画面', exact: true }).click();
  await expect(page.locator('.group-header-region')).toHaveCSS('visibility', 'hidden');
  await page.getByRole('button', { name: /^另一群组，/ }).click();
  await expect(page.locator('.group-header-region')).toHaveCSS('visibility', 'visible');
  await expect(page.locator('.group-header-region')).toContainText('另一群组');
  await expect(page.locator('.group-header-region')).not.toHaveAttribute('inert');
  await page.getByRole('button', { name: '返回当前通话群组', exact: true }).click();
  await expect(page.locator('.group-header-region')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('.viewing-tile')).toHaveCount(1);
});

test('群资料和邀请窗口在网络读取完成前可操作', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/groups/viewing-group-0/**', async route => {
    await gate;
    await route.fulfill({ json: { members: [], hasMore: false, code: 'TEST' } });
  });
  await page.route('**/api/groups/viewing-group-0', async route => {
    await gate;
    await route.fulfill({ json: groups[0] });
  });
  try {
    const menu = page.getByRole('button', { name: '群组菜单', exact: true });
    await menu.click();
    await page.getByRole('button', { name: '编辑群组资料' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input:not([type=file])').first().fill('草稿');
    await page.keyboard.press('Escape');
    await menu.click();
    await page.getByRole('button', { name: '邀请成员' }).click();
    await expect(dialog.getByPlaceholder('搜索成员')).toBeEnabled();
    await expect(dialog.getByRole('button', { name: '复制' })).toBeDisabled();
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
  } finally { release(); }
});

test('群资料和邀请窗口之外的成员管理与转让也可在首次读取时操作', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // 首次建立在线状态游标会独立复核群资料，本例只计弹窗操作引起的读取。
  let resumePresence!: () => void;
  const presenceGate = new Promise<void>(resolve => { resumePresence = resolve; });
  await page.route('**/api/groups/viewing-group-1/presence-changes*', async route => {
    await presenceGate;
    await route.fallback();
  });
  let reads = 0;
  await page.route('**/api/groups/viewing-group-1', async route => {
    reads++;
    if (reads === 1) {
      await gate;
      return route.fulfill({ status: 503, json: { detail: '暂时无法读取成员' } });
    }
    await route.fulfill({ json: groups[1] });
  });
  try {
    await page.getByRole('button', { name: /^另一群组，/ }).click();
    const menu = page.getByRole('button', { name: '群组菜单' });
    await menu.click();
    await page.getByRole('button', { name: '管理成员', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByPlaceholder('搜索成员')).toBeEnabled();
    await expect(dialog.getByText('没有匹配的成员')).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭' }).click();
    await menu.click();
    await page.getByRole('button', { name: '转让群主', exact: true }).click();
    await dialog.getByPlaceholder('搜索成员').fill('成员A');
    expect(reads).toBe(1);
    release();
    await dialog.getByRole('button', { name: '重新读取' }).click();
    await expect(dialog.getByPlaceholder('搜索成员')).toHaveValue('成员A');
    await expect(dialog.getByText('成员A', { exact: true })).toBeVisible();
    expect(reads).toBe(2);
  } finally { release(); resumePresence(); }
});
