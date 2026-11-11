import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScreenShareSelection } from './useScreenShareSelection';
import type { NativeScreenAudioMode } from './nativeScreenAudioMode';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { for (let step = 0; step < 8; step++) await nextTick(); };
const source = (sourceId: string, kind: 'window' | 'monitor' = 'window'): NativeVideoSource =>
  ({ sourceId, kind, title: sourceId, width: 640, height: 480, primary: false });

it('慢窗口不阻挡快窗口，图像加载后才统计首图和可见覆盖率，取消保留缺图数量', async () => {
  const f = setup();
  f.desktop.listNativeVideoSources.mockResolvedValue({ revision: 1, discoveryId: 'helper', sources: [source('slow'), source('fast')] });
  let finish!: (value: { sourceId: string; thumbnail: string }[]) => void;
  f.desktop.getNativeVideoSourceThumbnails.mockImplementation(async requested => requested[0]?.sourceId === 'slow'
    ? new Promise(resolve => { finish = resolve; }) : [{ sourceId: 'fast', thumbnail: 'preview' }]);
  f.container.value = { getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    querySelectorAll: () => ['slow', 'fast'].map(id => ({ dataset: { sourceId: id },
      getBoundingClientRect: () => ({ top: 10, bottom: 100 }) })) } as unknown as HTMLElement;
  const pending = f.open(); await flush();
  expect(f.state.captureRequest.value?.sources.find(source => source.id === 'fast')?.thumbnail).toBe('preview');
  expect(f.desktop.reportCapturePickerTiming.mock.calls.some(call => call[0] === 'screenPickerPreviewReady')).toBe(false);
  f.app.reportRenderedPreviews('fast');
  expect(f.desktop.reportCapturePickerTiming).toHaveBeenCalledWith('screenPickerPreviewReady', expect.any(Number),
    expect.objectContaining({ sourceCount: 2, readyCount: 1 }));
  expect(f.desktop.reportCapturePickerTiming.mock.calls.some(call => call[0] === 'screenPickerVisibleReady')).toBe(false);
  f.app.chooseCaptureSource('fast');
  expect(f.desktop.reportCapturePickerTiming).toHaveBeenCalledWith('screenPickerSelectionReady', expect.any(Number), expect.any(Object));
  f.app.selectCaptureSource(null); await pending;
  expect(f.desktop.reportCapturePickerTiming).toHaveBeenCalledWith('screenPickerClosed', expect.any(Number),
    expect.objectContaining({ sourceCount: 2, readyCount: 1, confirmed: false }));
  finish([{ sourceId: 'slow', thumbnail: 'late' }]); await flush();
  expect(f.state.captureRequest.value).toBeNull();
});

function setup(mode: NativeScreenAudioMode = 'process', configure?: (stored: Map<string, string>, getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>) => void) {
  const stored = new Map([['lycansync.screen-share-quality', JSON.stringify({ quality: 'custom', customQuality: { resolution: 1440, fps: 120 } })]]);
  const setItem = vi.fn((key: string, value: string) => { stored.set(key, value); });
  const getItem = vi.fn((key: string) => stored.get(key) ?? null);
  configure?.(stored, getItem);
  vi.stubGlobal('localStorage', { getItem, setItem });
  vi.stubGlobal('document', { hidden: false });
  const viewerNotice = ref('');
  const room = ref<object | null>({});
  const activity = ref<DetectedActivity | null>(null);
  const sharing = ref(false);
  const container = ref<HTMLElement>();
  const desktop = {
    listNativeVideoSources: vi.fn(async () => ({ revision: 1, discoveryId: 'helper', sources: [source('window:test')] })),
    getNativeVideoSourceThumbnails: vi.fn(async (_sources: NativeVideoSource[]): Promise<{ sourceId: string; thumbnail: string }[]> => []),
    prepareNativeVideoSource: vi.fn(async (_sourceId: string | null): Promise<{ prepared: boolean; followGame?: 'league' }> => ({ prepared: true })),
    reportCapturePickerTiming: vi.fn(), getCurrentActivity: vi.fn(async () => activity.value),
  };
  const scope = effectScope(); scopes.push(scope);
  const app = scope.run(() => useScreenShareSelection({ desktop, notice: viewerNotice,
    sourcesElement: () => container.value, room: () => room.value, sharing: () => sharing.value, activity: () => activity.value }))!;
  const state = { ...app, viewerNotice };
  const capability = mode === 'process' ? { available: true, reason: 'windowsApplicationLoopbackProcessTree' }
    : mode === 'systemMix' ? { available: true, reason: 'windowsSystemMixLoopback' } : { available: false, reason: 'unsupported' };
  const open = () => app.requestNativeScreenSource(Promise.resolve({ screenShareAudioCapture: capability }));
  return { app, state, stored, getItem, setItem, open, desktop, scope, container, room, sharing, activity };
}

