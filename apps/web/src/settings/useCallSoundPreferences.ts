import { reactive, ref } from 'vue';

export const CALL_SOUND_EVENTS = [
  { id: 'joined', label: '自己加入语音' }, { id: 'left', label: '自己离开／断开语音' },
  { id: 'participantJoined', label: '成员加入语音' }, { id: 'participantLeft', label: '成员离开语音' },
  { id: 'screenShareStarted', label: '开始共享' }, { id: 'screenShareStopped', label: '停止共享' },
  { id: 'microphoneOn', label: '麦克风恢复' }, { id: 'microphoneOff', label: '麦克风静音' },
  { id: 'listeningOn', label: '恢复收听' }, { id: 'listeningOff', label: '停止收听' },
] as const;
export type CallSoundEvent = typeof CALL_SOUND_EVENTS[number]['id'];

export function useCallSoundPreferences(userId: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  const volume = ref(1);
  const customEntrances = ref(true);
  const enabled = reactive(Object.fromEntries(CALL_SOUND_EVENTS.map(event => [event.id, true])) as Record<CallSoundEvent, boolean>);
  const error = ref('');
  const key = `lycansync.call-sounds.v1.${userId}`;
  try {
    const stored = storage.getItem(key);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.volume !== 'number' || !Number.isFinite(parsed.volume) || parsed.volume < 0 || parsed.volume > 1
          || typeof parsed.customEntrances !== 'boolean' || !parsed.enabled
          || CALL_SOUND_EVENTS.some(event => typeof parsed.enabled[event.id] !== 'boolean')) throw new Error('invalid sound preferences');
      volume.value = parsed.volume;
      customEntrances.value = parsed.customEntrances;
      CALL_SOUND_EVENTS.forEach(event => { enabled[event.id] = parsed.enabled[event.id]; });
    }
  } catch { error.value = '无法读取提示音设置，暂用默认音效；请重新设置。'; }

  function save() {
    try {
      storage.setItem(key, JSON.stringify({ volume: volume.value, customEntrances: customEntrances.value, enabled }));
      error.value = '';
    } catch { error.value = '提示音本次已调整，但无法保存到本机。'; }
  }
  function setVolume(value: number) {
    if (!Number.isFinite(value)) return;
    volume.value = Math.max(0, Math.min(1, value));
    save();
  }
  function setEnabled(event: CallSoundEvent, value: boolean) { enabled[event] = value; save(); }
  function setCustomEntrances(value: boolean) { customEntrances.value = value; save(); }
  return { volume, enabled, customEntrances, error, setVolume, setEnabled, setCustomEntrances };
}
