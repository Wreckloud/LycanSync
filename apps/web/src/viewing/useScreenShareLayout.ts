import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { RoomEvent, Track, type Participant, type Room } from 'livekit-client';

export interface ViewedShare {
  key: number;
  participant: Participant;
  session?: string;
  trackSid?: string;
  observedAt: number;
}

interface LayoutOptions {
  room(): Room | null;
  participants(): Participant[];
  revision(): number;
  status(): string;
  session(identity: string): string | undefined;
  privateControl(identity: string): string;
}

export function useScreenShareLayout(options: LayoutOptions) {
  const mode = ref<'collapsed' | 'focus' | 'grid'>('collapsed');
  const shares = shallowRef<ViewedShare[]>([]);
  const focused = ref<number | null>(null);
  const membersVisible = ref(true);
  const height = ref<number | null>(null);
  const expanded = ref(false);
  let nextKey = 0;
  let reconnecting = false;
  const focusedShare = computed(() => shares.value.find(share => share.key === focused.value));
  const displayed = computed(() => mode.value === 'focus'
    ? focusedShare.value ? [focusedShare.value] : [] : shares.value);

  function available(participant: Participant) {
    return participant.isScreenShareEnabled && !options.privateControl(participant.identity);
  }

  function select(identity: string) {
    if (options.status() !== 'connected') return false;
    sync();
    const share = shares.value.find(share => share.participant.identity === identity);
    if (!share) return false;
    if (mode.value === 'focus' && focused.value === share.key) { collapse(); return true; }
    focused.value = share.key;
    mode.value = 'focus';
    return true;
  }

  function grid() {
    sync();
    if (!shares.value.length) return;
    mode.value = 'grid';
  }

  function collapse() {
    expanded.value = false;
    focused.value = null;
    mode.value = 'collapsed';
  }

  function reset() {
    shares.value = []; focused.value = null;
    expanded.value = false;
    mode.value = 'collapsed';
    membersVisible.value = true; height.value = null; reconnecting = false;
  }

  function sync() {
    if (reconnecting || options.status() !== 'connected') return;
    shares.value = options.participants().filter(available).map(participant => {
      const session = options.session(participant.identity);
      const trackSid = participant.getTrackPublication(Track.Source.ScreenShare)?.trackSid;
      const previous = shares.value.find(share => share.participant.identity === participant.identity);
      const changed = previous && (previous.session && session ? previous.session !== session
        : previous.trackSid && trackSid && previous.trackSid !== trackSid);
      return { key: previous && !changed ? previous.key : ++nextKey, participant, session, trackSid,
        observedAt: previous && !changed ? previous.observedAt : performance.now() };
    });
    // 网格随有效共享更新；聚焦目标结束或换源只能收起，不能自动接管新画面。
    if (!shares.value.length || mode.value === 'focus' && !focusedShare.value) collapse();
  }

  watch(options.room, (room, _, cleanup) => {
    reset();
    if (!room) return;
    sync();
    const reconnected = () => { reconnecting = false; sync(); };
    room.on(RoomEvent.Reconnected, reconnected);
    cleanup(() => room.off(RoomEvent.Reconnected, reconnected));
  }, { immediate: true, flush: 'sync' });
  watch(options.status, status => { if (status === 'reconnecting') reconnecting = true; }, { flush: 'sync' });
  watch(options.revision, sync, { flush: 'sync' });
  onScopeDispose(reset);
  return { mode, shares, focused, focusedShare, displayed, membersVisible, height, expanded, select, grid, collapse, reset };
}
