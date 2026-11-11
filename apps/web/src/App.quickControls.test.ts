import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, effectScope, reactive, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useScreenShareSelection } from './rtc/useScreenShareSelection';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const functions = ['requestNativeScreenSource', 'shareCurrentGame', 'shareAndRecord', 'updateVoiceMode'];
const variables = ['currentGame', 'gameShareBusy'];
const compiled = ts.transpile(source.statements.filter(statement => ts.isFunctionDeclaration(statement)
  ? functions.includes(statement.name?.text ?? '') : ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => variables.includes(declaration.name.getText(source))))
  .map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
const capabilities = () => Promise.resolve({ screenShareAudioCapture: { available: true, reason: 'windowsApplicationLoopbackProcessTree' } });

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals(); });

function setup() {
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'lycansync.screen-share' ? JSON.stringify({ hideCursor: true }) : null, setItem: vi.fn() });
  const game: DetectedActivity = { type: 'GAME', name: '自定义游戏名', startedAt: '2026-11-10T00:00:00Z', windowIds: ['22'] };
  const sources: NativeVideoSource[] = [
    { sourceId: 'screen', kind: 'monitor', title: '屏幕' },
    { sourceId: 'other', kind: 'window', windowId: '11', title: '自定义游戏名' },
    { sourceId: 'game', kind: 'window', windowId: '22', title: '原始窗口标题' },
  ].map(item => ({ ...item, kind: item.kind as 'window' | 'monitor', width: 640, height: 480, primary: false }));
  const state = {
    computed, desktop: { listNativeVideoSources: vi.fn(async () => ({ revision: 1, discoveryId: 'discovery', sources })),
      getCurrentActivity: vi.fn(async (): Promise<DetectedActivity | null> => game),
      getNativeVideoSourceThumbnails: vi.fn(async () => []), prepareNativeVideoSource: vi.fn(async () => ({ prepared: true })), reportCapturePickerTiming: vi.fn() },
    captureRequest: ref<ReturnType<typeof useScreenShareSelection>['captureRequest']['value']>(null), currentActivity: ref<DetectedActivity | null>(game),
    captureQuality: ref('custom'), captureCustomQuality: ref({ resolution: 1440, fps: 60 }),
    viewerNotice: ref(''), appDisposed: false, connected: ref(true), screenShareLimitReached: ref(false), requestedGame: null as DetectedActivity | null,
    Track: { Source: { ScreenShare: 'screen_share' } },
    rtc: reactive({ room: {}, screenShareActive: false, busySources: [] as string[], screenShareQualityBusy: false, screenShareSourceBusy: false,
      toggleMedia: vi.fn(async () => {}) }),
    recording: { busy: ref(false), start: vi.fn(async () => {}) },
    audioShortcuts: { error: '', bindings: { pushToTalk: '' }, setVoiceMode: vi.fn() }, openSettings: vi.fn(),
  };
  const scope = effectScope(); scopes.push(scope);
  const captureSelection = scope.run(() => useScreenShareSelection({ desktop: state.desktop, notice: state.viewerNotice,
    sourcesElement: () => undefined, room: () => state.connected.value ? state.rtc.room : null,
    sharing: () => state.rtc.screenShareActive, activity: () => state.currentActivity.value }))!;
  captureSelection.captureQuality.value = 'custom';
  captureSelection.captureCustomQuality.value = { resolution: 1440, fps: 60 };
  state.captureRequest = captureSelection.captureRequest;
  const resolveGameScreenSource = (target: DetectedActivity, pending: ReturnType<typeof capabilities>) => captureSelection.requestNativeScreenSource(pending, target);
  const app = runInNewContext(`${compiled}\n({ ${functions.join(', ')}, currentGame, resolveGameScreenSource })`, Object.assign(state, { captureSelection, resolveGameScreenSource })) as {
    resolveGameScreenSource: (game: DetectedActivity, pendingCapabilities: ReturnType<typeof capabilities>) => Promise<unknown>;
    requestNativeScreenSource: (pendingCapabilities: ReturnType<typeof capabilities>) => Promise<unknown>;
    shareCurrentGame: () => Promise<void>; shareAndRecord: () => Promise<void>;
    updateVoiceMode: (mode: string, opener: unknown) => void;
  };
  return { app, state, sources, game, resolve: () => app.resolveGameScreenSource(game, capabilities()) };
}