it('创建模块时恢复画质和来源分类，取消后不写入偏好', async () => {
  const f = setup('process', stored => { stored.set('lycansync.screen-share-quality', 'highFrameRate'); stored.set('lycansync.capture-source-type', 'screen'); });
  expect(f.state.captureQuality.value).toBe('highFrameRate');
  const pending = f.open();
  expect(f.state.captureSourceType.value).toBe('screen');
  f.app.selectCaptureSource(null);
  expect(await pending).toBeNull();
  expect(f.setItem).not.toHaveBeenCalled();
});

it.each(['lycansync.screen-share-quality', 'lycansync.capture-source-type'])('%s 不可读时保留完整默认值并明确提示', key => {
  const f = setup('process', (_, getItem) => { getItem.mockImplementation(name => { if (name === key) throw new Error('denied'); return 'highFrameRate'; }); });
  expect(f.state.captureQuality.value).toBe('standard');
  expect(f.state.viewerNotice.value).toContain('无法读取上次的共享设置');
  expect(f.setItem).not.toHaveBeenCalled();
});

it('关闭重开等待旧枚举结束，迟到来源不覆盖新选择器', async () => {
  const f = setup();
  let finish!: (value: Awaited<ReturnType<typeof f.desktop.listNativeVideoSources>>) => void;
  f.desktop.listNativeVideoSources.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const first = f.open(), second = f.open();
  expect(await first).toBeNull();
  expect(f.desktop.listNativeVideoSources).toHaveBeenCalledTimes(1);
  finish({ revision: 1, discoveryId: 'old', sources: [source('old-window')] });
  await flush();
  expect(f.desktop.listNativeVideoSources).toHaveBeenCalledTimes(2);
  expect(f.state.captureRequest.value?.sources.map(item => item.id)).toEqual(['window:test']);
  f.app.selectCaptureSource(null); await second;
});

it('两个分类可独立出图，关闭后迟到的缩略图不进入新选择器', async () => {
  const f = setup();
  f.desktop.listNativeVideoSources.mockResolvedValue({ revision: 1, discoveryId: 'helper', sources: [source('window:test'), source('monitor:test', 'monitor')] });
  let finishWindow!: (value: { sourceId: string; thumbnail: string }[]) => void;
  f.desktop.getNativeVideoSourceThumbnails.mockImplementation(async requested => requested[0]?.kind === 'window'
    ? new Promise(resolve => { finishWindow = resolve; }) : [{ sourceId: 'monitor:test', thumbnail: 'screen-preview' }]);
  f.container.value = { getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    querySelectorAll: () => [{ dataset: { sourceId: f.state.captureSourceType.value === 'window' ? 'window:test' : 'monitor:test' },
      getBoundingClientRect: () => ({ top: 10, bottom: 100 }) }] } as unknown as HTMLElement;
  const first = f.open(); await flush();
  f.state.captureSourceType.value = 'screen'; await flush();
  expect(f.state.captureRequest.value?.sources.find(item => item.id === 'monitor:test')?.thumbnail).toBe('screen-preview');
  f.app.selectCaptureSource(null); await first;
  f.container.value = undefined;
  const second = f.open(); await flush();
  finishWindow([{ sourceId: 'window:test', thumbnail: 'old-preview' }]); await flush();
  expect(f.state.captureRequest.value?.sources.every(item => !item.thumbnail)).toBe(true);
  f.app.selectCaptureSource(null); await second;
});

it('A→B→A 不接受第一次 A 的迟到准备结果，销毁后也不更新跟随状态', async () => {
  const f = setup();
  const pending: ((value: { prepared: boolean; followGame?: 'league' }) => void)[] = [];
  f.desktop.prepareNativeVideoSource.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  for (const id of ['A', 'B', 'A']) { f.state.selectedCaptureSourceId.value = id; await nextTick(); }
  pending[0]!({ prepared: true, followGame: 'league' }); await flush();
  expect(f.state.captureFollowGameAvailable.value).toBe(false);
  f.scope.stop();
  pending[2]!({ prepared: true, followGame: 'league' }); await flush();
  expect(f.state.captureFollowGameAvailable.value).toBe(false);
  pending[1]!({ prepared: true });
});

it('准备失败保留选择，清空选择撤销准备，不启动采集', async () => {
  const f = setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  f.desktop.prepareNativeVideoSource.mockRejectedValueOnce(new Error('expired'));
  f.state.selectedCaptureSourceId.value = 'window:test'; await flush();
  expect(f.state.selectedCaptureSourceId.value).toBe('window:test');
  f.state.selectedCaptureSourceId.value = ''; await flush();
  expect(f.desktop.prepareNativeVideoSource.mock.calls).toEqual([['window:test'], [null]]);
});

it('销毁选择器结束等待，迟到能力及来源不再写入，并停止刷新', async () => {
  const f = setup();
  let resolve!: (value: Record<string, { available: boolean; reason: string }>) => void;
  const waiting = f.app.requestNativeScreenSource(new Promise(done => { resolve = done; }));
  f.scope.stop(); resolve({}); await flush();
  expect(await waiting).toBeNull();
  expect(f.state.captureRequest.value).toBeNull();
  expect(f.state.captureAudioCapabilityReady.value).toBe(false);
});

