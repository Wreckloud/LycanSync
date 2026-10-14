import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeVideoSourceSelection } from './components/nativeVideoSourceSelection';
import { canSelectNativeSource, readScreenShareAudioPreference, resolveNativeScreenAudioCapability,
  saveScreenShareAudioPreference, shouldShareAudioInNativeSelection, type NativeScreenAudioMode } from './rtc/nativeScreenAudioMode';
import { saveScreenShareQuality, type ScreenShareQualityId } from './rtc/screenShareQuality';

type Selection = { sourceId: string; shareAudio: boolean; quality?: ScreenShareQualityId };
const callbackNames = ['stopNativeSourceRefresh', 'selectCaptureSource', 'saveCapturePreferences',
  'updateCaptureShareAudio', 'requestNativeScreenSource', 'changeScreenShareAudio'];
const script = parse(readFileSync(new URL('./App.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const sourceFile = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
// 执行 App 的真实回调而非复制选择器逻辑；只注入来源枚举、存储和 RTC 边界，不启动页面或设备。
const callbacks = callbackNames.map((name) => {
  const declaration = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!declaration) throw new Error(`App 回调不存在：${name}`);
  return declaration.getText(sourceFile);
}).join('\n');
const compiled = ts.transpile(callbacks, { target: ts.ScriptTarget.ES2022 });

function setup(mode: NativeScreenAudioMode = 'process') {
  const stored = new Map<string, string>();
  const order: string[] = [];
  const setItem = vi.fn((key: string, value: string) => { order.push(key); stored.set(key, value); });
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem };
  vi.stubGlobal('localStorage', storage);
  const state = {
    captureRequest: ref<{ sources: Array<{ id: string; type: 'window' | 'screen' }> } | null>(null),
    captureSourceType: ref('window'), captureQuality: ref<ScreenShareQualityId>('text'),
    captureAudioCapabilityReady: ref(false), captureAudioCapabilityFailed: ref(false),
    captureAudioMode: ref<NativeScreenAudioMode>('unavailable'), captureShareAudio: ref(false),
    selectedCaptureSourceId: ref(''), captureSourceNotice: ref(''), viewerNotice: ref(''),
    nativeSourceLoading: ref(false), nativeSourceError: ref(''),
  };
  const rtc = { currentScreenShareAudioMode: mode, setScreenShareAudioEnabled: vi.fn(async () => true) };
  const sandbox = {
    ...state, localStorage: storage, rtc,
    nativeSourceChooser: undefined, nativeSourceChooserGeneration: 0, nativeSourceRefreshTimer: undefined,
    lastCaptureSourceType: 'window', lastNativeSelection: undefined, currentNativeDiscoveryId: '',
    clearTimeout, canSelectNativeSource, saveScreenShareQuality, readScreenShareAudioPreference,
    saveScreenShareAudioPreference, resolveNativeScreenAudioCapability, shouldShareAudioInNativeSelection,
    createNativeVideoSourceSelection: () => {
      const chooser = createNativeVideoSourceSelection([]);
      return { ...chooser, get options() { return chooser.options; },
        finish(selection: Selection | null) { order.push('finish'); chooser.finish(selection); } };
    },
    scheduleNativeSourceRefresh: async (_generation: number, chooser: ReturnType<typeof createNativeVideoSourceSelection>) => {
      chooser.replaceSources([{ sourceId: 'window:test', kind: 'window', title: '测试窗口', width: 320,
        height: 180, primary: false }]);
      state.captureRequest.value = { sources: chooser.options };
      state.nativeSourceLoading.value = false;
    },
  };
  const app = runInNewContext(`${compiled}\n({ ${callbackNames.join(', ')} })`, sandbox) as {
    requestNativeScreenSource(capabilities: Promise<Record<string, { available: boolean; reason: string }>>): Promise<Selection | null>;
    updateCaptureShareAudio(enabled: boolean): void;
    selectCaptureSource(sourceId: string | null): void;
    changeScreenShareAudio(enabled: boolean): Promise<void>;
  };
  const capability = mode === 'process' ? { available: true, reason: 'windowsApplicationLoopbackProcessTree' }
    : mode === 'systemMix' ? { available: true, reason: 'windowsSystemMixLoopback' }
      : { available: false, reason: 'unsupported' };
  const open = () => app.requestNativeScreenSource(Promise.resolve({ screenShareAudioCapture: capability }));
  return { app, state, stored, setItem, order, open, rtc };
}

afterEach(() => vi.unstubAllGlobals());

describe('App 共享选择的音频偏好提交顺序', () => {
  it.each(['process', 'systemMix'] as const)('%s 勾选后取消不写入偏好', async (mode) => {
    const { app, state, setItem, open } = setup(mode);
    const waiting = open();
    await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
    app.updateCaptureShareAudio(true);
    expect(state.captureShareAudio.value).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    app.selectCaptureSource(null);
    expect(await waiting).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([['process', true], ['process', false], ['systemMix', true], ['systemMix', false]] as const)(
    '%s 声音 %s 有效确认先结束选择，再保存独立的声音、画质与来源偏好',
    async (mode, enabled) => {
      const { app, state, stored, setItem, order, open } = setup(mode);
      const waiting = open();
      await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
      app.updateCaptureShareAudio(enabled);
      expect(setItem).not.toHaveBeenCalled();
      app.selectCaptureSource('window:test');
      expect(await waiting).toEqual({ sourceId: 'window:test', shareAudio: enabled, quality: 'text' });
      expect(order[0]).toBe('finish');
      expect(stored.get(`lycansync.screen-share-audio.${mode}`)).toBe(String(enabled));
      expect(stored.has(`lycansync.screen-share-audio.${mode === 'process' ? 'systemMix' : 'process'}`)).toBe(false);
      expect(stored.get('lycansync.screen-share-quality')).toBe('text');
      expect(stored.get('lycansync.capture-source-type')).toBe('window');
    },
  );

  it.each(['empty', 'missing', 'sourceError', 'notReady'] as const)('%s 确认不结束等待、不写入', async (invalid) => {
    const { app, state, setItem, open } = setup();
    const waiting = open();
    await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
    app.updateCaptureShareAudio(false);
    if (invalid === 'sourceError') state.nativeSourceError.value = '来源读取失败';
    if (invalid === 'notReady') state.captureAudioCapabilityReady.value = false;
    app.selectCaptureSource(invalid === 'empty' ? '' : invalid === 'missing' ? 'window:gone' : 'window:test');
    expect(state.captureRequest.value).not.toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    app.selectCaptureSource(null);
    expect(await waiting).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('能力请求失败后确认不能保存，仍可取消结束等待', async () => {
    const { app, state, setItem } = setup();
    const waiting = app.requestNativeScreenSource(Promise.reject(new Error('capability failed')));
    await vi.waitFor(() => expect(state.captureAudioCapabilityFailed.value).toBe(true));
    app.updateCaptureShareAudio(true);
    app.selectCaptureSource('window:test');
    expect(setItem).not.toHaveBeenCalled();
    app.selectCaptureSource(null);
    expect(await waiting).toBeNull();
  });

  it('没有声音能力的有效画面选择不会覆盖已有声音偏好', async () => {
    const { app, state, stored, open } = setup('unavailable');
    stored.set('lycansync.screen-share-audio.process', 'true');
    const waiting = open();
    await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
    app.updateCaptureShareAudio(true);
    app.selectCaptureSource('window:test');
    expect((await waiting)?.shareAudio).toBe(false);
    expect(stored.get('lycansync.screen-share-audio.process')).toBe('true');
    expect(stored.has('lycansync.screen-share-audio.unavailable')).toBe(false);
    expect(state.viewerNotice.value).toBe('');
  });

  it.each(['all', 'audio'] as const)('%s 存储失败也返回选择，不宣称采集已生效', async (failure) => {
    const { app, state, setItem, order, open } = setup();
    const waiting = open();
    await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
    setItem.mockImplementation((key) => {
      order.push(key);
      if (failure === 'all' || key.includes('screen-share-audio')) throw new Error('storage denied');
    });
    app.updateCaptureShareAudio(true);
    expect(() => app.selectCaptureSource('window:test')).not.toThrow();
    expect(await waiting).toEqual({ sourceId: 'window:test', shareAudio: true, quality: 'text' });
    expect(state.captureRequest.value).toBeNull();
    expect(order[0]).toBe('finish');
    expect(state.viewerNotice.value).toContain('无法保存');
    expect(state.viewerNotice.value).not.toContain('已生效');
  });

  it.each([true, false])('共享中开关仅在 RTC 操作成功 %s 后保存', async (success) => {
    const { app, rtc, setItem } = setup('systemMix');
    let complete!: (success: boolean) => void;
    rtc.setScreenShareAudioEnabled.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const changing = app.changeScreenShareAudio(true);
    expect(rtc.setScreenShareAudioEnabled).toHaveBeenCalledWith(true);
    expect(setItem).not.toHaveBeenCalled();
    complete(success);
    await changing;
    if (success) expect(setItem).toHaveBeenCalledWith('lycansync.screen-share-audio.systemMix', 'true');
    else expect(setItem).not.toHaveBeenCalled();
  });
});
