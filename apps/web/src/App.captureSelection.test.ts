import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { ref } from 'vue';
import type { ScreenSharePreferences } from './settings/screenSharePreferences';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeVideoSourceSelection } from './components/nativeVideoSourceSelection';
import { canSelectNativeSource, readScreenShareAudioPreference, resolveNativeScreenAudioCapability,
  saveScreenShareAudioPreference, shouldShareAudioInNativeSelection, type NativeScreenAudioMode } from './rtc/nativeScreenAudioMode';
import { readScreenShareQuality, saveScreenShareQuality, type CustomScreenShareQuality, type ScreenShareQualityId } from './rtc/screenShareQuality';

type Selection = { sourceId: string; shareAudio: boolean; quality?: ScreenShareQualityId;
  customQuality?: CustomScreenShareQuality; captureSettings?: ScreenSharePreferences };
const callbackNames = ['restoreCapturePreferences', 'stopNativeSourceRefresh', 'selectCaptureSource', 'saveCapturePreferences',
  'updateCaptureShareAudio', 'requestNativeScreenSource', 'changeScreenShareAudio', 'changeScreenShareQuality'];
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
  const getItem = vi.fn((key: string) => stored.get(key) ?? null);
  const storage = { getItem, setItem };
  vi.stubGlobal('localStorage', storage);
  const state = {
    captureRequest: ref<{ sources: Array<{ id: string; type: 'window' | 'screen' }>;
      quality: ScreenShareQualityId; customQuality: { resolution: number; fps: number } } | null>(null),
    captureSourceType: ref('window'), captureQuality: ref<ScreenShareQualityId>('custom'),
    captureCustomQuality: ref<CustomScreenShareQuality>({ resolution: 1440, fps: 120 }),
    captureAudioCapabilityReady: ref(false), captureAudioCapabilityFailed: ref(false),
    captureAudioMode: ref<NativeScreenAudioMode>('unavailable'), captureShareAudio: ref(false),
    selectedCaptureSourceId: ref(''), captureSourceNotice: ref(''), viewerNotice: ref(''),
    nativeSourceLoading: ref(false), nativeSourceError: ref(''),
  };
  const rtc = { currentScreenShareAudioMode: mode, setScreenShareAudioEnabled: vi.fn(async () => true),
    currentCustomScreenShareQuality: { resolution: 1080, fps: 60 } as CustomScreenShareQuality, setScreenShareQuality: vi.fn(async () => true) };
  const localParticipant = ref({ isScreenShareEnabled: true });
  const sandbox = {
    ...state, localStorage: storage, rtc, localParticipant,
    nativeSourceChooser: undefined, nativeSourceChooserGeneration: 0, nativeSourceRefreshTimer: undefined,
    lastCaptureSourceType: 'window', lastNativeSelection: undefined, currentNativeDiscoveryId: '',
    clearTimeout, canSelectNativeSource, readScreenShareQuality, saveScreenShareQuality, readScreenShareAudioPreference,
    saveScreenShareAudioPreference, resolveNativeScreenAudioCapability, shouldShareAudioInNativeSelection,
    createNativeVideoSourceSelection: () => {
      const chooser = createNativeVideoSourceSelection([]);
      return { ...chooser, get options() { return chooser.options; },
        finish(selection: Selection | null) { order.push('finish'); chooser.finish(selection); } };
    },
    scheduleNativeSourceRefresh: async (_generation: number, chooser: ReturnType<typeof createNativeVideoSourceSelection>) => {
      chooser.replaceSources([{ sourceId: 'window:test', kind: 'window', title: '测试窗口', width: 320,
        height: 180, primary: false }]);
      state.captureRequest.value = { ...state.captureRequest.value!, sources: chooser.options };
      state.nativeSourceLoading.value = false;
    },
  };
  const app = runInNewContext(`${compiled}\n({ ${callbackNames.join(', ')} })`, sandbox) as {
    restoreCapturePreferences(): void;
    requestNativeScreenSource(capabilities: Promise<Record<string, { available: boolean; reason: string }>>): Promise<Selection | null>;
    updateCaptureShareAudio(enabled: boolean): void;
    selectCaptureSource(sourceId: string | null, settings?: ScreenSharePreferences): void;
    changeScreenShareAudio(enabled: boolean): Promise<void>;
    changeScreenShareQuality(quality: ScreenShareQualityId, custom?: CustomScreenShareQuality): Promise<void>;
  };
  const capability = mode === 'process' ? { available: true, reason: 'windowsApplicationLoopbackProcessTree' }
    : mode === 'systemMix' ? { available: true, reason: 'windowsSystemMixLoopback' }
      : { available: false, reason: 'unsupported' };
  const open = () => app.requestNativeScreenSource(Promise.resolve({ screenShareAudioCapture: capability }));
  return { app, state, stored, getItem, setItem, order, open, rtc };
}

afterEach(() => vi.unstubAllGlobals());

