import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { computed, reactive, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { createNativeVideoSourceSelection } from './components/nativeVideoSourceSelection';

const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const functions = ['refreshNativeSources', 'shareCurrentGame', 'updateVoiceMode', 'updateMicrophoneProcessing'];
const variables = ['captureSources', 'currentGame', 'gameShareBusy'];
const compiled = ts.transpile(source.statements.filter(statement => ts.isFunctionDeclaration(statement)
  ? functions.includes(statement.name?.text ?? '') : ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => variables.includes(declaration.name.getText(source))))
  .map(statement => statement.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });

function setup(windowIds: string[] | null = ['22']) {
  const sources = [
    { sourceId: 'screen', kind: 'monitor' as const, title: '屏幕', width: 1920, height: 1080, primary: true },
    { sourceId: 'other', kind: 'window' as const, windowId: '11', title: '自定义游戏名', width: 800, height: 600, primary: false },
    { sourceId: 'game', kind: 'window' as const, windowId: '22', title: '原始窗口标题', width: 800, height: 600, primary: false },
  ];
  const chooser = createNativeVideoSourceSelection([]);
  const state = {
    computed, desktop: { listNativeVideoSources: vi.fn(async () => ({ discoveryId: 'discovery', sources })), reportCapturePickerTiming: vi.fn() },
    document: { hidden: false }, performance: { now: () => 0 }, console, nextTick: async () => {},
    nativeSourceRefresh: undefined, nativeSourceChooserGeneration: 1, nativeSourceChooser: chooser,
    nativeSourceChooserOpenedAt: 0, currentNativeDiscoveryId: '',
    captureRequest: ref<{ sources: typeof chooser.options } | null>({ sources: [] }),
    captureGameWindowIds: ref(windowIds), captureSourceType: ref('window'), selectedCaptureSourceId: ref(''),
    captureSourceNotice: ref(''), nativeSourceLoading: ref(true), nativeSourceError: ref(''),
    currentActivity: ref<DetectedActivity | null>({ type: 'GAME', name: '自定义游戏名', startedAt: '2026-11-08T00:00:00Z', windowIds: windowIds ?? [] }),
    lastNativeSelection: { discoveryId: 'discovery', sourceId: 'other' }, loadNativeSourceThumbnails: vi.fn(),
    connected: ref(true), screenShareLimitReached: ref(false), requestedGameWindowIds: null as string[] | null,
    Track: { Source: { ScreenShare: 'screen_share' } },
    rtc: reactive({ screenShareActive: false, busySources: [] as string[], screenShareQualityBusy: false, screenShareSourceBusy: false,
      toggleMedia: vi.fn(async () => {}), changeScreenShareSource: vi.fn(async () => {}), setMicrophoneProcessing: vi.fn() }),
    recording: { withSourceChange: vi.fn(async (callback: (before: undefined) => Promise<void>) => callback(undefined)) },
    audioShortcuts: { bindings: { pushToTalk: '' }, setVoiceMode: vi.fn() }, openSettings: vi.fn(),
    audioPreferences: { setProcessing: vi.fn(() => true), processing: { noiseSuppression: true } },
  };
  const app = runInNewContext(`${compiled}\n({ ${functions.join(', ')}, captureSources, currentGame, gameShareBusy })`, state) as {
    refreshNativeSources: (generation: number, selection: typeof chooser) => Promise<void>;
    shareCurrentGame: () => Promise<void>;
    updateVoiceMode: (mode: string, opener: unknown) => void;
    updateMicrophoneProcessing: (enabled: boolean) => void;
    captureSources: { value: typeof chooser.options };
    currentGame: { value: DetectedActivity | null };
  };
  return { app, state, sources, refresh: () => app.refreshNativeSources(1, chooser) };
}

it('按游戏窗口身份预选并置顶，忽略相同显示名称与上次选择，不启动采集', async () => {
  const f = setup();
  await f.refresh();
  expect(f.state.selectedCaptureSourceId.value).toBe('game');
  expect(f.app.captureSources.value.map(source => source.id)).toEqual(['game', 'other']);
  expect(f.state.rtc.toggleMedia).not.toHaveBeenCalled();
  expect(f.state.captureSourceNotice.value).toBe('');
});

