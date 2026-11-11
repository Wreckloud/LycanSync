import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';
import { createNativeVideoSourceSelection, type NativeScreenSourceSelection } from '../components/nativeVideoSourceSelection';
import { DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY, readScreenShareQuality, saveScreenShareQuality,
  type CustomScreenShareQuality, type ScreenShareQualityId } from './screenShareQuality';
import { canSelectNativeSource, readScreenShareAudioPreference, saveScreenShareAudioPreference,
  resolveNativeScreenAudioCapability, shouldShareAudioInNativeSelection, type NativeScreenAudioMode } from './nativeScreenAudioMode';
import { readScreenSharePreferences, type ScreenSharePreferences } from '../settings/screenSharePreferences';

type SelectionDesktop = Pick<NonNullable<Window['lycanDesktop']>, 'listNativeVideoSources' | 'getNativeVideoSourceThumbnails'
  | 'prepareNativeVideoSource' | 'reportCapturePickerTiming' | 'getCurrentActivity'>;

interface ScreenShareSelectionOptions {
  desktop?: SelectionDesktop;
  sourcesElement(): HTMLElement | null | undefined;
  room(): object | null;
  sharing(): boolean;
  activity(): DetectedActivity | null;
  notice: Ref<string>;
}

// 只持有选窗草稿、静态预览与偏好；采集、发布和录制仍由各自会话负责。
export function useScreenShareSelection(options: ScreenShareSelectionOptions) {
  const { desktop, notice } = options;
  let disposed = false;
  const captureRequest = ref<{ sources: ReturnType<typeof createNativeVideoSourceSelection>['options'];
    quality: ScreenShareQualityId; customQuality: CustomScreenShareQuality } | null>(null);
  const captureSourceType = ref<'window' | 'screen'>('window');
  const captureQuality = ref<ScreenShareQualityId>('standard');
  const captureCustomQuality = ref<CustomScreenShareQuality>({ ...DEFAULT_CUSTOM_SCREEN_SHARE_QUALITY });
  const selectedCaptureSourceId = ref('');
  const captureFollowGameAvailable = ref(false);
  const captureSourceNotice = ref('');
  let lastCaptureSourceType: 'window' | 'screen' = 'window';
  restoreCapturePreferences();

  function restoreCapturePreferences() {
    try {
      const quality = readScreenShareQuality();
      const sourceType = localStorage.getItem('lycansync.capture-source-type') === 'screen' ? 'screen' : 'window';
      captureQuality.value = quality.quality;
      captureCustomQuality.value = quality.customQuality;
      lastCaptureSourceType = sourceType;
    } catch {
      // 偏好不可读不能阻止主界面启动；未读完之前不覆盖默认选择。
      notice.value = '无法读取上次的共享设置，暂用标准画质和窗口共享。';
    }
  }

  let lastNativeSelection: { discoveryId: string; sourceId: string } | undefined;
  let currentNativeDiscoveryId = '';
  const captureAudioCapabilityReady = ref(false);
  const captureAudioCapabilityFailed = ref(false);
  const captureAudioMode = ref<NativeScreenAudioMode>('unavailable');
  const captureShareAudio = ref(false);
  const NATIVE_SOURCE_REFRESH_INTERVAL_MS = 750;
  let nativeSourceChooser: ReturnType<typeof createNativeVideoSourceSelection> | undefined;
  const nativeSourceChooserGeneration = ref(0);
  let nativeSourceChooserOpenedAt = 0;
  let nativeSourcePreviewReported = false;
  let visiblePreviewReported = '';
  let selectedPreviewReported = '';
  let sourceSelectedAt = 0;
  const renderedPreviews = new Set<string>();
  let nativeSourceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let nativeSourceRefresh: { promise: Promise<void> } | undefined;
  const nativeThumbnailRefresh = new Map<'window' | 'screen', { generation: number; promise: Promise<void> }>();
  const nativeSourceLoading = ref(false);
  const nativeSourceError = ref('');
  const captureSources = computed(() => captureRequest.value?.sources
    .filter((source) => source.type === captureSourceType.value) ?? []);
  function stopNativeSourceRefresh() {
    // IPC 无法在页面侧取消；使本次选择失效，迟到结果不能改写下次打开的选择器。
    nativeSourceChooserGeneration.value++;
    if (nativeSourceRefreshTimer !== undefined) clearTimeout(nativeSourceRefreshTimer);
    nativeSourceRefreshTimer = undefined;
    nativeSourceLoading.value = false;
  }

  function updateNativeSourceOptions(generation: number, chooser: ReturnType<typeof createNativeVideoSourceSelection>) {
    if (generation !== nativeSourceChooserGeneration.value || !captureRequest.value) return;
    captureRequest.value = { ...captureRequest.value, sources: chooser.options };
  }

  async function loadNativeSourceThumbnails(
    generation: number,
    chooser: ReturnType<typeof createNativeVideoSourceSelection>,
  ) {
    const sourceType = captureSourceType.value;
    if (!desktop || nativeThumbnailRefresh.get(sourceType)?.generation === generation || document.hidden
        || generation !== nativeSourceChooserGeneration.value || nativeSourceChooser !== chooser) return;
    const container = options.sourcesElement();
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const visibleIds = new Set([...container.querySelectorAll<HTMLButtonElement>('[data-source-id]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      }).map((element) => element.dataset.sourceId!));
    const requested = chooser.sourcesNeedingThumbnails(Date.now(), visibleIds, selectedCaptureSourceId.value);
    if (!requested.length) return;
    const discoveryId = currentNativeDiscoveryId;
    // 窗口逐项交付，慢窗口不阻挡其他预览；主进程统一限制并发和子进程寿命。
    const batches = sourceType === 'window' ? requested.map(source => [source]) : [requested];
    const promise = Promise.all(batches.map(batch => desktop.getNativeVideoSourceThumbnails(batch).then((thumbnails) => {
      if (generation !== nativeSourceChooserGeneration.value || nativeSourceChooser !== chooser
          || currentNativeDiscoveryId !== discoveryId) return;
      chooser.applyThumbnails(batch, thumbnails);
      updateNativeSourceOptions(generation, chooser);
    }).catch((error) => {
      console.error('共享来源缩略图更新失败', error);
    }))).then(() => {});
    // 两个分类独立等待；旧选择器的结果仍由代次和来源身份隔离。
    nativeThumbnailRefresh.set(sourceType, { generation, promise });
    try { await promise; }
    finally { if (nativeThumbnailRefresh.get(sourceType)?.promise === promise) nativeThumbnailRefresh.delete(sourceType); }
  }

  async function refreshNativeSources(
    generation: number,
    chooser: ReturnType<typeof createNativeVideoSourceSelection>,
  ) {
    if (nativeSourceRefresh) await nativeSourceRefresh.promise;
    if (!desktop || document.hidden || generation !== nativeSourceChooserGeneration.value || nativeSourceRefresh) return;
    const promise = (async () => {
      try {
        const snapshot = await desktop.listNativeVideoSources();
        if (generation !== nativeSourceChooserGeneration.value || nativeSourceChooser !== chooser
            || !captureRequest.value) return;
        if (currentNativeDiscoveryId && currentNativeDiscoveryId !== snapshot.discoveryId) chooser.replaceSources([]);
        const options = chooser.replaceSources(snapshot.sources);
        const firstSnapshot = !currentNativeDiscoveryId;
        if (currentNativeDiscoveryId && currentNativeDiscoveryId !== snapshot.discoveryId) {
          // helper 重启后来源标识不再可信，不能按同名窗口恢复选中。
          selectedCaptureSourceId.value = '';
          captureSourceNotice.value = '共享来源已重新连接，请重新选择。';
        }
        currentNativeDiscoveryId = snapshot.discoveryId;
        if (firstSnapshot && lastNativeSelection?.discoveryId === snapshot.discoveryId
            && options.some((source) => source.id === lastNativeSelection?.sourceId && source.type === captureSourceType.value)) {
          selectedCaptureSourceId.value = lastNativeSelection.sourceId;
        }
        if (selectedCaptureSourceId.value && !options.some((source) => source.id === selectedCaptureSourceId.value)) {
          selectedCaptureSourceId.value = '';
          captureSourceNotice.value = '所选窗口或屏幕已不可用，请重新选择。';
        }
        captureRequest.value = { ...captureRequest.value!, sources: options };
        for (const id of renderedPreviews) {
          if (!options.some(source => source.id === id && source.thumbnail)) renderedPreviews.delete(id);
        }
        nativeSourceLoading.value = false;
        nativeSourceError.value = '';
        await nextTick();
        if (firstSnapshot && generation === nativeSourceChooserGeneration.value && nativeSourceChooser === chooser) {
          desktop?.reportCapturePickerTiming?.('screenPickerSourcesReady', performance.now() - nativeSourceChooserOpenedAt,
            { pickerId: generation, sourceCount: captureSources.value.length, readyCount: 0 });
        }
        void loadNativeSourceThumbnails(generation, chooser);
      } catch (error) {
        if (generation !== nativeSourceChooserGeneration.value || nativeSourceChooser !== chooser
            || !captureRequest.value) return;
        nativeSourceLoading.value = false;
        if (!nativeSourceError.value) console.error('共享来源读取失败', error);
        nativeSourceError.value = '无法读取共享来源，正在重试。';
      }
    })();
    nativeSourceRefresh = { promise };
    try { await promise; }
    finally {
      if (nativeSourceRefresh?.promise === promise) nativeSourceRefresh = undefined;
    }
  }

  async function scheduleNativeSourceRefresh(generation: number, chooser: ReturnType<typeof createNativeVideoSourceSelection>) {
    await refreshNativeSources(generation, chooser);
    if (generation !== nativeSourceChooserGeneration.value || nativeSourceChooser !== chooser) return;
    // 等本次枚举完成再计时，慢请求不会按固定频率不断积压。
    nativeSourceRefreshTimer = setTimeout(() => void scheduleNativeSourceRefresh(generation, chooser),
      NATIVE_SOURCE_REFRESH_INTERVAL_MS);
  }

  function refreshVisibleSourceThumbnails() {
    reportRenderedPreviews();
    if (nativeSourceChooser) void loadNativeSourceThumbnails(nativeSourceChooserGeneration.value, nativeSourceChooser);
  }

  function visiblePreviewCounts() {
    const container = options.sourcesElement();
    if (!container) return { sourceCount: 0, readyCount: 0, ids: [] as string[] };
    const bounds = container.getBoundingClientRect();
    const ids = [...container.querySelectorAll<HTMLButtonElement>('[data-source-id]')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }).map(element => element.dataset.sourceId!);
    return { sourceCount: ids.length, readyCount: ids.filter(id => renderedPreviews.has(id)).length, ids };
  }

  function reportRenderedPreviews(sourceId?: string) {
    if (!captureRequest.value || document.hidden) return;
    if (sourceId && captureSources.value.some(source => source.id === sourceId && source.thumbnail)) renderedPreviews.add(sourceId);
    const { sourceCount, readyCount, ids } = visiblePreviewCounts();
    const details = { pickerId: nativeSourceChooserGeneration.value, sourceCount, readyCount };
    if (!nativeSourcePreviewReported && readyCount) {
      nativeSourcePreviewReported = true;
      desktop?.reportCapturePickerTiming?.('screenPickerPreviewReady', performance.now() - nativeSourceChooserOpenedAt, details);
    }
    const visibleKey = ids.join(',');
    if (sourceCount && sourceCount === readyCount && visibleKey !== visiblePreviewReported) {
      visiblePreviewReported = visibleKey;
      desktop?.reportCapturePickerTiming?.('screenPickerVisibleReady', performance.now() - nativeSourceChooserOpenedAt, details);
    }
    const selected = selectedCaptureSourceId.value;
    if (selected && renderedPreviews.has(selected) && selected !== selectedPreviewReported) {
      selectedPreviewReported = selected;
      desktop?.reportCapturePickerTiming?.('screenPickerSelectionReady', performance.now() - sourceSelectedAt, details);
    }
  }

  function chooseCaptureSource(sourceId: string) {
    if (!captureSources.value.some((source) => source.id === sourceId)) return;
    selectedCaptureSourceId.value = sourceId;
    sourceSelectedAt = performance.now();
    selectedPreviewReported = '';
    captureSourceNotice.value = '';
    refreshVisibleSourceThumbnails();
  }

  function selectCaptureSource(sourceId: string | null, captureSettings?: ScreenSharePreferences) {
    const request = captureRequest.value;
    if (!request) return;
    if (sourceId !== null
        && (!sourceId || nativeSourceError.value
          || !canSelectNativeSource(captureAudioCapabilityReady.value, captureAudioCapabilityFailed.value))) return;
    if (sourceId !== null && !request.sources.some((source) => source.id === sourceId)) return;
    if (sourceId === null) {
      // 取消只丢弃本次草稿，不能改变下一次共享或菜单里的自定义选择。
      selectedCaptureSourceId.value = '';
      captureQuality.value = request.quality;
      captureCustomQuality.value = { ...request.customQuality };
    }
    if (sourceId) {
      lastCaptureSourceType = captureSourceType.value;
      lastNativeSelection = { discoveryId: currentNativeDiscoveryId, sourceId };
    }
    const { sourceCount, readyCount } = visiblePreviewCounts();
    desktop?.reportCapturePickerTiming?.('screenPickerClosed', performance.now() - nativeSourceChooserOpenedAt,
      { pickerId: nativeSourceChooserGeneration.value, sourceCount, readyCount, confirmed: sourceId !== null });
    captureRequest.value = null;
    const chooser = nativeSourceChooser;
    nativeSourceChooser = undefined;
    stopNativeSourceRefresh();
    const selection = sourceId ? {
      sourceId,
      quality: captureQuality.value,
      customQuality: { ...captureCustomQuality.value },
      ...(captureSettings ? { captureSettings: { ...captureSettings } } : {}),
      shareAudio: shouldShareAudioInNativeSelection(
        captureAudioCapabilityReady.value,
        captureAudioMode.value,
        captureShareAudio.value,
      ),
    } : null;
    captureAudioCapabilityReady.value = false;
    captureAudioCapabilityFailed.value = false;
    // 取消及清理不依赖偏好存储；写入失败也必须结束本次选择等待。
    chooser?.finish(selection);
    if (selection) {
      saveCapturePreferences(captureQuality.value, lastCaptureSourceType);
      if (captureAudioMode.value !== 'unavailable') {
        try { saveScreenShareAudioPreference(captureAudioMode.value, selection.shareAudio); }
        catch { notice.value = '已确认本次共享选择，但声音设置未能保存。'; }
      }
    }
  }
  function saveCapturePreferences(quality: ScreenShareQualityId, sourceType?: 'window' | 'screen') {
    try {
      saveScreenShareQuality(quality, captureCustomQuality.value);
      if (sourceType) localStorage.setItem('lycansync.capture-source-type', sourceType);
    } catch {
      notice.value = '共享设置未能保存，下次启动可能恢复原设置。';
    }
  }
  function updateCaptureShareAudio(enabled: boolean) {
    captureShareAudio.value = enabled;
  }
  function requestNativeScreenSource(
    capabilities: Promise<Record<string, { available: boolean; reason: string }>>,
    requestedGame?: DetectedActivity | null,
  ): Promise<NativeScreenSourceSelection | null> {
    if (requestedGame) return resolveGameScreenSource(requestedGame, capabilities);
    selectCaptureSource(null);
    const chooser = createNativeVideoSourceSelection([]);
    const generation = ++nativeSourceChooserGeneration.value;
    nativeSourceChooserOpenedAt = performance.now();
    nativeSourcePreviewReported = false;
    visiblePreviewReported = ''; selectedPreviewReported = ''; renderedPreviews.clear();
    sourceSelectedAt = nativeSourceChooserOpenedAt;
    nativeSourceChooser = chooser;
    nativeSourceLoading.value = true;
    nativeSourceError.value = '';
    captureAudioCapabilityReady.value = false;
    captureAudioCapabilityFailed.value = false;
    captureAudioMode.value = 'unavailable';
    captureShareAudio.value = false;
    captureSourceType.value = lastCaptureSourceType;
    selectedCaptureSourceId.value = '';
    captureSourceNotice.value = '';
    currentNativeDiscoveryId = '';
    captureRequest.value = {
      sources: chooser.options,
      quality: captureQuality.value,
      customQuality: { ...captureCustomQuality.value },
    };
    void resolveNativeScreenAudioCapability(capabilities).then((state) => {
      if (generation !== nativeSourceChooserGeneration.value || nativeSourceChooser !== chooser) return;
      captureAudioMode.value = state.mode;
      try { captureShareAudio.value = readScreenShareAudioPreference(captureAudioMode.value); }
      catch {
        captureShareAudio.value = captureAudioMode.value === 'process';
        captureSourceNotice.value = '无法读取声音设置，暂用默认设置。';
      }
      captureAudioCapabilityFailed.value = state.failed;
      captureAudioCapabilityReady.value = true;
    });
    void scheduleNativeSourceRefresh(generation, chooser);
    return chooser.result;
  }

  watch(captureSourceType, () => {
    if (!captureSources.value.some((source) => source.id === selectedCaptureSourceId.value)) selectedCaptureSourceId.value = '';
    void nextTick().then(refreshVisibleSourceThumbnails);
  });
  watch(selectedCaptureSourceId, (sourceId, _, onCleanup) => {
    captureFollowGameAvailable.value = false;
    if (!desktop) return;
    let current = true;
    onCleanup(() => { current = false; });
    // 只准备当前选中窗口的身份和分类，不采集、不发布；真实启动仍重新校验身份。
    void desktop.prepareNativeVideoSource(sourceId || null).then((result) => {
      if (current) captureFollowGameAvailable.value = result.followGame === 'league';
    }).catch((error) => console.error('共享来源准备未完成', error));
  });

  async function resolveGameScreenSource(game: DetectedActivity,
    capabilities: Promise<Record<string, { available: boolean; reason: string }>>): Promise<NativeScreenSourceSelection | null> {
    const room = options.room();
    try {
      const [snapshot, activity, audio] = await Promise.all([
        desktop!.listNativeVideoSources(), desktop!.getCurrentActivity(), resolveNativeScreenAudioCapability(capabilities),
      ]);
      if (disposed || !options.room() || options.room() !== room) return null;
      const candidates = snapshot.sources.filter(source => source.kind === 'window' && source.windowId
        && game.windowIds?.includes(source.windowId) && activity?.type === 'GAME'
        && activity.startedAt === game.startedAt && activity.windowIds?.includes(source.windowId));
      if (candidates.length !== 1) {
        notice.value = candidates.length ? '找到了多个游戏窗口，请使用共享按钮选择画面。'
          : '未找到可共享的游戏窗口，请恢复游戏窗口或使用共享按钮选择画面。';
        return null;
      }
      if (audio.failed) { notice.value = '无法确认共享声音设置，请重试。'; return null; }
      return { sourceId: candidates[0]!.sourceId, quality: captureQuality.value,
        customQuality: { ...captureCustomQuality.value }, captureSettings: { ...readScreenSharePreferences(), windowMethod: 'auto' },
        shareAudio: shouldShareAudioInNativeSelection(true, audio.mode, readScreenShareAudioPreference(audio.mode)) };
    } catch {
      if (!disposed && Boolean(options.room()) && options.room() === room) notice.value = '无法准备游戏共享，请使用共享按钮重新选择。';
      return null;
    }
  }

  let captureIntentPending: Promise<void> | undefined;
  let captureIntentAt = -Infinity;
  async function preloadCaptureSources() {
    if (!desktop || disposed || document.hidden || !options.room() || captureRequest.value
        || options.sharing() || captureIntentPending || Date.now() - captureIntentAt < 10_000) return;
    const room = options.room();
    const sourceType = lastCaptureSourceType;
    captureIntentAt = Date.now();
    captureIntentPending = (async () => {
      const snapshot = await desktop.listNativeVideoSources();
      if (disposed || document.hidden || !options.room() || options.room() !== room || captureRequest.value || options.sharing()) return;
      const activity = options.activity();
      const gameWindows = new Set(activity?.type === 'GAME' ? activity.windowIds : []);
      const sources = snapshot.sources.filter(source => source.kind === (sourceType === 'window' ? 'window' : 'monitor'))
        .sort((left, right) => Number(gameWindows.has(right.windowId ?? '')) - Number(gameWindows.has(left.windowId ?? '')));
      // 仅预取本机静态预览；正式选择器仍重新枚举身份并复用主进程的同一批请求。
      await desktop.getNativeVideoSourceThumbnails(sources.slice(0, 6));
    })().catch(error => console.warn('共享预览预加载失败', error));
    try { await captureIntentPending; }
    finally { captureIntentPending = undefined; }
  }

  onScopeDispose(() => { disposed = true; selectCaptureSource(null); });
  return { captureRequest, captureSourceType, captureQuality, captureCustomQuality, selectedCaptureSourceId,
    captureFollowGameAvailable, captureSourceNotice, captureAudioCapabilityReady, captureAudioCapabilityFailed,
    captureAudioMode, captureShareAudio, nativeSourceLoading, nativeSourceError, nativeSourceChooserGeneration,
    requestNativeScreenSource, selectCaptureSource, chooseCaptureSource, refreshVisibleSourceThumbnails, reportRenderedPreviews,
    updateCaptureShareAudio, saveCapturePreferences, preloadCaptureSources };
}