it('预加载只取同类前六项并优先游戏窗口，切房后的结果不继续取图', async () => {
  const f = setup();
  f.activity.value = { type: 'GAME', name: '游戏', startedAt: 'now', windowIds: ['8'] };
  f.desktop.listNativeVideoSources.mockResolvedValue({ revision: 1, discoveryId: 'helper', sources: Array.from({ length: 9 }, (_, i) => ({ ...source(String(i)), windowId: String(i) })) });
  await f.app.preloadCaptureSources();
  expect(f.desktop.getNativeVideoSourceThumbnails.mock.calls[0]![0].map(item => item.sourceId)).toEqual(['8', '0', '1', '2', '3', '4']);
  await f.app.preloadCaptureSources();
  expect(f.desktop.listNativeVideoSources).toHaveBeenCalledTimes(1);
  const second = setup();
  second.desktop.listNativeVideoSources.mockImplementation(async () => { second.room.value = {}; return { revision: 1, discoveryId: 'helper', sources: [source('test')] }; });
  await second.app.preloadCaptureSources();
  expect(second.desktop.getNativeVideoSourceThumbnails).not.toHaveBeenCalled();
});


it('高级采集设置只用于本次确认，不保存长期边框授权', async () => {
  const f = setup();
  const pending = f.open(); await flush();
  const settings = { hideCursor: true, hideBorder: true, windowMethod: 'game' as const, followGame: 'league' as const };
  f.app.selectCaptureSource('window:test', settings);
  expect((await pending)?.captureSettings).toEqual(settings);
  expect(f.setItem.mock.calls.some(([key]) => key === 'lycansync.screen-share')).toBe(false);
});

it('按上次来源分类预取，合并并发意图；不打开选择器或开始共享', async () => {
  const f = setup('process', stored => stored.set('lycansync.capture-source-type', 'screen'));
  const monitor = source('screen', 'monitor');
  f.desktop.listNativeVideoSources.mockResolvedValue({ revision: 1, discoveryId: 'helper', sources: [source('window'), monitor] });
  await Promise.all([f.app.preloadCaptureSources(), f.app.preloadCaptureSources()]);
  expect(f.desktop.listNativeVideoSources).toHaveBeenCalledTimes(1);
  expect(f.desktop.getNativeVideoSourceThumbnails).toHaveBeenCalledWith([monitor]);
  expect(f.state.captureRequest.value).toBeNull();
  expect(f.sharing.value).toBe(false);
});

it.each(['hidden', 'disconnected', 'disposed', 'picker', 'sharing'])('%s 时不预取', async reason => {
  const f = setup();
  if (reason === 'hidden') vi.stubGlobal('document', { hidden: true });
  if (reason === 'disconnected') f.room.value = null;
  if (reason === 'disposed') f.scope.stop();
  if (reason === 'picker') {
    void f.open(); await flush();
    f.desktop.listNativeVideoSources.mockClear();
  }
  if (reason === 'sharing') f.sharing.value = true;
  await f.app.preloadCaptureSources();
  expect(f.desktop.listNativeVideoSources).not.toHaveBeenCalled();
});

describe('选择草稿与偏好提交边界', () => {
  it.each(['cancel', 'confirm', 'storageFailure'] as const)('手动码率选择 %s 遵守草稿及有效确认的保存边界', async (action) => {
    const { app, state, open, setItem, stored } = setup();
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
      if (action === 'confirm') expect(JSON.parse(stored.get('lycansync.screen-share-quality')!).customQuality.bitrateMbps).toBe(6);
      else {
        expect(JSON.parse(stored.get('lycansync.screen-share-quality')!).customQuality).toEqual({ resolution: 1440, fps: 120 });
        expect(state.viewerNotice.value).toContain('未能保存');
      }
    }
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
      const { app, state, stored, setItem, open } = setup(mode);
      const waiting = open();
      await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
      app.updateCaptureShareAudio(enabled);
      expect(setItem).not.toHaveBeenCalled();
      app.selectCaptureSource('window:test');
      expect(await waiting).toEqual({ sourceId: 'window:test', shareAudio: enabled, quality: 'custom',
        customQuality: { resolution: 1440, fps: 120 } });
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
    const { app, state, setItem, open } = setup();
    const waiting = open();
    await vi.waitFor(() => expect(state.captureAudioCapabilityReady.value).toBe(true));
    setItem.mockImplementation((key) => {
      if (failure === 'all' || key.includes('screen-share-audio')) throw new Error('storage denied');
    });
    app.updateCaptureShareAudio(true);
    expect(() => app.selectCaptureSource('window:test')).not.toThrow();
    expect(await waiting).toEqual({ sourceId: 'window:test', shareAudio: true, quality: 'custom',
      customQuality: { resolution: 1440, fps: 120 } });
    expect(state.captureRequest.value).toBeNull();
    expect(state.viewerNotice.value).toContain('未能保存');
    expect(state.viewerNotice.value).not.toContain('已生效');
  });
});