it.each([[], ['11', '22'], ['99']].map(ids => [ids]))('未唯一匹配 %j 时必须手选，不恢复旧窗口或桌面', async windowIds => {
  const f = setup(windowIds);
  await f.refresh();
  expect(f.state.selectedCaptureSourceId.value).toBe('');
  expect(f.state.captureSourceNotice.value).not.toBe('');
});

it('普通入口仍恢复上次选择，手动选择不被刷新抢回，目标消失则清除选择', async () => {
  const normal = setup(null);
  await normal.refresh();
  expect(normal.state.selectedCaptureSourceId.value).toBe('other');
  const f = setup();
  await f.refresh();
  f.state.selectedCaptureSourceId.value = 'other';
  await f.refresh();
  expect(f.state.selectedCaptureSourceId.value).toBe('other');
  f.sources.splice(1, 1);
  await f.refresh();
  expect(f.state.selectedCaptureSourceId.value).toBe('');
});

it('迟到枚举不改新选择器，游戏已切换时不再预选旧窗口', async () => {
  const f = setup();
  f.state.currentActivity.value = null;
  await f.refresh();
  expect(f.state.selectedCaptureSourceId.value).toBe('');
  const stale = setup();
  stale.state.desktop.listNativeVideoSources.mockImplementation(async () => {
    stale.state.nativeSourceChooserGeneration++;
    return { discoveryId: 'discovery', sources: stale.sources };
  });
  await stale.refresh();
  expect(stale.state.captureRequest.value?.sources).toEqual([]);
});

it('游戏快捷入口沿用开始或更改来源流程，忙碌、未入房和音乐不触发', async () => {
  const f = setup();
  f.state.captureRequest.value = null;
  await f.app.shareCurrentGame();
  expect(f.state.rtc.toggleMedia).toHaveBeenCalledWith('screen_share');
  expect(f.state.requestedGameWindowIds).toBeNull();
  f.state.rtc.screenShareActive = true;
  await f.app.shareCurrentGame();
  expect(f.state.recording.withSourceChange).toHaveBeenCalledOnce();
  expect(f.state.rtc.changeScreenShareSource).toHaveBeenCalledOnce();
  f.state.rtc.toggleMedia.mockClear();
  f.state.rtc.screenShareActive = false;
  f.state.connected.value = false;
  await f.app.shareCurrentGame();
  f.state.connected.value = true;
  f.state.rtc.busySources = ['screen_share'];
  await f.app.shareCurrentGame();
  f.state.rtc.busySources = [];
  f.state.currentActivity.value = { type: 'MUSIC', name: '歌曲', startedAt: '' };
  await f.app.shareCurrentGame();
  expect(f.app.currentGame.value).toBeNull();
  expect(f.state.rtc.toggleMedia).not.toHaveBeenCalled();
});

it('未绑定按键先进入快捷键设置，声音处理复用全部设置与现有实时更新', () => {
  const f = setup();
  const opener = {};
  f.app.updateVoiceMode('pushToTalk', opener);
  expect(f.state.openSettings).toHaveBeenCalledWith('shortcuts', opener);
  expect(f.state.audioShortcuts.setVoiceMode).not.toHaveBeenCalled();
  f.state.audioShortcuts.bindings.pushToTalk = 'F2';
  f.app.updateVoiceMode('pushToTalk', opener);
  expect(f.state.audioShortcuts.setVoiceMode).toHaveBeenCalledWith('pushToTalk');
  f.app.updateMicrophoneProcessing(false);
  expect(f.state.audioPreferences.setProcessing).toHaveBeenCalledWith({ echoCancellation: false, noiseSuppression: false,
    autoGainControl: false, voiceEnhancement: false });
  expect(f.state.rtc.setMicrophoneProcessing).toHaveBeenCalledWith(f.state.audioPreferences.processing);
});