it('直分享按窗口身份匹配，忽略名称并继承画质、光标和声音偏好', async () => {
  const f = setup();
  f.state.requestedGame = f.game;
  expect(await f.app.requestNativeScreenSource(capabilities())).toEqual({ sourceId: 'game', quality: 'custom', customQuality: { resolution: 1440, fps: 60 },
    captureSettings: { hideCursor: true, hideBorder: false, windowMethod: 'auto' }, shareAudio: true });
  expect(f.state.captureRequest.value).toBeNull();
});

it.each(['multiple', 'missing', 'differentSession', 'noActivity', 'failure'])('%s 不猜测窗口或自动共享桌面', async scenario => {
  const f = setup();
  if (scenario === 'multiple') f.game.windowIds!.push('11');
  if (scenario === 'missing') f.sources.pop();
  if (scenario === 'differentSession') f.state.desktop.getCurrentActivity.mockResolvedValue({ ...f.game, startedAt: 'another-session' });
  if (scenario === 'noActivity') f.state.desktop.getCurrentActivity.mockResolvedValue(null);
  if (scenario === 'failure') f.state.desktop.listNativeVideoSources.mockRejectedValue(new Error('unavailable'));
  expect(await f.resolve()).toBeNull();
  expect(f.state.viewerNotice.value).not.toBe('');
});

it('声音能力请求失败不共享，迟到结果不进入新房间', async () => {
  const f = setup();
  expect(await f.app.resolveGameScreenSource(f.game, Promise.reject(new Error('capabilities')))).toBeNull();
  f.state.viewerNotice.value = '';
  f.state.desktop.listNativeVideoSources.mockImplementation(async () => {
    f.state.rtc.room = {};
    return { revision: 1, discoveryId: 'new', sources: f.sources };
  });
  expect(await f.resolve()).toBeNull();
  expect(f.state.viewerNotice.value).toBe('');
});

it('游戏入口借用原有共享启动流程，结束后清除直分享请求', async () => {
  const f = setup();
  f.state.rtc.toggleMedia.mockImplementation(async () => { expect(f.state.requestedGame).toEqual(f.game); });
  await f.app.shareCurrentGame();
  expect(f.state.rtc.toggleMedia).toHaveBeenCalledWith('screen_share');
  expect(f.state.requestedGame).toBeNull();
  f.state.rtc.toggleMedia.mockClear();
  f.state.rtc.screenShareActive = true;
  await f.app.shareCurrentGame();
  expect(f.state.rtc.toggleMedia).not.toHaveBeenCalled();
});

it.each(['success', 'cancel', 'leave', 'switch', 'disposed'])('共享并录制：%s 只在同一房间成功启动共享后录制', async outcome => {
  const f = setup();
  f.state.rtc.toggleMedia.mockImplementation(async () => {
    f.state.rtc.screenShareActive = outcome !== 'cancel';
    if (outcome === 'leave') f.state.connected.value = false;
    if (outcome === 'switch') f.state.rtc.room = {};
    if (outcome === 'disposed') f.state.appDisposed = true;
  });
  await f.app.shareAndRecord();
  expect(f.state.recording.start).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
});

it('未绑定入口进入设置但不再注入重复提示，不提前开启按键发言', () => {
  const f = setup();
  const opener = {};
  f.app.updateVoiceMode('pushToTalk', opener);
  expect(f.state.openSettings).toHaveBeenCalledWith('shortcuts', opener);
  expect(f.state.audioShortcuts.error).toBe('');
  expect(f.state.audioShortcuts.setVoiceMode).not.toHaveBeenCalled();
  f.state.audioShortcuts.bindings.pushToTalk = 'F2';
  f.app.updateVoiceMode('pushToTalk', opener);
  expect(f.state.audioShortcuts.setVoiceMode).toHaveBeenCalledWith('pushToTalk');
});
