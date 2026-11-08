import { onScopeDispose, ref } from 'vue';
import type { useAudioPreferences } from './useAudioPreferences';

interface MicrophoneDeviceOptions {
  preferences: ReturnType<typeof useAudioPreferences>;
  desktop?: Pick<NonNullable<Window['lycanDesktop']>, 'listMicrophoneDevices'>;
  stopTest: () => Promise<void>;
  changeInput: (deviceId: string) => Promise<void>;
  inputLost: () => Promise<void>;
  mediaDevices?: Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>;
}

/** 设备名与 ID 仅供本机选择；枚举不申请采集，也不进入诊断。 */
export function useMicrophoneDevices(options: MicrophoneDeviceOptions) {
  const devices = ref<{ id: string; label: string }[]>([]);
  const notice = ref('');
  const changing = ref(false);
  const loading = ref(false);
  const media = options.mediaDevices ?? navigator.mediaDevices;
  let disposed = false;
  let refreshTask: Promise<void> | undefined;
  let refreshAgain = false;

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (refreshTask) { refreshAgain = true; return refreshTask; }
    loading.value = true;
    refreshTask = (async () => {
      do {
        refreshAgain = false;
        try {
          const available = options.desktop ? await options.desktop.listMicrophoneDevices()
            : (await media.enumerateDevices()).filter((device) => device.kind === 'audioinput'
              && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
              .map((device, index) => ({ id: device.deviceId, label: device.label || `麦克风 ${index + 1}` }));
          if (disposed) return;
          devices.value = available;
          const selected = options.preferences.inputDeviceId.value;
          if (!changing.value && selected !== 'default' && !available.some((device) => device.id === selected)) {
            // 不换用默认设备；重新插入也不能替用户自动开麦。
            await Promise.all([options.inputLost(), options.stopTest()]);
            if (!disposed) notice.value = '所选麦克风不可用，已停止发声。请重新连接设备或选择其他麦克风。';
          } else if (!changing.value) notice.value = '';
        } catch {
          if (!disposed) notice.value = '无法读取麦克风列表。';
        }
      } while (!disposed && refreshAgain);
    })().finally(() => { refreshTask = undefined; loading.value = false; });
    return refreshTask;
  }

  async function select(deviceId: string) {
    if (disposed || changing.value || deviceId === options.preferences.inputDeviceId.value) return;
    if (deviceId !== 'default' && !devices.value.some((device) => device.id === deviceId)) {
      notice.value = '该麦克风已不可用，请重新打开设备列表选择。';
      return;
    }
    changing.value = true;
    notice.value = '';
    try {
      await options.stopTest();
      if (disposed) return;
      await options.changeInput(deviceId);
      if (!disposed) {
        options.preferences.setInputDeviceId(deviceId);
        void refresh();
      }
    } catch {
      if (!disposed) notice.value = '麦克风切换未完成，请检查设备连接后重试。';
    } finally { changing.value = false; }
  }

  const changed = () => { void refresh(); };
  media?.addEventListener('devicechange', changed);
  void refresh();
  onScopeDispose(() => {
    disposed = true;
    media?.removeEventListener('devicechange', changed);
  });
  return { devices, notice, changing, loading, refresh, select };
}
