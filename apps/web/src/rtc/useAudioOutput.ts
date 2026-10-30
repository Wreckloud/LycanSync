import { computed, onScopeDispose, ref } from 'vue';
import type { useAudioPreferences } from './useAudioPreferences';

export interface AudioOutputBinding { ready: Promise<void>; release: () => void; }
export interface AudioOutputRouting {
  available: Readonly<{ value: boolean }>;
  bindContext: (context: AudioContext) => AudioOutputBinding;
  bindElement: (element: HTMLMediaElement) => AudioOutputBinding;
}
interface OutputEntry {
  target: AudioContext | HTMLMediaElement;
  context: boolean;
  released: boolean;
  pending: Promise<void>;
  removeListener?: () => void;
}
type RoutedContext = AudioContext & { setSinkId?: (id: string | { type: 'none' }) => Promise<void>;
  sinkId?: string | { type: 'none' } };

/** 统一现有播放资源的去向，不创建音频图、不拥有采集或播放器。 */
export function useAudioOutput(preferences: ReturnType<typeof useAudioPreferences>, media = navigator.mediaDevices) {
  const devices = ref<{ id: string; label: string }[]>([]);
  const notice = ref('');
  const changing = ref(false);
  const blocked = ref(false);
  const available = computed(() => !blocked.value && !changing.value);
  const supported = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
    && typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const entries = new Set<OutputEntry>();
  let desiredId = preferences.outputDeviceId.value;
  let disposed = false;
  let refreshVersion = 0;
  let routeVersion = 0;

  function apply(entry: OutputEntry): Promise<void> {
    const version = routeVersion;
    const next = entry.pending.catch(() => {}).then(async () => {
      if (disposed || entry.released || (entry.context && (entry.target as AudioContext).state === 'closed')) return;
      if (entry.context) {
        const context = entry.target as RoutedContext;
        if (!context.setSinkId) {
          if (desiredId !== 'default') throw new Error('audioOutputUnsupported');
          return;
        }
        // 静音输出仍运行音频图，不能 suspend 可能同时参与浏览器麦克风处理的上下文。
        await context.setSinkId(blocked.value ? { type: 'none' } : desiredId === 'default' ? '' : desiredId);
      } else if (!blocked.value) {
        const element = entry.target as HTMLMediaElement;
        if (!element.setSinkId) {
          if (desiredId !== 'default') throw new Error('audioOutputUnsupported');
          return;
        }
        await element.setSinkId(desiredId === 'default' ? '' : desiredId);
      }
    }).catch((error) => {
      // 旧设备请求迟到失败时，新选择已有自己的排队应用，不覆盖它的结果。
      if (!disposed && !entry.released && version === routeVersion) throw error;
    });
    entry.pending = next;
    return next;
  }

  function silence() {
    routeVersion++;
    blocked.value = true;
    for (const entry of entries) {
      if (entry.context) void apply(entry).catch(() => {
        if (!disposed) notice.value = '声音输出未能恢复，请检查设备并重新选择。';
      });
    }
  }

  function bind(target: AudioContext | HTMLMediaElement, context: boolean): AudioOutputBinding {
    if (disposed) throw new Error('audioOutputDisposed');
    const entry: OutputEntry = { target, context, released: false, pending: Promise.resolve() };
    entries.add(entry);
    const changed = () => {
      const sink = (target as RoutedContext).sinkId;
      const expected = desiredId === 'default' ? '' : desiredId;
      if ((blocked.value && typeof sink !== 'string') || (!blocked.value && sink === expected)) return;
      // LiveKit 的默认设备事件可能改动上下文输出，重新应用本机明确选择。
      void apply(entry).catch(() => {
        if (!disposed && !entry.released) { notice.value = '所选声音输出不可用，请重新选择设备。'; silence(); }
      });
    };
    if (context) target.addEventListener('sinkchange', changed);
    entry.removeListener = () => { if (context) target.removeEventListener('sinkchange', changed); };
    const ready = apply(entry).catch((error) => {
      if (!disposed && !entry.released) {
        notice.value = '所选声音输出不可用，请重新选择设备。';
        silence();
        throw error;
      }
    });
    void ready.catch(() => {});
    return { get ready() { return entry.pending; }, release: () => {
      entry.released = true;
      entries.delete(entry);
      entry.removeListener?.();
    } };
  }

  async function refresh() {
    const version = ++refreshVersion;
    try {
      const current = await media.enumerateDevices();
      if (disposed || version !== refreshVersion) return;
      devices.value = current.filter((device) => device.kind === 'audiooutput' && device.deviceId
        && device.deviceId !== 'default' && device.deviceId !== 'communications')
        .map((device, index) => ({ id: device.deviceId, label: device.label || `扬声器 ${index + 1}` }));
      if (desiredId !== 'default' && !devices.value.some((device) => device.id === desiredId)) {
        notice.value = '所选扬声器不可用，已暂停声音输出。请重新连接设备或手动选择系统默认。';
        silence();
      }
    } catch {
      if (!disposed && version === refreshVersion) notice.value = '无法读取声音输出列表，请检查权限后刷新。';
    }
  }

  async function select(id: string) {
    if (disposed || changing.value || (id === desiredId && !blocked.value)) return;
    if ((id !== 'default' && (!supported || !devices.value.some((device) => device.id === id)))) {
      notice.value = '当前声音输出不可用，请刷新设备列表。';
      return;
    }
    const previousId = desiredId;
    const previouslyBlocked = blocked.value;
    changing.value = true;
    routeVersion++;
    blocked.value = false;
    desiredId = id;
    notice.value = '';
    try {
      await Promise.all([...entries].map(apply));
      if (blocked.value) throw new Error('audioOutputUnavailable');
      if (!disposed) preferences.setOutputDeviceId(id);
    } catch {
      routeVersion++;
      desiredId = previousId;
      blocked.value = previouslyBlocked;
      const rollback = await Promise.allSettled([...entries].map(apply));
      if (rollback.some((result) => result.status === 'rejected')) silence();
      if (!disposed) notice.value = '声音输出切换失败，未保存新选择。请检查设备后重试。';
    } finally { changing.value = false; }
  }

  const changed = () => { void refresh(); };
  media?.addEventListener('devicechange', changed);
  void refresh();
  onScopeDispose(() => {
    disposed = true;
    refreshVersion++;
    media?.removeEventListener('devicechange', changed);
    for (const entry of entries) { entry.released = true; entry.removeListener?.(); }
    entries.clear();
  });
  return { devices, notice, available, changing, supported, refresh, select,
    bindContext: (context: AudioContext) => bind(context, true), bindElement: (element: HTMLMediaElement) => bind(element, false) };
}