describe('App 启动恢复共享偏好', () => {
  it('高级采集选择只交给本次共享，不落盘为长期边框授权', async () => {
    const { app, state, stored, open } = setup();
    const waiting = open();
    await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
    const settings: ScreenSharePreferences = { hideCursor: true, hideBorder: false, windowMethod: 'wgc' };
    app.selectCaptureSource('window:test', settings);
    expect((await waiting)?.captureSettings).toEqual(settings);
    expect(stored.has('lycansync.screen-share')).toBe(false);
  });
  it('沿用已保存的画质和屏幕来源', async () => {
    const { app, state, stored, open } = setup();
    stored.set('lycansync.screen-share-quality', 'highFrameRate');
    stored.set('lycansync.capture-source-type', 'screen');
    app.restoreCapturePreferences();
    expect(state.captureQuality.value).toBe('highFrameRate');
    expect(state.viewerNotice.value).toBe('');
    const waiting = open();
    expect(state.captureSourceType.value).toBe('screen');
    app.selectCaptureSource(null);
    await waiting;
  });

  it.each(['lycansync.screen-share-quality', 'lycansync.capture-source-type'])(
    '%s 读取失败不抛出、不写入，保留完整默认选择并提示', async (failedKey) => {
      const { app, state, stored, getItem, setItem, open } = setup();
      state.captureQuality.value = 'standard';
      stored.set('lycansync.screen-share-quality', 'highFrameRate');
      getItem.mockImplementation((key) => {
        if (key === failedKey) throw new Error('storage denied');
        return stored.get(key) ?? null;
      });
      expect(() => app.restoreCapturePreferences()).not.toThrow();
      expect(state.captureQuality.value).toBe('standard');
      expect(state.viewerNotice.value).toContain('无法读取本机共享偏好');
      expect(setItem).not.toHaveBeenCalled();
      const waiting = open();
      expect(state.captureSourceType.value).toBe('window');
      app.selectCaptureSource(null);
      await waiting;
    },
  );
});

describe('App 共享选择的音频偏好提交顺序', () => {
  it.each(['cancel', 'confirm', 'storageFailure'] as const)('手动码率选择 %s 遵守草稿及有效确认的保存边界', async (action) => {
    const { app, state, open, setItem, stored, order } = setup();
    const waiting = open();
    await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
    state.captureCustomQuality.value = { resolution: 1440, fps: 120, bitrateMbps: 6 };
    if (action === 'storageFailure') setItem.mockImplementation(() => { throw new Error('storage denied'); });
    app.selectCaptureSource(action === 'cancel' ? null : 'window:test');
    const selection = await waiting;
    if (action === 'cancel') {
      expect(selection).toBeNull();
      expect(state.captureCustomQuality.value).toEqual({ resolution: 1440, fps: 120 });
      expect(setItem).not.toHaveBeenCalled();
    } else {
      expect(selection?.customQuality).toEqual({ resolution: 1440, fps: 120, bitrateMbps: 6 });
      expect(order[0]).toBe('finish');
      if (action === 'confirm') expect(JSON.parse(stored.get('lycansync.screen-share-quality')!).customQuality.bitrateMbps).toBe(6);
      else {
        expect(stored.has('lycansync.screen-share-quality')).toBe(false);
        expect(state.viewerNotice.value).toContain('无法保存');
      }
    }
  });

  it.each([true, false])('共享中手动码率只在应用成功 %s 后保存', async (success) => {
    const { app, rtc, state, setItem } = setup();
    rtc.setScreenShareQuality.mockResolvedValueOnce(success);
    await app.changeScreenShareQuality('custom', { resolution: 1080, fps: 60, bitrateMbps: 6 });
    expect(setItem).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(state.captureCustomQuality.value.bitrateMbps).toBe(success ? 6 : undefined);
  });

  it('取消自定义草稿立即恢复原值，连续打开也不继承已取消值', async () => {
    const { app, state, open, setItem } = setup();
    const waiting = open();
    state.captureCustomQuality.value = { resolution: 720, fps: 30 };
    state.captureQuality.value = 'economy';
    const nextWaiting = open();
    expect(await waiting).toBeNull();
    expect(state.captureQuality.value).toBe('custom');
    expect(state.captureCustomQuality.value).toEqual({ resolution: 1440, fps: 120 });
    app.selectCaptureSource(null);
    await nextWaiting;
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([true, false])('共享中自定义只有实际应用成功 %s 才更新偏好，默认读取当前共享而非选择器草稿', async (success) => {
    const { app, state, rtc, setItem } = setup();
    let complete!: (value: boolean) => void;
    rtc.setScreenShareQuality.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const changing = app.changeScreenShareQuality('custom');
    expect(rtc.setScreenShareQuality).toHaveBeenCalledWith('custom', { resolution: 1080, fps: 60 });
    expect(setItem).not.toHaveBeenCalled();
    complete(success);
    await changing;
    expect(setItem).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(state.captureCustomQuality.value).toEqual(success ? { resolution: 1080, fps: 60 } : { resolution: 1440, fps: 120 });
  });

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
      expect(await waiting).toEqual({ sourceId: 'window:test', shareAudio: enabled, quality: 'custom',
        customQuality: { resolution: 1440, fps: 120 } });
      expect(order[0]).toBe('finish');
      expect(stored.get(`lycansync.screen-share-audio.${mode}`)).toBe(String(enabled));
      expect(stored.has(`lycansync.screen-share-audio.${mode === 'process' ? 'systemMix' : 'process'}`)).toBe(false);
      expect(JSON.parse(stored.get('lycansync.screen-share-quality')!)).toEqual({ quality: 'custom',
        customQuality: { resolution: 1440, fps: 120 } });
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
    expect(await waiting).toEqual({ sourceId: 'window:test', shareAudio: true, quality: 'custom',
      customQuality: { resolution: 1440, fps: 120 } });
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
