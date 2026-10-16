import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import { RoomEvent, type Participant, type Room } from 'livekit-client';
import type { VoiceOverlayBridge, VoiceOverlaySettings, VoiceOverlaySnapshot } from './types';

export const DEFAULT_OVERLAY_SETTINGS: VoiceOverlaySettings = { enabled: false, mode: 'all', scale: 100,
  width: 240, displayId: null, x: 1, y: 0.5, includeInCapture: false };

function validStoredSettings(value: VoiceOverlaySettings) {
  return value && typeof value.enabled === 'boolean' && ['all', 'speaking'].includes(value.mode)
    && Number.isInteger(value.scale) && value.scale >= 75 && value.scale <= 150
    && Number.isInteger(value.width) && value.width >= 180 && value.width <= 420
    && (value.displayId === null || Number.isInteger(value.displayId))
    && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1
    && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1
    && typeof value.includeInCapture === 'boolean';
}

export function useVoiceOverlay(options: {
  userId: string;
  room: () => Room | null;
  revision: () => number;
  status: () => string;
  microphone: () => boolean;
  listening: () => boolean;
  avatar: (identity: string) => string;
  bridge?: VoiceOverlayBridge;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}) {
  const bridge = options.bridge;
  const settings = shallowRef<VoiceOverlaySettings>({ ...DEFAULT_OVERLAY_SETTINGS });
  const displays = ref<{ id: number; label: string }[]>([]);
  const error = ref('');
  const busy = ref(false);
  const ready = ref(false);
  const editing = ref(false);
  const key = `lycansync.voice-overlay.v1.${options.userId}`;
  let owner: string | undefined;
  let disposed = false;
  let sequence = 0;
  let roomGeneration = 0;
  let lastSnapshot = '';
  let lastPortraits = new Map<string, string>();
  let removeRoomListener: (() => void) | undefined;

  function saveSettings(next: VoiceOverlaySettings) {
    settings.value = next;
    try { (options.storage ?? localStorage).setItem(key, JSON.stringify(next)); }
    catch { error.value = '本次覆盖设置已生效，但无法保存到本机。'; }
  }

  function publish() {
    if (!bridge || !owner || disposed || !settings.value.enabled) return;
    const room = options.room();
    const status = options.status();
    const connected = status === 'connected';
    const members: Participant[] = room ? [room.localParticipant, ...room.remoteParticipants.values()] : [];
    const snapshot: VoiceOverlaySnapshot = {
      sequence: sequence++, roomId: room ? String(roomGeneration) : null,
      status: room && (connected || status === 'reconnecting') ? status : 'hidden',
      members: members.map((member) => {
        const local = member === room?.localParticipant;
        const listening = local ? options.listening() : member.attributes['lycansync.listening'] !== 'false';
        const microphone = listening && (local ? options.microphone() : member.isMicrophoneEnabled);
        return { identity: member.identity, name: member.name || member.identity,
          microphone, listening, speaking: connected && microphone && member.isSpeaking };
      }),
    };
    const nextPortraits = members.map((member) => ({ identity: member.identity, avatar: options.avatar(member.identity) }));
    const portraitsChanged = lastPortraits.size !== nextPortraits.length
      || nextPortraits.some((portrait) => lastPortraits.get(portrait.identity) !== portrait.avatar);
    const signature = JSON.stringify({ ...snapshot, sequence: 0 });
    if (lastSnapshot === signature && !portraitsChanged) return;
    if (portraitsChanged) snapshot.portraits = nextPortraits;
    lastSnapshot = signature;
    if (portraitsChanged) lastPortraits = new Map(nextPortraits.map((portrait) => [portrait.identity, portrait.avatar]));
    void bridge.update(owner, snapshot).catch(() => {
      if (!disposed) error.value = '屏幕覆盖状态未能更新；语音不受影响，请关闭覆盖后重新开启。';
    });
  }

  watch(options.room, (room) => {
    removeRoomListener?.();
    roomGeneration++;
    lastPortraits.clear();
    // 直接转发 SDK 事件，主窗口后台时不依赖页面的 120ms 显示计时器。
    const onSpeakers = () => { if (options.room() === room) publish(); };
    room?.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    removeRoomListener = () => room?.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    publish();
  }, { immediate: true, flush: 'sync' });
  watch(() => {
    if (!bridge || !settings.value.enabled) return null;
    void options.revision();
    void options.status();
    void options.microphone();
    void options.listening();
    const room = options.room();
    return room ? [room.localParticipant, ...room.remoteParticipants.values()].map((member) => options.avatar(member.identity)) : [];
  }, publish, { flush: 'sync' });

  const removeErrorListener = bridge?.onError((message) => { error.value = message; editing.value = false; });
  const removePlacementListener = bridge?.onPlacement((next) => { if (!disposed) saveSettings(next); });
  const removeEditingListener = bridge?.onEditingChange((enabled) => { if (!disposed) editing.value = enabled; });

  async function initialize() {
    if (!bridge) return;
    try {
      const stored = (options.storage ?? localStorage).getItem(key);
      if (stored !== null) {
        const parsed = JSON.parse(stored) as VoiceOverlaySettings;
        if (!validStoredSettings(parsed)) throw new Error('invalid overlay preference');
        settings.value = parsed;
      }
    } catch { error.value = '无法读取本机覆盖设置，当前保持关闭。'; }
    try {
      const token = await bridge.begin();
      if (disposed) { await bridge.end(token); return; }
      owner = token;
      await bridge.configure(token, settings.value);
      if (disposed) return;
      ready.value = true;
      publish();
      displays.value = await bridge.displays();
    } catch { if (!disposed) error.value = '屏幕覆盖初始化失败；语音不受影响。'; }
  }

  async function configure(patch: Partial<VoiceOverlaySettings>) {
    if (!bridge || !owner || disposed || busy.value || !ready.value) return;
    busy.value = true;
    error.value = '';
    try {
      const next = await bridge.configure(owner, { ...settings.value, ...patch });
      if (disposed) return;
      if (!next.enabled) editing.value = false;
      lastSnapshot = '';
      lastPortraits.clear();
      saveSettings(next);
      publish();
    } catch { if (!disposed) error.value = '覆盖设置未能应用，请重试。'; }
    finally { busy.value = false; }
  }

  async function edit(enabled: boolean) {
    if (!bridge || !owner || disposed) return;
    try {
      const applied = await bridge.edit(owner, enabled);
      if (!disposed) editing.value = applied;
    } catch { if (!disposed) error.value = '无法切换覆盖编辑模式，请重试。'; }
  }

  async function refreshDisplays() {
    if (!bridge || disposed) return;
    try { displays.value = await bridge.displays(); }
    catch { if (!disposed) error.value = '无法读取显示器，请重新进入本栏目。'; }
  }

  void initialize();
  onScopeDispose(() => {
    disposed = true;
    removeRoomListener?.();
    removeErrorListener?.();
    removePlacementListener?.();
    removeEditingListener?.();
    if (bridge && owner) void bridge.end(owner).catch(() => console.error('屏幕覆盖关闭未确认。'));
  });
  return { settings, displays, error, busy, ready, editing, configure, edit, refreshDisplays };
}
